import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { DranglerError, UsageError } from '../errors';
import { emit, kv } from '../format';
import { ownerCall, ownerTarget } from '../owner';

/**
 * Point-in-time recovery, which had no command and no button.
 *
 * The platform keeps a 30-day change log for a Durable Object's SQLite and exposes it as bookmarks,
 * and the worker's own `/pitr` docblock says the thing that makes this matter: **there is no
 * wrangler command and no dashboard button, so without a route an operator cannot reach the window
 * at all.** The route existed and was diagnostic-only, which meant the supported way to recover a
 * site was to first expose arbitrary SQL to the internet.
 *
 * `drangler migrate restore` is a different thing and the names are easy to confuse: that replays a
 * dump from a local file. This reaches the platform's own log and needs nothing on disk.
 *
 * A restore is SCHEDULED rather than performed: the platform applies it on the object's next start,
 * and the call that schedules it is the only place the undo bookmark can be obtained. Losing that
 * value loses the ability to reverse the restore, so it is printed even in JSON mode and the command
 * refuses to schedule without `--yes`.
 */

export interface RecoverOptions {
	/** an ISO timestamp or epoch ms to resolve to a bookmark */
	at?: string;
	/** the bookmark to schedule; mutually exclusive with a bare read */
	bookmark?: string;
	/** required before anything is scheduled */
	yes?: boolean;
	globals: GlobalOptions;
}

export interface RecoverReport {
	site: string;
	/** whether the back end keeps a change log at all; false is a refusal, not an error */
	supported: boolean;
	/** the bookmark for right now, on a read */
	current: string | null;
	/** the time asked about, and the bookmark it resolved to */
	at: string | null;
	resolved: string | null;
	/** what a schedule wrote, and the value that reverses it */
	scheduled: string | null;
	undo: string | null;
	windowDays: number | null;
	error: string | null;
	notes: string[];
}

/** Reads the recovery window, resolves a time to a bookmark, or schedules a restore. */
export async function runRecover(
	ctx: Context,
	target: string | undefined,
	opts: RecoverOptions
): Promise<void> {
	const owner = ownerTarget(opts.globals, target);
	const report: RecoverReport = {
		site: owner.origin,
		supported: false,
		current: null,
		at: null,
		resolved: null,
		scheduled: null,
		undo: null,
		windowDays: null,
		error: null,
		notes: []
	};

	if (opts.bookmark !== undefined) {
		if (opts.yes !== true) {
			throw new UsageError(
				"scheduling a restore replaces this site's database on its next start; pass --yes to confirm"
			);
		}
		if (opts.globals.dryRun) {
			report.notes.push('dry run: nothing was scheduled');
			emit(ctx.io, opts.globals.json, report, () => render(report));
			return;
		}
		const reply = await ownerCall(ctx, owner, '/pitr', {
			method: 'POST',
			params: { bookmark: opts.bookmark }
		});
		if (reply.status >= 400) {
			report.error = String(reply.body['error'] ?? `HTTP ${reply.status}`);
			emit(ctx.io, opts.globals.json, report, () => render(report));
			throw new DranglerError(
				'recover',
				`${owner.origin} refused the restore: ${report.error}`
			);
		}
		report.supported = true;
		report.scheduled = stringOrNull(reply.body['scheduled']);
		report.undo = stringOrNull(reply.body['undo']);
		report.notes.push('applied on the next start of this object, not now');
		if (report.undo) {
			// the only place this value exists; there is no second call that can produce it
			report.notes.push(`keep this undo bookmark, it is the only way back: ${report.undo}`);
		}
		emit(ctx.io, opts.globals.json, report, () => render(report));
		return;
	}

	const params = opts.at === undefined ? {} : { at: opts.at };
	const reply = await ownerCall(ctx, owner, '/pitr', { params });
	report.supported = reply.body['supported'] === true;
	report.error = stringOrNull(reply.body['error']);
	report.current = stringOrNull(reply.body['current']);
	report.at = stringOrNull(reply.body['at']);
	report.resolved = stringOrNull(reply.body['bookmark']);
	report.windowDays =
		typeof reply.body['windowDays'] === 'number' ? reply.body['windowDays'] : null;

	// 501 is the back end saying it keeps no change log, which is a state rather than a failure;
	// 400 is a bad argument and is one
	if (reply.status === 501 || report.supported === false) {
		report.notes.push(
			'this storage back end keeps no change log, so there is no recovery window here; `drangler migrate export` is what protects the site instead'
		);
		emit(ctx.io, opts.globals.json, report, () => render(report));
		return;
	}
	if (reply.status >= 400) {
		emit(ctx.io, opts.globals.json, report, () => render(report));
		throw new DranglerError(
			'recover',
			`${owner.origin} refused /pitr: ${report.error ?? reply.status}`
		);
	}
	if (report.resolved) {
		report.notes.push(`schedule it with: drangler recover --bookmark ${report.resolved} --yes`);
	}
	emit(ctx.io, opts.globals.json, report, () => render(report));
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

function render(report: RecoverReport): string[] {
	const rows: [string, string][] = [
		['site', report.site],
		['recovery log', report.supported ? 'available' : 'not available']
	];
	if (report.windowDays !== null) rows.push(['window', `${report.windowDays} days`]);
	if (report.current) rows.push(['bookmark now', report.current]);
	if (report.at) rows.push(['asked about', report.at]);
	if (report.resolved) rows.push(['bookmark then', report.resolved]);
	if (report.scheduled) rows.push(['scheduled', report.scheduled]);
	if (report.undo) rows.push(['undo', report.undo]);
	if (report.error) rows.push(['error', report.error]);
	return [...kv(rows), ...report.notes.map((n) => `  ${n}`)];
}
