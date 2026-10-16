import { describe, expect, it } from 'vitest';
import { deployDuplicate, leaveFleet, splitDeployValues } from '../src/commands/preview-deploy';
import { DranglerError, UsageError } from '../src/errors';
import { scriptedRunner } from '../src/host/exec';
import { memoryFiles } from '../src/host/files';
import { fakeFetch, ok, testContext, testGlobals } from './helpers';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const NAME = 'drupflare-preview-earth-app-c49dd78f';
const ORIGIN = `https://${NAME}.me.workers.dev`;
const WHOAMI = [
	'You are logged in with an OAuth Token, associated with the email me@example.com.',
	`│ Personal     │ ${ACCOUNT} │`
].join('\n');

const envelope = (result: unknown) =>
	new Response(JSON.stringify({ success: true, errors: [], result }), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});

/** one fetch for both the Cloudflare API and the preview address, recording what each saw */
function world(guardedAfter: number, scriptExists = false) {
	const log: string[] = [];
	let unguarded = 0;
	const fetch = fakeFetch((url, init) => {
		const u = String(url);
		const method = (init as { method?: string } | undefined)?.method ?? 'GET';
		if (u.startsWith('https://api.cloudflare.com')) {
			const path = u.replace('https://api.cloudflare.com/client/v4', '');
			log.push(`${method} ${path.replace(ACCOUNT, '<acct>')}`);
			if (path.endsWith('/workers/subdomain')) return envelope({ subdomain: 'me' });
			if (path.endsWith('/settings')) {
				return scriptExists
					? envelope({})
					: new Response(
							JSON.stringify({
								success: false,
								errors: [{ code: 10007, message: 'not found' }]
							}),
							{ status: 404, headers: { 'content-type': 'application/json' } }
						);
			}
			if (path.endsWith('/access/apps') && method === 'GET') return envelope([]);
			if (path.endsWith('/service_tokens'))
				return envelope({ id: 'tok', client_id: 'cid', client_secret: 'sec' });
			if (path.endsWith('/policies')) return envelope({ id: 'pol' });
			if (path.endsWith('/access/apps')) return envelope({ id: 'app' });
		}
		log.push(`origin ${method}`);
		unguarded += 1;
		return unguarded > guardedAfter
			? new Response(null, {
					status: 302,
					headers: { location: 'https://me.cloudflareaccess.com/login' }
				})
			: new Response('nothing here yet', { status: 404 });
	});
	return { fetch, log };
}

const runner = (log: string[] = []) =>
	scriptedRunner({
		'wrangler whoami': ok(WHOAMI),
		'bunx wrangler deploy -c /out/guard-placeholder/wrangler.jsonc': () => {
			log.push('PLACEHOLDER');
			return ok('');
		},
		'bunx wrangler secret bulk /out/secrets.json --name drupflare-preview-earth-app-c49dd78f':
			ok('')
	});

const input = (deploy: (args: string[]) => Promise<void>) => ({
	name: NAME,
	out: '/out',
	workspace: '/out/worker',
	hasSecrets: true,
	globals: testGlobals(),
	deploy,
	sleep: async () => {}
});

describe('deployDuplicate', () => {
	const env = { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: ACCOUNT };

	it('guards the hostname, proves it on a placeholder, and only then deploys the site', async () => {
		const { fetch, log } = world(1);
		const events: string[] = [];
		const ctx = testContext({ env, fetch, runner: runner(log) });
		const deployed = await deployDuplicate(
			ctx,
			input(async (args) => {
				events.push(`deploy ${args.join(' ')}`);
				log.push('DEPLOY');
			})
		);
		expect(deployed.origin).toBe(ORIGIN);
		expect(deployed.headers).toEqual({
			'cf-access-client-id': 'cid',
			'cf-access-client-secret': 'sec'
		});
		expect(events).toEqual([`deploy --name ${NAME}`]);
		const order = log.filter((l) => !/\/workers\/(subdomain|scripts\/.*\/settings)$/.test(l));
		expect(order.indexOf('POST /accounts/<acct>/access/apps')).toBeLessThan(
			order.indexOf('DEPLOY')
		);
		expect(order.slice(order.indexOf('POST /accounts/<acct>/access/apps') + 1)).toEqual([
			'PLACEHOLDER',
			'origin GET',
			'origin GET',
			'DEPLOY',
			'origin GET'
		]);
		expect(ctx.files.readText('/out/guard-placeholder/index.js')).not.toContain('fetch(');
		const saved = JSON.parse(ctx.files.readText('/out/access-guard.json'));
		expect(saved).toMatchObject({
			hostname: `${NAME}.me.workers.dev`,
			email: 'me@example.com'
		});
	});

	it('leaves a worker that is already up alone: no placeholder over real code', async () => {
		const { fetch, log } = world(0, true);
		const ctx = testContext({ env, fetch, runner: runner(log) });
		await deployDuplicate(
			ctx,
			input(async () => void log.push('DEPLOY'))
		);
		expect(log).not.toContain('PLACEHOLDER');
		expect(log).toContain('DEPLOY');
	});

	it('sends the values the worker config declares as vars, and keeps them out of the secrets', async () => {
		const { fetch } = world(0);
		const ctx = testContext({ env, fetch, runner: runner() });
		const seen: string[][] = [];
		await deployDuplicate(ctx, {
			...input(async (args) => void seen.push(args)),
			vars: { PLAN: 'paid' }
		});
		expect(seen).toEqual([['--name', NAME, '--var', 'PLAN:paid']]);
	});

	it('never deploys the site when the edge does not turn a visitor away from the placeholder', async () => {
		const { fetch } = world(Number.POSITIVE_INFINITY);
		const scripted = runner();
		const ctx = testContext({ env, fetch, runner: scripted });
		let deployed = false;
		const err = await deployDuplicate(
			ctx,
			input(async () => void (deployed = true))
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(DranglerError);
		expect((err as DranglerError).code).toBe('guard');
		expect((err as DranglerError).next).toContain(`wrangler delete --name ${NAME}`);
		expect(deployed).toBe(false);
		expect(scripted.calls.some((c) => c.args.includes('secret'))).toBe(false);
	});

	it('sends no secret when the site itself answers without a login', async () => {
		let polls = 0;
		const base = world(0).fetch;
		const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const u = String(url);
			if (!u.startsWith('https://api.cloudflare.com')) {
				polls += 1;
				const guarded = polls <= 1;
				return guarded
					? new Response(null, {
							status: 302,
							headers: { location: 'https://me.cloudflareaccess.com/login' }
						})
					: new Response('open', { status: 200 });
			}
			return base(url, init);
		}) as typeof base;
		const scripted = runner();
		const ctx = testContext({ env, fetch, runner: scripted });
		const err = await deployDuplicate(
			ctx,
			input(async () => {})
		).catch((e: unknown) => e);
		expect((err as DranglerError).code).toBe('guard');
		expect(scripted.calls.some((c) => c.args.includes('secret'))).toBe(false);
	});

	it('reuses the stored guard on a rerun, and refuses a folder that guards another hostname', async () => {
		const { fetch, log } = world(0);
		const ctx = testContext({ env, fetch, runner: runner() });
		ctx.files.writeSecret(
			'/out/access-guard.json',
			JSON.stringify({
				hostname: `${NAME}.me.workers.dev`,
				appId: 'app',
				tokenId: 'tok',
				clientId: 'cid',
				clientSecret: 'sec',
				email: 'me@example.com'
			})
		);
		await deployDuplicate(
			ctx,
			input(async () => {})
		);
		expect(log.some((l) => l.startsWith('POST'))).toBe(false);

		ctx.files.writeSecret(
			'/out/access-guard.json',
			JSON.stringify({ hostname: 'other.me.workers.dev', clientId: 'x', clientSecret: 'y' })
		);
		await expect(
			deployDuplicate(
				ctx,
				input(async () => {})
			)
		).rejects.toBeInstanceOf(UsageError);
	});

	it('asks for an email when neither the flag nor wrangler names one', async () => {
		const { fetch } = world(0);
		const ctx = testContext({
			env,
			fetch,
			runner: scriptedRunner({ 'wrangler whoami': ok('Not logged in') })
		});
		const err = await deployDuplicate(
			ctx,
			input(async () => {})
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(UsageError);
		expect((err as UsageError).next).toContain('--access-email');
	});

	it('takes the email from the flag without asking wrangler', async () => {
		const { fetch, log } = world(0);
		const ctx = testContext({ env, fetch, runner: runner() });
		await deployDuplicate(ctx, { ...input(async () => {}), accessEmail: 'flag@example.com' });
		expect(JSON.parse(ctx.files.readText('/out/access-guard.json')).email).toBe(
			'flag@example.com'
		);
		expect(log.length).toBeGreaterThan(0);
	});
});

describe('splitDeployValues', () => {
	const values = { PLAN: 'paid', DRUPAL_CONFIG: '{"a":1}', REDIS_URL: 'redis://x' };
	const split = (config: string | null) => {
		const ctx = testContext({
			files: memoryFiles(config === null ? {} : { '/ws/wrangler.jsonc': config })
		});
		return splitDeployValues(ctx, '/ws', values);
	};

	it('sends a name the config declares as a var as a var, and the rest as secrets', () => {
		const got = split('{"vars":{"CMS":"drupal","PLAN":"free"}}');
		expect(got.vars).toEqual({ PLAN: 'paid' });
		expect(got.secrets).toEqual({ DRUPAL_CONFIG: '{"a":1}', REDIS_URL: 'redis://x' });
	});

	it('reads past whole-line comments in the config', () => {
		const got = split('{\n// the plan\n"vars":{"PLAN":"free"}\n}');
		expect(got.vars).toEqual({ PLAN: 'paid' });
	});

	it('keeps everything a secret when the config is absent or unreadable', () => {
		expect(split(null).vars).toEqual({});
		expect(split('not json').secrets).toEqual(values);
	});
});

describe('leaveFleet', () => {
	const config = (d1: string) =>
		`{\n\t"name": "x",\n\t"vars": {"PLAN": "free"},\n${d1}\t"kv_namespaces": [{ "binding": "CONFIG_KV" }]\n}\n`;
	const FLEET =
		'\t"d1_databases": [{ "binding": "FLEET_DB", "database_name": "drupflare-fleet" }],\n';

	it('takes the fleet database out of the copy config and leaves the rest', () => {
		const ctx = testContext({ files: memoryFiles({ '/ws/wrangler.jsonc': config(FLEET) }) });
		expect(leaveFleet(ctx, '/ws')).toBe(true);
		const after = JSON.parse(ctx.files.readText('/ws/wrangler.jsonc'));
		expect(after.d1_databases).toBeUndefined();
		expect(after.kv_namespaces).toEqual([{ binding: 'CONFIG_KV' }]);
		expect(after.vars).toEqual({ PLAN: 'free' });
	});

	it('keeps a database that is not the fleet registry', () => {
		const other =
			'\t"d1_databases": [{ "binding": "FLEET_DB", "database_name": "a" }, { "binding": "MINE", "database_name": "b" }],\n';
		const ctx = testContext({ files: memoryFiles({ '/ws/wrangler.jsonc': config(other) }) });
		expect(leaveFleet(ctx, '/ws')).toBe(true);
		expect(JSON.parse(ctx.files.readText('/ws/wrangler.jsonc')).d1_databases).toEqual([
			{ binding: 'MINE', database_name: 'b' }
		]);
	});

	it('does nothing to a config with no fleet binding, and refuses one it cannot read', () => {
		const clean = testContext({ files: memoryFiles({ '/ws/wrangler.jsonc': config('') }) });
		expect(leaveFleet(clean, '/ws')).toBe(false);
		const broken = testContext({ files: memoryFiles({ '/ws/wrangler.jsonc': 'not json' }) });
		expect(() => leaveFleet(broken, '/ws')).toThrow(DranglerError);
	});

	it('runs before the deploy, so the copy never goes up bound to the fleet', async () => {
		const { fetch } = world(0, true);
		const ctx = testContext({
			env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
			fetch,
			runner: runner(),
			files: memoryFiles({ '/out/worker/wrangler.jsonc': config(FLEET) })
		});
		let seen = '';
		await deployDuplicate(ctx, {
			...input(async () => void (seen = ctx.files.readText('/out/worker/wrangler.jsonc')))
		});
		expect(seen).not.toContain('FLEET_DB');
	});
});
