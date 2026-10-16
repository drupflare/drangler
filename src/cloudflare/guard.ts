import { DranglerError, UsageError } from '../errors';
import type { FetchLike } from '../health/probe';
import type { CloudflareTarget } from './client';

/** the one method of the workforce client this file needs, so a spec passes a table */
export interface RawClient {
	request<T>(
		path: string,
		options?: { method?: string; body?: string; headers?: Record<string, string> }
	): Promise<T>;
}

export interface Guard {
	hostname: string;
	appId: string;
	tokenId: string;
	clientId: string;
	clientSecret: string;
}

/** what is written beside the preview, so a rerun can reach the site again */
export interface StoredGuard extends Guard {
	email: string;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** `drupflare-preview-x` on the account's subdomain, which is where wrangler deploys it */
export function workerOrigin(name: string, subdomain: string): string {
	return `https://${name}.${subdomain}.workers.dev`;
}

export async function workersSubdomain(t: CloudflareTarget): Promise<string> {
	const got = await (t.client.raw as RawClient).request<{ subdomain?: string }>(
		`/accounts/${t.account}/workers/subdomain`
	);
	if (typeof got.subdomain !== 'string' || got.subdomain === '') {
		throw new DranglerError(
			'guard',
			'the account has no workers.dev subdomain, so a deployed preview has no address to guard',
			{ next: 'wrangler deploy' }
		);
	}
	return got.subdomain;
}

/** the header pair Access takes in place of a login */
export function guardHeaders(g: Pick<Guard, 'clientId' | 'clientSecret'>): Record<string, string> {
	return {
		'cf-access-client-id': g.clientId,
		'cf-access-client-secret': g.clientSecret
	};
}

/**
 * Puts a Cloudflare Access app in front of a workers.dev hostname BEFORE the worker is deployed.
 *
 * Two policies: the account owner's email may log in, and one service token may pass without a
 * login, which is how drangler claims and checks the copy. Creating the app first closes the
 * window in which a deployed site that holds real rows is claimable by whoever finds its address,
 * because `/firstrun` is trust-on-first-use.
 */
export async function createGuard(
	raw: RawClient,
	account: string,
	input: { hostname: string; email: string; name: string }
): Promise<Guard> {
	const apps = await raw.request<{ id?: string; domain?: string }[]>(
		`/accounts/${account}/access/apps`
	);
	const existing = apps.find((a) => a.domain === input.hostname);
	if (existing !== undefined) {
		throw new UsageError(
			`an Access app already guards ${input.hostname} (${existing.id}) and its service token is not recoverable`,
			`drangler preview --out <the folder holding access-token>`
		);
	}
	const token = await raw
		.request<{ id: string; client_id: string; client_secret: string }>(
			`/accounts/${account}/access/service_tokens`,
			{
				method: 'POST',
				headers: JSON_HEADERS,
				body: JSON.stringify({ name: input.name, duration: '8760h' })
			}
		)
		.catch((e: unknown) => {
			// the read above can succeed on a token that cannot write, so this is the first place to know
			if (e instanceof Error && /HTTP 40[13]\b/.test(e.message)) {
				throw new DranglerError(
					'guard',
					`the Cloudflare API token can read Access but not write it (${e.message}); nothing was created and nothing was deployed`,
					{
						next: 'give the token Access: Service Tokens Edit and Access: Apps and Policies Edit on the account, then run the same drangler preview command again'
					}
				);
			}
			throw e;
		});
	const owner = await raw.request<{ id: string }>(`/accounts/${account}/access/policies`, {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({
			name: `${input.name} owner`,
			decision: 'allow',
			include: [{ email: { email: input.email } }]
		})
	});
	const service = await raw.request<{ id: string }>(`/accounts/${account}/access/policies`, {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({
			name: `${input.name} drangler`,
			decision: 'non_identity',
			include: [{ service_token: { token_id: token.id } }]
		})
	});
	const app = await raw.request<{ id: string }>(`/accounts/${account}/access/apps`, {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({
			name: input.name,
			type: 'self_hosted',
			domain: input.hostname,
			session_duration: '24h',
			app_launcher_visible: false,
			policies: [
				{ id: owner.id, precedence: 1 },
				{ id: service.id, precedence: 2 }
			]
		})
	});
	return {
		hostname: input.hostname,
		appId: app.id,
		tokenId: token.id,
		clientId: token.client_id,
		clientSecret: token.client_secret
	};
}

/** whether an unauthenticated request is turned away at the edge: a login redirect or a refusal */
export function isTurnedAway(status: number, location: string | null): boolean {
	if (status === 302 || status === 301) return /cloudflareaccess\.com/i.test(location ?? '');
	return status === 401 || status === 403;
}

/**
 * Waits until the edge turns an unauthenticated visitor away.
 *
 * Run after the deploy, because a hostname with no script gives a bare 404 whatever Access holds. A
 * hostname that answers 200 or a bare 404 once the script is there is unguarded as far as this
 * check can tell.
 */
export async function waitGuarded(
	deps: { fetch: FetchLike; sleep: (ms: number) => Promise<void> },
	origin: string,
	limitMs = 90_000,
	stepMs = 3_000
): Promise<boolean> {
	let waited = 0;
	for (;;) {
		try {
			const res = await deps.fetch(`${origin}/`, { redirect: 'manual' });
			if (isTurnedAway(res.status, res.headers.get('location'))) return true;
		} catch {
			// the name is not answering yet
		}
		if (waited >= limitMs) return false;
		await deps.sleep(stepMs);
		waited += stepMs;
	}
}
