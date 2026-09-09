import { describe, expect, it } from 'vitest';
import { runSweep, type SweepReport } from '../src/commands/sweep';
import { EXIT, FindingError } from '../src/errors';
import type { FetchLike } from '../src/health/probe';
import { run } from '../src/run';
import { testContext, testGlobals, type TestContext } from './helpers';

const ORIGIN = 'https://mysite.example';
const TOKEN = 'tok-owner-1';

function recorder(handler: () => unknown): FetchLike & { urls: string[] } {
	const urls: string[] = [];
	const fn = async (input: unknown): Promise<Response> => {
		urls.push(String(input));
		return new Response(JSON.stringify(handler()), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	};
	return Object.assign(fn, { urls }) as unknown as FetchLike & { urls: string[] };
}

const coverage = (covered: number, addressable: number) => ({
	addressable,
	covered,
	pending: addressable - covered,
	fraction: Number((covered / addressable).toFixed(4))
});

const ctxFor = (fetch: FetchLike): TestContext => testContext({ fetch, cwd: '/work' });
const globalsFor = (ctx: TestContext, over = {}) =>
	testGlobals({ json: true, ...over }, ctx, { site: ORIGIN, token: TOKEN });

describe('sweep', () => {
	it('reads the report over one GET and reports coverage as a fraction', async () => {
		const fetch = recorder(() => ({
			sweep: {
				ok: true,
				queued: 50,
				boundBy: 'batch',
				reason: 'queueing 50 of 380 pending paths',
				cost: { rows: 802, doRequests: 1 },
				coverage: coverage(120, 500),
				cursor: { rowsSpent: 802, pages: 50, done: false }
			},
			at: 1_757_000_000_000,
			enabled: true,
			ran: false
		}));
		const ctx = ctxFor(fetch);
		await runSweep(ctx, undefined, { globals: globalsFor(ctx) });

		expect(new URL(fetch.urls[0] as string).pathname).toBe('/sweep');
		expect(new URL(fetch.urls[0] as string).searchParams.has('run')).toBe(false);

		const report = ctx.io.json<SweepReport>();
		expect(report).toMatchObject({ ok: true, queued: 50, boundBy: 'batch', never: false });
		expect(report.coverage).toMatchObject({ addressable: 500, covered: 120, fraction: 0.24 });
	});

	it('renders the fraction as a percentage beside the counts', async () => {
		const fetch = recorder(() => ({
			sweep: {
				ok: true,
				queued: 12,
				boundBy: 'covered',
				reason: 'queueing 12 of 12 pending paths',
				cost: { rows: 194, doRequests: 1 },
				coverage: coverage(41, 984),
				cursor: { rowsSpent: 194, pages: 12, done: true }
			},
			at: 1_757_000_000_000,
			enabled: true,
			ran: false
		}));
		const ctx = ctxFor(fetch);
		await runSweep(ctx, ORIGIN, { globals: globalsFor(ctx, { json: false }) });

		const text = ctx.io.text();
		expect(text).toContain('41 of 984 addressable (4.2%)');
		expect(text).toContain('943 pending');
	});

	/**
	 * Off, on-but-never-stepped, and refused are three answers and each gets its own.
	 *
	 * Both of the first two answer `{sweep: null}`, so the body alone cannot separate them; `enabled`
	 * is the site's own `sweepEnabled()` and is what makes the distinction a reading rather than an
	 * inference. A refusal carries the governor's bound and reason instead.
	 */
	it('says the sweep is off, and names the var that switches it on', async () => {
		const fetch = recorder(() => ({ sweep: null, at: null, enabled: false, ran: false }));
		const ctx = ctxFor(fetch);
		await runSweep(ctx, ORIGIN, { globals: globalsFor(ctx) });

		const report = ctx.io.json<SweepReport>();
		expect(report).toMatchObject({
			enabled: false,
			never: true,
			boundBy: null,
			coverage: null
		});
		expect(report.notes.join(' ')).toContain('`SWEEP` is off on this site');
		expect(report.notes.join(' ')).toContain('SWEEP_ROWS_FRACTION');
	});

	it('separates a sweep that is on and has not stepped from one that is off', async () => {
		const fetch = recorder(() => ({ sweep: null, at: null, enabled: true, ran: false }));
		const ctx = ctxFor(fetch);
		await runSweep(ctx, ORIGIN, { globals: globalsFor(ctx) });

		const report = ctx.io.json<SweepReport>();
		expect(report).toMatchObject({ enabled: true, never: true });
		expect(report.notes.join(' ')).toContain('on and has recorded no step yet');
		expect(report.notes.join(' ')).not.toContain('off on this site');
	});

	// the report a forced call gets back is either the step it took or one from an earlier firing
	it('says whether the report is this call step or an earlier one', async () => {
		const stepped = recorder(() => ({
			sweep: {
				ok: true,
				queued: 8,
				boundBy: 'batch',
				reason: 'queueing 8 of 8 pending paths'
			},
			at: 1_757_000_000_000,
			enabled: true,
			ran: true
		}));
		const ctx = ctxFor(stepped);
		await runSweep(ctx, ORIGIN, { run: true, globals: globalsFor(ctx) });
		expect(ctx.io.json<SweepReport>().ran).toBe(true);
		expect(ctx.io.json<SweepReport>().notes.join(' ')).toContain('the step this call forced');

		const refused = ctxFor(
			recorder(() => ({
				sweep: { ok: true, queued: 8, boundBy: 'batch', reason: 'an earlier firing' },
				at: 1_757_000_000_000,
				enabled: false,
				ran: false,
				skipped: 'SWEEP is off'
			}))
		);
		await runSweep(refused, ORIGIN, { run: true, globals: globalsFor(refused) });
		const report = refused.io.json<SweepReport>();
		expect(report).toMatchObject({ ran: false, skipped: 'SWEEP is off' });
		expect(report.notes.join(' ')).toContain('the site drove no step: SWEEP is off');
	});

	it('carries the governor reason when it declined, rather than reporting nothing', async () => {
		const fetch = recorder(() => ({
			sweep: {
				ok: false,
				queued: 0,
				boundBy: 'daily-cap',
				reason: "the sweep's 25% share of today is spent (12408 rows over 762 pages); resumes at 00:00 UTC",
				cost: { rows: 0, doRequests: 0 },
				coverage: coverage(762, 900),
				cursor: { rowsSpent: 12408, pages: 762, done: false }
			},
			at: 1_757_000_000_000,
			enabled: true,
			ran: false
		}));
		const ctx = ctxFor(fetch);
		await runSweep(ctx, ORIGIN, { globals: globalsFor(ctx) });

		const report = ctx.io.json<SweepReport>();
		expect(report).toMatchObject({ ok: false, queued: 0, boundBy: 'daily-cap' });
		expect(report.reason).toContain('resumes at 00:00 UTC');
		expect(report.notes.join(' ')).toContain('resumes at 00:00 UTC');
	});

	// the one bound an operator has to act on: the ladder has already stopped cron and the queue
	it('exits 3 when the governor refused at the quota floor', async () => {
		const fetch = recorder(() => ({
			sweep: {
				ok: false,
				queued: 0,
				boundBy: 'floor',
				reason: "rows at 82.4% of today's quota, at or past the 80% floor",
				cost: { rows: 0, doRequests: 0 },
				coverage: coverage(10, 100),
				cursor: { rowsSpent: 0, pages: 0, done: false }
			},
			at: null,
			enabled: true,
			ran: false
		}));
		const ctx = ctxFor(fetch);
		await expect(runSweep(ctx, ORIGIN, { globals: globalsFor(ctx) })).rejects.toBeInstanceOf(
			FindingError
		);
		expect(ctx.io.json<SweepReport>().boundBy).toBe('floor');
	});

	it('forces a step under --run, and forces none under --dry-run', async () => {
		const fetch = recorder(() => ({ sweep: null, at: null, enabled: true, ran: true }));
		const ctx = ctxFor(fetch);
		await runSweep(ctx, ORIGIN, { run: true, globals: globalsFor(ctx) });
		expect(new URL(fetch.urls[0] as string).searchParams.get('run')).toBe('1');

		const dry = ctxFor(recorder(() => ({ sweep: null, at: null, enabled: true, ran: false })));
		await runSweep(dry, ORIGIN, { run: true, globals: globalsFor(dry, { dryRun: true }) });
		expect((dry.fetch as unknown as { urls: string[] }).urls[0]).not.toContain('run=1');
		expect(dry.io.json<SweepReport>().notes.join(' ')).toContain('dry run');
	});

	// caught on the site so an alarm cannot be taken down by a sweep, which means it is silent otherwise
	it('surfaces an error the site recorded instead of reading it as a refusal', async () => {
		const fetch = recorder(() => ({
			sweep: { error: 'no such table: router' },
			at: null,
			enabled: true,
			ran: false
		}));
		const ctx = ctxFor(fetch);
		await runSweep(ctx, ORIGIN, { globals: globalsFor(ctx) });

		const report = ctx.io.json<SweepReport>();
		expect(report).toMatchObject({ never: false, error: 'no such table: router', ok: null });
		expect(report.notes.join(' ')).toContain('caught there');
	});
});

describe('the parser wiring', () => {
	it('passes --run through and exits 0', async () => {
		const fetch = recorder(() => ({ sweep: null, at: null, enabled: true, ran: true }));
		const ctx = ctxFor(fetch);
		const code = await run(ctx, ['sweep', ORIGIN, '--run', '--token', TOKEN, '--json']);
		expect(code).toBe(EXIT.OK);
		expect(fetch.urls[0]).toContain('run=1');
	});

	it('answers a route refusal as a failure rather than a finding', async () => {
		const fetch = (async () =>
			new Response('{"error":"no"}', { status: 503 })) as unknown as FetchLike;
		const ctx = ctxFor(fetch);
		const code = await run(ctx, ['sweep', ORIGIN, '--token', TOKEN, '--json']);
		expect(code).toBe(EXIT.FAILED);
		expect(JSON.parse(ctx.io.text()).error.code).toBe('sweep');
	});
});
