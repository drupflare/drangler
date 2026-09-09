import { describe, expect, it } from 'vitest';
import { runDoctor } from '../src/commands/doctor';
import { resolveConfig } from '../src/config/file';
import { EXIT, FindingError } from '../src/errors';
import type { FetchLike } from '../src/health/probe';
import { scriptedRunner, type CommandResult } from '../src/host/exec';
import { memoryFiles } from '../src/host/files';
import { surveyPlan } from '../src/migrate/survey';
import { run } from '../src/run';
import { ok, testContext, type TestContext } from './helpers';

const ORIGIN = 'https://mysite.example';
const TOKEN = 'tok-owner-1';
const HOST = 'me@old.example';
const ROOT = '/var/www/html';

const PLAN = surveyPlan(ROOT);
const step = (id: string) => PLAN.find((s) => s.id === id)?.command as string;

/** the tools half always runs, so every case scripts it */
const TOOLS: Record<string, CommandResult> = {
	'ssh -V': { code: 0, stdout: '', stderr: 'OpenSSH_9.8p1' },
	'git --version': ok('git version 2.39.5'),
	'wrangler --version': ok('wrangler 4.20.0'),
	'wrangler whoami': ok('me@example.com\n0123456789abcdef0123456789abcdef'),
	'bun --version': ok('1.4.0'),
	'rsync --version': ok('rsync  version 3.2.7')
};

/** every survey step, through ssh, the way `doctor --source` issues them */
function ssh(over: Record<string, CommandResult> = {}): Record<string, CommandResult> {
	const healthy: Record<string, CommandResult> = {
		'php-version': ok('PHP 8.2.15 (cli) (built: Jan 1 2026)'),
		'php-modules': ok('[PHP Modules]\ncurl\npdo_mysql'),
		'drush-version': ok('Drush Commandline Tool 12.5.1'),
		'drush-status': ok(
			JSON.stringify({
				'drupal-version': '10.3.1',
				'db-driver': 'mysql',
				'db-name': 'drupal',
				root: ROOT
			})
		),
		modules: ok(JSON.stringify({ node: {} })),
		'files-kb': ok('40960\t/var/www/html/sites/default/files'),
		'files-count': ok('   1200\n'),
		'db-bytes': ok('SUM\n1048576'),
		'db-alive': ok('1\n1'),
		'file-rows': ok('COUNT(*)\n1200'),
		nodes: ok('COUNT(*)\n20'),
		'image-styles': ok('COUNT(*)\n6')
	};
	const script: Record<string, CommandResult> = { ...TOOLS };
	const prefix = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new';
	for (const [id, result] of Object.entries({ ...healthy, ...over })) {
		script[`${prefix} ${HOST} ${step(id)}`] = result;
	}
	return script;
}

function ctxFor(script: Record<string, CommandResult>, fetch?: FetchLike): TestContext {
	return testContext({
		runner: scriptedRunner(script),
		files: memoryFiles({}),
		env: {},
		...(fetch === undefined ? {} : { fetch })
	});
}

describe('bare doctor is unchanged', () => {
	it('looks at nothing on disk and nothing on the network beyond wrangler', async () => {
		const ctx = ctxFor(TOOLS);
		await runDoctor(ctx, { json: true, config: resolveConfig(ctx) });
		const report = ctx.io.json<{ source: unknown; site: unknown; tools: unknown[] }>();
		expect(report.source).toBeNull();
		expect(report.site).toBeNull();
		expect(report.tools).toHaveLength(5);
	});

	it('reports which file supplied each setting', async () => {
		const ctx = ctxFor(TOOLS);
		await runDoctor(ctx, { config: resolveConfig(ctx, { site: ORIGIN }) });
		expect(ctx.io.text()).toContain('https://mysite.example (flag --site)');
		// the value never appears; a preflight that echoed a credential puts it in a scrollback
		expect(ctx.io.text()).toMatch(/owner token\s+not set/);
	});
});

describe('doctor --source', () => {
	it('says nothing is wrong with a source a survey can read', async () => {
		const ctx = ctxFor(ssh());
		await runDoctor(ctx, { source: HOST, root: ROOT, config: resolveConfig(ctx) });
		expect(ctx.io.text()).toContain('nothing wrong with the source');
	});

	it('exits 3 and names the evidence when php is dead', async () => {
		const ctx = ctxFor(
			ssh({ 'php-version': { code: 127, stdout: '', stderr: 'php: command not found' } })
		);
		const failure = (await runDoctor(ctx, {
			source: HOST,
			root: ROOT,
			config: resolveConfig(ctx)
		}).then(
			() => null,
			(e: unknown) => e as FindingError
		)) as FindingError;
		expect(failure.code).toBe('source-broken');
		expect(failure.exitCode).toBe(EXIT.FINDING);
		expect(ctx.io.text()).toContain('source.php-dead');
		expect(ctx.io.text()).toContain('evidence: survey.errors[php-version]');
	});

	it('reports a database that refuses a connection separately from one with no driver', async () => {
		const ctx = ctxFor(ssh({ 'db-alive': { code: 1, stdout: '', stderr: 'Access denied' } }));
		await expect(
			runDoctor(ctx, { source: HOST, root: ROOT, config: resolveConfig(ctx) })
		).rejects.toBeInstanceOf(FindingError);
		expect(ctx.io.text()).toContain('source.db-unreadable');
		expect(ctx.io.text()).toContain('SELECT 1');
	});

	it('names a root drush did not bootstrap', async () => {
		const ctx = ctxFor(
			ssh({
				'drush-status': ok(
					JSON.stringify({
						'drupal-version': '10.3.1',
						'db-driver': 'mysql',
						root: '/var/www/other'
					})
				)
			})
		);
		await expect(
			runDoctor(ctx, { source: HOST, root: ROOT, config: resolveConfig(ctx) })
		).rejects.toBeInstanceOf(FindingError);
		expect(ctx.io.text()).toContain('source.root-wrong');
	});
});

describe('doctor --site', () => {
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});

	const siteFetch = (over: Record<string, unknown> = {}): FetchLike =>
		(async (input: unknown) => {
			const url = new URL(String(input));
			if (url.pathname === '/serve') {
				return new Response('<html></html>', {
					headers: {
						'x-cfw-cache': 'MISS',
						'x-cfw-generation': '41',
						...((over.headers as object) ?? {})
					}
				});
			}
			if (url.pathname === '/firstrun') {
				return json({ ok: true, configured: over.claimed !== false, firstRunAt: 1 });
			}
			const body = over[url.pathname];
			if (body === undefined) return json({ ok: false }, 404);
			return json(body);
		}) as unknown as FetchLike;

	it('reads every owner route and reports the version that answered', async () => {
		const ctx = ctxFor(
			TOOLS,
			siteFetch({
				'/health': {
					repair: { rung: 'observe', code: null, strikes: 0, quarantinedAt: null },
					quarantined: false,
					rollback: { rollback: false, reason: 'not quarantined' },
					version: { id: '8c31f0a2', tag: 'v37', timestamp: '2026-09-07T22:10:04Z' },
					lastFindings: [],
					ledger: []
				},
				'/updb': { run: { phase: 'complete', cursorSeq: 9 } },
				'/replica': { stage: 'SERVING', lanes: 2 },
				'/git': { remotes: [] },
				'/modify': { packages: [] }
			})
		);
		await runDoctor(ctx, {
			site: ORIGIN,
			token: TOKEN,
			workspace: '/ws',
			config: resolveConfig(ctx)
		});
		expect(ctx.io.text()).toMatch(/worker version\s+8c31f0a2 \(v37\)/);
		expect(ctx.io.text()).toMatch(/generation\s+41/);
	});

	/** an owner route that did not answer is a check that did not run, never one that passed */
	it('reports an unreachable route as not checked rather than as clean', async () => {
		const ctx = ctxFor(TOOLS, siteFetch());
		await runDoctor(ctx, { site: ORIGIN, token: TOKEN, config: resolveConfig(ctx) });
		const said = ctx.io.text();
		expect(said).toContain('not checked');
		expect(said).toContain('site.quarantined');
		expect(said).toContain('/health did not answer');
		expect(said).toContain('site.container-cid-stale');
		expect(said).toContain('--workspace; the check compares');
	});

	it('exits 3 on a quarantined site and names the command that clears it', async () => {
		const ctx = ctxFor(
			TOOLS,
			siteFetch({
				'/health': {
					repair: {
						rung: 'quarantine',
						code: 'bridge.asyncify_called',
						strikes: 3,
						quarantinedAt: 1
					},
					quarantined: true,
					rollback: { rollback: false, reason: 'waiting for the dwell' },
					lastFindings: [],
					ledger: []
				}
			})
		);
		const failure = (await runDoctor(ctx, {
			site: ORIGIN,
			token: TOKEN,
			config: resolveConfig(ctx)
		}).then(
			() => null,
			(e: unknown) => e as FindingError
		)) as FindingError;
		expect(failure.code).toBe('site-broken');
		expect(failure.next).toContain('--release --yes');
		expect(ctx.io.text()).toContain('site.quarantined');
	});

	it('scores a site with no token at all, reporting every owner route as not checked', async () => {
		const ctx = ctxFor(TOOLS, siteFetch());
		await runDoctor(ctx, { site: ORIGIN, config: resolveConfig(ctx) });
		expect(ctx.io.text()).toContain('/updb did not answer');
	});
});

describe('the parser', () => {
	it('takes --source and --root off the command line', async () => {
		const ctx = ctxFor(ssh());
		expect(await run(ctx, ['doctor', '--source', HOST, '--root', ROOT])).toBe(EXIT.OK);
		expect(ctx.io.text()).toContain('nothing wrong with the source');
	});

	it('scores the site the config names, with no flag at all', async () => {
		const ctx = ctxFor(TOOLS, (async (input: unknown) => {
			const url = new URL(String(input));
			if (url.pathname === '/serve') {
				return new Response('<html></html>', { headers: { 'x-cfw-cache': 'MISS' } });
			}
			return new Response(JSON.stringify({ ok: true, configured: true }), {
				headers: { 'content-type': 'application/json' }
			});
		}) as unknown as FetchLike);
		expect(await run(ctx, ['doctor', '--site', ORIGIN])).toBe(EXIT.OK);
		expect(ctx.io.text()).toContain(ORIGIN);
	});
});
