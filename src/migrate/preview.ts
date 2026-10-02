import { posix } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DranglerError, UsageError } from '../errors';
import type { FileHost } from '../host/files';
import type { Dialect } from './convert';
import { surveyPlan } from './survey';
import type { Transport } from './transport';

// #region read-only allow-list

/**
 * Splits remote command text into words, keeping double-quoted spans whole.
 *
 * Returns null on anything a shell would give a second meaning to outside quotes: redirection,
 * command separators, substitution, a background `&`, a single quote. The allow-list then has only
 * plain words and the two joins it permits (`&&` and `|`) to reason about.
 */
export function shellWords(command: string): string[] | null {
	const words: string[] = [];
	let word = '';
	let quoted = false;
	let inWord = false;
	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		if (quoted) {
			if (c === '"') quoted = false;
			else if (c === '\\' || c === '$' || c === '`') return null;
			else word += c;
			continue;
		}
		if (c === '"') {
			quoted = true;
			inWord = true;
			continue;
		}
		if (c === ' ' || c === '\t') {
			if (inWord) words.push(word);
			word = '';
			inWord = false;
			continue;
		}
		if (c === '&' && command[i + 1] === '&') {
			if (inWord) words.push(word);
			words.push('&&');
			word = '';
			inWord = false;
			i++;
			continue;
		}
		if (c === '|' && command[i + 1] !== '|') {
			if (inWord) words.push(word);
			words.push('|');
			word = '';
			inWord = false;
			continue;
		}
		if (/[;<>&|`$'\\\n\r(){}*?[\]!#~]/.test(c)) return null;
		word += c;
		inWord = true;
	}
	if (quoted) return null;
	if (inWord) words.push(word);
	return words;
}

const PATH = /^\/[A-Za-z0-9._\-/]*$/;
const DRUSH_READS = new Set(['--version', 'status', 'pm:list', 'sql:query', 'sql:dump']);

/** why one segment is refused, or null when it is a read the allow-list knows */
function refuseSegment(argv: string[], first: boolean): string | null {
	const [program, ...args] = argv;
	switch (program) {
		case 'cd':
			return first && args.length === 1 && PATH.test(args[0]!) ? null : 'cd only as a lead';
		case 'php':
			return args.length === 1 && (args[0] === '-v' || args[0] === '-m') ? null : 'php flag';
		case 'du':
			return args.length === 2 && args[0] === '-sk' && PATH.test(args[1]!) ? null : 'du form';
		case 'wc':
			return args.length === 1 && args[0] === '-l' ? null : 'wc form';
		case 'find':
			return (args.length === 3 &&
				PATH.test(args[0]!) &&
				args[1] === '-type' &&
				args[2] === 'f') ||
				(args.length === 5 &&
					PATH.test(args[0]!) &&
					args[1] === '-maxdepth' &&
					args[2] === '1' &&
					args[3] === '-type' &&
					args[4] === 'f')
				? null
				: 'find form';
		case 'tar':
			// `-f -` is the only archive target: anything else names a file on the host
			return args.length >= 5 &&
				args[0] === '-cf' &&
				args[1] === '-' &&
				args[2] === '-C' &&
				PATH.test(args[3]!) &&
				args.slice(4).every((n) => /^[A-Za-z0-9._-]+$/.test(n) && n !== '..')
				? null
				: 'tar must create to stdout';
		case 'cat':
			// the settings files, composer.lock and the two .htaccess copies; nothing else is read whole
			return args.length === 1 &&
				PATH.test(args[0]!) &&
				/(\/sites\/default\/settings(\.local)?\.php|\/composer\.lock|\/\.htaccess|\/core\/assets\/scaffold\/files\/htaccess)$/.test(
					args[0]!
				)
				? null
				: 'cat reads only the settings files, composer.lock and .htaccess';
		case 'drush': {
			const sub = args[0];
			if (sub === undefined || !DRUSH_READS.has(sub)) return `drush ${sub ?? ''} writes`;
			if (args.some((a) => a.startsWith('--result-file') || a.startsWith('--gzip'))) {
				return 'a dump goes to stdout';
			}
			if (sub === 'sql:query') {
				const query = args[1] ?? '';
				if (args.length !== 2 || !/^\s*SELECT\s/i.test(query))
					return 'sql:query must SELECT';
				if (/;|\bINTO\s+(OUT|DUMP)FILE\b|\bFOR\s+UPDATE\b/i.test(query))
					return 'query writes';
			}
			return null;
		}
		default:
			return `${program ?? '(empty)'} is not on the list`;
	}
}

/**
 * Why a remote command is refused, or null when it only reads.
 *
 * The rule is a list, not a filter: a command passes only if every segment is a program and a form
 * named here, so something nobody thought of is refused rather than let through. `|` is allowed in
 * exactly one place, `find ... | wc -l`.
 */
export function refuseRemote(command: string): string | null {
	const words = shellWords(command);
	if (words === null) return 'shell syntax outside the allow-list';
	const segments: { argv: string[]; join: string | null }[] = [{ argv: [], join: null }];
	for (const w of words) {
		if (w === '&&' || w === '|') segments.push({ argv: [], join: w });
		else segments[segments.length - 1]!.argv.push(w);
	}
	for (const [i, seg] of segments.entries()) {
		if (seg.argv.length === 0) return 'empty segment';
		if (seg.join === '|') {
			const before = segments[i - 1]!.argv[0];
			if (before !== 'find' || seg.argv[0] !== 'wc') return 'only find | wc -l may pipe';
		}
		const why = refuseSegment(seg.argv, i === 0);
		if (why !== null) return why;
	}
	return null;
}

/** A transport that refuses any command the allow-list does not name, before it reaches the host. */
export function readOnlyTransport(inner: Transport): Transport {
	const check = (command: string) => {
		const why = refuseRemote(command);
		if (why !== null) throw new UsageError(`refused a remote command (${why}): ${command}`);
	};
	return {
		label: inner.label,
		async exec(command) {
			check(command);
			return await inner.exec(command);
		},
		async download(command, out) {
			check(command);
			return await inner.download(command, out);
		}
	};
}

// #endregion

// #region remote commands

/** The dialect a drush-reported driver converts from; null for one with no converter. */
export function dialectOf(driver: string | null): Dialect | null {
	if (driver === 'mysql' || driver === 'mariadb') return 'mysql';
	if (driver === 'pgsql' || driver === 'postgres') return 'pgsql';
	if (driver === 'sqlite') return 'sqlite';
	return null;
}

/** The dump, to stdout. `--hex-blob` keeps binary columns ASCII so the stream survives any pipe. */
export function dumpCommand(root: string, dialect: Dialect): string {
	return dialect === 'mysql'
		? `cd ${root} && drush sql:dump --extra-dump=--hex-blob`
		: `cd ${root} && drush sql:dump`;
}

/** The public files tree as a tar on stdout. */
export function filesCommand(root: string): string {
	return `tar -cf - -C ${root}/sites/default files`;
}

/**
 * The private files directory as a tar on stdout, or null when its path cannot be streamed safely.
 *
 * drush reports the path as settings.php wrote it, often relative to the Drupal root
 * (`../private`), so it is resolved against the root first.
 */
export function privateFilesCommand(root: string, path: string): string | null {
	const resolved = posix.normalize(path.startsWith('/') ? path : posix.join(root, path));
	const dir = posix.dirname(resolved);
	const name = posix.basename(resolved);
	if (!PATH.test(dir) || !/^[A-Za-z0-9._-]+$/.test(name) || name === '..') return null;
	return `tar -cf - -C ${dir} ${name}`;
}

/** The code trees under the Drupal root; any of them may be absent. */
export const CODE_DIRS = ['modules', 'themes', 'profiles', 'libraries'] as const;

/** One code tree as a tar on stdout. */
export function codeCommand(root: string, dir: (typeof CODE_DIRS)[number]): string {
	return `tar -cf - -C ${root} ${dir}`;
}

/** The docroot's top-level files, so the ones a browser fetches directly can be carried. */
export function rootListCommand(root: string): string {
	return `find ${root} -maxdepth 1 -type f`;
}

export function rootFilesCommand(root: string, names: readonly string[]): string {
	return `tar -cf - -C ${root} ${names.join(' ')}`;
}

/** The lock file sits beside the docroot in a composer project and inside it otherwise. */
export function composerLockCommands(root: string): string[] {
	return [`cat ${posix.dirname(root)}/composer.lock`, `cat ${root}/composer.lock`];
}

export interface MissingLibrary {
	name: string;
	version: string;
}

/**
 * Composer libraries the source runs that the duplicate's tree does not carry.
 *
 * Drupal extensions are left out because their code travels in the code step; a library (a
 * `stripe/stripe-php`, a `league/*`) does not, and a module needing one fails on a missing class.
 */
export function missingLibraries(sourceLock: string, workerLock: string): MissingLibrary[] {
	type Lock = {
		packages?: {
			name: string;
			version: string;
			type?: string;
			require?: Record<string, string>;
		}[];
	};
	const read = (text: string): Lock => {
		try {
			return JSON.parse(text) as Lock;
		} catch {
			return {};
		}
	};
	const have = new Set((read(workerLock).packages ?? []).map((p) => p.name));
	const source = read(sourceLock).packages ?? [];
	const cliOnly = cliOnlyPackages(source);
	return source
		.filter((p) => !cliOnly.has(p.name))
		.filter(
			(p) =>
				!have.has(p.name) &&
				!(p.type ?? '').startsWith('drupal-') &&
				p.type !== 'metapackage' &&
				p.type !== 'composer-plugin' &&
				!p.name.startsWith('drupal/core')
		)
		.map((p) => ({ name: p.name, version: p.version }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** command-line tools a site keeps in its lock and never loads to serve a page */
const CLI_TOOLS = ['drush/drush'];

/**
 * The CLI tools and every package reachable only through them.
 *
 * drush pulls in some twenty packages (consolidation/*, psy/psysh, league/container), and none of
 * them is missing from the duplicate in any sense a page would notice.
 */
export function cliOnlyPackages(
	packages: readonly { name: string; require?: Record<string, string> }[]
): Set<string> {
	const removed = new Set(CLI_TOOLS.filter((t) => packages.some((p) => p.name === t)));
	let changed = true;
	while (changed) {
		changed = false;
		for (const p of packages) {
			if (removed.has(p.name)) continue;
			const requiredBy = packages.filter((q) => q.require?.[p.name] !== undefined);
			if (requiredBy.length > 0 && requiredBy.every((q) => removed.has(q.name))) {
				removed.add(p.name);
				changed = true;
			}
		}
	}
	return removed;
}

export function wellKnownCommand(root: string): string {
	return `tar -cf - -C ${root} .well-known`;
}

export function settingsCommands(root: string): string[] {
	return [
		`cat ${root}/sites/default/settings.php`,
		`cat ${root}/sites/default/settings.local.php`
	];
}

/** Drupal's scaffold files, which the worker's own tree already answers for */
const SCAFFOLD = new Set([
	'index.php',
	'update.php',
	'autoload.php',
	'install.php',
	'.htaccess',
	'web.config',
	'.ht.router.php',
	'example.gitignore',
	'.csslintrc',
	'.eslintignore',
	'.eslintrc.json',
	'INSTALL.txt',
	'README.txt',
	'README.md',
	'LICENSE.txt',
	'COPYRIGHT.txt',
	'CHANGELOG.txt',
	'MAINTAINERS.txt',
	'UPDATE.txt'
]);

const PUBLISHABLE = /\.(html?|txt|xml|ico|png|jpe?g|gif|svg|webp|webmanifest)$/i;

/**
 * The top-level files a browser fetches by name: verification pages, `ads.txt`, a favicon.
 *
 * An allow-list by type, so a `backup.sql` or an `.env` left in a docroot is never republished by
 * the duplicate, and Drupal's own scaffold files are left to the worker.
 */
export function publishableRootFiles(listing: string, root: string): string[] {
	const prefix = `${root.replace(/\/+$/, '')}/`;
	return listing
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith(prefix))
		.map((line) => line.slice(prefix.length))
		.filter(
			(name) =>
				/^[A-Za-z0-9._-]+$/.test(name) && !SCAFFOLD.has(name) && PUBLISHABLE.test(name)
		)
		.sort();
}

export interface ConfigOverrides {
	/** the literal overrides, nested the way `$config` is */
	config: Record<string, unknown>;
	/** `$config[...]` assignments whose value is an expression, named and not carried */
	expressions: string[];
}

function literal(text: string): { ok: true; value: unknown } | { ok: false } {
	const t = text.trim();
	let m: RegExpExecArray | null;
	if ((m = /^'((?:[^'\\]|\\.)*)'$/s.exec(t))) {
		return { ok: true, value: m[1]!.replace(/\\(['\\])/g, '$1') };
	}
	if ((m = /^"((?:[^"\\$]|\\.)*)"$/s.exec(t))) {
		return { ok: true, value: m[1]!.replace(/\\(["\\])/g, '$1') };
	}
	if (/^-?\d+$/.test(t)) return { ok: true, value: Number(t) };
	if (/^-?\d*\.\d+$/.test(t)) return { ok: true, value: Number(t) };
	if (/^true$/i.test(t)) return { ok: true, value: true };
	if (/^false$/i.test(t)) return { ok: true, value: false };
	if (/^null$/i.test(t)) return { ok: true, value: null };
	return { ok: false };
}

/**
 * The `$config[...]` assignments in a settings file.
 *
 * Only literal values are carried: an expression (`getenv()`, a concatenation, a constant) is
 * named so the operator can set it by hand. Values are returned, never logged; they are often
 * credentials.
 */
export function parseConfigOverrides(php: string, into?: ConfigOverrides): ConfigOverrides {
	const out = into ?? { config: {}, expressions: [] };
	for (const line of php.split('\n')) {
		const m = /^\s*\$config((?:\[\s*'[^']*'\s*\])+)\s*=\s*(.+?);\s*(?:(?:#|\/\/).*)?$/.exec(
			line
		);
		if (!m) continue;
		const keys = [...m[1]!.matchAll(/'([^']*)'/g)].map((k) => k[1]!);
		const name = keys.join('.');
		const value = literal(m[2]!);
		if (!value.ok) {
			if (!out.expressions.includes(name)) out.expressions.push(name);
			continue;
		}
		let at = out.config;
		for (const key of keys.slice(0, -1)) {
			if (typeof at[key] !== 'object' || at[key] === null) at[key] = {};
			at = at[key] as Record<string, unknown>;
		}
		at[keys.at(-1)!] = value.value;
	}
	return out;
}

export interface SettingsAssignment {
	scope: 'settings' | 'config';
	keys: string[];
	/** null when the value is an expression */
	value: { literal: unknown } | null;
}

/**
 * Every `$settings[...]` and `$config[...]` assignment with a literal or named right-hand side.
 *
 * Kept as raw assignments because they can carry a password; {@link settingsReport} reduces them
 * to what a plan may print. `[]` pushes are kept as an empty key.
 */
export function parseSettings(php: string): SettingsAssignment[] {
	const out: SettingsAssignment[] = [];
	for (const line of php.split('\n')) {
		const m =
			/^\s*\$(settings|config)((?:\[\s*(?:'[^']*'|"[^"]*"|)\s*\])+)\s*=\s*(.+?);\s*(?:(?:#|\/\/).*)?$/.exec(
				line
			);
		if (!m) continue;
		const keys = [...m[2]!.matchAll(/\[\s*(?:'([^']*)'|"([^"]*)"|)\s*\]/g)].map(
			(k) => k[1] ?? k[2] ?? ''
		);
		const value = literal(m[3]!);
		out.push({
			scope: m[1] as 'settings' | 'config',
			keys,
			value: value.ok ? { literal: value.value } : null
		});
	}
	return out;
}

export interface TrustedHosts {
	/** patterns that name exactly one host, as that host */
	hosts: string[];
	/** patterns that match more than one host, which need a hostname chosen by hand */
	patterns: string[];
}

/**
 * The hostnames a site answered on, read from `$settings['trusted_host_patterns']`.
 *
 * Reads the array form across lines and the `[] =` push form. A pattern is a host only when it is
 * anchored and every other character is a literal or an escaped dot or hyphen.
 */
export function trustedHosts(php: string): TrustedHosts {
	const strings: string[] = [];
	const quoted = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
	const block =
		/\$settings\[\s*['"]trusted_host_patterns['"]\s*\]\s*=\s*(?:\[|array\s*\()([\s\S]*?)(?:\]|\))\s*;/g;
	for (const m of php.matchAll(block)) {
		for (const s of m[1]!.matchAll(quoted)) strings.push(s[1] ?? s[2] ?? '');
	}
	const push =
		/\$settings\[\s*['"]trusted_host_patterns['"]\s*\]\s*\[\s*\]\s*=\s*(['"])(.*?)\1\s*;/g;
	for (const m of php.matchAll(push)) strings.push(m[2]!);
	const out: TrustedHosts = { hosts: [], patterns: [] };
	for (const raw of strings) {
		const pattern = raw.replace(/\\\\/g, '\\');
		const literal = /^\^((?:[a-z0-9]|\\[.-]|-)+)\$$/i.exec(pattern);
		const list = literal ? out.hosts : out.patterns;
		const value = literal ? literal[1]!.replace(/\\/g, '').toLowerCase() : pattern;
		if (!list.includes(value)) list.push(value);
	}
	return out;
}

/** `domains.txt`: one command per host, then the patterns that need a hostname chosen */
export function domainsText(hosts: TrustedHosts): string {
	return [
		...hosts.hosts.map((h) => `drangler domain add ${h}`),
		...hosts.patterns.map((p) => `not one host, choose one by hand: ${p}`)
	]
		.map((line) => `${line}\n`)
		.join('');
}

export interface SettingsReport {
	/** dotted names of the memcache settings that are dropped */
	memcache: string[];
	/** `redis://[:password@]host:port`; holds a credential, so it is written to a secret and never printed */
	redisUrl: string | null;
	/** what was translated or why not, with no values in it */
	redisNote: string | null;
	/** `redis.connection` parts set by expression */
	redisExpressions: string[];
	/** dotted names of the s3fs and flysystem settings, which are not translated */
	s3: string[];
}

const REDIS_DEFAULT_PORT = 6379;

/** Reduces assignments to a report; later assignments win, the way settings.local.php overrides. */
export function settingsReport(assignments: readonly SettingsAssignment[]): SettingsReport {
	const report: SettingsReport = {
		memcache: [],
		redisUrl: null,
		redisNote: null,
		redisExpressions: [],
		s3: []
	};
	const add = (list: string[], name: string) => {
		if (!list.includes(name)) list.push(name);
	};
	const redis = new Map<string, unknown>();
	const expr = Symbol('expression');
	let redisSeen = false;
	for (const a of assignments) {
		const name = `${a.scope === 'config' ? 'config:' : ''}${a.keys.filter(Boolean).join('.')}`;
		const first = a.keys[0] ?? '';
		const text = typeof a.value?.literal === 'string' ? a.value.literal : '';
		if (a.scope === 'settings' && (first.startsWith('memcache') || /memcache/i.test(text))) {
			add(report.memcache, name);
		}
		if (
			(a.scope === 'settings' && (first.startsWith('s3fs') || first === 'flysystem')) ||
			(a.scope === 'config' && first.startsWith('s3fs.')) ||
			text.startsWith('s3://')
		) {
			add(report.s3, name);
		}
		if (a.scope === 'settings' && first === 'redis.connection') {
			redisSeen = true;
			if (a.keys.length === 1) add(report.redisExpressions, 'redis.connection');
			else redis.set(a.keys[1]!, a.value === null ? expr : a.value.literal);
		}
	}
	if (!redisSeen) return report;
	for (const part of ['host', 'port', 'password']) {
		if (redis.get(part) === expr) add(report.redisExpressions, `redis.connection.${part}`);
	}
	if (report.redisExpressions.length > 0) {
		report.redisNote = `set by expression, so REDIS_URL is not written: ${report.redisExpressions.join(', ')}`;
		return report;
	}
	const host = redis.get('host');
	if (typeof host !== 'string' || host === '') {
		report.redisNote = 'no literal host, so REDIS_URL is not written';
		return report;
	}
	if (host.startsWith('/')) {
		report.redisNote = 'the host is a unix socket, which a worker cannot reach';
		return report;
	}
	const port = redis.get('port');
	const password = redis.get('password');
	const auth =
		typeof password === 'string' && password !== '' ? `:${encodeURIComponent(password)}@` : '';
	report.redisUrl = `redis://${auth}${host.includes(':') ? `[${host}]` : host}:${typeof port === 'number' ? port : REDIS_DEFAULT_PORT}`;
	report.redisNote = `translated to REDIS_URL${typeof port === 'number' ? '' : ` with the default port ${REDIS_DEFAULT_PORT}`}${auth === '' ? '' : ' with its password'}`;
	return report;
}

/** Every command preview can send to the host, which is what the allow-list property test walks. */
export function previewCommands(root: string): string[] {
	return [
		...surveyPlan(root).map((s) => s.command),
		dumpCommand(root, 'mysql'),
		dumpCommand(root, 'pgsql'),
		filesCommand(root),
		privateFilesCommand(root, '../private')!,
		privateFilesCommand(root, '/var/private-files')!,
		...CODE_DIRS.map((d) => codeCommand(root, d)),
		rootListCommand(root),
		rootFilesCommand(root, ['robots.txt', 'google0123abcd.html', 'ads.txt']),
		wellKnownCommand(root),
		...settingsCommands(root),
		...composerLockCommands(root),
		...serverRulesCommands(root)
	];
}

// #endregion

// #region server rules

/** the site's own `.htaccess`, then the stock copy drupal/core ships, so only the site's edits remain */
export function serverRulesCommands(root: string): string[] {
	return [`cat ${root}/.htaccess`, `cat ${root}/core/assets/scaffold/files/htaccess`];
}

export interface RedirectRule {
	from: string;
	to: string;
	status: 301 | 302 | 307 | 308;
}

export interface HeaderRule {
	path: string;
	set: Record<string, string>;
}

export interface ServerRules {
	redirects: RedirectRule[];
	headers: HeaderRule[];
	/** source lines the worker cannot express, verbatim */
	unparsed: string[];
}

/** the worker's own ceiling on a rule document; rules past it are reported, not written */
export const MAX_SERVER_RULES = 100;

/** names the worker refuses to set, mirrored so a refusal is reported here instead of dropped there */
const FORBIDDEN_HEADERS = new Set([
	'set-cookie',
	'content-length',
	'content-encoding',
	'transfer-encoding',
	'connection',
	'host'
]);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const STATUS_WORDS: Record<string, number> = { permanent: 301, temp: 302 };
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

/** apache argument splitting: whitespace, with double-quoted words */
function apacheWords(line: string): string[] {
	const words: string[] = [];
	const re = /"((?:\\.|[^"\\])*)"|(\S+)/g;
	for (const m of line.matchAll(re))
		words.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!);
	return words;
}

/**
 * A regex that names one literal path, as `{ path, wildcard }`, or null.
 *
 * `^old/page$` is exact and `^old/(.*)$` is a prefix; anything else is a real pattern the worker's
 * prefix-or-exact match cannot express.
 */
function literalPattern(
	pattern: string,
	leadingSlash: boolean
): { path: string; wildcard: boolean } | null {
	const m = /^\^(\/?)((?:[A-Za-z0-9_~\/-]|\\[.\-/])*?)(\/\?)?(\(\.\*\))?\$?$/.exec(pattern);
	if (m === null) return null;
	const [, slash, body, , capture] = m;
	if (leadingSlash && slash !== '/') return null;
	if (!pattern.endsWith('$') && capture === undefined) return null;
	const path = `/${body!.replace(/\\(.)/g, '$1')}`;
	const exact = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
	return capture === undefined ? { path: exact, wildcard: false } : { path, wildcard: true };
}

/** a rewrite or redirect target the worker can serve, with `$1` as its trailing `*` */
function literalTarget(target: string, wildcard: boolean): string | null {
	const t = /^https?:\/\//.test(target) || target.startsWith('/') ? target : `/${target}`;
	if (/%\{|\$[02-9]/.test(t)) return null;
	const uses = (t.match(/\$1/g) ?? []).length;
	if (wildcard ? uses !== 1 || !t.endsWith('$1') : uses !== 0) return null;
	return wildcard ? `${t.slice(0, -2)}*` : t;
}

function redirectRule(from: string, to: string, status: number): RedirectRule | null {
	if (!REDIRECT_STATUSES.has(status) || from === to || /[\s\\]/.test(to)) return null;
	return { from, to, status: status as RedirectRule['status'] };
}

/** `Redirect` matches a path prefix, so it becomes the exact path plus everything under it */
function prefixRedirect(from: string, to: string, status: number): RedirectRule[] | null {
	if (!/^\/[^\s*]*$/.test(from)) return null;
	const base = from.length > 1 ? from.replace(/\/+$/, '') : from;
	const toBase = to.replace(/\/+$/, '');
	const exact = redirectRule(base, to, status);
	const under = redirectRule(base === '/' ? '/*' : `${base}/*`, `${toBase}/*`, status);
	return exact === null || under === null ? null : base === '/' ? [under] : [exact, under];
}

const normalise = (line: string) => line.trim().replace(/\s+/g, ' ');

/** `IfModule` only asks whether a module is loaded, so its contents count as top level */
const TRANSPARENT = /^<IfModule\b/i;

/**
 * Translates the redirects and headers of a site's `.htaccess` into the worker's two levers.
 *
 * Only unconditional rules translate: a `RewriteRule` with `[R]` and no `RewriteCond`, `Redirect`,
 * `RedirectMatch` on a literal path, and `Header set` outside any `<Files>` or `<If>` block. A line
 * identical to one in `stock` (Drupal's own `.htaccess`) is Drupal's, which the worker already
 * answers for. Everything else comes back verbatim in `unparsed`.
 */
export function parseHtaccess(text: string, stock = ''): ServerRules {
	const stockLines = new Set(
		stock
			.split('\n')
			.map(normalise)
			.filter((l) => l !== '' && !l.startsWith('#'))
	);
	const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
	const rules: ServerRules = { redirects: [], headers: [], unparsed: [] };
	const set: Record<string, string> = {};
	const stack: boolean[] = [];
	let block: string[] = [];
	let conditions: string[] = [];
	for (const raw of lines) {
		const line = normalise(raw);
		if (line === '' || line.startsWith('#')) continue;
		const stockLine = stockLines.has(line);
		if (line.startsWith('</')) {
			const transparent = stack.pop() ?? true;
			const inside = stack.includes(false);
			if (!transparent || inside) block.push(line);
			if (!transparent && !inside) {
				if (!block.every((l) => stockLines.has(l))) rules.unparsed.push(block.join('\n'));
				block = [];
			}
			continue;
		}
		if (line.startsWith('<')) {
			const transparent = TRANSPARENT.test(line);
			if (!transparent || stack.includes(false)) block.push(line);
			stack.push(transparent);
			continue;
		}
		if (stack.includes(false)) {
			block.push(line);
			continue;
		}
		const [directive = '', ...args] = apacheWords(line);
		const name = directive.toLowerCase();
		if (name === 'rewritecond') {
			conditions.push(line);
			continue;
		}
		const pending = name === 'rewriterule' ? conditions : [];
		const conditional = pending.length > 0;
		if (name === 'rewriterule') conditions = [];
		if (stockLine || name === 'rewriteengine' || name === 'rewritebase') continue;
		const translated = ((): RedirectRule[] | 'header' | null => {
			switch (name) {
				case 'rewriterule': {
					const [pattern = '', target = '', flagText = ''] = args;
					const flags = flagText
						.replace(/^\[|\]$/g, '')
						.split(',')
						.filter(Boolean);
					const r = flags.find((f) => /^R(=\d+)?$/i.test(f));
					if (conditional || r === undefined || args.length > 3) return null;
					if (!flags.every((f) => f === r || /^(L|NE|QSA|END)$/i.test(f))) return null;
					const literal = literalPattern(pattern, false);
					const to = literal === null ? null : literalTarget(target, literal.wildcard);
					if (literal === null || to === null) return null;
					const from = literal.wildcard ? `${literal.path}*` : literal.path;
					const rule = redirectRule(from, to, r.includes('=') ? Number(r.slice(2)) : 302);
					return rule === null ? null : [rule];
				}
				case 'redirect':
				case 'redirectpermanent':
				case 'redirecttemp': {
					const stated =
						name === 'redirect' && args.length === 3 ? args[0]!.toLowerCase() : null;
					const status =
						name === 'redirectpermanent'
							? 301
							: name === 'redirecttemp' || stated === null
								? 302
								: (STATUS_WORDS[stated] ?? Number(stated));
					const [from, to] = stated === null ? args : args.slice(1);
					if (from === undefined || to === undefined || args.length > 3) return null;
					return prefixRedirect(from, to, status);
				}
				case 'redirectmatch': {
					const status =
						args.length === 3
							? (STATUS_WORDS[args[0]!.toLowerCase()] ?? Number(args[0]))
							: 302;
					const [pattern = '', target = ''] = args.slice(args.length - 2);
					const literal = literalPattern(pattern, true);
					const to = literal === null ? null : literalTarget(target, literal.wildcard);
					if (literal === null || to === null) return null;
					const rule = redirectRule(
						literal.wildcard ? `${literal.path}*` : literal.path,
						to,
						status
					);
					return rule === null ? null : [rule];
				}
				case 'header': {
					const rest = args[0]?.toLowerCase() === 'always' ? args.slice(1) : args;
					const [action, header = '', value] = rest;
					if (action?.toLowerCase() !== 'set' || value === undefined || rest.length !== 3)
						return null;
					const key = header.toLowerCase();
					if (
						!HEADER_NAME.test(header) ||
						FORBIDDEN_HEADERS.has(key) ||
						key.startsWith('x-cfw-')
					)
						return null;
					set[header] = value;
					return 'header';
				}
				default:
					return null;
			}
		})();
		if (translated === null) rules.unparsed.push([...pending, line].join('\n'));
		else if (translated !== 'header') rules.redirects.push(...translated);
	}
	if (Object.keys(set).length > 0) rules.headers.push({ path: '/*', set });
	if (rules.redirects.length > MAX_SERVER_RULES) {
		for (const r of rules.redirects.splice(MAX_SERVER_RULES)) {
			rules.unparsed.push(`past the ${MAX_SERVER_RULES}-rule limit: ${r.from} -> ${r.to}`);
		}
	}
	return rules;
}

/** the same headers for the asset layer, which answers static files before the worker runs */
export function assetHeadersFile(headers: readonly HeaderRule[]): string {
	return headers
		.map(
			(h) =>
				`${h.path}\n${Object.entries(h.set)
					.map(([k, v]) => `  ${k}: ${v}`)
					.join('\n')}\n`
		)
		.join('');
}

/**
 * One `.dev.vars` line. wrangler's dotenv unescapes only `\n` inside double quotes, so a JSON value
 * goes in single quotes and a `'` inside it as the JSON escape `\u0027`.
 */
export function devVarLine(name: string, value: string): string {
	const json = value.startsWith('{') || value.startsWith('[');
	const safe = json ? value.replace(/'/g, '\\u0027') : value;
	if (!safe.includes("'") && !/[\r\n]/.test(safe)) return `${name}='${safe}'`;
	if (!/["\\\r\n]/.test(safe)) return `${name}="${safe}"`;
	throw new DranglerError('settings', `${name} cannot be written to .dev.vars as it stands`);
}

// #endregion

// #region site database

/** the worker serves a public file out of these two tables; chunked under the pack's value cap */
export const FILE_CHUNK_BYTES = 48 * 1024;

/** Derived trees Drupal rebuilds on demand; copying them would spend rows on nothing. */
export const REGENERATED_DIRS = new Set(['styles', 'css', 'js', 'php', 'languages']);

const MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	pdf: 'application/pdf',
	txt: 'text/plain',
	mp4: 'video/mp4',
	mp3: 'audio/mpeg',
	zip: 'application/zip',
	doc: 'application/msword',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	csv: 'text/csv'
};

export function mimeOf(path: string): string | null {
	const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
	return ext === undefined ? null : (MIME[ext] ?? null);
}

/** Every file under `dir`, relative, skipping the regenerated trees at its top level. */
/** Apache's two spellings of refusing every request, which Drupal writes into protected directories */
const DENY_ALL = /^\s*(Require\s+all\s+denied|Deny\s+from\s+all)\b/im;

/**
 * Every file under `dir`, relative, skipping the regenerated trees at its top level.
 *
 * A directory whose `.htaccess` denies every request is left out whole and named in `protectedDirs`:
 * Drupal keeps the config sync directory under public files that way, and the worker serves the
 * file store publicly, so carrying it would publish the site's configuration.
 */
export function walkFiles(
	files: FileHost,
	dir: string,
	prefix = '',
	protectedDirs: string[] = []
): string[] {
	const out: string[] = [];
	const htaccess = `${dir}/.htaccess`;
	if (prefix !== '' && files.exists(htaccess) && DENY_ALL.test(files.readText(htaccess))) {
		protectedDirs.push(prefix);
		return out;
	}
	for (const entry of files.readDir(dir)) {
		// a files tree's dotfiles are web-server protection (.htaccess), and served from the store they
		// would be public
		if (entry.name.startsWith('.')) continue;
		const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
		if (entry.directory) {
			if (prefix === '' && REGENERATED_DIRS.has(entry.name)) continue;
			out.push(...walkFiles(files, `${dir}/${entry.name}`, rel, protectedDirs));
		} else {
			out.push(rel);
		}
	}
	return out.sort();
}

/** directories a code tree carries that Drupal never loads */
const SKIPPED_CODE_DIRS = new Set(['node_modules', '.git', '.github', 'tests']);

/** text the mount can decode; the worker stores module files as TEXT, so a binary would corrupt */
const CODE_TEXT =
	/\.(php|module|inc|install|theme|profile|engine|yml|yaml|twig|css|js|mjs|json|txt|md|html|xml|svg|po|map|sql|info)$/i;

/** one module file row, capped under the worker's record ceiling */
export const MAX_CODE_FILE_BYTES = 1_500_000;

export interface CodeTree {
	files: { path: string; package: string; text: string }[];
	/** binaries and oversized files, which the mount cannot carry */
	skipped: string[];
}

/**
 * The text files of the code trees unpacked under `dir`, as `cfw_module_file` rows.
 *
 * `path` is relative to the Drupal root, which is how the worker mounts them. The package is the
 * extension directory (`modules/custom/foo` gives `migrated/foo`), so a later `/install` of the
 * same project replaces the rows rather than sitting beside them.
 */
export function codeTree(files: FileHost, dir: string): CodeTree {
	const out: CodeTree = { files: [], skipped: [] };
	const decoder = new TextDecoder('utf-8', { fatal: true });
	const walk = (at: string, rel: string) => {
		for (const entry of files.readDir(at)) {
			const path = `${rel}/${entry.name}`;
			if (entry.directory) {
				if (!SKIPPED_CODE_DIRS.has(entry.name)) walk(`${at}/${entry.name}`, path);
				continue;
			}
			const bytes = files.readBytes(`${at}/${entry.name}`);
			let text: string | null = null;
			if (CODE_TEXT.test(entry.name) && bytes.length <= MAX_CODE_FILE_BYTES) {
				try {
					text = decoder.decode(bytes);
				} catch {
					text = null;
				}
			}
			if (text === null) {
				out.skipped.push(path);
				continue;
			}
			const parts = path.split('/');
			const name =
				parts[1] === 'contrib' || parts[1] === 'custom' ? parts[2] : (parts[1] ?? parts[0]);
			out.files.push({ path, package: `migrated/${name}`, text });
		}
	};
	for (const top of CODE_DIRS) {
		if (files.exists(`${dir}/${top}`)) walk(`${dir}/${top}`, top);
	}
	out.files.sort((a, b) => a.path.localeCompare(b.path));
	return out;
}

export interface SiteDbReport {
	tables: number;
	nodes: number | null;
	fileRows: number | null;
	filesStored: number;
	fileBytes: number;
	codeFiles: number;
}

function count(db: DatabaseSync, sql: string): number | null {
	try {
		const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
		return row === undefined ? null : Number(Object.values(row)[0]);
	} catch {
		return null;
	}
}

/**
 * Replays a converted dump into a SQLite file and stores the public files beside it.
 *
 * The file rows use the worker's own `cfw_file` layout, so the pack that ships this database
 * provisions the uploads with the site rather than leaving every image a 404.
 */
export function buildSiteDb(
	path: string,
	sql: string,
	files: readonly { rel: string; bytes: Uint8Array; scheme?: 'public' | 'private' }[],
	nowMs: number,
	code: CodeTree['files'] = []
): SiteDbReport {
	const db = new DatabaseSync(path);
	try {
		db.exec(sql);
		db.exec(`CREATE TABLE IF NOT EXISTS cfw_file (
			uri TEXT PRIMARY KEY, size INTEGER NOT NULL, modified INTEGER NOT NULL,
			mime TEXT, chunks INTEGER NOT NULL, mirrored INTEGER NOT NULL DEFAULT 0)`);
		db.exec(`CREATE TABLE IF NOT EXISTS cfw_file_chunk (
			uri TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (uri, seq))`);
		const file = db.prepare(
			'INSERT OR REPLACE INTO cfw_file (uri, size, modified, mime, chunks) VALUES (?, ?, ?, ?, ?)'
		);
		// node 22's node:sqlite binds an empty Uint8Array as NULL, which an empty upload hits
		const chunk = db.prepare(
			"INSERT OR REPLACE INTO cfw_file_chunk (uri, seq, bytes) VALUES (?, ?, COALESCE(?, x''))"
		);
		let fileBytes = 0;
		db.exec('BEGIN');
		for (const { rel, bytes, scheme } of files) {
			const uri = `${scheme ?? 'public'}://${rel}`;
			const n = Math.max(1, Math.ceil(bytes.length / FILE_CHUNK_BYTES));
			for (let seq = 0; seq < n; seq++) {
				chunk.run(
					uri,
					seq,
					bytes.subarray(seq * FILE_CHUNK_BYTES, (seq + 1) * FILE_CHUNK_BYTES)
				);
			}
			file.run(uri, bytes.length, nowMs, mimeOf(rel), n);
			fileBytes += bytes.length;
		}
		db.exec(`CREATE TABLE IF NOT EXISTS cfw_module_file (
			path TEXT PRIMARY KEY, package TEXT NOT NULL, version TEXT NOT NULL,
			source TEXT NOT NULL, installed_at INTEGER NOT NULL)`);
		const module = db.prepare(
			`INSERT OR REPLACE INTO cfw_module_file (path, package, version, source, installed_at)
			 VALUES (?, ?, 'migrated', ?, ?)`
		);
		for (const f of code) module.run(f.path, f.package, f.text, nowMs);
		db.exec('COMMIT');
		return {
			tables: count(db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'") ?? 0,
			nodes: count(db, 'SELECT COUNT(*) FROM node'),
			fileRows: count(db, 'SELECT COUNT(*) FROM file_managed'),
			filesStored: files.length,
			fileBytes,
			codeFiles: code.length
		};
	} finally {
		db.close();
	}
}

// #endregion
