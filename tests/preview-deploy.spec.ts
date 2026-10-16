import { describe, expect, it } from 'vitest';
import { deployDuplicate } from '../src/commands/preview-deploy';
import { DranglerError, UsageError } from '../src/errors';
import { scriptedRunner } from '../src/host/exec';
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
function world(guardedAfter: number) {
	const log: string[] = [];
	let unguarded = 0;
	const fetch = fakeFetch((url, init) => {
		const u = String(url);
		const method = (init as { method?: string } | undefined)?.method ?? 'GET';
		if (u.startsWith('https://api.cloudflare.com')) {
			const path = u.replace('https://api.cloudflare.com/client/v4', '');
			log.push(`${method} ${path.replace(ACCOUNT, '<acct>')}`);
			if (path.endsWith('/workers/subdomain')) return envelope({ subdomain: 'me' });
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

const runner = () =>
	scriptedRunner({
		'wrangler whoami': ok(WHOAMI),
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

	it('guards the hostname, waits for the edge to turn visitors away, and only then deploys', async () => {
		const { fetch, log } = world(1);
		const events: string[] = [];
		const ctx = testContext({ env, fetch, runner: runner() });
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
		const order = log.filter((l) => l !== 'GET /accounts/<acct>/workers/subdomain');
		expect(order.indexOf('POST /accounts/<acct>/access/apps')).toBeLessThan(
			order.indexOf('DEPLOY')
		);
		expect(order.slice(order.indexOf('POST /accounts/<acct>/access/apps') + 1)).toEqual([
			'origin GET',
			'origin GET',
			'DEPLOY'
		]);
		const saved = JSON.parse(ctx.files.readText('/out/access-guard.json'));
		expect(saved).toMatchObject({
			hostname: `${NAME}.me.workers.dev`,
			email: 'me@example.com'
		});
	});

	it('deploys nothing when the edge never starts turning visitors away', async () => {
		const { fetch } = world(Number.POSITIVE_INFINITY);
		const ctx = testContext({ env, fetch, runner: runner() });
		let deployed = false;
		const slow = { ...input(async () => void (deployed = true)) };
		const err = await deployDuplicate(ctx, slow).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(DranglerError);
		expect((err as DranglerError).code).toBe('guard');
		expect(deployed).toBe(false);
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
