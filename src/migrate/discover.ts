import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { UsageError } from '../errors';
import type { Transport } from './transport';

export interface Vhost {
	names: string[];
	docroot: string | null;
	tls: boolean;
	file: string;
}

/** Where every resolved value came from, so a wrong guess can be traced to the byte that caused it. */
export interface SourceLayout {
	docroot: string;
	/** the directory holding composer.lock and vendor/, which is the docroot's parent or the docroot */
	composerRoot: string | null;
	/** the directory name under `sites/`, never a path */
	siteDir: string;
	/** `https://host` as the vhost serves it, or null when no name was found */
	uri: string | null;
	/** the project's own drush and the user it must run as, or null when only a global one may exist */
	/** `user` is the web user when the ssh user is root, and null when it runs as the ssh user */
	drush: { bin: string; user: string | null } | null;
	webUser: { name: string; source: 'apache envvars' | 'nginx.conf' | 'assumed' };
	/** one line per resolved value, naming the command whose output decided it */
	evidence: string[];
	/** short stable hash of host, composer root, docroot and site directory */
	id: string;
}

const SERVER_DIRS = ['/etc/apache2/sites-enabled', '/etc/nginx/sites-enabled', '/etc/nginx/conf.d'];

function strip(line: string): string {
	return line.replace(/(^|\s)#.*$/, '').trim();
}

function unquote(word: string): string {
	return word.replace(/^["']|["']$/g, '').replace(/;$/, '');
}

/** `<VirtualHost>` blocks: ServerName, ServerAlias, DocumentRoot and whether SSL is on */
export function parseApacheVhosts(text: string, file = ''): Vhost[] {
	const out: Vhost[] = [];
	let cur: Vhost | null = null;
	for (const raw of text.split('\n')) {
		const line = strip(raw);
		if (/^<VirtualHost\b/i.test(line)) {
			cur = { names: [], docroot: null, tls: /:443\b/.test(line), file };
			continue;
		}
		if (/^<\/VirtualHost>/i.test(line)) {
			if (cur !== null) out.push(cur);
			cur = null;
			continue;
		}
		if (cur === null) continue;
		const words = line.split(/\s+/);
		const key = words[0]?.toLowerCase();
		if (key === 'servername' || key === 'serveralias') {
			for (const w of words.slice(1))
				if (w !== '_' && !cur.names.includes(w)) cur.names.push(w);
		} else if (key === 'documentroot' && words[1] !== undefined) {
			cur.docroot = unquote(words[1]);
		} else if (key === 'sslengine' && words[1]?.toLowerCase() === 'on') {
			cur.tls = true;
		}
	}
	return out;
}

/** `server { }` blocks, reading only the directives at the block's own depth */
export function parseNginxServers(text: string, file = ''): Vhost[] {
	const out: Vhost[] = [];
	let depth = 0;
	let cur: Vhost | null = null;
	for (const raw of text.split('\n')) {
		const line = strip(raw);
		if (line === '') continue;
		if (cur === null && /^server\s*\{/.test(line)) {
			cur = { names: [], docroot: null, tls: false, file };
			depth = 1;
			continue;
		}
		if (cur === null) continue;
		if (depth === 1) {
			const words = line.replace(/;$/, '').split(/\s+/);
			if (words[0] === 'server_name') {
				for (const w of words.slice(1))
					if (w !== '_' && !cur.names.includes(w)) cur.names.push(w);
			} else if (words[0] === 'root' && words[1] !== undefined) {
				cur.docroot = unquote(words[1]);
			} else if (words[0] === 'listen' && words.includes('ssl')) {
				cur.tls = true;
			}
		}
		depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
		if (depth <= 0) {
			out.push(cur);
			cur = null;
			depth = 0;
		}
	}
	return out;
}

/** a docroot Drupal's scaffold wrote: an index and one of the files only the scaffold ships */
export function looksLikeDocroot(listing: string): boolean {
	const names = new Set(listing.split('\n').map((l) => posix.basename(l.trim())));
	return names.has('index.php') && (names.has('autoload.php') || names.has('update.php'));
}

/**
 * Drupal's own multisite order: sites.php first, then a directory named for the host, then each
 * shorter suffix of it, then `default`.
 */
export function chooseSiteDir(
	host: string | null,
	entries: string[],
	sitesPhp: string | null
): string {
	if (host === null) return 'default';
	const mapped = new Map<string, string>();
	for (const m of (sitesPhp ?? '').matchAll(
		/\$sites\[\s*['"]([^'"]+)['"]\s*\]\s*=\s*['"]([^'"]+)['"]/g
	)) {
		mapped.set(m[1]!, m[2]!);
	}
	const parts = host.toLowerCase().split('.');
	for (let j = parts.length; j > 0; j--) {
		const dir = parts.slice(-j).join('.');
		const via = mapped.get(dir);
		if (via !== undefined && /^[A-Za-z0-9._-]+$/.test(via)) return via;
		if (entries.includes(dir)) return dir;
	}
	return 'default';
}

/** `export APACHE_RUN_USER=www-data` or nginx's `user www-data;` */
export function parseWebUser(
	apacheEnvvars: string | null,
	nginxConf: string | null
): SourceLayout['webUser'] {
	const apache = /^\s*export\s+APACHE_RUN_USER=([a-z_][a-z0-9_-]*)\s*$/m.exec(
		apacheEnvvars ?? ''
	);
	if (apache?.[1] !== undefined) return { name: apache[1], source: 'apache envvars' };
	const nginx = /^\s*user\s+([a-z_][a-z0-9_-]*)[\s;]/m.exec(nginxConf ?? '');
	if (nginx?.[1] !== undefined) return { name: nginx[1], source: 'nginx.conf' };
	return { name: 'www-data', source: 'assumed' };
}

/** stable across runs and across two sites behind one ssh alias */
export function sourceId(
	host: string,
	composerRoot: string | null,
	docroot: string,
	siteDir: string
) {
	return createHash('sha256')
		.update([host, composerRoot ?? '', docroot, siteDir].join('\0'))
		.digest('hex')
		.slice(0, 8);
}

/** The drush a layout runs, as a command prefix the read-only allow-list accepts. */
export function drushPrefix(layout: Pick<SourceLayout, 'docroot' | 'drush' | 'uri'>): string {
	if (layout.drush === null) return `cd ${layout.docroot} && drush`;
	const uri = layout.uri === null ? '' : ` --uri=${layout.uri}`;
	const run = `${layout.drush.bin} --root=${layout.docroot}${uri}`;
	return layout.drush.user === null ? run : `runuser -u ${layout.drush.user} -- ${run}`;
}

export function discoveryCommands(root: string | null): string[] {
	return [
		'id -u',
		...SERVER_DIRS.map((d) => `ls ${d}`),
		...SERVER_DIRS.map((d) => `cat ${d}/site.conf`),
		'cat /etc/apache2/envvars',
		'cat /etc/nginx/nginx.conf',
		...(root === null
			? []
			: [
					`find ${root} -maxdepth 1 -type f`,
					`ls ${root}/sites`,
					`cat ${root}/sites/sites.php`,
					`ls ${posix.dirname(root)}/vendor/bin`,
					`ls ${root}/vendor/bin`
				])
	];
}

export interface DiscoverOptions {
	/** a docroot given by hand; vhost scanning is skipped, everything after it still resolves */
	root?: string | undefined;
	/** which vhost name to take when several Drupal docroots are served */
	site?: string | undefined;
	host: string;
}

async function lines(transport: Transport, command: string): Promise<string | null> {
	const got = await transport.exec(command);
	return got.code === 0 ? got.stdout : null;
}

/**
 * Resolves the layout of the Drupal site on a host from what the host itself shows.
 *
 * Nothing here assumes `modules/custom`, one docroot per host or a global drush. A value it cannot
 * read is `null` or `assumed`, never invented, and the evidence list names the command behind each.
 */
export async function discoverLayout(
	transport: Transport,
	opts: DiscoverOptions
): Promise<SourceLayout> {
	const evidence: string[] = [];
	let vhosts: Vhost[] = [];
	if (opts.root === undefined) {
		for (const dir of SERVER_DIRS) {
			const listing = await lines(transport, `ls ${dir}`);
			if (listing === null) continue;
			for (const name of listing
				.split('\n')
				.map((n) => n.trim())
				.filter(Boolean)) {
				const text = await lines(transport, `cat ${dir}/${name}`);
				if (text === null) continue;
				vhosts.push(
					...(dir.includes('nginx')
						? parseNginxServers(text, `${dir}/${name}`)
						: parseApacheVhosts(text, `${dir}/${name}`))
				);
			}
		}
		const wanted = opts.site?.toLowerCase();
		if (wanted !== undefined)
			vhosts = vhosts.filter((v) => v.names.some((n) => n.toLowerCase() === wanted));
		const roots = new Map<string, Vhost[]>();
		for (const v of vhosts) {
			if (v.docroot === null || !/^\/[A-Za-z0-9._\-/]*$/.test(v.docroot)) continue;
			roots.set(v.docroot, [...(roots.get(v.docroot) ?? []), v]);
		}
		const drupal: string[] = [];
		for (const docroot of roots.keys()) {
			const listing = await lines(transport, `find ${docroot} -maxdepth 1 -type f`);
			if (listing !== null && looksLikeDocroot(listing)) drupal.push(docroot);
		}
		if (drupal.length === 0) {
			throw new UsageError(
				`no Drupal docroot found in the web server config on ${opts.host}`,
				`drangler preview --host ${opts.host} --root /path/to/docroot`
			);
		}
		if (drupal.length > 1) {
			throw new UsageError(
				`${drupal.length} Drupal docroots are served on ${opts.host}: ${drupal.join(', ')}`,
				`drangler preview --host ${opts.host} --site <hostname>`
			);
		}
		opts = { ...opts, root: drupal[0]! };
		vhosts = roots.get(drupal[0]!)!;
		evidence.push(`docroot ${drupal[0]} from ${vhosts[0]!.file}`);
	} else {
		evidence.push(`docroot ${opts.root} from --root`);
	}
	const docroot = opts.root!;
	const names = vhosts.flatMap((v) => v.names);
	const name =
		(opts.site !== undefined ? [opts.site] : names).find((n) => !n.includes('*')) ?? null;
	const tls = vhosts.length === 0 || vhosts.some((v) => v.tls);
	const uri = name === null ? null : `${tls ? 'https' : 'http'}://${name}`;
	if (uri !== null) evidence.push(`uri ${uri} from ServerName`);

	let composerRoot: string | null = null;
	let drush: SourceLayout['drush'] = null;
	const webUser = parseWebUser(
		await lines(transport, 'cat /etc/apache2/envvars'),
		await lines(transport, 'cat /etc/nginx/nginx.conf')
	);
	evidence.push(`web user ${webUser.name} (${webUser.source})`);
	// runuser needs root; any other ssh user runs the project's drush as itself
	const asRoot = (await lines(transport, 'id -u'))?.trim() === '0';
	for (const candidate of [posix.dirname(docroot), docroot]) {
		const bin = `${candidate}/vendor/bin`;
		const listing = await lines(transport, `ls ${bin}`);
		if (listing === null) continue;
		composerRoot = candidate;
		if (
			listing
				.split('\n')
				.map((n) => n.trim())
				.includes('drush')
		) {
			drush = { bin: `${bin}/drush`, user: asRoot ? webUser.name : null };
			evidence.push(`drush ${bin}/drush, run as ${asRoot ? webUser.name : 'the ssh user'}`);
		}
		break;
	}
	if (drush === null) evidence.push('no vendor/bin/drush; a global drush is assumed');

	const entries = ((await lines(transport, `ls ${docroot}/sites`)) ?? '')
		.split('\n')
		.map((n) => n.trim())
		.filter(Boolean);
	const sitesPhp = entries.includes('sites.php')
		? await lines(transport, `cat ${docroot}/sites/sites.php`)
		: null;
	const siteDir = chooseSiteDir(name, entries, sitesPhp);
	evidence.push(`site directory sites/${siteDir}`);

	return {
		docroot,
		composerRoot,
		siteDir,
		uri,
		drush,
		webUser,
		evidence,
		id: sourceId(opts.host, composerRoot, docroot, siteDir)
	};
}
