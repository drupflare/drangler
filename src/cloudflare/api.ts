import type { CloudflareTarget } from './client';

export interface WorkerScript {
	id: string;
	createdOn: string | null;
	modifiedOn: string | null;
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

/** The account's scripts, named and sorted the way drangler reports them. */
export async function listWorkers(t: CloudflareTarget): Promise<WorkerScript[]> {
	const summaries = await t.client.plane.list();
	return summaries
		.map((s) => ({ id: s.name, createdOn: s.createdOn, modifiedOn: s.modifiedOn }))
		.filter((s) => s.id !== '')
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** Workers has no plan endpoint, so this reads the account subscriptions through the raw client. */
export async function workersPlan(t: CloudflareTarget): Promise<PlanReading> {
	const result = await t.client.raw.request<
		{ rate_plan?: { id?: string; public_name?: string } }[]
	>(`/accounts/${t.account}/subscriptions`);
	return readWorkersPlan(result);
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
