import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { DranglerError, FindingError } from '../errors';
import { emit, kv, table } from '../format';
import { ownerCall, ownerTarget, type OwnerReply, type OwnerTarget } from '../owner';

/** a step that ran and left the site still owing it; the one state that needs a human */
export const STUCK_STATE = 'failed';

export interface ReconcileStepView {
	id: string;
	/** the pack version the step was introduced at */
	since: number;
	describe: string;
	/** `applied`, `satisfied`, `owed`, `deferred` or `failed` */
	state: string;
	detail: string;
}

export interface ReconcileReport {
	site: string;
	/** the highest pack version this site has fully reached */
	version: number | null;
	/** the version the deployed pack reconciles to */
	packVersion: number | null;
	/** null when either version could not be read */
	behind: number | null;
	steps: ReconcileStepView[];
	owed: number;
	deferred: number;
	failed: number;
	/** how many times this run posted a step */
	posts: number;
	/** how many of those posts the site actually drove a step for */
	drove: number;
	/** the last step payload the site reported, which may predate this run */
	last: Record<string, unknown> | null;
	/** why the last post drove nothing, in the site's words; null when it drove something */
	skipped: string | null;
	/** the step an operator has to act on, or null */
	stuck: ReconcileStepView | null;
	notes: string[];
}

export interface ReconcileOptions {
	/** drive exactly one step */
	run?: boolean;
	/** drive steps until the site drives nothing or a step reports failed */
	all?: boolean;
	globals: GlobalOptions;
}

/**
 * Reads what a site still owes the pack that ships today, and drives the steps it owes.
 *
 * The pack delivers only at provisioning, so a fix that lands in it reaches new sites and no
 * existing one. `alarm()` drives one step per firing on its own; this is for an operator who wants a
 * fix now rather than at the next firing.
 */
export async function runReconcile(
	ctx: Context,
	target: string | undefined,
	opts: ReconcileOptions
): Promise<void> {
	const owner = ownerTarget(opts.globals, target);
	const report = emptyReport(owner.origin);

	if (opts.globals.dryRun) {
		fold(report, await read(ctx, owner, false));
		if (opts.run === true || opts.all === true) {
			report.notes.push('dry run: the standing was read and no step was driven');
		}
		finish(ctx, opts, report);
		return;
	}

	fold(report, await read(ctx, owner, false));
	if (opts.run !== true && opts.all !== true) {
		finish(ctx, opts, report);
		return;
	}

	// `ran` is THIS call's outcome and null when the site drove nothing, so it is the terminator.
	// A step that ran and did not converge is recorded `failed` immediately, which `stuck` catches
	// on the same reading; between them there is no way for another post to be worth making.
	const posts = opts.all === true ? report.steps.length + 1 : 1;
	for (let i = 0; i < posts; i++) {
		fold(report, await read(ctx, owner, true));
		report.posts++;
		ctx.io.err(`reconcile: version ${report.version ?? '?'}, ${report.owed} owed`);
		if (report.skipped !== null || report.stuck !== null) break;
		report.drove++;
	}

	finish(ctx, opts, report);
}

function emptyReport(site: string): ReconcileReport {
	return {
		site,
		version: null,
		packVersion: null,
		behind: null,
		steps: [],
		owed: 0,
		deferred: 0,
		failed: 0,
		posts: 0,
		drove: 0,
		last: null,
		skipped: null,
		stuck: null,
		notes: []
	};
}

async function read(ctx: Context, owner: OwnerTarget, post: boolean): Promise<OwnerReply> {
	const reply = await ownerCall(ctx, owner, '/reconcile', post ? { method: 'POST' } : {});
	if (reply.status >= 400) {
		throw new DranglerError(
			'reconcile',
			`${owner.origin} refused /reconcile (${reply.status})`
		);
	}
	return reply;
}

function fold(report: ReconcileReport, reply: OwnerReply): void {
	const body = reply.body;
	report.version = numberOrNull(body['version']);
	report.packVersion = numberOrNull(body['packVersion']);
	report.behind =
		report.version === null || report.packVersion === null
			? null
			: Math.max(0, report.packVersion - report.version);
	report.steps = readSteps(body['steps']);
	report.owed = report.steps.filter((s) => s.state === 'owed').length;
	report.deferred = report.steps.filter((s) => s.state === 'deferred').length;
	report.failed = report.steps.filter((s) => s.state === STUCK_STATE).length;
	report.stuck = report.steps.find((s) => s.state === STUCK_STATE) ?? null;
	// only a POST carries these two, and only a POST that drove nothing carries `skipped`
	report.skipped = stringOrNull(body['skipped']);
	// `ran` is this call's outcome; `last` is whatever the site recorded before it, including the
	// firing that parked on a deferred step
	report.last = unwrap(body['ran']) ?? unwrap(body['last']);
}

/** a reconcile payload is `{reconcile: {...}}`; anything else is passed through as it arrived */
function unwrap(payload: unknown): Record<string, unknown> | null {
	if (payload === null || typeof payload !== 'object') return null;
	const inner = (payload as Record<string, unknown>)['reconcile'];
	if (inner !== null && typeof inner === 'object') return inner as Record<string, unknown>;
	return payload as Record<string, unknown>;
}

function readSteps(value: unknown): ReconcileStepView[] {
	if (!Array.isArray(value)) return [];
	return value.map((raw) => {
		const step = (raw ?? {}) as Record<string, unknown>;
		return {
			id: String(step['id'] ?? ''),
			since: Number(step['since'] ?? 0),
			describe: String(step['describe'] ?? ''),
			state: String(step['state'] ?? 'unknown'),
			detail: String(step['detail'] ?? '')
		};
	});
}

function finish(ctx: Context, opts: ReconcileOptions, report: ReconcileReport): void {
	note(report);
	emit(ctx.io, opts.globals.json, report, () => render(report));
	if (report.stuck !== null) {
		throw new FindingError(
			'reconcile-failed',
			`${report.stuck.id} ran and left the site still owing it: ${report.stuck.detail}`
		);
	}
	if (refusal(report) !== null) {
		throw new FindingError('reconcile-refused', refusal(report) as string);
	}
}

/**
 * A site that was asked to drive a step, drove none, and is still behind.
 *
 * Not every such site is a finding. A chain parked on a deferred step drives nothing for as long as
 * the step cannot be decided, which on a site nobody claims is forever, and waiting there is the
 * correct behaviour rather than a fault to exit 3 on. `RECONCILE=0` and a replica lane are the two
 * that mean a fix an operator asked for did not arrive.
 */
function refusal(report: ReconcileReport): string | null {
	if (report.skipped === null || report.behind === null || report.behind === 0) return null;
	if (parked(report)) return null;
	return `${report.site} drove no step and is ${report.behind} version(s) behind: ${report.skipped}`;
}

/**
 * Whether the chain is parked on a deferred step.
 *
 * Read from the step states and the `waiting` payload rather than by matching the `skipped` text.
 * The reason string is written for a person and may be reworded; the states are the report's own
 * structure, and pattern-matching a message is what the error-code table exists to avoid.
 */
function parked(report: ReconcileReport): boolean {
	return report.owed === 0 && (report.deferred > 0 || report.last?.['waiting'] !== undefined);
}

function note(report: ReconcileReport): void {
	if (report.behind === 0 && report.failed === 0) {
		report.notes.push('this site is at the version the deployed pack reconciles to');
	}
	if (report.owed > 0 && report.posts === 0) {
		report.notes.push(
			'the alarm chain drives one step per firing on its own; --run drives one now, --all drives until the site drives nothing'
		);
	}
	if (report.skipped !== null && report.posts > 0) {
		report.notes.push(`the site drove nothing: ${report.skipped}`);
	}
	if (report.deferred > 0) {
		report.notes.push(
			'a deferred step cannot be decided yet and waiting is correct; claiming the site is what settles the two that read its birthday'
		);
	}
	if (report.stuck !== null) {
		report.notes.push(
			'a failed step stops being retried after three attempts, so it stays visible here rather than owning the alarm chain'
		);
	}
	const error = report.last?.['error'];
	if (typeof error === 'string' && error !== '') {
		report.notes.push(`the last step reported: ${error}`);
	}
	const waiting = report.last?.['waiting'];
	if (typeof waiting === 'string' && waiting !== '') {
		report.notes.push(`the chain is waiting on ${waiting}: ${String(report.last?.['reason'])}`);
	}
}

function render(report: ReconcileReport): string[] {
	const rows: [string, string][] = [
		['site', report.site],
		[
			'version',
			report.version === null
				? '-'
				: `${report.version} of ${report.packVersion ?? '?'}` +
					(report.behind !== null && report.behind > 0
						? ` (${report.behind} behind)`
						: '')
		],
		[
			'outstanding',
			report.owed + report.deferred + report.failed === 0
				? 'nothing'
				: `${report.owed} owed, ${report.deferred} deferred, ${report.failed} failed`
		]
	];
	if (report.posts > 0) {
		rows.push(['driven', `${report.drove} step(s) over ${report.posts} request(s)`]);
	}
	if (report.stuck !== null) rows.push(['stuck', `${report.stuck.id}: ${report.stuck.detail}`]);
	const lines = kv(rows);
	if (report.steps.length > 0) {
		lines.push(
			'',
			...table(
				['step', 'since', 'state', 'detail'],
				report.steps.map((s) => [s.id, String(s.since), s.state, s.detail || s.describe])
			)
		);
	}
	if (report.notes.length > 0) {
		lines.push('', 'notes');
		for (const note of report.notes) lines.push(`  - ${note}`);
	}
	return lines;
}

function numberOrNull(value: unknown): number | null {
	const n = Number(value);
	return value === undefined || value === null || !Number.isFinite(n) ? null : n;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}
