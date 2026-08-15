import { cloudflareApi, compareWorkers } from '../cloudflare/api';
import { requireAccount, requireToken, resolveAuth } from '../cloudflare/auth';
import { captureCommand, parseTailCapture, summariseCpu } from '../cloudflare/tail';
import type { Context } from '../context';
import { FindingError, UsageError } from '../errors';
import { emit, kv, table } from '../format';

export interface JsonOption {
	json?: boolean;
}

/** Reports which Cloudflare credential drangler would use, and what to run when there is none. */
export async function runWhoami(ctx: Context, opts: JsonOption): Promise<void> {
	const auth = await resolveAuth(ctx.runner, ctx.env);
	emit(ctx.io, opts.json === true, auth, () => {
		const lines = kv([
			['wrangler', auth.wrangler ?? 'not installed'],
			['source', auth.source],
			['authenticated', auth.authenticated ? 'yes' : 'no'],
			['email', auth.email ?? '-'],
			['account', auth.accountId ?? '-']
		]);
		if (auth.accounts.length > 1) {
			lines.push('', 'accounts');
			for (const account of auth.accounts) lines.push(`  ${account.id}  ${account.name}`);
		}
		if (auth.remedy !== null) lines.push('', `next: ${auth.remedy}`);
		return lines;
	});
	if (!auth.authenticated)
		throw new FindingError('logged-out', 'not authenticated to Cloudflare');
}

export interface WorkersOptions extends JsonOption {
	account?: string;
	save?: string;
	compare?: string;
}

/**
 * Lists the account's workers, and compares that list against a saved baseline.
 *
 * The baseline half is the point. `drupflare/worker` deploys throwaway `cfw-*` probes into an account
 * that holds real production workers, and its own documentation requires verifying the list returns to
 * exactly its prior state afterwards. Done by eye that step gets skipped; done here it exits 3.
 */
export async function runWorkers(ctx: Context, opts: WorkersOptions): Promise<void> {
	const auth = await resolveAuth(ctx.runner, ctx.env);
	const account = requireAccount(auth, opts.account ?? null);
	const api = cloudflareApi(ctx.fetch, requireToken(ctx.env));
	const workers = await api.listWorkers(account);
	const names = workers.map((w) => w.id);

	if (opts.save !== undefined) {
		ctx.files.writeText(opts.save, `${JSON.stringify({ account, workers: names }, null, 2)}\n`);
	}

	const diff =
		opts.compare === undefined ? null : compareWorkers(readBaseline(ctx, opts.compare), names);

	emit(ctx.io, opts.json === true, { account, workers, diff }, () => {
		const lines = [
			`account ${account}: ${workers.length} worker(s)`,
			'',
			...table(
				['name', 'modified'],
				workers.map((w) => [w.id, w.modifiedOn ?? '-'])
			)
		];
		if (opts.save !== undefined) lines.push('', `baseline written to ${opts.save}`);
		if (diff !== null) {
			lines.push('', diff.same ? 'baseline matches' : 'baseline DIFFERS');
			if (diff.added.length > 0) lines.push(`  added: ${diff.added.join(', ')}`);
			if (diff.removed.length > 0) lines.push(`  removed: ${diff.removed.join(', ')}`);
		}
		return lines;
	});

	if (diff !== null && !diff.same) {
		throw new FindingError(
			'baseline',
			`the worker list differs from ${opts.compare}: ${diff.added.length} added, ${diff.removed.length} removed`
		);
	}
}

function readBaseline(ctx: Context, path: string): string[] {
	if (!ctx.files.exists(path)) throw new UsageError(`no baseline at ${path}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(ctx.files.readText(path));
	} catch (e) {
		throw new UsageError(`${path} is not a baseline: ${e instanceof Error ? e.message : e}`);
	}
	if (Array.isArray(parsed)) return parsed.map(String);
	const workers = (parsed as { workers?: unknown }).workers;
	if (Array.isArray(workers)) return workers.map(String);
	throw new UsageError(`${path} has no \`workers\` array`);
}

/**
 * Summarises a saved `wrangler tail --format json` capture, and refuses one that cannot be trusted.
 *
 * Reads a file rather than attaching, because a tail is a long-lived stream and because the capture is
 * the artifact worth keeping: the same bytes can be re-read after the rule for reading them changes,
 * which is exactly what happened when tail was found dropping every Durable Object event.
 */
export async function runCpu(ctx: Context, capture: string, opts: JsonOption): Promise<void> {
	if (!ctx.files.exists(capture)) {
		throw new UsageError(
			`no capture at ${capture}; produce one with \`${captureCommand('<worker>')}\``
		);
	}
	const report = summariseCpu(parseTailCapture(ctx.files.readText(capture)));

	emit(ctx.io, opts.json === true, report, () => {
		const lines = [
			`${report.events} event(s) in ${capture}`,
			'',
			...table(
				['model', 'n', 'median', 'min', 'max', 'spread'],
				Object.entries(report.byModel).map(([model, s]) => [
					model,
					String(s.n),
					String(s.median),
					String(s.min),
					String(s.max),
					String(s.spread)
				])
			)
		];
		if (report.notes.length > 0) {
			lines.push('', 'notes');
			for (const note of report.notes) lines.push(`  - ${note}`);
		}
		return lines;
	});

	if (report.instrumentFailure) {
		throw new FindingError(
			'instrument',
			'the capture has no durableObject events; treat it as an instrument failure, not a measurement'
		);
	}
}
