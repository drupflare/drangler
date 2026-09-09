import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHeal } from '../../src/commands/heal';
import { runSiteUpdb } from '../../src/commands/site';
import { resolveConfig } from '../../src/config/file';
import { DEFAULT_TIMEOUT_MS, type GlobalOptions } from '../../src/config/globals';
import { defaultContext, type Context } from '../../src/context';
import { FindingError, UsageError } from '../../src/errors';
import { nodeFiles } from '../../src/host/files';
import { bufferIo, type BufferIo } from '../../src/io';
import { dockerGate } from './helpers/docker';
import { startFixtureWorker, type RunningWorker } from './helpers/worker';

// the fixture worker is wrangler, not Docker; the gate is only here to keep one lane's requirements
// from being confused with another's
const skip = process.env.REQUIRE_DOCKER === undefined ? false : await dockerGate();

const SITE = 'heal-e2e';
const PORT = 8903;

/**
 * `heal` and `site updb` against a real Durable Object, over real HTTP.
 *
 * The gate lane drives these functions against a fake `fetch`, which proves every verdict and every
 * refusal. What it cannot prove is that the envelopes drangler parses survive a real request: a
 * header set on a Response inside an object, a JSON body through `Response.json`, and the query
 * parameters arriving as the route reads them.
 *
 * The states here are the ones that are HARD to produce on a real site -- quarantine needs three
 * consecutive critical findings -- so the fixture reports them on demand. `heal-real.spec.ts` is
 * what stops that from becoming a second, drifting definition of the same contract.
 */
describe.skipIf(skip)('heal against a real object', () => {
	let worker: RunningWorker;

	const ctxWith = (io: BufferIo): Context => ({ ...defaultContext(), io, files: nodeFiles() });

	function globalsFor(ctx: Context, over: Partial<GlobalOptions> = {}): GlobalOptions {
		return {
			json: true,
			quiet: false,
			verbose: false,
			yes: false,
			dryRun: false,
			timeoutMs: DEFAULT_TIMEOUT_MS,
			config: resolveConfig(ctx, {
				site: worker.origin,
				siteName: SITE,
				token: 'fixture-token'
			}),
			...over
		};
	}

	/** sets one knob on the object, the way a fault would arrive on a real site */
	async function setState(params: Record<string, string>): Promise<void> {
		const url = new URL('/state', worker.origin);
		url.searchParams.set('site', SITE);
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
		const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
		expect(response.status).toBe(200);
	}

	beforeAll(async () => {
		worker = await startFixtureWorker({ port: PORT, probePath: `/serve?site=${SITE}` });
	}, 300_000);

	afterAll(() => worker?.stop());

	it('reports a clean site off the real envelope', async () => {
		await setState({ quarantined: '0', degrade: '', updbPhase: 'complete' });
		const io = bufferIo();
		const ctx = ctxWith(io);
		await runHeal(ctx, worker.origin, { globals: globalsFor(ctx) });
		expect(io.json<{ verdict: string }>().verdict).toBe('clean');
	}, 300_000);

	it('reads a quarantine, clears it, and reads the cleared state back', async () => {
		await setState({ quarantined: '1' });
		const io = bufferIo();
		const ctx = ctxWith(io);
		await expect(
			runHeal(ctx, worker.origin, { globals: globalsFor(ctx) })
		).rejects.toBeInstanceOf(FindingError);
		expect(io.json<{ rung: string; code: string }>()).toMatchObject({
			rung: 'quarantine',
			code: 'bridge.asyncify_called'
		});

		const clearing = bufferIo();
		const clearCtx = ctxWith(clearing);
		await runHeal(clearCtx, worker.origin, {
			release: true,
			globals: globalsFor(clearCtx, { yes: true })
		});
		expect(clearing.json<{ verdict: string }>().verdict).toBe('clean');
	}, 300_000);

	/** the headers reach the parser through a real Response, which a fake fetch cannot prove */
	it('reads the degradation headers off a real serve response', async () => {
		await setState({ quarantined: '0', degrade: 'reduced', degradeDriver: 'rows-written' });
		const io = bufferIo();
		const ctx = ctxWith(io);
		await runHeal(ctx, worker.origin, { globals: globalsFor(ctx) });
		expect(io.json<{ degraded: { level: string; driver: string } }>().degraded).toMatchObject({
			level: 'reduced',
			driver: 'rows-written'
		});
		await setState({ degrade: '' });
	}, 300_000);

	it('refuses a rebuild repair while the site is shedding load', async () => {
		await setState({ degrade: 'read-only', degradeDriver: 'do-requests' });
		const io = bufferIo();
		const ctx = ctxWith(io);
		await expect(
			runHeal(ctx, worker.origin, { armfill: true, globals: globalsFor(ctx, { yes: true }) })
		).rejects.toBeInstanceOf(UsageError);
		await setState({ degrade: '' });
	}, 300_000);

	/** the route that reaches no network, which is what makes it usable on a stuck pin */
	it('releases a preview pin through the real unpin action', async () => {
		await setState({ degrade: '', previewOf: '9' });
		const io = bufferIo();
		const ctx = ctxWith(io);
		await runHeal(ctx, worker.origin, {
			unpin: 'generic:o/r@main',
			globals: globalsFor(ctx, { yes: true })
		});
		expect(
			io.json<{ repairs: { id: string; performed: boolean }[] }>().repairs[0]
		).toMatchObject({ id: 'unpin', performed: true });
	}, 300_000);

	it('drives updb beats until the phase turns terminal', async () => {
		await setState({ updbPhase: 'running', updbCursor: '6' });
		const io = bufferIo();
		const ctx = ctxWith(io);
		await runSiteUpdb(ctx, worker.origin, {
			steps: 2,
			noSnapshot: true,
			globals: globalsFor(ctx)
		});
		const report = io.json<{ beats: number; cursor: number }>();
		expect(report.beats).toBe(2);
		expect(report.cursor).toBe(8);
	}, 300_000);

	it('exits 3 on a halted chain read off the real route', async () => {
		await setState({ updbPhase: 'halted' });
		const io = bufferIo();
		const ctx = ctxWith(io);
		await expect(runSiteUpdb(ctx, worker.origin, { globals: globalsFor(ctx) })).rejects.toThrow(
			/update-failed/
		);
		await setState({ updbPhase: 'complete' });
	}, 300_000);
});
