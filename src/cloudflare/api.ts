import { AuthError, DranglerError } from '../errors';
import type { FetchLike } from '../health/probe';

export const API_BASE = 'https://api.cloudflare.com/client/v4';

export interface WorkerScript {
	id: string;
	createdOn: string | null;
	modifiedOn: string | null;
}

interface ApiEnvelope<T> {
	success?: boolean;
	errors?: { code?: number; message?: string }[];
	result?: T;
}

/**
 * Reads one Cloudflare API envelope.
 *
 * A 200 with `success: false` is the normal way this API reports a permission problem, so the status
 * code alone is not the check; treating it as one is how a "no workers" answer gets confused with a
 * token that cannot list them.
 */
export async function readEnvelope<T>(response: Response, what: string): Promise<T> {
	let body: ApiEnvelope<T>;
	try {
		body = (await response.json()) as ApiEnvelope<T>;
	} catch {
		throw new DranglerError('api', `${what}: HTTP ${response.status} with a non-JSON body`);
	}
	if (response.status === 401 || response.status === 403) {
		throw new AuthError(`${what}: HTTP ${response.status}; the token was rejected`);
	}
	if (body.success === false || body.result === undefined) {
		const detail = (body.errors ?? []).map((e) => e.message ?? String(e.code)).join('; ');
		throw new DranglerError(
			'api',
			`${what}: ${detail === '' ? `HTTP ${response.status}` : detail}`
		);
	}
	return body.result;
}

/** what the account is actually entitled to, as far as the subscription list shows */
export type WorkersPlan = 'free' | 'paid' | 'unknown';

export interface PlanReading {
	plan: WorkersPlan;
	/** the rate-plan names the verdict was read from, so an `unknown` can be diagnosed */
	evidence: string[];
}

/**
 * Reads a Workers plan out of a subscription list.
 *
 * Tolerant on purpose, and it returns `unknown` rather than guessing `free`. The subscription
 * envelope carries several products and their rate-plan naming has changed; a reader that treated
 * "no paid marker found" as proof of the free plan would report a confident wrong answer every time
 * the naming moved, which is worse than reporting that it could not tell.
 */
export function readWorkersPlan(
	subscriptions: readonly { rate_plan?: { id?: string; public_name?: string } }[]
): PlanReading {
	const evidence: string[] = [];
	let paid = false;
	let sawWorkers = false;
	for (const sub of subscriptions) {
		const id = String(sub.rate_plan?.id ?? '');
		const name = String(sub.rate_plan?.public_name ?? '');
		const label = `${id} ${name}`.trim();
		if (label === '') continue;
		if (!/workers/i.test(label)) continue;
		sawWorkers = true;
		evidence.push(label);
		if (/paid|bundled|standard|unlimited|enterprise|business/i.test(label)) paid = true;
	}
	if (!sawWorkers) return { plan: 'unknown', evidence };
	return { plan: paid ? 'paid' : 'free', evidence };
}

export interface CloudflareApi {
	listWorkers(accountId: string): Promise<WorkerScript[]>;
	workersPlan(accountId: string): Promise<PlanReading>;
}

/** The REST surface drangler uses. Read-only: nothing here writes, deploys or deletes. */
export function cloudflareApi(
	fetchFn: FetchLike,
	token: string,
	base: string = API_BASE
): CloudflareApi {
	return {
		async listWorkers(accountId) {
			const response = await fetchFn(`${base}/accounts/${accountId}/workers/scripts`, {
				headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
			});
			const result = await readEnvelope<
				{ id?: string; created_on?: string; modified_on?: string }[]
			>(response, 'listing workers');
			return result
				.map((r) => ({
					id: String(r.id ?? ''),
					createdOn: r.created_on ?? null,
					modifiedOn: r.modified_on ?? null
				}))
				.filter((r) => r.id !== '')
				.sort((a, b) => a.id.localeCompare(b.id));
		},

		async workersPlan(accountId) {
			const response = await fetchFn(`${base}/accounts/${accountId}/subscriptions`, {
				headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
			});
			const result = await readEnvelope<
				{ rate_plan?: { id?: string; public_name?: string } }[]
			>(response, 'reading the account plan');
			return readWorkersPlan(result);
		}
	};
}

export interface BaselineDiff {
	added: string[];
	removed: string[];
	same: boolean;
}

/**
 * Compares a worker list against a saved baseline.
 *
 * This exists because `drupflare/worker` documents a manual step -- deploy a `cfw-*` probe, tear it
 * down, then verify the worker list returns to exactly its prior baseline -- against an account that
 * holds real production workers. A step performed by eye on a list of names is the one that gets
 * skipped at 2am.
 */
export function compareWorkers(
	baseline: readonly string[],
	current: readonly string[]
): BaselineDiff {
	const before = new Set(baseline);
	const after = new Set(current);
	const added = [...after].filter((n) => !before.has(n)).sort();
	const removed = [...before].filter((n) => !after.has(n)).sort();
	return { added, removed, same: added.length === 0 && removed.length === 0 };
}
