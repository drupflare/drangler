import { describe, expect, it } from 'vitest';
import {
	API_BASE,
	cloudflareApi,
	compareWorkers,
	readEnvelope,
	readWorkersPlan
} from '../src/cloudflare/api';
import { parseWhoami, requireAccount, requireToken, resolveAuth } from '../src/cloudflare/auth';
import {
	checkConfig,
	otherVars,
	parseWranglerConfig,
	PHP_BINARY_ALIAS,
	readLevers,
	stripJsonComments,
	SWEEP_FRACTION_MAX,
	SWEEP_FRACTION_MIN
} from '../src/cloudflare/config';
import { captureCommand, parseTailCapture, summariseCpu } from '../src/cloudflare/tail';
import { runCpu, runWhoami, runWorkers } from '../src/commands/cf';
import {
	resolvePlanFacts,
	runConfigCheck,
	runConfigLevers,
	type ConfigLeversReport
} from '../src/commands/config';
import { checkTools, parseVersion, runDoctor, TOOLS } from '../src/commands/doctor';
import { AuthError, DranglerError, FindingError, UsageError } from '../src/errors';
import { scriptedRunner } from '../src/host/exec';
import { memoryFiles } from '../src/host/files';
import { fail, fakeFetch, ok, testContext } from './helpers';

const WHOAMI = [
	'Getting User settings...',
	'You are logged in with an OAuth Token, associated with the email me@example.com.',
	'┌──────────────┬──────────────────────────────────┐',
	'│ Account Name │ Account ID                       │',
	'├──────────────┼──────────────────────────────────┤',
	'│ Personal     │ 0123456789abcdef0123456789abcdef │',
	'└──────────────┴──────────────────────────────────┘'
].join('\n');

const wrangler = (whoami = WHOAMI) =>
	scriptedRunner({
		'wrangler --version': ok('wrangler 4.20.0'),
		'wrangler whoami': ok(whoami)
	});

describe('parseWhoami', () => {
	it('reads the email and the account table', () => {
		expect(parseWhoami(WHOAMI)).toEqual({
			authenticated: true,
			email: 'me@example.com',
			accounts: [{ id: '0123456789abcdef0123456789abcdef', name: 'Personal' }]
		});
	});

	it('reports a logged-out session', () => {
		expect(parseWhoami('You are not authenticated.').authenticated).toBe(false);
	});

	it('falls back to the id as the name when the row has no other cell', () => {
		expect(
			parseWhoami('me@example.com\n0123456789abcdef0123456789abcdef').accounts[0]?.name
		).toBe('0123456789abcdef0123456789abcdef');
	});
});

describe('resolveAuth', () => {
	it('prefers an API token in the environment, since wrangler does', async () => {
		const runner = wrangler();
		const auth = await resolveAuth(runner, {
			CLOUDFLARE_API_TOKEN: 'tok',
			CLOUDFLARE_ACCOUNT_ID: 'acct'
		});
		expect(auth).toMatchObject({ source: 'api-token', tokenPresent: true, accountId: 'acct' });
		expect(runner.calls.map((c) => c.args[0])).not.toContain('whoami');
	});

	it('asks for an account id when only a token is set', async () => {
		const auth = await resolveAuth(wrangler(), { CF_API_TOKEN: 'tok' });
		expect(auth.remedy).toContain('CLOUDFLARE_ACCOUNT_ID');
	});

	it('falls back to the OAuth login', async () => {
		const auth = await resolveAuth(wrangler(), {});
		expect(auth).toMatchObject({
			source: 'wrangler-oauth',
			email: 'me@example.com',
			accountId: '0123456789abcdef0123456789abcdef',
			wrangler: '4.20.0'
		});
	});

	it('lets the environment override which account the login points at', async () => {
		const auth = await resolveAuth(wrangler(), { CLOUDFLARE_ACCOUNT_ID: 'other' });
		expect(auth.accountId).toBe('other');
	});

	it('reports a logged-out wrangler with the command to run', async () => {
		const auth = await resolveAuth(wrangler('You are not authenticated.'), {});
		expect(auth.source).toBe('none');
		expect(auth.remedy).toBe('run `bunx wrangler login`');
	});

	it('reports wrangler not being installed at all', async () => {
		const auth = await resolveAuth(scriptedRunner({}), {});
		expect(auth.wrangler).toBeNull();
		expect(auth.remedy).toContain('install wrangler');
	});
});

describe('requireToken and requireAccount', () => {
	it('reads either environment spelling', () => {
		expect(requireToken({ CLOUDFLARE_API_TOKEN: 'a' })).toBe('a');
		expect(requireToken({ CF_API_TOKEN: 'b' })).toBe('b');
	});

	it('refuses when the only credential is an OAuth login it cannot read', () => {
		expect(() => requireToken({})).toThrow(AuthError);
	});

	it('prefers an explicit account and refuses when there is none', async () => {
		const auth = await resolveAuth(wrangler(), {});
		expect(requireAccount(auth, 'explicit')).toBe('explicit');
		expect(() => requireAccount({ ...auth, accountId: null }, null)).toThrow(/no account id/);
	});
});

describe('readEnvelope', () => {
	it('reads a successful envelope', async () => {
		const result = await readEnvelope<number[]>(
			new Response(JSON.stringify({ success: true, result: [1] })),
			'x'
		);
		expect(result).toEqual([1]);
	});

	it('treats a 200 with success:false as a failure and quotes the message', async () => {
		await expect(
			readEnvelope(
				new Response(JSON.stringify({ success: false, errors: [{ message: 'nope' }] })),
				'listing workers'
			)
		).rejects.toThrow(/listing workers: nope/);
	});

	it('names an auth failure separately', async () => {
		await expect(readEnvelope(new Response('{}', { status: 403 }), 'x')).rejects.toThrow(
			AuthError
		);
	});

	it('refuses a non-JSON body', async () => {
		await expect(readEnvelope(new Response('<html>', { status: 500 }), 'x')).rejects.toThrow(
			DranglerError
		);
	});

	it('reports a missing result with the status', async () => {
		await expect(readEnvelope(new Response('{}', { status: 500 }), 'x')).rejects.toThrow(
			/HTTP 500/
		);
	});
});

describe('cloudflareApi', () => {
	it('calls the scripts endpoint with the bearer token and sorts the result', async () => {
		const fetch = fakeFetch(
			() =>
				new Response(
					JSON.stringify({
						success: true,
						result: [
							{ id: 'zeta', modified_on: '2026-01-02' },
							{ id: 'alpha', created_on: '2026-01-01' },
							{ nothing: true }
						]
					})
				)
		);
		const workers = await cloudflareApi(fetch, 'tok').listWorkers('acct');
		expect(fetch.urls[0]).toBe(`${API_BASE}/accounts/acct/workers/scripts`);
		expect(workers.map((w) => w.id)).toEqual(['alpha', 'zeta']);
		expect(workers[0]?.modifiedOn).toBeNull();
	});
});

describe('compareWorkers', () => {
	it('reports a matching baseline', () => {
		expect(compareWorkers(['a', 'b'], ['b', 'a'])).toEqual({
			added: [],
			removed: [],
			same: true
		});
	});

	it('names what a teardown left behind and what it took', () => {
		expect(compareWorkers(['a'], ['a', 'cfw-probe'])).toMatchObject({
			added: ['cfw-probe'],
			same: false
		});
		expect(compareWorkers(['a', 'prod'], ['a'])).toMatchObject({
			removed: ['prod'],
			same: false
		});
	});
});

describe('tail captures', () => {
	const events = [
		{ executionModel: 'durableObject', cpuTime: 1398, outcome: 'ok' },
		{ executionModel: 'durableObject', cpuTime: 22 },
		{ executionModel: 'durableObject', cpuTime: 34 },
		{ executionModel: 'stateless', cpuTime: 1 }
	];

	it('reads NDJSON, a JSON array and a single object', () => {
		expect(parseTailCapture(events.map((e) => JSON.stringify(e)).join('\n'))).toHaveLength(4);
		expect(parseTailCapture(JSON.stringify(events))).toHaveLength(4);
		expect(parseTailCapture('{"executionModel":"stateless","cpuTime":1}')).toHaveLength(1);
	});

	it('returns nothing for an empty capture and refuses an unparseable one', () => {
		expect(parseTailCapture('   ')).toEqual([]);
		expect(() => parseTailCapture('not json at all')).toThrow(UsageError);
	});

	it('defaults the model and drops the fields it did not get', () => {
		expect(parseTailCapture('{"cpuTime":"nope"}')[0]).toEqual({
			executionModel: 'unknown',
			cpuTime: null,
			wallTime: null,
			outcome: null,
			scriptName: null
		});
	});

	it('summarises per model with a spread rather than a bare median', () => {
		const report = summariseCpu(parseTailCapture(JSON.stringify(events)));
		expect(report.byModel['durableObject']).toEqual({
			n: 3,
			median: 34,
			min: 22,
			max: 1398,
			spread: 1376
		});
		expect(report.notes.join(' ')).toContain('spans 1376 ms');
		expect(report.usable).toBe(true);
	});

	it('calls a capture with no durableObject event an instrument failure', () => {
		const report = summariseCpu(parseTailCapture('{"executionModel":"stateless","cpuTime":1}'));
		expect(report.instrumentFailure).toBe(true);
		expect(report.usable).toBe(false);
		expect(report.notes.join(' ')).toContain('Workers Observability API');
	});

	it('warns at an n the platform bimodality does not support', () => {
		const report = summariseCpu(
			parseTailCapture('{"executionModel":"durableObject","cpuTime":40}')
		);
		expect(report.notes.join(' ')).toContain('n=1');
	});

	it('says an empty capture is not evidence', () => {
		expect(summariseCpu([]).notes.join(' ')).toContain('not evidence');
	});

	it('averages an even sample', () => {
		expect(
			summariseCpu(
				parseTailCapture(
					'{"executionModel":"a","cpuTime":10}\n{"executionModel":"a","cpuTime":20}'
				)
			).byModel['a']?.median
		).toBe(15);
	});

	it('names the command that produces a parseable capture', () => {
		expect(captureCommand('w')).toContain('--format json');
	});
});

describe('stripJsonComments', () => {
	it('keeps a // inside a string', () => {
		expect(stripJsonComments('{"a":"https://x.dev"}')).toBe('{"a":"https://x.dev"}');
	});

	it('removes line and block comments and the trailing comma they leave', () => {
		expect(stripJsonComments('{\n"a":1, // note\n/* b */\n}')).toContain('"a":1');
		expect(JSON.parse(stripJsonComments('{"a":1, // x\n}'))).toEqual({ a: 1 });
	});

	it('does not stop at an escaped quote', () => {
		expect(JSON.parse(stripJsonComments('{"a":"x\\"//y"}'))).toEqual({ a: 'x"//y' });
	});
});

describe('checkConfig', () => {
	const GOOD = {
		name: 'drupflare',
		main: 'src/site.ts',
		compatibility_date: '2026-08-01',
		compatibility_flags: ['nodejs_compat'],
		durable_objects: { bindings: [{ name: 'SITE', class_name: 'SitePhpDurableObject' }] },
		migrations: [{ tag: 'v1', new_sqlite_classes: ['SitePhpDurableObject'] }],
		assets: { directory: './assets', binding: 'ASSETS' },
		alias: { [PHP_BINARY_ALIAS]: './src/runtime/php-binary-raw.ts' },
		triggers: { crons: ['*/5 * * * *'] }
	};

	it('passes the canonical config', () => {
		expect(checkConfig(GOOD)).toEqual([]);
	});

	it('blocks a config with diagnostics enabled, naming the routes it opens', () => {
		const findings = checkConfig({ ...GOOD, vars: { PW_DIAGNOSTICS: '1' } });
		expect(findings[0]).toMatchObject({ id: 'diagnostics-public', severity: 'blocker' });
		expect(findings[0]?.detail).toContain('/restore');
		expect(findings[0]?.detail).toContain('/sql');
	});

	/**
	 * `/firstrun` is in `PUBLIC_ROUTES` and `/export` is in `OWNER_ROUTES`.
	 *
	 * The finding named both as things the flag exposes. It stayed a correct blocker with two stale
	 * details, which is the shape that survives review: the verdict is right and the reason a user
	 * acts on is wrong.
	 */
	it('does not name the public route or the owner route as things the flag opens', () => {
		const detail =
			checkConfig({ ...GOOD, vars: { PW_DIAGNOSTICS: '1' } })[0]?.detail.split(';')[0] ?? '';
		expect(detail).not.toContain('/firstrun');
		expect(detail).not.toContain('/export');
	});

	it('blocks a Durable Object migrated without SQLite', () => {
		const findings = checkConfig({
			...GOOD,
			migrations: [{ tag: 'v1', new_classes: ['SitePhpDurableObject'] }]
		});
		expect(findings.map((f) => f.id)).toContain('do-not-sqlite');
	});

	it('warns about an unmigrated class and a missing binding', () => {
		expect(checkConfig({ ...GOOD, migrations: [] }).map((f) => f.id)).toContain(
			'do-unmigrated'
		);
		expect(
			checkConfig({ ...GOOD, durable_objects: { bindings: [] } }).map((f) => f.id)
		).toContain('do-binding');
	});

	// the overshoot it used to quote was against the 3 MiB gzipped ceiling Cloudflare deleted
	it('warns when the interpreter alias is missing, without quoting a dead ceiling', () => {
		const findings = checkConfig({ ...GOOD, alias: {} });
		expect(findings[0]).toMatchObject({ id: 'interpreter-alias', severity: 'warning' });
		expect(findings[0]?.detail).toContain('fallback interpreter');
		expect(findings[0]?.detail).not.toMatch(/\d{1,3}(,\d{3})+/);
	});

	it('warns about missing assets, flags, date, main and cron', () => {
		const ids = checkConfig({ main: 'src/site.ts' }).map((f) => f.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				'compatibility-date',
				'nodejs-compat',
				'do-binding',
				'assets',
				'cron'
			])
		);
		expect(checkConfig({}).map((f) => f.id)).toContain('main');
	});
});

describe('readWorkersPlan', () => {
	it('reads a paid entitlement from the rate plan name', () => {
		expect(
			readWorkersPlan([{ rate_plan: { id: 'workers_paid', public_name: 'Workers Paid' } }])
		).toEqual({ plan: 'paid', evidence: ['workers_paid Workers Paid'] });
	});

	it('reads a free entitlement when a Workers plan is present but not paid', () => {
		expect(readWorkersPlan([{ rate_plan: { id: 'workers_free' } }]).plan).toBe('free');
	});

	it('returns unknown rather than guessing free when no Workers plan is listed', () => {
		expect(
			readWorkersPlan([{ rate_plan: { id: 'cf_free', public_name: 'Free Website' } }])
		).toEqual({ plan: 'unknown', evidence: [] });
		expect(readWorkersPlan([]).plan).toBe('unknown');
		expect(readWorkersPlan([{}]).plan).toBe('unknown');
	});

	it('ignores the non-Workers products around it', () => {
		expect(
			readWorkersPlan([
				{ rate_plan: { public_name: 'Enterprise Website' } },
				{ rate_plan: { public_name: 'Workers Bundled' } }
			])
		).toMatchObject({ plan: 'paid', evidence: ['Workers Bundled'] });
	});

	it('reads the plan over the API', async () => {
		const fetch = fakeFetch(
			() =>
				new Response(
					JSON.stringify({
						success: true,
						result: [{ rate_plan: { id: 'workers_paid' } }]
					})
				)
		);
		expect(await cloudflareApi(fetch, 'tok').workersPlan('acct')).toMatchObject({
			plan: 'paid'
		});
		expect(fetch.urls[0]).toBe(`${API_BASE}/accounts/acct/subscriptions`);
	});
});

describe('the PLAN var against the account', () => {
	const base = { main: 'src/index.ts', compatibility_date: '2026-08-01' };
	const planOf = (config: object, facts: object) =>
		checkConfig(config, facts).find((f) => f.id.startsWith('plan'));

	it('is not evaluated at all when the plan was not resolved', () => {
		expect(planOf({ ...base, vars: { PLAN: 'free' } }, {})).toBeUndefined();
	});

	it('passes when the var matches the account', () => {
		expect(
			planOf({ ...base, vars: { PLAN: 'paid' } }, { workersPlan: 'paid' })
		).toBeUndefined();
		expect(
			planOf({ ...base, vars: { PLAN: 'FREE' } }, { workersPlan: 'free' })
		).toBeUndefined();
	});

	it('warns when a free config runs on a paid account', () => {
		const finding = planOf({ ...base, vars: { PLAN: 'free' } }, { workersPlan: 'paid' });
		expect(finding).toMatchObject({ id: 'plan-mismatch', severity: 'warning' });
		expect(finding?.detail).toContain('KV page tier');
	});

	it('warns when a paid config runs on a free account, naming the quotas', () => {
		const finding = planOf({ ...base, vars: { PLAN: 'paid' } }, { workersPlan: 'free' });
		expect(finding?.detail).toContain('rows-written');
	});

	it('warns when PLAN is unset entirely', () => {
		expect(planOf(base, { workersPlan: 'paid' })).toMatchObject({ id: 'plan-unset' });
	});

	it('reports an unreadable plan as a note, never as a pass', () => {
		expect(
			planOf({ ...base, vars: { PLAN: 'free' } }, { workersPlan: 'unknown' })
		).toMatchObject({
			id: 'plan-unknown',
			severity: 'note'
		});
	});
});

describe('resolvePlanFacts', () => {
	it('takes an explicit --plan without touching the network', async () => {
		const ctx = testContext();
		expect(await resolvePlanFacts(ctx, { plan: 'paid' })).toEqual({
			facts: { workersPlan: 'paid' },
			source: '--plan'
		});
	});

	it('refuses a --plan outside the set', async () => {
		await expect(resolvePlanFacts(testContext(), { plan: 'enterprise' })).rejects.toThrow(
			UsageError
		);
	});

	it('leaves the plan unresolved when there is no token', async () => {
		const resolved = await resolvePlanFacts(testContext(), {});
		expect(resolved.facts).toEqual({});
		expect(resolved.source).toContain('no CLOUDFLARE_API_TOKEN');
	});

	it('looks the plan up when a token is present', async () => {
		const ctx = testContext({
			runner: wrangler(),
			env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct' },
			fetch: fakeFetch(
				() =>
					new Response(
						JSON.stringify({
							success: true,
							result: [{ rate_plan: { id: 'workers_paid' } }]
						})
					)
			)
		});
		const resolved = await resolvePlanFacts(ctx, {});
		expect(resolved.facts).toEqual({ workersPlan: 'paid' });
		expect(resolved.source).toContain('workers_paid');
	});
});

describe('parseWranglerConfig', () => {
	it('reads jsonc', () => {
		expect(parseWranglerConfig('{ // a\n"name":"x"\n}').name).toBe('x');
	});

	it('refuses a document that is not an object', () => {
		expect(() => parseWranglerConfig('[]')).toThrow(UsageError);
		expect(() => parseWranglerConfig('{')).toThrow(UsageError);
	});
});

describe('parseVersion', () => {
	it('reads a version from either stream', () => {
		expect(parseVersion('git version 2.39.5', '')).toBe('2.39.5');
		expect(parseVersion('', 'OpenSSH_9.8p1, LibreSSL 3.3.6')).toBe('9.8p1');
	});

	it('returns null when there is no version at all', () => {
		expect(parseVersion('', '')).toBeNull();
	});
});

describe('checkTools', () => {
	it('reports each tool with the command that needs it', async () => {
		const runner = scriptedRunner({
			'ssh -V': { code: 0, stdout: '', stderr: 'OpenSSH_9.8p1' }
		});
		const tools = await checkTools(runner);
		expect(tools).toHaveLength(TOOLS.length);
		expect(tools[0]).toMatchObject({ name: 'ssh', present: true, version: '9.8p1' });
		expect(tools[1]).toMatchObject({ name: 'git', present: false, version: null });
	});

	/**
	 * A preflight may only DEMAND what most of the surface runs.
	 *
	 * `git` is back and is optional: `build` clones the worker and `modify release` reads a tag and
	 * refuses a dirty tree, so it is a real dependency of two commands and of no others. Requiring
	 * it would fail the command someone runs when they are already confused, on a machine where
	 * everything else works.
	 */
	it('requires only what half the surface needs, and marks the rest optional', async () => {
		for (const tool of TOOLS) {
			if (!tool.required) continue;
			expect(['ssh', 'wrangler']).toContain(tool.name);
		}
		const git = TOOLS.find((t) => t.name === 'git');
		expect(git).toMatchObject({ required: false });
		expect(git?.usedBy).toContain('modify release');
	});
});

describe('cf commands', () => {
	it('whoami reports the resolved credential', async () => {
		const ctx = testContext({ runner: wrangler() });
		await runWhoami(ctx, {});
		expect(ctx.io.text()).toContain('me@example.com');
	});

	it('whoami exits with a finding when logged out', async () => {
		const ctx = testContext({ runner: wrangler('You are not authenticated.') });
		await expect(runWhoami(ctx, {})).rejects.toThrow(FindingError);
		expect(ctx.io.text()).toContain('wrangler login');
	});

	it('whoami lists several accounts', async () => {
		const two = `${WHOAMI}\n│ Work │ ffffffffffffffffffffffffffffffff │`;
		const ctx = testContext({ runner: wrangler(two) });
		await runWhoami(ctx, {});
		expect(ctx.io.text()).toContain('Work');
	});

	it('workers lists and saves a baseline', async () => {
		const files = memoryFiles({});
		const ctx = testContext({
			runner: wrangler(),
			env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct' },
			files,
			fetch: fakeFetch(
				() => new Response(JSON.stringify({ success: true, result: [{ id: 'prod' }] }))
			)
		});
		await runWorkers(ctx, { save: '/baseline.json' });
		expect(JSON.parse(files.written.get('/baseline.json') as string).workers).toEqual(['prod']);
		expect(ctx.io.text()).toContain('1 worker(s)');
	});

	it('workers exits with a finding when the baseline no longer matches', async () => {
		const ctx = testContext({
			runner: wrangler(),
			env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct' },
			files: memoryFiles({ '/baseline.json': JSON.stringify({ workers: ['prod'] }) }),
			fetch: fakeFetch(
				() =>
					new Response(
						JSON.stringify({
							success: true,
							result: [{ id: 'prod' }, { id: 'cfw-probe' }]
						})
					)
			)
		});
		await expect(runWorkers(ctx, { compare: '/baseline.json' })).rejects.toThrow(/1 added/);
		expect(ctx.io.text()).toContain('baseline DIFFERS');
	});

	it('workers accepts a bare array as a baseline and refuses anything else', async () => {
		const base = {
			runner: wrangler(),
			env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct' },
			fetch: fakeFetch(
				() => new Response(JSON.stringify({ success: true, result: [{ id: 'prod' }] }))
			)
		};
		const good = testContext({ ...base, files: memoryFiles({ '/b.json': '["prod"]' }) });
		await expect(runWorkers(good, { compare: '/b.json' })).resolves.toBeUndefined();

		const bad = testContext({ ...base, files: memoryFiles({ '/b.json': '{"a":1}' }) });
		await expect(runWorkers(bad, { compare: '/b.json' })).rejects.toThrow(/no `workers` array/);

		const missing = testContext({ ...base, files: memoryFiles({}) });
		await expect(runWorkers(missing, { compare: '/b.json' })).rejects.toThrow(/no baseline/);

		const broken = testContext({ ...base, files: memoryFiles({ '/b.json': '{' }) });
		await expect(runWorkers(broken, { compare: '/b.json' })).rejects.toThrow(/not a baseline/);
	});

	it('workers refuses without a token', async () => {
		const ctx = testContext({ runner: wrangler() });
		await expect(runWorkers(ctx, {})).rejects.toThrow(AuthError);
	});

	it('cpu summarises a capture', async () => {
		const ctx = testContext({
			files: memoryFiles({
				'/tail.json':
					'{"executionModel":"durableObject","cpuTime":22}\n{"executionModel":"stateless","cpuTime":1}'
			})
		});
		await runCpu(ctx, '/tail.json', {});
		expect(ctx.io.text()).toContain('durableObject');
	});

	it('cpu refuses a capture with no durableObject events', async () => {
		const ctx = testContext({
			files: memoryFiles({ '/tail.json': '{"executionModel":"stateless","cpuTime":1}' })
		});
		await expect(runCpu(ctx, '/tail.json', {})).rejects.toThrow(/instrument failure/);
	});

	it('cpu names the capture command when the file is absent', async () => {
		await expect(runCpu(testContext(), '/none.json', {})).rejects.toThrow(/wrangler tail/);
	});
});

describe('config check command', () => {
	it('passes a good config', async () => {
		const ctx = testContext({
			files: memoryFiles({
				'/wrangler.jsonc': JSON.stringify({
					name: 'x',
					main: 'src/index.ts',
					compatibility_date: '2026-08-01',
					compatibility_flags: ['nodejs_compat'],
					durable_objects: { bindings: [{ class_name: 'C' }] },
					migrations: [{ new_sqlite_classes: ['C'] }],
					triggers: { crons: ['* * * * *'] }
				})
			})
		});
		await expect(runConfigCheck(ctx, '/wrangler.jsonc', {})).resolves.toBeUndefined();
		expect(ctx.io.text()).toContain('blockers');
	});

	it('exits with a finding on a blocker', async () => {
		const ctx = testContext({
			files: memoryFiles({
				'/wrangler.jsonc': '{"main":"src/site.ts","vars":{"PW_DIAGNOSTICS":"1"}}'
			})
		});
		await expect(runConfigCheck(ctx, '/wrangler.jsonc', {})).rejects.toThrow(FindingError);
		expect(ctx.io.text()).toContain('diagnostics-public');
	});

	it('refuses a file that is not there', async () => {
		await expect(runConfigCheck(testContext(), '/none', {})).rejects.toThrow(UsageError);
	});

	/**
	 * `FILES_PUBLIC_URL` is an option and never a requirement.
	 *
	 * A warning for an absent one would turn an opt-in into something a deployer has to justify not
	 * taking; serving every file through the Worker is correct and costs one request each.
	 */
	it('says nothing about an unset FILES_PUBLIC_URL', async () => {
		const ctx = testContext({
			files: memoryFiles({
				'/wrangler.jsonc': JSON.stringify({
					name: 'x',
					main: 'src/index.ts',
					compatibility_date: '2026-08-01',
					compatibility_flags: ['nodejs_compat'],
					durable_objects: { bindings: [{ class_name: 'C' }] },
					migrations: [{ new_sqlite_classes: ['C'] }],
					triggers: { crons: ['* * * * *'] }
				})
			})
		});
		await runConfigCheck(ctx, '/wrangler.jsonc', {});
		expect(ctx.io.text()).not.toContain('FILES_PUBLIC_URL');
	});
});

describe('readLevers', () => {
	const levers = (vars: Record<string, unknown>) =>
		Object.fromEntries(readLevers({ vars }).map((l) => [l.name, l]));

	it('reports what the site does without a lever, rather than a blank', () => {
		const read = levers({});
		expect(read['FILES_PUBLIC_URL']?.value).toBeNull();
		expect(read['FILES_PUBLIC_URL']?.state).toContain('one Worker request each');
		expect(read['SWEEP']?.state).toContain('demand-driven');
	});

	/**
	 * `ASSET_AGGREGATES` shipped as a no-op and the reading has to be the real state.
	 *
	 * `assets/.assetsignore` never allowed `/agg/`, so the substitution rewrote every asset tag to a
	 * URL the asset layer did not publish and the page rendered with no CSS. What decides the state
	 * is the value and the artifact, so a value that is not `1` reads as off with its own value shown.
	 */
	it('reads ASSET_AGGREGATES as on only at 1, and names the build step it needs', () => {
		expect(levers({ ASSET_AGGREGATES: '1' })['ASSET_AGGREGATES']?.state).toContain(
			'assets:agg'
		);
		expect(levers({ ASSET_AGGREGATES: 'true' })['ASSET_AGGREGATES']?.state).toContain('off');
		expect(levers({ ASSET_AGGREGATES: '0' })['ASSET_AGGREGATES']?.state).toContain('off');
	});

	it('reads SWEEP off at 0 and on at anything else', () => {
		expect(levers({ SWEEP: '0' })['SWEEP']?.state).toContain('off');
		expect(levers({ SWEEP: '1' })['SWEEP']?.state).toBe('on');
	});

	// the site clamps rather than refusing, so a declared 5 is not the share it will spend
	it('says where SWEEP_ROWS_FRACTION lands after the site clamps it', () => {
		const read = levers({ SWEEP_ROWS_FRACTION: '5' })['SWEEP_ROWS_FRACTION'];
		expect(read?.state).toContain(`clamped down to ${SWEEP_FRACTION_MAX}`);
		expect(levers({ SWEEP_ROWS_FRACTION: '0.001' })['SWEEP_ROWS_FRACTION']?.state).toContain(
			`clamped up to ${SWEEP_FRACTION_MIN}`
		);
		expect(levers({ SWEEP_ROWS_FRACTION: '0.4' })['SWEEP_ROWS_FRACTION']?.state).toContain(
			'0.4 of each daily meter'
		);
	});

	it('echoes every other var and reports a credential-shaped one as set', () => {
		const other = otherVars({ vars: { PLAN: 'free', SMTP_PASS: 'hunter2', SWEEP: '1' } });
		expect(other).toEqual([
			{ name: 'PLAN', value: 'free' },
			{ name: 'SMTP_PASS', value: 'set' }
		]);
	});
});

describe('config levers command', () => {
	const withVars = (vars: Record<string, unknown>) =>
		memoryFiles({ '/wrangler.jsonc': JSON.stringify({ name: 'x', vars }) });

	it('lists every lever with its state and prints no finding for an unset one', async () => {
		const ctx = testContext({ files: withVars({}) });
		await runConfigLevers(ctx, '/wrangler.jsonc', { json: true });
		const report = ctx.io.json<ConfigLeversReport>();
		expect(report.levers.map((l) => l.name)).toEqual([
			'FILES_PUBLIC_URL',
			'ASSET_AGGREGATES',
			'SWEEP',
			'SWEEP_ROWS_FRACTION'
		]);
		expect(report.levers.every((l) => l.value === null)).toBe(true);
		expect(report.filesOrigin).toBeNull();
		expect(report.notes).toEqual([]);
	});

	it('probes the configured origin under --check and counts any status as an answer', async () => {
		const fetch = fakeFetch(() => new Response('', { status: 404 }));
		const ctx = testContext({ files: withVars({ FILES_PUBLIC_URL: 'files.example' }), fetch });
		await runConfigLevers(ctx, '/wrangler.jsonc', { json: true, check: true });

		expect(fetch.urls).toEqual(['https://files.example']);
		expect(ctx.io.json<ConfigLeversReport>().filesOrigin).toMatchObject({
			answered: true,
			status: 404
		});
	});

	it('reports an origin that does not answer without failing the command', async () => {
		const fetch = fakeFetch(() => {
			throw new Error('getaddrinfo ENOTFOUND files.example');
		});
		const ctx = testContext({
			files: withVars({ FILES_PUBLIC_URL: 'https://files.example' }),
			fetch
		});
		await expect(
			runConfigLevers(ctx, '/wrangler.jsonc', { json: true, check: true })
		).resolves.toBeUndefined();

		const report = ctx.io.json<ConfigLeversReport>();
		expect(report.filesOrigin).toMatchObject({ answered: false, status: null });
		expect(report.notes.join(' ')).toContain('keeps its Worker URL either way');
	});

	it('says there is nothing to check when no origin is configured', async () => {
		const ctx = testContext({ files: withVars({}) });
		await runConfigLevers(ctx, '/wrangler.jsonc', { json: true, check: true });
		expect(ctx.io.json<ConfigLeversReport>().notes.join(' ')).toContain('no FILES_PUBLIC_URL');
	});

	// on with no manifest is inert: no library matches and the page keeps the tags Drupal emitted
	it('notes an ASSET_AGGREGATES that is on with no aggregates built beside the assets', async () => {
		const on = JSON.stringify({
			name: 'x',
			assets: { directory: './assets' },
			vars: { ASSET_AGGREGATES: '1' }
		});
		const missing = testContext({ files: memoryFiles({ '/ws/wrangler.jsonc': on }) });
		await runConfigLevers(missing, '/ws/wrangler.jsonc', { json: true });
		expect(missing.io.json<ConfigLeversReport>().notes.join(' ')).toContain(
			'agg/manifest.json'
		);

		const built = testContext({
			files: memoryFiles({
				'/ws/wrangler.jsonc': on,
				'/ws/assets/agg/manifest.json': '{}'
			})
		});
		await runConfigLevers(built, '/ws/wrangler.jsonc', { json: true });
		expect(built.io.json<ConfigLeversReport>().notes).toEqual([]);
	});

	it('renders a table and refuses a file that is not there', async () => {
		const ctx = testContext({ files: withVars({ SWEEP: '1' }) });
		await runConfigLevers(ctx, '/wrangler.jsonc', {});
		expect(ctx.io.text()).toContain('SWEEP');
		await expect(runConfigLevers(testContext(), '/none', {})).rejects.toThrow(UsageError);
	});
});

describe('doctor command', () => {
	it('reports the tools and the credential', async () => {
		const ctx = testContext({
			runner: scriptedRunner({
				'ssh -V': { code: 0, stdout: '', stderr: 'OpenSSH_9.8p1' },
				'wrangler --version': ok('wrangler 4.20.0'),
				'wrangler whoami': ok(WHOAMI),
				'bun --version': ok('1.3.14'),
				'rsync --version': ok('rsync  version 3.2.7')
			})
		});
		await runDoctor(ctx, {});
		expect(ctx.io.text()).toContain('wrangler-oauth as me@example.com');
		expect(ctx.io.text()).toContain('ssh');
	});

	it('exits with a finding and prints how to install a missing required tool', async () => {
		const ctx = testContext({ runner: scriptedRunner({ 'bun --version': ok('1.3.14') }) });
		await expect(runDoctor(ctx, {})).rejects.toThrow(FindingError);
		expect(ctx.io.text()).toContain('openssh-client');
	});

	/**
	 * The command someone runs when they are already confused must pass on their machine.
	 *
	 * It used to fold in a scan for a drupflare SOURCE workspace, so a user who had merely deployed
	 * a site -- which is everyone except a drupflare maintainer -- got a failure line from the
	 * health check itself.
	 */
	it('passes on a machine that has never held a drupflare checkout', async () => {
		const ctx = testContext({
			runner: scriptedRunner({
				'ssh -V': ok('OpenSSH_9'),
				'wrangler --version': ok('wrangler 4'),
				'wrangler whoami': fail(1)
			}),
			// nothing on disk at all
			files: memoryFiles({}),
			cwd: '/home/someone'
		});
		await runDoctor(ctx, { json: true });
		const report = ctx.io.json<{ missing: string[]; tools: unknown[] }>();
		expect(report.missing).toEqual([]);
		expect(report.tools.length).toBeGreaterThan(0);
		expect(JSON.stringify(report)).not.toContain('workspace');
	});
});
