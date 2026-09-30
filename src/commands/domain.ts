import { join } from 'node:path';
import { parseWranglerConfig, setTopLevel, type WranglerRoute } from '../cloudflare/config';
import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { DranglerError, UsageError } from '../errors';
import { emit, kv, table } from '../format';
import { ownerCall, ownerTarget } from '../owner';
import { resolveWorkspace } from '../workspace/layout';
import { DEFAULT_CONFIG } from '../workspace/validate';

export interface DomainOptions {
	/** write the mapping into `wrangler dev`'s local KV and leave the routes alone */
	local?: boolean;
	/** the state directory `wrangler dev --persist-to` was given, with `--local` */
	persistTo?: string;
	/** map the host without adding a route, for a host routed some other way */
	route?: boolean;
	config?: string;
	workspace?: string;
	globals: GlobalOptions;
}

export interface DomainReport {
	host: string;
	site: string | null;
	mapped: boolean;
	route: 'added' | 'present' | 'removed' | 'absent' | 'skipped';
	/** true when `workers_dev: true` had to be written so the workers.dev URL survives the route */
	keptWorkersDev: boolean;
	notes: string[];
}

/** `host[:port]`, lowercased, from a bare host or a URL */
export function normaliseHost(raw: string): string {
	const text = raw.trim();
	let host: string;
	try {
		host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).host;
	} catch {
		throw new UsageError(`not a hostname: ${raw}`);
	}
	if (host === '' || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) {
		throw new UsageError(`not a hostname: ${raw}`);
	}
	return host.toLowerCase();
}

/** the KV key the worker's `resolveSite()` reads */
export const hostKey = (host: string) => `site:host:${host}`;

function configPath(ctx: Context, opts: DomainOptions): string {
	const ws = resolveWorkspace(ctx, opts, opts.globals.config).path;
	return join(ws, opts.config ?? DEFAULT_CONFIG);
}

async function wranglerKv(
	ctx: Context,
	opts: DomainOptions,
	args: readonly string[]
): Promise<string> {
	const ws = resolveWorkspace(ctx, opts, opts.globals.config).path;
	const argv = [
		'wrangler',
		'kv',
		'key',
		...args,
		'--binding',
		'CONFIG_KV',
		'-c',
		opts.config ?? DEFAULT_CONFIG,
		...(opts.local === true
			? ['--local', ...(opts.persistTo === undefined ? [] : ['--persist-to', opts.persistTo])]
			: ['--remote'])
	];
	ctx.io.err(`${ws}$ bunx ${argv.join(' ')}`);
	const result = await ctx.runner.run('bunx', argv, { cwd: ws });
	if (result.code !== 0) {
		throw new DranglerError(
			'domain',
			`wrangler kv exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`
		);
	}
	return result.stdout;
}

/** the site `--site-name` names, else the deployment's primary as the worker reports it */
async function primarySite(ctx: Context, opts: DomainOptions, target?: string): Promise<string> {
	const named = opts.globals.config.siteName.value;
	if (named !== null && named !== '') return named;
	const owner = ownerTarget(opts.globals, target);
	const reply = await ownerCall(ctx, owner, '/deployment');
	const primary = (reply.body as { deployment?: { primary?: unknown } }).deployment?.primary;
	if (reply.status >= 400 || typeof primary !== 'string' || primary === '') {
		throw new UsageError(
			'the deployment has no primary site yet; claim the site first, or pass --site-name <id>'
		);
	}
	return primary;
}

function readRoutes(text: string): WranglerRoute[] {
	const routes = parseWranglerConfig(text).routes;
	return Array.isArray(routes) ? routes : [];
}

const hostOnly = (host: string) => host.replace(/:\d+$/, '');

/**
 * Maps a host to the site: the worker's `site:host:` mapping plus a Custom Domain route.
 *
 * The mapping makes the host resolve to the site and turns on the alias rewrite, so links,
 * redirects and the login cookie follow the host a visitor used. The route is what Cloudflare
 * attaches at the next deploy; on a zone in the same account it creates the DNS record and the
 * certificate itself. The mapping is written with wrangler's own credential, never an owner token:
 * pointing a hostname at a site is an account decision.
 */
export async function runDomainAdd(
	ctx: Context,
	rawHost: string,
	target: string | undefined,
	opts: DomainOptions
): Promise<DomainReport> {
	const host = normaliseHost(rawHost);
	const site = await primarySite(ctx, opts, target);
	const report: DomainReport = {
		host,
		site,
		mapped: false,
		route: 'skipped',
		keptWorkersDev: false,
		notes: []
	};
	const withRoute = opts.local !== true && opts.route !== false;
	if (opts.globals.dryRun) {
		report.notes.push(
			`dry run: would write ${hostKey(host)} = ${site}${withRoute ? ` and add a custom_domain route for ${hostOnly(host)}` : ''}`
		);
		return finish(ctx, opts, report);
	}
	await wranglerKv(ctx, opts, ['put', hostKey(host), site]);
	report.mapped = true;

	if (withRoute) {
		const path = configPath(ctx, opts);
		let text = ctx.files.readText(path);
		const routes = readRoutes(text);
		const pattern = hostOnly(host);
		if (routes.some((r) => r.pattern === pattern)) {
			report.route = 'present';
		} else {
			text = setTopLevel(text, 'routes', [...routes, { pattern, custom_domain: true }]);
			report.route = 'added';
			if (parseWranglerConfig(text).workers_dev === undefined) {
				text = setTopLevel(text, 'workers_dev', true);
				report.keptWorkersDev = true;
			}
			ctx.files.writeText(path, text);
		}
		report.notes.push(
			'run `drangler deploy` to attach the route. On a zone in this Cloudflare account, the deploy creates the DNS record and certificate; a hostname that already has a DNS record is refused until that record is deleted. A zone elsewhere needs its DNS moved to Cloudflare first'
		);
		if (report.keptWorkersDev) {
			report.notes.push(
				'`workers_dev: true` was written, because wrangler turns the workers.dev URL off when routes appear and nothing says otherwise'
			);
		}
	}
	return finish(ctx, opts, report);
}

/** Removes a host's mapping and its route. */
export async function runDomainRemove(
	ctx: Context,
	rawHost: string,
	opts: DomainOptions
): Promise<DomainReport> {
	const host = normaliseHost(rawHost);
	const report: DomainReport = {
		host,
		site: null,
		mapped: true,
		route: 'skipped',
		keptWorkersDev: false,
		notes: []
	};
	if (opts.globals.dryRun) {
		report.notes.push(`dry run: would delete ${hostKey(host)} and its route`);
		return finish(ctx, opts, report);
	}
	await wranglerKv(ctx, opts, ['delete', hostKey(host)]);
	report.mapped = false;
	if (opts.local !== true && opts.route !== false) {
		const path = configPath(ctx, opts);
		const text = ctx.files.readText(path);
		const routes = readRoutes(text);
		const kept = routes.filter((r) => r.pattern !== hostOnly(host));
		if (kept.length === routes.length) {
			report.route = 'absent';
		} else {
			ctx.files.writeText(path, setTopLevel(text, 'routes', kept));
			report.route = 'removed';
			report.notes.push(
				'run `drangler deploy` to detach the route; Cloudflare removes the DNS record it created'
			);
		}
	}
	return finish(ctx, opts, report);
}

export interface DomainListing {
	hosts: { host: string; site: string | null; route: boolean }[];
}

/** Every mapped host and every route, joined. */
export async function runDomainList(ctx: Context, opts: DomainOptions): Promise<DomainListing> {
	const listed = JSON.parse(await wranglerKv(ctx, opts, ['list', '--prefix', 'site:host:'])) as {
		name: string;
	}[];
	const routes = readRoutes(ctx.files.readText(configPath(ctx, opts)))
		.map((r) => r.pattern)
		.filter((p): p is string => typeof p === 'string');
	const hosts = new Map<string, { host: string; site: string | null; route: boolean }>();
	for (const { name } of listed) {
		const host = name.slice('site:host:'.length);
		const site = (await wranglerKv(ctx, opts, ['get', name])).trim();
		hosts.set(host, {
			host,
			site: site === '' ? null : site,
			route: routes.includes(hostOnly(host))
		});
	}
	for (const pattern of routes) {
		if (![...hosts.keys()].some((h) => hostOnly(h) === pattern)) {
			hosts.set(pattern, { host: pattern, site: null, route: true });
		}
	}
	const listing = { hosts: [...hosts.values()] };
	emit(ctx.io, opts.globals.json, listing, () =>
		listing.hosts.length === 0
			? ['no hosts are mapped and no routes are configured']
			: table(
					['host', 'site', 'route'],
					listing.hosts.map((h) => [
						h.host,
						h.site ?? '(unmapped)',
						h.route ? 'yes' : 'no'
					])
				)
	);
	return listing;
}

function finish(ctx: Context, opts: DomainOptions, report: DomainReport): DomainReport {
	emit(ctx.io, opts.globals.json, report, () => [
		...kv([
			['host', report.host],
			['site', report.site ?? '-'],
			['mapped', report.mapped ? 'yes' : 'no'],
			['route', report.route]
		]),
		...report.notes.map((n) => `note: ${n}`)
	]);
	return report;
}
