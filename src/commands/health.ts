import type { Context } from '../context';
import { FindingError, UsageError } from '../errors';
import { emit, kv } from '../format';
import { probeSite, type ProbeOptions, type ProbeResult } from '../health/probe';

export interface HealthOptions extends Omit<ProbeOptions, 'target'> {
	json?: boolean;
}

/** The reportable fields, in the order a reader wants them. */
function lines(result: ProbeResult): string[] {
	const rows: [string, string][] = [
		['target', result.requested],
		['kind', result.kind],
		['verdict', result.verdict],
		['status', result.status === null ? 'none' : String(result.status)],
		['wall ms', `${result.wallMs} (wall clock, not cpuTime)`]
	];
	if (result.kind === 'worker') {
		rows.push(
			['tier', result.tier ?? '-'],
			['edge', result.edgeTier ?? '-'],
			['generation', result.generation === null ? '-' : String(result.generation)],
			['render ms', result.renderMs === null ? '-' : String(result.renderMs)],
			['serve ms', result.serveMs === null ? '-' : String(result.serveMs)],
			['worker ms', result.workerMs === null ? '-' : String(result.workerMs)],
			['php booted', result.phpBooted === null ? '-' : result.phpBooted ? 'yes' : 'no'],
			['queue depth', result.queueDepth === null ? '-' : String(result.queueDepth)],
			['diagnostics', result.diagnostics]
		);
	} else {
		rows.push(
			['x-generator', result.generator ?? '-'],
			['page cache', result.drupalCache ?? '-'],
			['dynamic cache', result.drupalDynamicCache ?? '-']
		);
	}

	const out = kv(rows);
	const extra = Object.entries(result.cfw).filter(
		([name]) => !['x-cfw-cache', 'x-cfw-edge', 'x-cfw-generation'].includes(name)
	);
	if (extra.length > 0) {
		out.push('', 'headers');
		out.push(...kv(extra.map(([n, v]) => [`  ${n}`, v] as [string, string])));
	}
	if (result.notes.length > 0) {
		out.push('', 'notes');
		for (const note of result.notes) out.push(`  - ${note}`);
	}
	return out;
}

/**
 * Probes one site, worker or VPS, and reports what answered.
 *
 * The same command covers both directions on purpose: a user part-way through a migration has two
 * hosts and needs to compare them, and a health check that only understood the destination would make
 * that comparison by hand.
 */
export async function runHealth(ctx: Context, target: string, opts: HealthOptions): Promise<void> {
	// commander hands every option value through as a string, and AbortSignal.timeout(NaN) throws
	if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) {
		throw new UsageError(`--timeout must be a positive number of milliseconds`);
	}
	const result = await probeSite({ fetch: ctx.fetch }, { ...opts, target });
	emit(ctx.io, opts.json === true, result, () => lines(result));

	if (result.verdict === 'degraded' || result.verdict === 'unreachable') {
		throw new FindingError('unhealthy', `${result.requested} is ${result.verdict}`);
	}
	if (result.verdict === 'not-drupflare') {
		throw new FindingError('not-drupflare', `${result.target} is not a drupflare worker`);
	}
}
