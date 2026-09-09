import { dirname, isAbsolute, resolve } from 'node:path';
import { UsageError } from '../errors';
import { normaliseTarget } from '../health/probe';
import type { FileHost } from '../host/files';

/** the project config, committed alongside the module or site it describes */
export const PROJECT_CONFIG_NAME = 'drangler.json';

/** the profile used when nothing selects one */
export const DEFAULT_PROFILE = 'default';

/** a per-site record in the GLOBAL config; never in the project one */
export interface SiteCredentials {
	/** the owner token `/firstrun` returns once, kept out of any file people commit */
	ownerToken?: string;
}

/**
 * What either config file may carry.
 *
 * `profiles` holds the same shape again under a name, so one file describes staging and production
 * without two files. `sites` is global-only and holds credentials keyed by origin.
 */
export interface DranglerConfig {
	site?: { origin?: string; name?: string };
	/** the module project `modify` works on, written by `drangler modify init` */
	module?: { root?: string; package?: string };
	workspace?: string;
	account?: string;
	profiles?: Record<string, Omit<DranglerConfig, 'profiles'>>;
	sites?: Record<string, SiteCredentials>;
}

export type ConfigScope = 'project' | 'global';

export interface ConfigSource {
	scope: ConfigScope;
	path: string;
	/** the file with its selected profile block already merged over the top level */
	config: DranglerConfig;
	/** whether the file declared the selected profile at all */
	hasProfile: boolean;
}

/** where a resolved value came from, so a report never presents an inference as an instruction */
export type SettingOrigin = 'flag' | 'env' | 'project' | 'global' | 'default' | 'unset';

export interface Setting {
	value: string | null;
	origin: SettingOrigin;
	/** the flag, the environment variable or the file path that supplied it */
	from: string;
}

export interface ResolvedConfig {
	profile: string;
	/** every file that was read, most specific first */
	sources: ConfigSource[];
	/** the site to act on, always an origin */
	site: Setting;
	/** the Durable Object identity inside that site */
	siteName: Setting;
	workspace: Setting;
	account: Setting;
	/**
	 * The owner token.
	 *
	 * Read from the flag, then the environment, then the GLOBAL file's `sites[<origin>].ownerToken`.
	 * Never from the project file: `drangler.json` is a file people commit.
	 */
	token: Setting;
}

/** what the caller passed on the command line that changes which config is read */
export interface ConfigDiscovery {
	profile?: string;
	/** an explicit file, which replaces the search rather than adding to it */
	configFile?: string;
	site?: string;
	siteName?: string;
	workspace?: string;
	account?: string;
	token?: string;
}

/** the seams config discovery needs; a `Context` satisfies it */
export interface ConfigHost {
	files: FileHost;
	env: NodeJS.ProcessEnv;
	cwd: string;
}

/**
 * The nearest ancestor of `cwd` holding a `drangler.json`.
 *
 * Walking up is what lets a command run from a subdirectory of the module it is working on, which
 * is how `git` and every other project-scoped tool behaves.
 */
export function findProjectConfig(files: FileHost, cwd: string): string | null {
	let dir = resolve(cwd);
	for (;;) {
		const candidate = `${dir.replace(/\/+$/, '')}/${PROJECT_CONFIG_NAME}`;
		if (files.exists(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** `$XDG_CONFIG_HOME/drangler/config.json`, else `~/.config/drangler/config.json` */
export function globalConfigPath(env: NodeJS.ProcessEnv): string {
	const xdg = env.XDG_CONFIG_HOME?.trim();
	if (xdg !== undefined && xdg !== '') return `${xdg.replace(/\/+$/, '')}/drangler/config.json`;
	return `${(env.HOME ?? '').replace(/\/+$/, '')}/.config/drangler/config.json`;
}

/**
 * Reads one config file.
 *
 * **An unparseable file is an error, never an absent one.** Treating a broken `drangler.json` as no
 * config would silently drop every setting in it and send the user hunting for a flag they already
 * set.
 */
function readConfig(files: FileHost, path: string, profile: string): ConfigSource | null {
	if (!files.exists(path)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(files.readText(path));
	} catch (e) {
		throw new UsageError(
			`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
		);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new UsageError(`${path} must hold a JSON object`);
	}
	const config = parsed as DranglerConfig;
	const block = config.profiles?.[profile];
	return {
		scope: path.endsWith(`/${PROJECT_CONFIG_NAME}`) ? 'project' : 'global',
		path,
		config: block === undefined ? config : merge(config, block),
		hasProfile: block !== undefined
	};
}

/** a profile block overrides the top level key by key, one level deep */
function merge(base: DranglerConfig, over: Omit<DranglerConfig, 'profiles'>): DranglerConfig {
	return {
		...base,
		...over,
		...(base.site === undefined && over.site === undefined
			? {}
			: { site: { ...base.site, ...over.site } }),
		...(base.sites === undefined && over.sites === undefined
			? {}
			: { sites: { ...base.sites, ...over.sites } })
	};
}

/**
 * Every config file that applies, most specific first.
 *
 * `--config-file` REPLACES the search rather than joining it, so a caller pointing at one file gets
 * that file and nothing layered underneath it.
 */
export function discoverConfigs(host: ConfigHost, opts: ConfigDiscovery = {}): ConfigSource[] {
	const profile = opts.profile ?? host.env.DRANGLER_PROFILE ?? DEFAULT_PROFILE;
	if (opts.configFile !== undefined) {
		const path = isAbsolute(opts.configFile)
			? opts.configFile
			: resolve(host.cwd, opts.configFile);
		const source = readConfig(host.files, path, profile);
		if (source === null) throw new UsageError(`no config file at ${path}`);
		return [source];
	}
	const found: ConfigSource[] = [];
	const project = findProjectConfig(host.files, host.cwd);
	if (project !== null) {
		const source = readConfig(host.files, project, profile);
		if (source !== null) found.push(source);
	}
	const global = readConfig(host.files, globalConfigPath(host.env), profile);
	if (global !== null) found.push(global);
	return found;
}

const UNSET: Setting = { value: null, origin: 'unset', from: '' };

/**
 * Resolves one key down the precedence chain.
 *
 * Flag, then environment, then the project file, then the global file, then the built-in default.
 * The environment sits above both files for the same reason it sits above the working directory in
 * `resolveWorkspace`: an explicit setting outranks one inferred from where the shell is.
 */
function settle(
	flag: string | undefined,
	flagName: string,
	env: { name: string; value: string | undefined }[],
	sources: readonly ConfigSource[],
	read: (config: DranglerConfig) => string | undefined,
	fallback?: string
): Setting {
	if (flag !== undefined && flag.trim() !== '') {
		return { value: flag, origin: 'flag', from: flagName };
	}
	for (const candidate of env) {
		if (candidate.value !== undefined && candidate.value.trim() !== '') {
			return { value: candidate.value, origin: 'env', from: candidate.name };
		}
	}
	for (const source of sources) {
		const value = read(source.config);
		if (value !== undefined && value.trim() !== '') {
			return { value, origin: source.scope, from: source.path };
		}
	}
	if (fallback === undefined) return UNSET;
	return { value: fallback, origin: 'default', from: 'built-in' };
}

/**
 * Everything a command needs to know about where its settings came from.
 *
 * `drangler config where` prints this verbatim, which is what stops the "why is it picking that
 * account" question: a value and the file that supplied it, in one place.
 */
export function resolveConfig(host: ConfigHost, opts: ConfigDiscovery = {}): ResolvedConfig {
	const profile = opts.profile ?? host.env.DRANGLER_PROFILE ?? DEFAULT_PROFILE;
	const sources = discoverConfigs(host, opts);

	// a typo in a profile name would otherwise resolve to the top-level block and look like it worked
	if (profile !== DEFAULT_PROFILE && sources.length > 0 && !sources.some((s) => s.hasProfile)) {
		throw new UsageError(
			`no \`${profile}\` profile in ${sources.map((s) => s.path).join(' or ')}; ` +
				'add a `profiles` block naming it, or drop --profile'
		);
	}

	const site = settle(
		opts.site,
		'--site',
		[{ name: 'DRANGLER_SITE', value: host.env.DRANGLER_SITE }],
		sources,
		(c) => c.site?.origin
	);
	if (site.value !== null) site.value = siteOrigin(site.value, site.from);

	return {
		profile,
		sources,
		site,
		siteName: settle(
			opts.siteName,
			'--site-name',
			[{ name: 'DRANGLER_SITE_NAME', value: host.env.DRANGLER_SITE_NAME }],
			sources,
			(c) => c.site?.name,
			'site'
		),
		workspace: settle(
			opts.workspace,
			'--workspace',
			[{ name: 'DRANGLER_WORKSPACE', value: host.env.DRANGLER_WORKSPACE }],
			sources,
			(c) => c.workspace
		),
		account: settle(
			opts.account,
			'--account',
			[
				{ name: 'CLOUDFLARE_ACCOUNT_ID', value: host.env.CLOUDFLARE_ACCOUNT_ID },
				{ name: 'CF_ACCOUNT_ID', value: host.env.CF_ACCOUNT_ID }
			],
			sources,
			(c) => c.account
		),
		token: settle(
			opts.token,
			'--token',
			[{ name: 'DRUPFLARE_OWNER_TOKEN', value: host.env.DRUPFLARE_OWNER_TOKEN }],
			// the project file is skipped by construction: it is a file people commit
			sources.filter((s) => s.scope === 'global'),
			(c) => (site.value === null ? undefined : c.sites?.[site.value]?.ownerToken)
		)
	};
}

/**
 * The module project a config file names, most specific file first.
 *
 * Read through `sources` rather than promoted to a {@link Setting} on {@link ResolvedConfig}: it is
 * one command's setting, and a global flag for it would be a flag every other command inherits and
 * none of them reads.
 */
export function readModule(config: ResolvedConfig): {
	root: string | null;
	package: string | null;
	/** the file that declared it, so a relative root resolves against the config rather than cwd */
	from: string | null;
} {
	for (const source of config.sources) {
		const block = source.config.module;
		if (block === undefined) continue;
		return { root: block.root ?? null, package: block.package ?? null, from: source.path };
	}
	return { root: null, package: null, from: null };
}

/**
 * Requires `--site` to be an ORIGIN, and refuses a bare word by naming the flag that takes one.
 *
 * `--site` used to be the Durable Object identity on `status`, `health` and `migrate export`, and a
 * deployment origin on `migrate plan`. One string, two meanings. It is always an origin now and the
 * identity is `--site-name`, so `--site blog` has to fail loudly: probing `https://blog` for a user
 * who meant the object called `blog` reports on somebody else's hostname.
 */
export function siteOrigin(value: string, from = '--site'): string {
	const raw = value.trim();
	const hostish = /^https?:\/\//i.test(raw) || raw.includes('.') || /^localhost(:|$)/i.test(raw);
	if (!hostish) {
		throw new UsageError(
			`${from} takes a site ORIGIN such as https://mysite.example, and \`${raw}\` is not one. ` +
				'The Durable Object identity is --site-name.'
		);
	}
	return normaliseTarget(raw);
}
