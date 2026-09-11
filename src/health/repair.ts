import { kv, table } from '../format';
import type { Degradation } from './probe';

/**
 * Reading a site's repair ladder, its findings and its ledger.
 *
 * Pure: everything here turns one `/health` reply into a report and a verdict, so the decisions a
 * user acts on -- is this site quarantined, is a rollback pending, what is the site itself refusing
 * to do -- are covered without a network.
 *
 * The worker decides; drangler reports. `shouldRollback()` says no far more often than it says yes
 * and every refusal names its mechanism, so the reason string is repeated verbatim rather than
 * re-derived here.
 */

/** the rungs a site climbs, in order; `RUNGS` in the worker's `src/ops/repair.ts` */
export const RUNGS = ['observe', 'reset', 'reconstruct', 'reconfigure', 'quarantine', 'rollback'];

/**
 * Consecutive same-code failures before quarantine.
 *
 * Owned by the worker, repeated here so `strikes 2 of 3` reads as progress rather than as a bare
 * count. `tests/heal.spec.ts` reads the sibling's source and fails when the two disagree.
 */
export const QUARANTINE_STRIKES = 3;

export interface RepairState {
	rung: string;
	code: string | null;
	strikes: number;
	quarantinedAt: number | null;
	lastRollbackAt: number | null;
}

export interface RollbackDecision {
	rollback: boolean;
	reason: string;
}

export interface HealthFinding {
	code: string;
	severity: string;
	scope: string;
	context: string;
}

export interface LedgerRow {
	ts: number;
	code: string;
	severity: string;
	scope: string;
	action: string;
	outcome: string;
}

/** which worker code answered, from `CF_VERSION_METADATA`; null on a deploy that binds none */
export interface WorkerVersion {
	id: string;
	tag: string | null;
	timestamp: string | null;
}

export interface RepairReport {
	site: string;
	rung: string;
	code: string | null;
	strikes: number;
	quarantined: boolean;
	/** when quarantine started, as the site reports it */
	quarantinedAt: number | null;
	/** how long it has been quarantined, in ms; null when it is not */
	heldMs: number | null;
	rollback: RollbackDecision;
	advisories: { state: string; insecure: number; detail: string } | null;
	version: WorkerVersion | null;
	degraded: Degradation | null;
	findings: HealthFinding[];
	ledger: LedgerRow[];
	ledgerRows: number | null;
	/** whether this run cleared the quarantine */
	released: boolean;
	notes: string[];
}

const CLEAN: RepairState = {
	rung: 'observe',
	code: null,
	strikes: 0,
	quarantinedAt: null,
	lastRollbackAt: null
};

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function str(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function nul(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

function int(value: unknown): number | null {
	const n = Number(value);
	return value === undefined || value === null || !Number.isFinite(n) ? null : n;
}

/** the repair state, defaulting to clean rather than to a rung nobody set */
export function readRepairState(value: unknown): RepairState {
	const raw = asRecord(value);
	if (Object.keys(raw).length === 0) return CLEAN;
	return {
		rung: RUNGS.includes(str(raw['rung'])) ? str(raw['rung']) : 'observe',
		code: nul(raw['code']),
		strikes: int(raw['strikes']) ?? 0,
		quarantinedAt: int(raw['quarantinedAt']),
		lastRollbackAt: int(raw['lastRollbackAt'])
	};
}

/** the `{id, tag, timestamp}` `/health` reports, or null on a worker that binds no version */
export function readVersion(value: unknown): WorkerVersion | null {
	const raw = asRecord(value);
	const id = nul(raw['id']);
	if (id === null) return null;
	return { id, tag: nul(raw['tag']), timestamp: nul(raw['timestamp']) };
}

/**
 * Turns one `/health` reply into the report a user reads.
 *
 * `nowMs` comes from the caller's clock rather than from the site's, so the dwell reads as elapsed
 * time here and never as a difference between two clocks that were never synchronised.
 */
export function summariseHealth(
	site: string,
	body: Record<string, unknown>,
	nowMs: number,
	degraded: Degradation | null = null
): RepairReport {
	const state = readRepairState(body['repair']);
	const rollbackRaw = asRecord(body['rollback']);
	const advisoriesRaw = asRecord(body['advisories']);
	const report: RepairReport = {
		site,
		rung: state.rung,
		code: state.code,
		strikes: state.strikes,
		quarantined: body['quarantined'] === true || state.rung === 'quarantine',
		quarantinedAt: state.quarantinedAt,
		heldMs: state.quarantinedAt === null ? null : Math.max(0, nowMs - state.quarantinedAt),
		rollback: {
			rollback: rollbackRaw['rollback'] === true,
			reason: str(rollbackRaw['reason'], 'the site reported no rollback decision')
		},
		advisories:
			Object.keys(advisoriesRaw).length === 0
				? null
				: {
						state: str(advisoriesRaw['state'], 'unknown'),
						insecure: int(advisoriesRaw['insecure']) ?? 0,
						detail: str(advisoriesRaw['detail'])
					},
		version: readVersion(body['version']),
		degraded,
		findings: readFindings(body['lastFindings']),
		ledger: readLedger(body['ledger']),
		ledgerRows: int(body['ledgerRows']),
		released: body['released'] !== undefined,
		notes: []
	};

	if (report.quarantined) {
		report.notes.push(
			'a quarantined site still serves; writes and the fill lane are what stop. `--release --yes` clears it'
		);
	}
	if (report.rollback.rollback) {
		report.notes.push(
			'the site has decided to roll back on its next alarm; drangler reports that decision and does not drive it'
		);
	}
	if (report.advisories?.state === 'insecure') {
		report.notes.push(
			`${report.advisories.insecure} project(s) carry a security advisory: ${report.advisories.detail}`
		);
	}
	if (report.degraded !== null) {
		report.notes.push(
			`the site is shedding load at the ${report.degraded.level} level, driven by ${report.degraded.driver}`
		);
	}
	if (report.version === null) {
		report.notes.push(
			'this worker reports no version, so which code answered cannot be named from here'
		);
	}
	return report;
}

function readFindings(value: unknown): HealthFinding[] {
	if (!Array.isArray(value)) return [];
	return value.map((raw) => {
		const row = asRecord(raw);
		return {
			code: str(row['code'], 'unknown'),
			severity: str(row['severity'], 'info'),
			scope: str(row['scope']),
			context: str(row['context'])
		};
	});
}

function readLedger(value: unknown): LedgerRow[] {
	if (!Array.isArray(value)) return [];
	return value.map((raw) => {
		const row = asRecord(raw);
		return {
			ts: int(row['ts']) ?? 0,
			code: str(row['code'], 'unknown'),
			severity: str(row['severity'], 'info'),
			scope: str(row['scope']),
			action: str(row['action']),
			outcome: str(row['outcome'])
		};
	});
}

/** whether anything here needs a person; the two that do are what `heal` exits 3 on */
export function healthVerdict(report: RepairReport): 'clean' | 'quarantined' | 'rollback-pending' {
	if (report.rollback.rollback) return 'rollback-pending';
	if (report.quarantined) return 'quarantined';
	return 'clean';
}

/** `2700000` as `45m`; the dwell a user compares against the site's own reason string */
export function elapsed(ms: number | null): string {
	if (ms === null) return '-';
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function iso(ms: number | null): string {
	return ms === null ? '-' : new Date(ms).toISOString();
}

export function renderRepair(report: RepairReport): string[] {
	const rows: [string, string][] = [
		['site', report.site],
		['rung', report.rung],
		['code', report.code ?? '-'],
		['strikes', `${report.strikes} of ${QUARANTINE_STRIKES}`],
		[
			'since',
			report.quarantinedAt === null
				? '-'
				: `${iso(report.quarantinedAt)} (${elapsed(report.heldMs)})`
		],
		['rollback', `${report.rollback.rollback ? 'yes' : 'no'} -- ${report.rollback.reason}`],
		[
			'advisories',
			report.advisories === null
				? '-'
				: `${report.advisories.state}${report.advisories.detail === '' ? '' : `: ${report.advisories.detail}`}`
		],
		[
			'degraded',
			report.degraded === null
				? 'no'
				: `${report.degraded.level} (${report.degraded.driver} ${report.degraded.fraction ?? '?'})`
		],
		[
			'version',
			report.version === null
				? '-'
				: `${report.version.id}${report.version.tag === null ? '' : ` (${report.version.tag})`}`
		]
	];
	if (report.released) rows.push(['released', 'the quarantine was cleared by this run']);
	const lines = kv(rows);

	if (report.findings.length > 0) {
		lines.push('', 'findings');
		for (const finding of report.findings) {
			lines.push(`  ${finding.severity}  ${finding.code}  ${finding.context}`);
		}
	}
	if (report.ledger.length > 0) {
		lines.push(
			'',
			`ledger (last ${report.ledger.length}${report.ledgerRows === null ? '' : ` of ${report.ledgerRows}`})`,
			...table(
				['when', 'severity', 'code', 'scope', 'action', 'outcome'],
				report.ledger.map((row) => [
					iso(row.ts),
					row.severity,
					row.code,
					row.scope,
					row.action,
					row.outcome
				])
			)
		);
	}
	if (report.notes.length > 0) {
		lines.push('', 'notes');
		for (const note of report.notes) lines.push(`  - ${note}`);
	}
	return lines;
}

/**
 * The class a repair falls into, from `worker/docs/configuration.md`'s repair surface.
 *
 * The worker documents these three words and this reads them rather than inventing a parallel
 * vocabulary: **safe** changes nothing a visitor sees, **rebuild** discards derived state that comes
 * back on its own, **stateful** changes what the site serves.
 *
 * The class is the blast radius. What a repair needs on top of `--yes` is its own two flags, because
 * two stateful repairs can differ: releasing a quarantine re-quarantines after three more strikes,
 * and a `hook_update_N` has no rollback any route reaches.
 */
export type RepairClass = 'safe' | 'rebuild' | 'stateful';

export interface Repair {
	id: string;
	klass: RepairClass;
	/** whether `--auto` may perform it unattended */
	auto: boolean;
	/** whether it needs an explicit `--snapshot` / `--no-snapshot`, because nothing else undoes it */
	needsSnapshot: boolean;
	/** what it does to the site, in one clause a person reads before consenting */
	blastRadius: string;
	/** how to undo it, or why nothing can */
	rollback: string;
}

/**
 * Every repair a `heal` flag drives.
 *
 * **A withdrawn replica lane is not here and does not need to be.** A lane that withdrew asks the
 * primary for a fresh copy itself and the primary queues it and arms an alarm, so there is nothing
 * for an operator to drive; `/replica` also carries the path a lane uses to commit a speculative
 * batch, which belongs to the pool rather than to whoever holds the owner token. It is
 * diagnostic-only, and lane state is read through `/health`. This used to name `/serve-stats`
 * beside it, which nothing here reads -- `/serve-stats` is owner-reachable now, so a command that
 * wants the object's own meters can take it, but no code path did and the sentence implied one.
 */
export const REPAIRS: Record<string, Repair> = {
	release: {
		id: 'release',
		klass: 'stateful',
		auto: true,
		needsSnapshot: false,
		blastRadius: 'this site serves whatever the quarantine was stopping',
		rollback: 're-quarantines after three more strikes on the same code'
	},
	replay: {
		id: 'replay',
		klass: 'stateful',
		auto: true,
		needsSnapshot: false,
		blastRadius: 'none; the replay cursor only advances',
		rollback: 'none needed'
	},
	armfill: {
		id: 'armfill',
		klass: 'rebuild',
		auto: false,
		needsSnapshot: false,
		blastRadius: 'the rows the queued fills write',
		rollback: 'none; the pages it warms would have been rendered by a visitor'
	},
	invalidate: {
		id: 'invalidate',
		klass: 'rebuild',
		auto: false,
		needsSnapshot: false,
		blastRadius: 'the tagged pages re-render',
		rollback: 'none; a stored page comes back on the next fill'
	},
	bump: {
		id: 'bump',
		klass: 'rebuild',
		auto: false,
		needsSnapshot: false,
		blastRadius: 'THE WHOLE SITE re-renders; every stored page is retired at once',
		rollback: 'none; every page comes back one fill at a time'
	},
	unpin: {
		id: 'unpin',
		klass: 'stateful',
		auto: false,
		needsSnapshot: false,
		blastRadius:
			'the poller owns the branch again, so the next successful poll replaces that tree',
		rollback: 'pin it again by previewing the same pull request'
	},
	updb: {
		id: 'updb',
		klass: 'stateful',
		auto: false,
		needsSnapshot: true,
		blastRadius: "one site's schema; a beat can execute a hook_update_N",
		rollback: 'updbRollback() exists on the worker and no route reaches it'
	}
};

export type SnapshotDecision = 'taken' | 'declined' | 'undecided';

export interface RepairGate {
	allowed: boolean;
	/** why not, when it is not */
	reason: string | null;
	/** the flag that would allow it */
	flag: string | null;
}

/**
 * Whether one repair may run, given consent, a snapshot decision and how loaded the site is.
 *
 * A site in `reduced` or `read-only` refuses the REBUILD class with the driver named, because
 * spending the meter it is already shedding on is how a repair becomes the outage. A repair that
 * declares `needsSnapshot` refuses without a decision even WITH `--yes`, because the only rollback a
 * CLI has for it is the snapshot it took.
 */
export function gateRepair(
	repair: Repair,
	consent: { yes: boolean; snapshot: SnapshotDecision; degraded: Degradation | null }
): RepairGate {
	if (!consent.yes) {
		return {
			allowed: false,
			reason: `${repair.id} writes to a live site: ${repair.blastRadius}`,
			flag: '--yes'
		};
	}
	if (repair.klass === 'rebuild' && consent.degraded !== null) {
		return {
			allowed: false,
			reason: `the site is shedding load at the ${consent.degraded.level} level, driven by ${consent.degraded.driver}, and ${repair.id} spends that same meter`,
			flag: null
		};
	}
	if (repair.needsSnapshot && consent.snapshot === 'undecided') {
		return {
			allowed: false,
			reason: `${repair.id} changes the schema and ${repair.rollback}`,
			flag: '--snapshot <dir> or --no-snapshot'
		};
	}
	return { allowed: true, reason: null, flag: null };
}
