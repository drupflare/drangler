import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { FindingError, UsageError } from '../errors';
import { emit } from '../format';
import { probeSite, readDegradation, type Degradation } from '../health/probe';
import {
	gateRepair,
	healthVerdict,
	renderRepair,
	REPAIRS,
	summariseHealth,
	type Repair,
	type RepairReport,
	type SnapshotDecision
} from '../health/repair';
import { ownerCall, ownerTarget, pause, replyError, type OwnerTarget } from '../owner';
import { DEFAULT_POLL_INTERVAL_MS, numberFlag } from './site';

/** how long `--watch` keeps re-reading before it gives up */
export const DEFAULT_WATCH_MS = 300_000;

export interface HealOptions {
	/** re-read until the site is clean or the wait runs out */
	watch?: boolean;
	interval?: string | number;
	wait?: string | number;
	/** clear a quarantine */
	release?: boolean;
	/** drive the pack replay forward; the cursor only advances */
	replay?: boolean;
	/** re-arm a stalled fill; spends the rows the drain writes */
	armfill?: boolean;
	/** invalidate cache tags; spends a render each */
	invalidate?: string;
	/** bump the generation, which re-renders the whole site */
	bump?: boolean;
	/** release a preview pin on this remote, reaching no network */
	unpin?: string;
	/** perform only the repairs that may run unattended, stopping at the first that may not */
	auto?: boolean;
	/** a directory to take an /export into first; a repair nothing else undoes needs a decision */
	snapshot?: string;
	/** state that a snapshot was declined; there is no default */
	noSnapshot?: boolean;
	/** how many ledger rows to ask for; the worker caps this itself */
	ledger?: string | number;
	globals: GlobalOptions;
}

/** one repair this run performed, or refused, with why */
export interface RepairOutcome {
	id: string;
	klass: string;
	performed: boolean;
	blastRadius: string;
	detail: string;
}

export interface HealReport extends RepairReport {
	verdict: 'clean' | 'quarantined' | 'rollback-pending';
	/** how many times the site was read */
	reads: number;
	timedOut: boolean;
	repairs: RepairOutcome[];
}

/**
 * What is wrong with a site, and the one thing that can be fixed from here.
 *
 * Read-only by default. Every write is behind its own flag and `--yes`, and each one carries the
 * class `worker/docs/configuration.md` gives its route: `safe`, `rebuild` or `stateful`. A command
 * that implied more repair than the routes permit would be reporting on work it never did.
 *
 * Three things stay manual on purpose. A rollback is a decision the object makes with a dwell timer
 * and a restore point it can see, and a flag whose only job is defeating that guard is not a
 * feature. Point-in-time recovery reaches a 30-day window with no undo. Recycling the interpreter
 * has to happen BETWEEN invocations, so a request that triggered one would hold both allocations at
 * once, which is the documented failure.
 */
export async function runHeal(
	ctx: Context,
	target: string | undefined,
	opts: HealOptions
): Promise<void> {
	const { globals } = opts;
	const owner = ownerTarget(globals, target);
	const intervalMs = numberFlag(opts.interval, DEFAULT_POLL_INTERVAL_MS, '--interval');
	const waitMs = numberFlag(opts.wait, DEFAULT_WATCH_MS, '--wait');

	if (opts.snapshot !== undefined && opts.noSnapshot === true) {
		throw new UsageError('--snapshot and --no-snapshot ask for opposite things; pass one');
	}
	const wanted = askedFor(opts);
	if (wanted.length > 0 && globals.dryRun) {
		throw new UsageError('a repair flag and --dry-run ask for opposite things; pass one');
	}

	// read BEFORE anything is written, because the gate needs the degradation state and the report
	// needs a `was` to compare against
	let report = await readHealth(ctx, owner, opts, false);
	report.reads = 1;
	const performed = await performRepairs(ctx, owner, opts, wanted, report);
	if (performed.some((r) => r.performed)) {
		// the state AFTER the repair is what a caller acts on, and what it did is what it reports;
		// re-reading used to drop the record of the repair that caused the re-read
		const reads = report.reads + 1;
		report = await readHealth(ctx, owner, opts, false);
		report.reads = reads;
	}
	report.repairs = performed;

	if (opts.watch === true) {
		const deadline = ctx.now().getTime() + waitMs;
		while (report.verdict !== 'clean') {
			if (ctx.now().getTime() >= deadline) {
				report.timedOut = true;
				break;
			}
			ctx.io.err(`${report.rung}: ${report.rollback.reason}`);
			await pause(intervalMs);
			const reads = report.reads + 1;
			report = await readHealth(ctx, owner, opts, false);
			report.reads = reads;
		}
	}

	emit(ctx.io, globals.json, report, () => [
		...renderRepair(report),
		...(report.repairs.length === 0 ? [] : ['', ...renderRepairs(report.repairs)]),
		'',
		`verdict: ${report.verdict}`,
		...(report.verdict === 'clean'
			? []
			: [
					report.verdict === 'quarantined'
						? `next: drangler heal ${report.site} --release --yes`
						: 'next: nothing from here; the site rolls back on its own alarm'
				])
	]);

	const refused = report.repairs.find((r) => !r.performed);
	if (refused !== undefined) {
		throw new UsageError(`${refused.id} was refused: ${refused.detail}`);
	}
	if (report.timedOut) {
		throw new FindingError('heal-timeout', `${report.site} did not come clean within --wait`);
	}
	if (report.verdict !== 'clean') {
		throw new FindingError(report.verdict, `${report.site} is ${report.verdict}`);
	}
}

async function readHealth(
	ctx: Context,
	owner: OwnerTarget,
	opts: HealOptions,
	release: boolean
): Promise<HealReport> {
	const reply = await ownerCall(ctx, owner, '/health', {
		params: {
			...(release ? { clear: '1' } : {}),
			...(opts.ledger === undefined ? {} : { limit: String(opts.ledger) })
		}
	});
	// `?clear=1` answers `{ok, released, was}` and nothing else, so the state after a release is
	// read back rather than assumed from the reply that performed it
	const body = release
		? (
				await ownerCall(ctx, owner, '/health', {
					...(opts.ledger === undefined ? {} : { params: { limit: String(opts.ledger) } })
				})
			).body
		: reply.body;
	const degraded = await readDegraded(ctx, owner);
	const summary = summariseHealth(owner.origin, body, ctx.now().getTime(), degraded);
	summary.released = release;
	return {
		...summary,
		verdict: healthVerdict(summary),
		reads: 1,
		timedOut: false,
		repairs: []
	};
}

/** one public serve request, because `/health` carries no degradation state and the headers do */
async function readDegraded(ctx: Context, owner: OwnerTarget): Promise<Degradation | null> {
	try {
		const probe = await probeSite(
			{ fetch: ctx.fetch },
			{
				target: owner.origin,
				site: owner.site,
				kind: 'worker',
				skipEdge: true,
				timeoutMs: owner.timeoutMs
			}
		);
		return readDegradation(probe.cfw);
	} catch {
		// an unreachable serve route says nothing about the repair state, which came from a
		// request that did answer
		return null;
	}
}

/** every repair this invocation asked for, in the order they are safe to perform */
function askedFor(opts: HealOptions): string[] {
	const wanted: string[] = [];
	if (opts.release === true) wanted.push('release');
	if (opts.replay === true) wanted.push('replay');
	if (opts.armfill === true) wanted.push('armfill');
	if (opts.invalidate !== undefined) wanted.push('invalidate');
	if (opts.bump === true) wanted.push('bump');
	if (opts.unpin !== undefined) wanted.push('unpin');
	// `--auto` performs what may run unattended and nothing else, and it still needs --yes
	if (opts.auto === true) {
		for (const [id, repair] of Object.entries(REPAIRS)) {
			if (repair.auto && !wanted.includes(id)) wanted.push(id);
		}
	}
	return wanted;
}

function snapshotDecision(opts: HealOptions): SnapshotDecision {
	if (opts.snapshot !== undefined) return 'taken';
	if (opts.noSnapshot === true) return 'declined';
	return 'undecided';
}

/**
 * Performs the repairs that pass their gate, and records the ones that did not.
 *
 * `--auto` is the closest thing to unattended repair and it is narrow: only the repairs that declare
 * they may run unattended, and it stops at the first that does not rather than escalating. A
 * `--auto` that escalated would be a supervisor, and the object already has one.
 *
 * `release()` on the worker is documented "explicit, never automatic". Under `--auto --yes` the
 * user typed both, which is explicit; `--watch` clearing a quarantine on its own would not be, and
 * does not.
 */
async function performRepairs(
	ctx: Context,
	owner: OwnerTarget,
	opts: HealOptions,
	wanted: readonly string[],
	before: HealReport
): Promise<RepairOutcome[]> {
	const out: RepairOutcome[] = [];
	const snapshot = snapshotDecision(opts);
	for (const id of wanted) {
		const repair = REPAIRS[id] as Repair;
		if (opts.auto === true && !repair.auto) {
			out.push({
				id,
				klass: repair.klass,
				performed: false,
				blastRadius: repair.blastRadius,
				detail: `--auto performs only what may run unattended, and ${id} is ${repair.klass} and may not`
			});
			break;
		}
		const gate = gateRepair(repair, {
			yes: opts.globals.yes,
			snapshot,
			degraded: before.degraded
		});
		if (!gate.allowed) {
			out.push({
				id,
				klass: repair.klass,
				performed: false,
				blastRadius: repair.blastRadius,
				detail: `${gate.reason}${gate.flag === null ? '' : `; add ${gate.flag}`}`
			});
			break;
		}
		// the blast radius goes on stderr BEFORE the request, because a bump re-renders the whole
		// site and reading that after the fact is reading it too late
		ctx.io.err(`${id}: ${repair.blastRadius}`);
		const reply = await callRepair(ctx, owner, id, opts);
		out.push({
			id,
			klass: repair.klass,
			performed: reply.ok,
			blastRadius: repair.blastRadius,
			detail: reply.detail
		});
		if (!reply.ok) break;
	}
	return out;
}

/** one repair, one owner route */
async function callRepair(
	ctx: Context,
	owner: OwnerTarget,
	id: string,
	opts: HealOptions
): Promise<{ ok: boolean; detail: string }> {
	const call = async (path: string, params: Record<string, string> = {}) => {
		const reply = await ownerCall(ctx, owner, path, { method: 'POST', params });
		return reply.status < 400 && reply.body['ok'] !== false
			? { ok: true, detail: `${path} answered ${reply.status}` }
			: { ok: false, detail: replyError(reply, `${path} refused`) };
	};
	switch (id) {
		case 'release': {
			const reply = await ownerCall(ctx, owner, '/health', { params: { clear: '1' } });
			return reply.status < 400
				? { ok: true, detail: 'the quarantine was cleared' }
				: { ok: false, detail: replyError(reply, '/health refused the clear') };
		}
		case 'replay':
			return await call('/migrate');
		case 'armfill':
			return await call('/armfill');
		case 'invalidate':
			return await call('/invalidate', { tags: opts.invalidate ?? 'rendered' });
		case 'bump':
			return await call('/bump', { reason: 'drangler heal' });
		case 'unpin':
			// `unpreview` re-syncs to the branch head, so it needs the remote to answer -- and a pin
			// held against a remote that is down is exactly what is being released. `unpin` reaches
			// no network; the poller owns the branch again and the next successful poll converges it
			return await call('/git', { action: 'unpin', id: opts.unpin ?? '' });
		default:
			return { ok: false, detail: `no repair named ${id}` };
	}
}

function renderRepairs(repairs: readonly RepairOutcome[]): string[] {
	const lines = ['repairs'];
	for (const repair of repairs) {
		lines.push(`  ${repair.performed ? 'ran     ' : 'REFUSED '}${repair.id} (${repair.klass})`);
		lines.push(`  ${' '.repeat(8)}${repair.detail}`);
	}
	return lines;
}
