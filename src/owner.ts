import type { GlobalOptions } from './config/globals';
import type { Context } from './context';
import { ProbeError, UsageError } from './errors';
import { normaliseTarget, type FetchLike } from './health/probe';

/**
 * One owner route, one reply.
 *
 * The status is DATA: `/modify?action=commit` answers 409 when the kernel refused to boot and
 * `/firstrun` answers 409 when somebody else already claimed the site, and both are verdicts a
 * command reports rather than failures it raises.
 */
export interface OwnerReply {
	status: number;
	body: Record<string, unknown>;
}

/** everything an owner-authenticated request needs, resolved once per command */
export interface OwnerTarget {
	origin: string;
	/**
	 * The Durable Object identity inside that origin, or null to let the site resolve its own.
	 *
	 * NULL IS THE NORMAL CASE and a name drangler invents is the bug. `resolveSite()` on the worker
	 * honours `?site=` only on a route that is not public, so `/firstrun` -- which is public --
	 * resolves from the host and mints the token on THAT object, while every owner route after it
	 * would be told a different name and answer 401. A default of `'site'` therefore worked on
	 * localhost, where the host derives to the same fallback, and broke every deployed site.
	 */
	site: string | null;
	token: string;
	timeoutMs: number;
}

export interface OwnerCallOptions {
	method?: 'GET' | 'POST';
	params?: Record<string, string | number | undefined>;
	body?: unknown;
}

/** the origin to act on, from the argument, then `--site`, then the config */
export function siteOriginOf(globals: GlobalOptions, target?: string | null): string {
	const given = target ?? globals.config.site.value;
	if (given === null || given === undefined || given.trim() === '') {
		throw new UsageError(
			'no site to act on; pass it as an argument, as --site, or put it in a drangler.json'
		);
	}
	return normaliseTarget(given);
}

/**
 * The origin and the credential the owner routes need.
 *
 * The token is resolved by `resolveConfig`, which reads it from `--token`, then
 * `DRUPFLARE_OWNER_TOKEN`, then the GLOBAL config keyed by origin. A site that has never been
 * claimed has no token to find, so the refusal names the command that mints one.
 */
export function ownerTarget(globals: GlobalOptions, target?: string | null): OwnerTarget {
	const origin = siteOriginOf(globals, target);
	const token = globals.config.token.value;
	if (token === null) {
		throw new UsageError(
			`no owner token for ${origin}; pass --token, set DRUPFLARE_OWNER_TOKEN, or run \`drangler site claim ${origin}\``
		);
	}
	return {
		origin,
		site: globals.config.siteName.value,
		token,
		timeoutMs: globals.timeoutMs
	};
}

export function ownerUrl(
	owner: OwnerTarget,
	path: string,
	params: OwnerCallOptions['params'] = {}
): string {
	const url = new URL(`${owner.origin}${path}`);
	if (owner.site !== null && owner.site !== '') url.searchParams.set('site', owner.site);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}
	return url.toString();
}

/**
 * Calls one owner route and parses what came back.
 *
 * The token rides an `Authorization` header rather than a query parameter, because a query string
 * lands in every log the request passes through. A 401 is the one status raised rather than
 * returned: the fix is the same wherever it happens, and a command that reported it as a finding
 * would be reporting on a site it never reached.
 */
export async function ownerCall(
	deps: { fetch: FetchLike },
	owner: OwnerTarget,
	path: string,
	opts: OwnerCallOptions = {}
): Promise<OwnerReply> {
	const url = ownerUrl(owner, path, opts.params);
	const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
	let response: Response;
	try {
		response = await deps.fetch(url, {
			method,
			headers: {
				// `/firstrun` is public and takes no credential on a site nobody has claimed yet
				...(owner.token === '' ? {} : { authorization: `Bearer ${owner.token}` }),
				...(opts.body === undefined ? {} : { 'content-type': 'application/json' })
			},
			...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
			signal: AbortSignal.timeout(owner.timeoutMs)
		});
	} catch (e) {
		throw new ProbeError(`${url}: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (response.status === 401 || response.status === 403) {
		throw new UsageError(
			`${owner.origin} refused the owner token on ${path}; re-read it from \`drangler site claim\` or pass --token`
		);
	}
	return { status: response.status, body: await readJsonBody(response) };
}

/** a route that answered with something other than JSON still has to report what it said */
async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	try {
		const parsed = JSON.parse(text) as unknown;
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return { value: parsed };
	} catch {
		return { error: text.slice(0, 300) };
	}
}

/** the error a route reported, or a generic one naming the status */
export function replyError(reply: OwnerReply, fallback: string): string {
	const error = reply.body['error'];
	return typeof error === 'string' && error !== '' ? error : `${fallback} (HTTP ${reply.status})`;
}

/**
 * Waits without a sixth seam on `Context`.
 *
 * Every polling command takes an `--interval`, and a spec passes 0 so the loop runs at the speed of
 * the microtask queue rather than holding a suite open for real seconds.
 */
export async function pause(ms: number): Promise<void> {
	if (ms <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/** the deps every owner-driven command needs, so a spec passes a context and nothing else */
export type OwnerDeps = Pick<Context, 'fetch' | 'io'>;
