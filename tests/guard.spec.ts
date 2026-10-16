import { describe, expect, it } from 'vitest';
import {
	createGuard,
	guardHeaders,
	isTurnedAway,
	waitGuarded,
	workerOrigin,
	workersSubdomain,
	type RawClient
} from '../src/cloudflare/guard';
import { DranglerError, UsageError } from '../src/errors';
import { fakeTarget } from './helpers';

/** a raw client that answers from a table and records every call */
function raw(answers: Record<string, unknown>): {
	client: RawClient;
	calls: [string, string, unknown][];
} {
	const calls: [string, string, unknown][] = [];
	return {
		calls,
		client: {
			async request<T>(path: string, options?: { method?: string; body?: string }) {
				const method = options?.method ?? 'GET';
				calls.push([
					method,
					path,
					options?.body === undefined ? null : JSON.parse(options.body)
				]);
				const key = `${method} ${path}`;
				if (!(key in answers)) throw new Error(`unscripted ${key}`);
				return answers[key] as T;
			}
		}
	};
}

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const HOST = 'drupflare-preview-earth-app-c49dd78f.me.workers.dev';

describe('the preview address', () => {
	it('is the worker name on the account subdomain', () => {
		expect(workerOrigin('drupflare-preview-x', 'me')).toBe(
			'https://drupflare-preview-x.me.workers.dev'
		);
	});

	it('is read from the account, and an account with none is an error naming wrangler', async () => {
		const envelope = (result: unknown) => async () =>
			new Response(JSON.stringify({ success: true, errors: [], result }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		await expect(workersSubdomain(fakeTarget(envelope({ subdomain: 'me' })))).resolves.toBe(
			'me'
		);
		const err = await workersSubdomain(fakeTarget(envelope({}))).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(DranglerError);
		expect((err as DranglerError).code).toBe('guard');
	});
});

describe('createGuard', () => {
	const answers = {
		[`GET /accounts/${ACCOUNT}/access/apps`]: [{ id: 'other', domain: 'other.example' }],
		[`POST /accounts/${ACCOUNT}/access/service_tokens`]: {
			id: 'tok1',
			client_id: 'cid.access',
			client_secret: 'secret-value'
		},
		[`POST /accounts/${ACCOUNT}/access/policies`]: { id: 'pol' },
		[`POST /accounts/${ACCOUNT}/access/apps`]: { id: 'app1' }
	};

	it('names the missing permission when the token can read Access but not write it', async () => {
		const client: RawClient = {
			async request<T>(path: string, options?: { method?: string }) {
				if ((options?.method ?? 'GET') === 'GET') return [] as T;
				throw new Error(`POST ${path}: HTTP 403, the credential was rejected (code 1010)`);
			}
		};
		const failure = await createGuard(client, ACCOUNT, {
			hostname: HOST,
			email: 'me@example.com',
			name: 'x'
		}).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(DranglerError);
		expect((failure as DranglerError).code).toBe('guard');
		expect((failure as DranglerError).message).toContain('nothing was created');
		expect((failure as DranglerError).next).toContain('Service Tokens Edit');
	});

	it('creates a service token, two policies and an app on the hostname, in that order', async () => {
		const { client, calls } = raw(answers);
		const guard = await createGuard(client, ACCOUNT, {
			hostname: HOST,
			email: 'me@example.com',
			name: 'drupflare-preview-earth-app-c49dd78f'
		});
		expect(guard).toEqual({
			hostname: HOST,
			appId: 'app1',
			tokenId: 'tok1',
			clientId: 'cid.access',
			clientSecret: 'secret-value'
		});
		expect(calls.map(([m, p]) => `${m} ${p.replace(ACCOUNT, '<acct>')}`)).toEqual([
			'GET /accounts/<acct>/access/apps',
			'POST /accounts/<acct>/access/service_tokens',
			'POST /accounts/<acct>/access/policies',
			'POST /accounts/<acct>/access/policies',
			'POST /accounts/<acct>/access/apps'
		]);
		const [, , ownerPolicy] = calls[2]!;
		const [, , servicePolicy] = calls[3]!;
		const [, , app] = calls[4]!;
		expect(ownerPolicy).toMatchObject({
			decision: 'allow',
			include: [{ email: { email: 'me@example.com' } }]
		});
		expect(servicePolicy).toMatchObject({
			decision: 'non_identity',
			include: [{ service_token: { token_id: 'tok1' } }]
		});
		expect(app).toMatchObject({
			type: 'self_hosted',
			domain: HOST,
			policies: [
				{ id: 'pol', precedence: 1 },
				{ id: 'pol', precedence: 2 }
			]
		});
	});

	it('refuses to guard a hostname twice, because the first token cannot be read back', async () => {
		const { client, calls } = raw({
			...answers,
			[`GET /accounts/${ACCOUNT}/access/apps`]: [{ id: 'app0', domain: HOST }]
		});
		await expect(
			createGuard(client, ACCOUNT, { hostname: HOST, email: 'me@example.com', name: 'n' })
		).rejects.toBeInstanceOf(UsageError);
		expect(calls).toHaveLength(1);
	});
});

describe('guard checks', () => {
	it('names the header pair Access takes in place of a login', () => {
		expect(guardHeaders({ clientId: 'a', clientSecret: 'b' })).toEqual({
			'cf-access-client-id': 'a',
			'cf-access-client-secret': 'b'
		});
	});

	it('counts a login redirect or a refusal as guarded, and a 200 or a bare 404 as not', () => {
		expect(isTurnedAway(302, 'https://me.cloudflareaccess.com/cdn-cgi/access/login/x')).toBe(
			true
		);
		expect(isTurnedAway(302, 'https://elsewhere.example/')).toBe(false);
		expect(isTurnedAway(403, null)).toBe(true);
		expect(isTurnedAway(401, null)).toBe(true);
		expect(isTurnedAway(200, null)).toBe(false);
		expect(isTurnedAway(404, null)).toBe(false);
	});

	it('waits for the edge to start turning visitors away, and gives up at the limit', async () => {
		const replies = [404, 404, 302];
		let slept = 0;
		const fetch = async () =>
			new Response(null, {
				status: replies.shift() ?? 404,
				headers: { location: 'https://me.cloudflareaccess.com/login' }
			});
		const sleep = async (ms: number) => void (slept += ms);
		await expect(waitGuarded({ fetch, sleep }, `https://${HOST}`, 60_000, 3_000)).resolves.toBe(
			true
		);
		expect(slept).toBe(6_000);
		const never = async () => new Response(null, { status: 404 });
		await expect(
			waitGuarded({ fetch: never, sleep }, `https://${HOST}`, 9_000, 3_000)
		).resolves.toBe(false);
	});
});
