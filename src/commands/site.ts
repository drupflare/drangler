import { globalConfigPath, type DranglerConfig } from '../config/file';
import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { DranglerError, FindingError, UsageError } from '../errors';
import { emit, kv, table } from '../format';
import { probeSite } from '../health/probe';
import {
	ownerCall,
	ownerTarget,
	pause,
	replyError,
	siteOriginOf,
	type OwnerTarget
} from '../owner';
import { runDeployCommand, type RunCommandOptions } from './workspace';

/** phases in which the update chain does no more work; `UPDB_PHASES` on the worker side */
export const TERMINAL_UPDB_PHASES = ['complete', 'halted', 'rolled_back', 'abandoned'];

/** how long a poll waits between reads when nothing says otherwise */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** how long `site upgrade` waits for a replay and an update chain, in total */
export const DEFAULT_WAIT_MS = 600_000;

export interface ClaimOptions {
	/** the Drupal site title, which is the `siteName` the route's body carries */
	title?: string;
	adminPass?: string;
	adminMail?: string;
	/** reconfigure a site that is already claimed; needs the owner token */
	force?: boolean;
	/** write the minted token to the global config without asking */
	save?: boolean;
	globals: GlobalOptions;
}

export interface SiteClaimReport {
	site: string;
	siteName: string;
	claimed: boolean;
	/** somebody claimed it before this run did */
	alreadyClaimed: boolean;
	/** minted by the site and shown once; null when the caller supplied one */
	adminPass: string | null;
	ownerToken: string | null;
	/** the config file the token was written to, when it was */
	saved: string | null;
	error: string | null;
	notes: string[];
}

/**
 * Claims a site, which is the whole security-relevant moment of a new deploy.
 *
 * The pack ships an INSTALLED database, so Drupal's installer never runs and uid 1 carries a hash
 * no password matches until `/firstrun` mints one. Until that happens the claim is open to whoever
 * reaches the URL first, and the token six owner routes need does not exist.
 *
 * The password goes in a JSON body. The route refuses a `?pass=` query parameter outright and says
 * why: a query string lands in tail, in observability and in every intermediary between here and
 * the object.
 */
export async function runSiteClaim(
	ctx: Context,
	target: string | undefined,
	opts: ClaimOptions
): Promise<void> {
	const { globals } = opts;
	const origin = siteOriginOf(globals, target);
	const owner: OwnerTarget = {
		origin,
		site: globals.config.siteName.value ?? 'site',
		token: globals.config.token.value ?? '',
		timeoutMs: globals.timeoutMs
	};
	if (opts.force === true && owner.token === '') {
		throw new UsageError(
			'--force reconfigures a site that is already claimed, which needs the owner token; pass --token or set DRUPFLARE_OWNER_TOKEN'
		);
	}

	const report: SiteClaimReport = {
		site: origin,
		siteName: owner.site,
		claimed: false,
		alreadyClaimed: false,
		adminPass: null,
		ownerToken: null,
		saved: null,
		error: null,
		notes: []
	};

	if (globals.dryRun) {
		report.notes.push('dry run: nothing was sent');
		emit(ctx.io, globals.json, report, () => renderClaim(report));
		return;
	}

	const reply = await ownerCall(ctx, owner, '/firstrun', {
		method: 'POST',
		...(opts.force === true ? { params: { force: '1' } } : {}),
		body: {
			...(opts.title === undefined ? {} : { siteName: opts.title }),
			...(opts.adminPass === undefined ? {} : { adminPass: opts.adminPass }),
			...(opts.adminMail === undefined ? {} : { adminMail: opts.adminMail })
		}
	});

	if (reply.status === 409) {
		report.alreadyClaimed = true;
		report.error = replyError(reply, 'already configured');
		report.notes.push(
			'somebody has already claimed this site; `--force` reconfigures it and needs the owner token the first claim returned'
		);
		emit(ctx.io, globals.json, report, () => renderClaim(report));
		throw new FindingError('already-claimed', `${origin} was already claimed`);
	}
	if (reply.body['ok'] !== true) {
		report.error = replyError(reply, 'the site refused the claim');
		// the route's own remedy, which is where the `?pass=` refusal explains itself
		const how = reply.body['how'];
		if (typeof how === 'string') report.notes.push(how);
		emit(ctx.io, globals.json, report, () => renderClaim(report));
		throw new DranglerError('claim', report.error);
	}

	report.claimed = true;
	report.adminPass = stringOrNull(reply.body['adminPass']);
	report.ownerToken = stringOrNull(reply.body['ownerToken']);
	report.notes.push('the password and the token are shown once and are stored nowhere else');
	if (report.ownerToken !== null) {
		report.saved = await saveToken(ctx, origin, report.ownerToken, opts.save === true);
	}
	emit(ctx.io, globals.json, report, () => renderClaim(report));
}

/**
 * Writes the token to the GLOBAL config, never to `drangler.json`.
 *
 * `drangler.json` is a file people commit. Without `--save` and without a terminal to ask on the
 * token is printed and nothing is written, which is the right answer in a pipe.
 */
async function saveToken(
	ctx: Context,
	origin: string,
	token: string,
	always: boolean
): Promise<string | null> {
	if (!always) {
		const answer = await ctx.ask(
			`Write the owner token to your global config for ${origin}? (yes/no)`,
			['yes', 'no']
		);
		if (answer !== 'yes') return null;
	}
	const path = globalConfigPath(ctx.env);
	let existing: DranglerConfig = {};
	if (ctx.files.exists(path)) {
		try {
			existing = JSON.parse(ctx.files.readText(path)) as DranglerConfig;
		} catch (e) {
			throw new UsageError(
				`${path} is not valid JSON and claim will not overwrite it: ${e instanceof Error ? e.message : String(e)}`
			);
		}
	}
	const merged: DranglerConfig = {
		...existing,
		sites: { ...existing.sites, [origin]: { ...existing.sites?.[origin], ownerToken: token } }
	};
	ctx.files.writeSecret(path, `${JSON.stringify(merged, null, '\t')}\n`);
	return path;
}

function renderClaim(report: SiteClaimReport): string[] {
	const rows: [string, string][] = [
		['site', report.site],
		['site name', report.siteName],
		['claimed', report.claimed ? 'yes, by this run' : report.alreadyClaimed ? 'already' : 'no']
	];
	if (report.adminPass !== null) rows.push(['admin password', report.adminPass]);
	if (report.ownerToken !== null) rows.push(['owner token', report.ownerToken]);
	rows.push(['token saved to', report.saved ?? 'nowhere; keep it yourself']);
	if (report.error !== null) rows.push(['error', report.error]);
	const lines = kv(rows);
	if (report.notes.length > 0) {
		lines.push('', 'notes');
		for (const note of report.notes) lines.push(`  - ${note}`);
	}
	return lines;
}

export interface UpdbOptions {
	/** advance exactly one beat before reading the cursor */
	step?: boolean;
	/** advance at most n beats, stopping on a terminal phase or a cursor that did not move */
	steps?: string | number;
	/** take an /export into this directory first; a run above one beat needs a decision */
	snapshot?: string;
	/** state that a snapshot was declined; there is no default */
	noSnapshot?: boolean;
	globals: GlobalOptions;
}

export interface UpdbReport {
	site: string;
	/** null on a site whose update chain has never started */
	phase: string | null;
	cursor: number | null;
	max: number | null;
	remaining: number | null;
	haltReason: string | null;
	byState: Record<string, number>;
	stepped: boolean;
	/** how many beats this run drove */
	beats: number;
	/** what the last beat reported, when one was driven */
	beat: Record<string, unknown> | null;
	notes: string[];
}

/**
 * Reads the Drupal update chain, and drives one beat of it.
 *
 * `alarm()` has always run this and nothing could read it or start it: `OPS_DRIVERS` refused a
 * sliced `updb` operation by naming a route that did not exist. `POST` advances exactly one beat
 * and re-arms nothing, so a caller that wants the chain finished polls and each invocation stays
 * inside its own budget the way the alarm chain does.
 */
export async function runSiteUpdb(
	ctx: Context,
	target: string | undefined,
	opts: UpdbOptions
): Promise<void> {
	const owner = ownerTarget(opts.globals, target);
	const budget = beatBudget(opts);

	if (budget === 0 || opts.globals.dryRun) {
		const report = await readUpdb(ctx, owner, false);
		if (budget > 0) report.notes.push('dry run: the cursor was read and no beat was driven');
		emit(ctx.io, opts.globals.json, report, () => renderUpdb(report));
		if (report.phase === 'halted') {
			throw new FindingError('updb-halted', report.haltReason ?? 'the chain is halted');
		}
		return;
	}

	// a beat can execute a hook_update_N, and `updbRollback()` exists on the worker with no route
	// reaching it -- so above one beat the only rollback a CLI has is the snapshot it took
	if (budget > 1 && opts.snapshot === undefined && opts.noSnapshot !== true) {
		throw new UsageError(
			`--steps ${budget} can execute several hook_update_N; pass --snapshot <dir> or --no-snapshot to say which it is`
		);
	}

	let report = await readUpdb(ctx, owner, false);
	let stalled = false;
	for (let beat = 0; beat < budget; beat++) {
		if (report.phase === null || TERMINAL_UPDB_PHASES.includes(report.phase)) break;
		const before = report.cursor;
		const next = await readUpdb(ctx, owner, true);
		next.beats = report.beats + 1;
		report = next;
		ctx.io.err(`updb ${report.phase}, cursor ${report.cursor ?? '?'}`);
		// the terminating OBSERVATION, not just the bound: a beat that leaves the cursor where it
		// was will leave it there every time, and a loop with only a count would spend the rest
		if (report.cursor === before && !TERMINAL_UPDB_PHASES.includes(report.phase ?? '')) {
			stalled = true;
			break;
		}
	}

	emit(ctx.io, opts.globals.json, report, () => renderUpdb(report));
	if (report.phase === 'halted') {
		throw new FindingError('updb-halted', report.haltReason ?? 'the update chain is halted');
	}
	if (stalled) {
		throw new FindingError(
			'updb-stalled',
			`a beat left the cursor at ${report.cursor ?? '?'}; the chain is not advancing`
		);
	}
}

/** how many beats to drive: `--steps` wins, then `--step`, then none */
export function beatBudget(opts: UpdbOptions): number {
	if (opts.steps !== undefined) {
		const n = Number(opts.steps);
		if (!Number.isInteger(n) || n < 1) {
			throw new UsageError(`--steps must be a whole number of beats, not \`${opts.steps}\``);
		}
		return n;
	}
	return opts.step === true ? 1 : 0;
}

async function readUpdb(ctx: Context, owner: OwnerTarget, step: boolean): Promise<UpdbReport> {
	const reply = await ownerCall(ctx, owner, '/updb', step ? { method: 'POST' } : {});
	// a POST answers `{updb, status}` and a GET answers the status alone
	const status = (reply.body['status'] ?? reply.body) as Record<string, unknown>;
	const run = status['run'] as Record<string, unknown> | null | undefined;
	const report: UpdbReport = {
		site: owner.origin,
		phase: run ? String(run['phase']) : null,
		cursor: run ? Number(run['cursorSeq']) : null,
		max: run ? Number(run['maxSeq']) : null,
		remaining: status['remaining'] === undefined ? null : Number(status['remaining']),
		haltReason: run ? stringOrNull(run['haltReason']) : null,
		byState: (status['byState'] as Record<string, number> | undefined) ?? {},
		stepped: step,
		beats: step ? 1 : 0,
		beat: step ? ((reply.body['updb'] as Record<string, unknown> | undefined) ?? null) : null,
		notes: []
	};
	if (report.phase === null) {
		report.notes.push('no update run on this site; nothing has needed one');
	} else if (!TERMINAL_UPDB_PHASES.includes(report.phase)) {
		report.notes.push('re-run with --step to advance one beat, or wait for the alarm chain');
	}
	if (report.phase === 'halted') {
		report.notes.push(
			'a halted run is an operator decision; clearing it is a rollback or an abandon on the site, not a retry'
		);
	}
	return report;
}

function renderUpdb(report: UpdbReport): string[] {
	const rows: [string, string][] = [
		['site', report.site],
		['phase', report.phase ?? 'no run'],
		[
			'cursor',
			report.cursor === null ? '-' : `${report.cursor} of ${report.max ?? report.cursor}`
		],
		['remaining', report.remaining === null ? '-' : String(report.remaining)]
	];
	if (report.haltReason !== null) rows.push(['halted', report.haltReason]);
	if (report.beats > 0) rows.push(['beats', `${report.beats} driven`]);
	const lines = kv(rows);
	const states = Object.entries(report.byState);
	if (states.length > 0) {
		lines.push(
			'',
			...table(
				['state', 'units'],
				states.map(([s, n]) => [s, String(n)])
			)
		);
	}
	if (report.notes.length > 0) {
		lines.push('', 'notes');
		for (const note of report.notes) lines.push(`  - ${note}`);
	}
	return lines;
}

export interface InvalidateOptions {
	/** cache tags to invalidate; the site defaults to `rendered` */
	tags?: string;
	/** bump the generation instead, which invalidates every edge-cached URL for the site */
	bump?: boolean;
	globals: GlobalOptions;
}

export interface InvalidateReport {
	site: string;
	action: 'invalidate' | 'bump';
	tags: string[];
	generationBefore: number | null;
	generationAfter: number | null;
	notes: string[];
}

/**
 * Purges a site's own cache.
 *
 * Both routes used to be reachable only with `PW_DIAGNOSTICS=1`, so the supported way to clear your
 * own page cache was to expose arbitrary SQL to the internet first. They take the owner token now,
 * which is the narrower credential: per site rather than per deployment.
 */
export async function runSiteInvalidate(
	ctx: Context,
	target: string | undefined,
	opts: InvalidateOptions
): Promise<void> {
	const owner = ownerTarget(opts.globals, target);
	const tags = (opts.tags ?? 'rendered')
		.split(',')
		.map((tag) => tag.trim())
		.filter((tag) => tag !== '');
	const report: InvalidateReport = {
		site: owner.origin,
		action: opts.bump === true ? 'bump' : 'invalidate',
		tags: opts.bump === true ? [] : tags,
		generationBefore: null,
		generationAfter: null,
		notes: []
	};

	if (opts.globals.dryRun) {
		report.notes.push('dry run: nothing was purged');
		emit(ctx.io, opts.globals.json, report, () => renderInvalidate(report));
		return;
	}

	const reply =
		report.action === 'bump'
			? await ownerCall(ctx, owner, '/bump', {
					method: 'POST',
					params: { reason: 'drangler' }
				})
			: await ownerCall(ctx, owner, '/invalidate', {
					method: 'POST',
					params: { tags: tags.join(',') }
				});
	report.generationBefore = numberOrNull(reply.body['generationBefore']);
	report.generationAfter = numberOrNull(
		reply.body['generationAfter'] ?? reply.body['generation']
	);
	if (reply.status >= 400) {
		throw new DranglerError('invalidate', replyError(reply, 'the site refused the purge'));
	}
	report.notes.push(
		report.action === 'bump'
			? 'a bump invalidates every edge-cached URL for this site with one integer write'
			: 'tag invalidation runs inside Drupal, so it costs a render rather than an integer'
	);
	emit(ctx.io, opts.globals.json, report, () => renderInvalidate(report));
}

function renderInvalidate(report: InvalidateReport): string[] {
	const lines = kv([
		['site', report.site],
		['action', report.action],
		['tags', report.tags.length === 0 ? '-' : report.tags.join(', ')],
		[
			'generation',
			report.generationAfter === null
				? '-'
				: `${report.generationBefore ?? '?'} -> ${report.generationAfter}`
		]
	]);
	if (report.notes.length > 0) {
		lines.push('', 'notes');
		for (const note of report.notes) lines.push(`  - ${note}`);
	}
	return lines;
}

export interface UpgradeOptions extends Omit<RunCommandOptions, 'globals'> {
	/** skip the deploy and wait on a site somebody else deployed */
	deploy?: boolean;
	/** how long to wait for the replay and the update chain, in total */
	wait?: string | number;
	/** how long between polls; a spec passes 0 */
	interval?: string | number;
	globals: GlobalOptions;
}

export interface UpgradeReport {
	site: string;
	deployed: boolean;
	/** the last replay chunk seen, or null when the site was never replaying */
	migrateChunk: string | null;
	migrateDone: boolean;
	polls: number;
	updb: UpdbReport | null;
	timedOut: boolean;
	notes: string[];
}

/**
 * Deploy, wait for the pack replay, then report the update chain.
 *
 * Resumable rather than restartable: both halves are cursor-driven on the worker side, so a run
 * that ran out of `--wait` continues where it stopped when it is run again.
 *
 * The replay is read from `/serve?edge=0`, which is public, because a fresh object answers 503 with
 * `x-cfw-migrate` until its cursor is done and that header is the only place the chunk appears.
 */
export async function runSiteUpgrade(
	ctx: Context,
	target: string | undefined,
	opts: UpgradeOptions
): Promise<void> {
	const owner = ownerTarget(opts.globals, target);
	const waitMs = numberFlag(opts.wait, DEFAULT_WAIT_MS, '--wait');
	const intervalMs = numberFlag(opts.interval, DEFAULT_POLL_INTERVAL_MS, '--interval');
	const report: UpgradeReport = {
		site: owner.origin,
		deployed: false,
		migrateChunk: null,
		migrateDone: false,
		polls: 0,
		updb: null,
		timedOut: false,
		notes: []
	};

	if (opts.deploy !== false && !opts.globals.dryRun) {
		await runDeployCommand(ctx, [], { ...opts, globals: opts.globals });
		report.deployed = true;
	}
	if (opts.globals.dryRun) {
		report.notes.push('dry run: nothing was deployed and nothing was polled');
		emit(ctx.io, opts.globals.json, report, () => renderUpgrade(report));
		return;
	}

	const deadline = ctx.now().getTime() + waitMs;
	for (;;) {
		report.polls++;
		const probe = await probeSite(
			{ fetch: ctx.fetch },
			{
				target: owner.origin,
				site: owner.site,
				kind: 'worker',
				skipEdge: true,
				timeoutMs: opts.globals.timeoutMs
			}
		);
		const chunk = probe.cfw['x-cfw-migrate'];
		if (chunk === undefined) {
			report.migrateDone = true;
			break;
		}
		report.migrateChunk = chunk;
		ctx.io.err(`replaying the database, chunk ${chunk}`);
		if (ctx.now().getTime() >= deadline) {
			report.timedOut = true;
			break;
		}
		await pause(intervalMs);
	}

	if (report.migrateDone) {
		report.updb = await readUpdb(ctx, owner, false);
		while (
			report.updb.phase !== null &&
			!TERMINAL_UPDB_PHASES.includes(report.updb.phase) &&
			ctx.now().getTime() < deadline
		) {
			await pause(intervalMs);
			report.polls++;
			report.updb = await readUpdb(ctx, owner, true);
			ctx.io.err(`updb ${report.updb.phase}, ${report.updb.remaining ?? '?'} remaining`);
		}
		if (report.updb.phase !== null && !TERMINAL_UPDB_PHASES.includes(report.updb.phase)) {
			report.timedOut = true;
		}
	}
	if (report.timedOut) {
		report.notes.push(
			'ran out of --wait; both halves are cursor-driven, so running this again continues rather than restarting'
		);
	}

	emit(ctx.io, opts.globals.json, report, () => renderUpgrade(report));
	if (report.timedOut) {
		throw new FindingError('upgrade-incomplete', `${owner.origin} has not finished upgrading`);
	}
	if (report.updb?.phase === 'halted') {
		throw new FindingError(
			'updb-halted',
			report.updb.haltReason ?? 'the update chain is halted'
		);
	}
}

function renderUpgrade(report: UpgradeReport): string[] {
	const rows: [string, string][] = [
		['site', report.site],
		['deploy', report.deployed ? 'ran' : 'skipped'],
		[
			'replay',
			report.migrateDone
				? report.migrateChunk === null
					? 'nothing to replay'
					: `done (last chunk ${report.migrateChunk})`
				: `waiting at chunk ${report.migrateChunk ?? '?'}`
		],
		['updb', report.updb === null ? 'not read' : (report.updb.phase ?? 'no run')],
		['polls', String(report.polls)]
	];
	const lines = kv(rows);
	if (report.notes.length > 0) {
		lines.push('', 'notes');
		for (const note of report.notes) lines.push(`  - ${note}`);
	}
	return lines;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

function numberOrNull(value: unknown): number | null {
	const n = Number(value);
	return value === undefined || value === null || !Number.isFinite(n) ? null : n;
}

/** a flag that has to be a number, refused by name rather than silently read as NaN */
export function numberFlag(
	value: string | number | undefined,
	fallback: number,
	flag: string
): number {
	if (value === undefined) return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0) {
		throw new UsageError(`${flag} must be a number of milliseconds, not \`${String(value)}\``);
	}
	return n;
}
