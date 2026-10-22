import { createHash } from 'node:crypto';
import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { DranglerError, FindingError, UsageError } from '../errors';
import { emit, kv, table } from '../format';
import { ownerCall, ownerTarget } from '../owner';

/** the `prev` of the first entry a site ever writes; the worker's `AUDIT_GENESIS` */
export const AUDIT_GENESIS = '0'.repeat(64);

/** how many of the newest entries a text report lists unless `--limit` says otherwise */
export const DEFAULT_LIMIT = 20;

/** one owner call as the site stores it */
export interface AuditEntry {
	seq: number;
	at: number;
	route: string;
	method: string;
	status: number;
	actor: string;
	prev: string;
	hash: string;
}

/** a position in the chain */
export interface AuditPoint {
	seq: number;
	hash: string;
}

export interface AuditOptions {
	/** recompute the chain here instead of reading the site's verdict */
	verify?: boolean;
	/** how many of the newest entries a text report lists */
	limit?: string | number;
	globals: GlobalOptions;
}

export interface AuditReport {
	site: string;
	/** the most entries the site retains */
	ring: number | null;
	head: AuditPoint | null;
	/** the hash of the last entry the ring dropped, which the first retained entry chains from */
	floor: AuditPoint | null;
	failedAttempts: { count: number; since: number | null };
	/** the site's own verdict, which this command reports and does not rely on */
	siteVerified: boolean | null;
	/** the local verdict; null unless `--verify` ran */
	verified: boolean | null;
	/** the first sequence number at which the local check failed */
	firstBadSeq: number | null;
	/** every retained entry, oldest first */
	entries: AuditEntry[];
	notes: string[];
}

/** the entry without its own hash, keys in the order the hash covers; matches the worker */
export function canonicalEntry(entry: Omit<AuditEntry, 'hash'>): string {
	return JSON.stringify({
		seq: entry.seq,
		at: entry.at,
		route: entry.route,
		method: entry.method,
		status: entry.status,
		actor: entry.actor,
		prev: entry.prev
	});
}

/** `sha256(prev || canonical entry)` as lowercase hex */
export function entryHash(entry: Omit<AuditEntry, 'hash'>): string {
	return createHash('sha256')
		.update(entry.prev + canonicalEntry(entry))
		.digest('hex');
}

function isEntry(value: unknown): value is AuditEntry {
	if (typeof value !== 'object' || value === null) return false;
	const e = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(e['seq']) &&
		Number.isSafeInteger(e['at']) &&
		Number.isSafeInteger(e['status']) &&
		typeof e['route'] === 'string' &&
		typeof e['method'] === 'string' &&
		typeof e['actor'] === 'string' &&
		typeof e['prev'] === 'string' &&
		typeof e['hash'] === 'string'
	);
}

/**
 * Recomputes the retained window of a chain from its entries.
 *
 * `floor` is the hash the first retained entry must name as its `prev`; without one the first
 * entry must be sequence 1 chaining from the genesis hash. `head` is the pointer the site keeps
 * beside the ring, which catches a chain cut short at the end. An edit to one entry shows at that
 * entry, and an edit that also rewrites its hash shows at the next one.
 */
export function verifyChain(
	entries: readonly unknown[],
	floor: AuditPoint | null,
	head: AuditPoint | null
): { verified: boolean; firstBadSeq: number | null } {
	let expectSeq = (floor?.seq ?? 0) + 1;
	let expectPrev = floor?.hash ?? AUDIT_GENESIS;
	for (const raw of entries) {
		if (!isEntry(raw)) return { verified: false, firstBadSeq: expectSeq };
		if (raw.seq !== expectSeq || raw.prev !== expectPrev || entryHash(raw) !== raw.hash) {
			return { verified: false, firstBadSeq: raw.seq };
		}
		expectSeq = raw.seq + 1;
		expectPrev = raw.hash;
	}
	if (head !== null && (head.seq !== expectSeq - 1 || head.hash !== expectPrev)) {
		return { verified: false, firstBadSeq: Math.min(head.seq, expectSeq) };
	}
	return { verified: true, firstBadSeq: null };
}

function pointOrNull(value: unknown): AuditPoint | null {
	if (typeof value !== 'object' || value === null) return null;
	const p = value as Record<string, unknown>;
	return Number.isSafeInteger(p['seq']) && typeof p['hash'] === 'string'
		? { seq: p['seq'] as number, hash: p['hash'] }
		: null;
}

/**
 * Prints the site's owner audit log and, with `--verify`, checks it here.
 *
 * Every retained entry is one owner call that changed state or read a secret: who (the first 8 hex
 * characters of the SHA-256 of the token), what, when and the status. `--verify` recomputes every
 * hash from the entries, so a site that reports `verified: true` over an edited log is still caught.
 * A broken chain exits 3. The log is evidence against an attacker on the site, and the account
 * holder can edit Durable Object storage, so the anchor the site writes to Workers observability
 * on each entry is what to compare against.
 */
export async function runAudit(
	ctx: Context,
	target: string | undefined,
	opts: AuditOptions
): Promise<void> {
	const owner = ownerTarget(opts.globals, target);
	const limit = opts.limit === undefined ? DEFAULT_LIMIT : Number(opts.limit);
	if (!Number.isInteger(limit) || limit < 1) {
		throw new UsageError(`--limit must be a whole number of 1 or more, not \`${opts.limit}\``);
	}

	const reply = await ownerCall(ctx, owner, '/audit');
	if (reply.status === 404) {
		throw new DranglerError(
			'audit',
			`${owner.origin} answers 404 for /audit; this worker predates the owner audit log`,
			{ next: 'drangler update' }
		);
	}
	if (reply.status >= 400) {
		throw new DranglerError('audit', `${owner.origin} refused /audit (${reply.status})`);
	}

	const rawEntries = Array.isArray(reply.body['entries']) ? reply.body['entries'] : [];
	const head = pointOrNull(reply.body['head']);
	const floor = pointOrNull(reply.body['floor']);
	const failed = reply.body['failedAttempts'] as Record<string, unknown> | undefined;
	const report: AuditReport = {
		site: owner.origin,
		ring: Number.isSafeInteger(reply.body['ring']) ? (reply.body['ring'] as number) : null,
		head,
		floor,
		failedAttempts: {
			count: Number.isSafeInteger(failed?.['count']) ? (failed?.['count'] as number) : 0,
			since: Number.isSafeInteger(failed?.['since']) ? (failed?.['since'] as number) : null
		},
		siteVerified: typeof reply.body['verified'] === 'boolean' ? reply.body['verified'] : null,
		verified: null,
		firstBadSeq: null,
		entries: rawEntries.filter(isEntry),
		notes: []
	};
	if (report.entries.length !== rawEntries.length) {
		report.notes.push(
			`${rawEntries.length - report.entries.length} stored value(s) are not entries and were left out of the list`
		);
	}
	if (opts.verify === true) {
		const verdict = verifyChain(rawEntries, floor, head);
		report.verified = verdict.verified;
		report.firstBadSeq = verdict.firstBadSeq;
		if (report.siteVerified !== null && report.siteVerified !== verdict.verified) {
			report.notes.push(
				`the site reported verified: ${report.siteVerified}; this check disagrees, and this check is the one to believe`
			);
		}
	} else {
		report.notes.push(
			'the chain was not checked here; --verify recomputes every hash from the entries'
		);
	}
	if (report.head === null) {
		report.notes.push('the site has recorded no owner call yet, so the chain is empty');
	}
	if (report.floor !== null) {
		report.notes.push(
			`the ring has wrapped: entries before seq ${report.floor.seq + 1} are dropped, and the chain verifies from the retained window`
		);
	}

	emit(ctx.io, opts.globals.json, report, () => render(report, limit));

	if (report.verified === false) {
		throw new FindingError(
			'audit-broken',
			`the audit chain on ${owner.origin} does not verify; it first fails at seq ${report.firstBadSeq}`
		);
	}
}

function render(report: AuditReport, limit: number): string[] {
	const first = report.entries[0];
	const rows: [string, string][] = [
		['site', report.site],
		[
			'entries',
			`${report.entries.length} retained of ${report.ring ?? '?'}` +
				(first === undefined ? '' : `, seq ${first.seq} to ${report.head?.seq ?? '?'}`)
		],
		['head', report.head === null ? 'none' : `seq ${report.head.seq} ${report.head.hash}`],
		[
			'failed attempts',
			report.failedAttempts.count === 0
				? '0'
				: `${report.failedAttempts.count} since ${
						report.failedAttempts.since === null
							? '?'
							: new Date(report.failedAttempts.since).toISOString()
					}`
		],
		['site says', report.siteVerified === null ? '-' : String(report.siteVerified)],
		[
			'checked here',
			report.verified === null
				? 'no (pass --verify)'
				: report.verified
					? 'chain verifies'
					: `BROKEN at seq ${report.firstBadSeq}`
		]
	];
	const lines = kv(rows);
	const shown = report.entries.slice(-limit);
	if (shown.length > 0) {
		lines.push(
			'',
			...table(
				['seq', 'at', 'actor', 'call', 'status'],
				shown.map((e) => [
					String(e.seq),
					new Date(e.at).toISOString(),
					e.actor,
					`${e.method} ${e.route}`,
					String(e.status)
				])
			)
		);
		if (shown.length < report.entries.length) {
			lines.push(`(${report.entries.length - shown.length} older entries not shown)`);
		}
	}
	if (report.notes.length > 0) {
		lines.push('', 'notes');
		for (const note of report.notes) lines.push(`  - ${note}`);
	}
	return lines;
}
