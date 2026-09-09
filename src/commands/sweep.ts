import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { DranglerError, FindingError } from '../errors';
import { emit, kv } from '../format';
import { ownerCall, ownerTarget } from '../owner';

/**
 * Why the governor stopped, in the worker's own words.
 *
 * `floor` is the one an operator has to act on: the site is at or past the point where the quota
 * ladder has already stopped cron, the queue and image regeneration. The rest are the sweep working.
 */
export const SWEEP_BOUNDS: Record<string, string> = {
	floor: 'a daily meter is past the point where the quota ladder stops discretionary work',
	'daily-cap': "the sweep's declared share of today is spent; it resumes at 00:00 UTC",
	remaining: 'the share of what is left this step is spent; it resumes on the next interval',
	batch: 'one step queues at most one fill batch',
	backlog: 'the fill queue still has work, so the sweep yields to it',
	covered: 'every addressable path is stored, queued or proven unstorable'
};

/** the two vars an operator sets; `SWEEP_ROWS_FRACTION` is clamped to this range on the site */
export const SWEEP_FRACTION_RANGE = { min: 0.01, max: 0.5 };

export interface SweepCoverageView {
	addressable: number;
	covered: number;
	pending: number;
	/** 1 when there is nothing addressable, because no pages is covered rather than uncovered */
	fraction: number;
}

export interface SweepReport {
	site: string;
	/** whether this run asked the site to take a step */
	forced: boolean;
	/** `sweepEnabled()` on the site, so an off sweep is read rather than inferred */
	enabled: boolean | null;
	/** whether THIS call took a step; false on a read, and on a forced call the site refused */
	ran: boolean;
	/** why a forced call took no step, in the site's words */
	skipped: string | null;
	/** the site has recorded no sweep, so the report below is empty rather than stale */
	never: boolean;
	/** the last step that queued something, as an epoch ms; null when none ever has */
	at: number | null;
	ok: boolean | null;
	queued: number | null;
	boundBy: string | null;
	reason: string | null;
	cost: { rows: number; doRequests: number } | null;
	coverage: SweepCoverageView | null;
	cursor: Record<string, unknown> | null;
	/** the sweep threw on the site; it is caught there so an alarm cannot be taken down by one */
	error: string | null;
	notes: string[];
}

export interface SweepOptions {
	/** force a step now; the site skips its interval on this path and the alarm chain does not */
	run?: boolean;
	globals: GlobalOptions;
}

/**
 * Reports what fraction of a site's addressable space has a stored page, and what stopped the sweep.
 *
 * Four answers the route separates and this must not collapse: the sweep is off (`enabled`), it is on
 * and has never stepped (`sweep` null), this call forced a step (`ran`), and the governor declined
 * (`boundBy` plus `reason`). A report with no step behind it is from an earlier firing, and saying so
 * is what stops a stale coverage figure being read as this call's answer.
 */
export async function runSweep(
	ctx: Context,
	target: string | undefined,
	opts: SweepOptions
): Promise<void> {
	const owner = ownerTarget(opts.globals, target);
	const forced = opts.run === true && !opts.globals.dryRun;
	const report: SweepReport = {
		site: owner.origin,
		forced,
		enabled: null,
		ran: false,
		skipped: null,
		never: true,
		at: null,
		ok: null,
		queued: null,
		boundBy: null,
		reason: null,
		cost: null,
		coverage: null,
		cursor: null,
		error: null,
		notes: []
	};

	const reply = await ownerCall(ctx, owner, '/sweep', forced ? { params: { run: '1' } } : {});
	if (reply.status >= 400) {
		throw new DranglerError('sweep', `${owner.origin} refused /sweep (${reply.status})`);
	}
	if (opts.run === true && opts.globals.dryRun) {
		report.notes.push('dry run: the report was read and no step was asked for');
	}

	const sweep = reply.body['sweep'] as Record<string, unknown> | null | undefined;
	report.at = numberOrNull(reply.body['at']);
	report.enabled = typeof reply.body['enabled'] === 'boolean' ? reply.body['enabled'] : null;
	report.ran = reply.body['ran'] === true;
	report.skipped = stringOrNull(reply.body['skipped']);
	if (sweep !== null && sweep !== undefined) {
		report.never = false;
		report.error = stringOrNull(sweep['error']);
		report.ok = typeof sweep['ok'] === 'boolean' ? sweep['ok'] : null;
		report.queued = numberOrNull(sweep['queued']);
		report.boundBy = stringOrNull(sweep['boundBy']);
		report.reason = stringOrNull(sweep['reason']);
		report.cost = readCost(sweep['cost']);
		report.coverage = readCoverage(sweep['coverage']);
		report.cursor = (sweep['cursor'] as Record<string, unknown> | undefined) ?? null;
	}

	note(report);
	emit(ctx.io, opts.globals.json, report, () => render(report));

	if (report.boundBy === 'floor') {
		throw new FindingError(
			'sweep-refused',
			report.reason ?? 'a daily meter is past the floor the sweep will not start below'
		);
	}
}

function note(report: SweepReport): void {
	// `enabled` is the site's own `sweepEnabled()`, so an off sweep and one that has simply not run
	// yet are two different notes rather than one hedged sentence covering both
	if (report.enabled === false) {
		report.notes.push(
			'`SWEEP` is off on this site; set it to anything other than `0` to switch it on, and ' +
				`\`SWEEP_ROWS_FRACTION\` between ${SWEEP_FRACTION_RANGE.min} and ${SWEEP_FRACTION_RANGE.max} to declare its share of the day`
		);
		if (report.skipped !== null) report.notes.push(`the site drove no step: ${report.skipped}`);
		return;
	}
	if (report.skipped !== null) report.notes.push(`the site drove no step: ${report.skipped}`);
	if (report.never) {
		report.notes.push(
			'the sweep is on and has recorded no step yet; --run forces one off its interval'
		);
		return;
	}
	if (report.forced) {
		report.notes.push(
			report.ran
				? 'this report is the step this call forced'
				: 'no step was taken, so this report is from an earlier firing'
		);
	}
	if (report.error !== null) {
		report.notes.push(
			'the sweep threw on the site and was caught there, so the alarm that serves the site kept running'
		);
	}
	const bound = report.boundBy === null ? undefined : SWEEP_BOUNDS[report.boundBy];
	if (bound !== undefined) report.notes.push(bound);
	report.notes.push(
		'the sweep queues and never renders; the fill batch the alarm already runs drains what it queued'
	);
	if (report.at === null) {
		report.notes.push(
			'no step has queued a path yet, so there is no last-swept time to report'
		);
	}
}

function render(report: SweepReport): string[] {
	const coverage = report.coverage;
	const rows: [string, string][] = [
		['site', report.site],
		['sweep', report.enabled === null ? '-' : report.enabled ? 'on' : 'off'],
		[
			'coverage',
			coverage === null
				? '-'
				: `${coverage.covered} of ${coverage.addressable} addressable (${percent(coverage.fraction)}), ${coverage.pending} pending`
		],
		[
			'last step',
			report.never
				? 'never run'
				: `${(report.ok ?? false) ? 'queued' : 'refused'}${report.ran ? ', forced by this call' : ''}`
		],
		['queued', report.queued === null ? '-' : String(report.queued)],
		['bound by', report.boundBy ?? '-'],
		['reason', report.reason ?? (report.never ? 'no sweep has run on this site' : '-')],
		[
			'cost',
			report.cost === null
				? '-'
				: `${report.cost.rows} rows, ${report.cost.doRequests} DO request(s)`
		],
		['last queued at', report.at === null ? 'never' : new Date(report.at).toISOString()]
	];
	if (report.error !== null) rows.push(['error', report.error]);
	const spent = report.cursor;
	if (spent !== null) {
		rows.push([
			'spent today',
			`${Number(spent['rowsSpent'] ?? 0)} rows over ${Number(spent['pages'] ?? 0)} pages` +
				(spent['done'] === true ? ', nothing left at this generation' : '')
		]);
	}
	const lines = kv(rows);
	if (report.notes.length > 0) {
		lines.push('', 'notes');
		for (const note of report.notes) lines.push(`  - ${note}`);
	}
	return lines;
}

/** a fraction as a percentage with one decimal, so 0.0417 does not render as 4% */
function percent(fraction: number): string {
	return `${(fraction * 100).toFixed(1)}%`;
}

function readCost(value: unknown): { rows: number; doRequests: number } | null {
	if (value === null || typeof value !== 'object') return null;
	const cost = value as Record<string, unknown>;
	return { rows: Number(cost['rows'] ?? 0), doRequests: Number(cost['doRequests'] ?? 0) };
}

function readCoverage(value: unknown): SweepCoverageView | null {
	if (value === null || typeof value !== 'object') return null;
	const coverage = value as Record<string, unknown>;
	const addressable = Number(coverage['addressable'] ?? 0);
	const covered = Number(coverage['covered'] ?? 0);
	return {
		addressable,
		covered,
		pending: Number(coverage['pending'] ?? addressable - covered),
		fraction: Number(coverage['fraction'] ?? (addressable === 0 ? 1 : covered / addressable))
	};
}

function numberOrNull(value: unknown): number | null {
	const n = Number(value);
	return value === undefined || value === null || !Number.isFinite(n) ? null : n;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}
