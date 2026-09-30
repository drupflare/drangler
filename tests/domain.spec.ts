import { describe, expect, it } from 'vitest';
import { parseWranglerConfig, setTopLevel } from '../src/cloudflare/config';
import {
	hostKey,
	normaliseHost,
	runDomainAdd,
	runDomainList,
	runDomainRemove
} from '../src/commands/domain';
import { resolveConfig } from '../src/config/file';
import { UsageError } from '../src/errors';
import { scriptedRunner } from '../src/host/exec';
import { memoryFiles } from '../src/host/files';
import { fakeFetch, ok, testContext, testGlobals, WORKSPACE } from './helpers';

const CONFIG = [
	'{',
	'\t"$schema": "node_modules/wrangler/config-schema.json",',
	'\t"name": "drupflare",',
	'\t"vars": { "NOTE": "a } and a [ inside a string, and // not a comment" },',
	'\t"kv_namespaces": [{ "binding": "CONFIG_KV" }]',
	'}',
	''
].join('\n');
const PATH = `${WORKSPACE}/wrangler.jsonc`;
const kvArgs = (...args: string[]) =>
	['bunx wrangler kv key', ...args, '--binding CONFIG_KV -c wrangler.jsonc --remote'].join(' ');

function setup(over: { files?: Record<string, string>; siteName?: string | null } = {}) {
	const files = memoryFiles({ [PATH]: CONFIG, ...over.files });
	const runner = scriptedRunner({
		[kvArgs('put', 'site:host:www.example.org', 'example.org')]: ok(''),
		[kvArgs('delete', 'site:host:www.example.org')]: ok(''),
		[kvArgs('list', '--prefix', 'site:host:')]: ok('[{"name":"site:host:www.example.org"}]'),
		[kvArgs('get', 'site:host:www.example.org')]: ok('example.org\n')
	});
	const fetch = fakeFetch(() =>
		Response.json({ deployment: { primary: 'example.org', chosen: 'first-claim' } })
	);
	const ctx = testContext({ files, runner, fetch });
	const siteName = over.siteName === undefined ? 'example.org' : over.siteName;
	const globals = testGlobals(
		{
			config: resolveConfig(ctx, {
				site: 'https://example.org',
				token: 'owner',
				...(siteName === null ? {} : { siteName })
			})
		},
		ctx
	);
	return { ctx, files, runner, fetch, opts: { workspace: WORKSPACE, globals } };
}

describe('setting one top-level key of a wrangler config', () => {
	it('inserts a missing key and leaves every other line byte-identical', () => {
		const out = setTopLevel(CONFIG, 'routes', [{ pattern: 'a.example', custom_domain: true }]);
		expect(out.split('\n').slice(0, 5)).toEqual([
			...CONFIG.split('\n').slice(0, 4),
			'\t"kv_namespaces": [{ "binding": "CONFIG_KV" }],'
		]);
		expect(parseWranglerConfig(out).routes).toEqual([
			{ pattern: 'a.example', custom_domain: true }
		]);
		expect(parseWranglerConfig(out).vars).toEqual(parseWranglerConfig(CONFIG).vars);
	});

	it('replaces an existing value in place, whatever its position', () => {
		const once = setTopLevel(CONFIG, 'routes', [{ pattern: 'a.example' }]);
		const twice = setTopLevel(once, 'routes', []);
		expect(parseWranglerConfig(twice).routes).toEqual([]);
		expect(setTopLevel(CONFIG, 'name', 'renamed')).toBe(
			CONFIG.replace('"name": "drupflare"', '"name": "renamed"')
		);
	});

	it('handles a trailing comma and a comment', () => {
		const jsonc = '{\n\t// the name\n\t"name": "x",\n}\n';
		const out = setTopLevel(jsonc, 'workers_dev', true);
		expect(parseWranglerConfig(out)).toEqual({ name: 'x', workers_dev: true });
		expect(out.startsWith('{\n\t// the name\n\t"name": "x",')).toBe(true);
	});
});

describe('normalising a host', () => {
	it('keeps a port and drops a scheme and a path', () => {
		expect(normaliseHost('https://WWW.Example.org/x')).toBe('www.example.org');
		expect(normaliseHost('alias.localhost:8787')).toBe('alias.localhost:8787');
	});

	it('refuses what is not a hostname', () => {
		expect(() => normaliseHost('')).toThrow(UsageError);
		expect(() => normaliseHost('a b')).toThrow(UsageError);
	});
});

describe('drangler domain add', () => {
	it('maps the host, adds a Custom Domain route and keeps the workers.dev URL', async () => {
		const { ctx, files, runner, opts } = setup();
		const report = await runDomainAdd(ctx, 'www.example.org', undefined, opts);
		expect(runner.calls.map((c) => [c.file, ...c.args].join(' '))).toEqual([
			kvArgs('put', hostKey('www.example.org'), 'example.org')
		]);
		const config = parseWranglerConfig(files.readText(PATH));
		expect(config.routes).toEqual([{ pattern: 'www.example.org', custom_domain: true }]);
		expect(config.workers_dev).toBe(true);
		expect(report).toMatchObject({ mapped: true, route: 'added', keptWorkersDev: true });

		// a second add finds the route and writes nothing new
		const again = await runDomainAdd(ctx, 'www.example.org', undefined, opts);
		expect(again.route).toBe('present');
		expect(parseWranglerConfig(files.readText(PATH)).routes).toHaveLength(1);
	});

	it('leaves an operator decision about workers_dev alone', async () => {
		const { ctx, files, opts } = setup({
			files: {
				[PATH]: CONFIG.replace(
					'"name": "drupflare",',
					'"name": "drupflare",\n\t"workers_dev": false,'
				)
			}
		});
		const report = await runDomainAdd(ctx, 'www.example.org', undefined, opts);
		expect(report.keptWorkersDev).toBe(false);
		expect(parseWranglerConfig(files.readText(PATH)).workers_dev).toBe(false);
	});

	it('reads the primary site from the deployment when no site is named', async () => {
		const { ctx, fetch, opts } = setup({ siteName: null });
		const report = await runDomainAdd(ctx, 'www.example.org', undefined, opts);
		expect(report.site).toBe('example.org');
		expect(fetch.urls.some((u) => new URL(u).pathname === '/deployment')).toBe(true);
	});

	it('refuses when the deployment has no primary', async () => {
		const { ctx, opts } = setup({ siteName: null });
		ctx.fetch = fakeFetch(() => Response.json({ deployment: { primary: null } }));
		await expect(runDomainAdd(ctx, 'www.example.org', undefined, opts)).rejects.toThrow(
			/no primary site/
		);
	});

	it('writes local KV and no route with --local', async () => {
		const { ctx, files, opts } = setup();
		ctx.runner = scriptedRunner({
			'bunx wrangler kv key put site:host:alias.localhost:8787 example.org --binding CONFIG_KV -c wrangler.jsonc --local --persist-to /tmp/state':
				ok('')
		});
		const report = await runDomainAdd(ctx, 'alias.localhost:8787', undefined, {
			...opts,
			local: true,
			persistTo: '/tmp/state'
		});
		expect(report).toMatchObject({ mapped: true, route: 'skipped' });
		expect(files.readText(PATH)).toBe(CONFIG);
	});

	it('runs nothing on a dry run', async () => {
		const { ctx, files, runner, opts } = setup();
		opts.globals.dryRun = true;
		await runDomainAdd(ctx, 'www.example.org', undefined, opts);
		expect(runner.calls).toEqual([]);
		expect(files.readText(PATH)).toBe(CONFIG);
	});

	it('fails loudly when wrangler cannot write the mapping', async () => {
		const { ctx, opts } = setup();
		ctx.runner = scriptedRunner({});
		await expect(runDomainAdd(ctx, 'www.example.org', undefined, opts)).rejects.toThrow(
			/wrangler kv exited 127/
		);
	});
});

describe('drangler domain remove and list', () => {
	it('deletes the mapping and the route', async () => {
		const { ctx, files, opts } = setup();
		await runDomainAdd(ctx, 'www.example.org', undefined, opts);
		const report = await runDomainRemove(ctx, 'www.example.org', opts);
		expect(report).toMatchObject({ mapped: false, route: 'removed' });
		expect(parseWranglerConfig(files.readText(PATH)).routes).toEqual([]);
	});

	it('joins the mapped hosts with the routes', async () => {
		const { ctx, opts } = setup();
		await runDomainAdd(ctx, 'www.example.org', undefined, opts);
		ctx.files.writeText(
			PATH,
			setTopLevel(ctx.files.readText(PATH), 'routes', [
				{ pattern: 'www.example.org', custom_domain: true },
				{ pattern: 'other.example.org', custom_domain: true }
			])
		);
		const listing = await runDomainList(ctx, opts);
		expect(listing.hosts).toEqual([
			{ host: 'www.example.org', site: 'example.org', route: true },
			{ host: 'other.example.org', site: null, route: true }
		]);
	});
});
