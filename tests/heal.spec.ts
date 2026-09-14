import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runHeal, type HealReport } from '../src/commands/heal';
import { EXIT, FindingError, UsageError } from '../src/errors';
import { readDegradation, type FetchLike } from '../src/health/probe';
import {
	elapsed,
	gateRepair,
	healthVerdict,
	QUARANTINE_STRIKES,
	readRepairState,
	renderRepair,
	REPAIRS,
	RUNGS,
	summariseHealth,
	type Repair
} from '../src/health/repair';
import { run } from '../src/run';
import { testContext, testGlobals, type TestContext } from './helpers';

const ORIGIN = 'https://mysite.example';
const TOKEN = 'tok-owner-1';
const NOW = new Date('2026-09-08T05:00:00.000Z').getTime();

/** the shape `/health` returns; every field is one this worker really sends */
function healthBody(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		repair: {
			rung: 'observe',
			code: null,
			strikes: 0,
			quarantinedAt: null,
			lastRollbackAt: null
		},
		quarantined: false,
		rollback: { rollback: false, reason: 'not quarantined; the lower rungs own this' },
		advisories: {
			state: 'current',
			insecure: 0,
			stale: 0,
			at: 1,
			detail: 'nothing outstanding'
		},
		version: { id: 'ver-1', tag: null, timestamp: '2026-09-08T04:00:00Z' },
		lastFindings: [],
		ledger: [],
		ledgerRows: 0,
		...over
	};
}

const QUARANTINED = healthBody({
	repair: {
		rung: 'quarantine',
		code: 'bridge.asyncify_called',
		strikes: 3,
		quarantinedAt: NOW - 48 * 60_000,
		lastRollbackAt: null
	},
	quarantined: true,
	rollback: {
		rollback: false,
		reason: 'quarantined 2880s of 1800s for bridge.asyncify_called'
	},
	lastFindings: [
		{
			code: 'memory.trend_rising',
			severity: 'warn',
			scope: 'heap',
			context: 'recycle at the next quiet moment'
		}
	],
	ledger: [
		{
			ts: NOW - 60_000,
			code: 'bridge.asyncify_called',
			severity: 'error',
			scope: 'bridge',
			action: 'reset',
			outcome: 'failed',
			attempt: 3
		}
	],
	ledgerRows: 500
});

function siteFetch(
	health: (clear: boolean) => Record<string, unknown>,
	serveHeaders: Record<string, string> = { 'x-cfw-cache': 'MISS' }
): FetchLike & { state: { cleared: number } } {
	const state = { cleared: 0 };
	const fn = async (input: unknown): Promise<Response> => {
		const url = new URL(String(input));
		if (url.pathname === '/serve') {
			return new Response('<html></html>', { headers: serveHeaders });
		}
		const clear = url.searchParams.get('clear') === '1';
		if (clear) state.cleared++;
		return new Response(JSON.stringify(health(clear)), {
			headers: { 'content-type': 'application/json' }
		});
	};
	return Object.assign(fn, { state }) as unknown as FetchLike & { state: { cleared: number } };
}

function ctxFor(fetch: FetchLike): TestContext {
	return testContext({ fetch, now: () => new Date(NOW) });
}

const globalsFor = (ctx: TestContext, over = {}) =>
	testGlobals({ json: true, ...over }, ctx, { site: ORIGIN, token: TOKEN });

describe('reading a health reply', () => {
	it('defaults to a clean state rather than to a rung nobody set', () => {
		expect(readRepairState(undefined)).toMatchObject({ rung: 'observe', strikes: 0 });
		expect(readRepairState({ rung: 'sideways' }).rung).toBe('observe');
		expect(RUNGS).toContain('quarantine');
	});

	it('summarises a quarantined site, dwell included', () => {
		const report = summariseHealth(ORIGIN, QUARANTINED, NOW);
		expect(report).toMatchObject({
			rung: 'quarantine',
			code: 'bridge.asyncify_called',
			strikes: 3,
			quarantined: true
		});
		expect(elapsed(report.heldMs)).toBe('48m');
		expect(healthVerdict(report)).toBe('quarantined');
	});

	/** the site decides; drangler repeats the reason it gave rather than re-deriving one */
	it('repeats the rollback decision verbatim, in both directions', () => {
		const waiting = summariseHealth(ORIGIN, QUARANTINED, NOW);
		expect(waiting.rollback).toEqual({
			rollback: false,
			reason: 'quarantined 2880s of 1800s for bridge.asyncify_called'
		});

		const pending = summariseHealth(
			ORIGIN,
			healthBody({
				quarantined: true,
				rollback: {
					rollback: true,
					reason: 'quarantined 48m for bridge.asyncify_called; replaying restore point 17 (412 statements)'
				}
			}),
			NOW
		);
		expect(healthVerdict(pending)).toBe('rollback-pending');
		expect(pending.notes.join(' ')).toContain('does not drive it');
	});

	it('reads the degradation off serve headers, and reports none when there are none', () => {
		expect(readDegradation({})).toBeNull();
		expect(
			readDegradation({
				'x-cfw-degrade': 'reduced',
				'x-cfw-degrade-driver': 'rows-written',
				'x-cfw-degrade-at': '0.830'
			})
		).toEqual({ level: 'reduced', driver: 'rows-written', fraction: 0.83 });
	});

	it('says so when a worker reports no version at all', () => {
		const report = summariseHealth(ORIGIN, healthBody({ version: null }), NOW);
		expect(report.version).toBeNull();
		expect(report.notes.join(' ')).toContain('no version');
	});

	it('renders the findings and the ledger a person reads', () => {
		const text = renderRepair(summariseHealth(ORIGIN, QUARANTINED, NOW)).join('\n');
		expect(text).toContain(`3 of ${QUARANTINE_STRIKES}`);
		expect(text).toContain('memory.trend_rising');
		expect(text).toContain('ledger (last 1 of 500)');
	});

	it('formats a dwell in seconds, minutes and hours', () => {
		expect(elapsed(null)).toBe('-');
		expect(elapsed(30_000)).toBe('30s');
		expect(elapsed(45 * 60_000)).toBe('45m');
		expect(elapsed(125 * 60_000)).toBe('2h05m');
	});
});

describe('drangler heal', () => {
	it('reports a clean site and exits 0', async () => {
		const ctx = ctxFor(siteFetch(() => healthBody()));
		await runHeal(ctx, ORIGIN, { globals: globalsFor(ctx) });
		expect(ctx.io.json<HealReport>()).toMatchObject({ verdict: 'clean', rung: 'observe' });
	});

	it('exits 3 on a quarantined site and names the command that clears it', async () => {
		const ctx = ctxFor(siteFetch(() => QUARANTINED));
		await expect(
			runHeal(ctx, ORIGIN, { globals: globalsFor(ctx, { json: false }) })
		).rejects.toBeInstanceOf(FindingError);
		expect(ctx.io.text()).toContain('--release --yes');
	});

	it('reports a degradation read from a serve response, which /health does not carry', async () => {
		const ctx = ctxFor(
			siteFetch(() => healthBody(), {
				'x-cfw-cache': 'MISS',
				'x-cfw-degrade': 'reduced',
				'x-cfw-degrade-driver': 'rows-written',
				'x-cfw-degrade-at': '0.830'
			})
		);
		await runHeal(ctx, ORIGIN, { globals: globalsFor(ctx) });
		expect(ctx.io.json<HealReport>().degraded).toMatchObject({ level: 'reduced' });
	});

	/** the one repair `--auto` reaches, and it still needs consent */
	it('clears a quarantine with --release --yes and re-reads the state afterwards', async () => {
		let released = false;
		const fetch = siteFetch((clear) => {
			if (clear) {
				released = true;
				return { ok: true, released: {}, was: {} };
			}
			return released ? healthBody() : QUARANTINED;
		});
		const ctx = ctxFor(fetch);
		await runHeal(ctx, ORIGIN, {
			release: true,
			globals: globalsFor(ctx, { yes: true })
		});
		expect(fetch.state.cleared).toBe(1);
		expect(ctx.io.json<HealReport>().verdict).toBe('clean');
	});

	it('refuses --release without --yes, and refuses it with --dry-run', async () => {
		const ctx = ctxFor(siteFetch(() => QUARANTINED));
		await expect(
			runHeal(ctx, ORIGIN, { release: true, globals: globalsFor(ctx) })
		).rejects.toBeInstanceOf(UsageError);
		await expect(
			runHeal(ctx, ORIGIN, {
				release: true,
				globals: globalsFor(ctx, { yes: true, dryRun: true })
			})
		).rejects.toThrow(/opposite things/);
	});

	it('re-reads under --watch until the site comes clean', async () => {
		let reads = 0;
		const ctx = ctxFor(siteFetch(() => (reads++ < 2 ? QUARANTINED : healthBody())));
		await runHeal(ctx, ORIGIN, {
			watch: true,
			interval: 0,
			globals: globalsFor(ctx)
		});
		const report = ctx.io.json<HealReport>();
		expect(report.verdict).toBe('clean');
		expect(report.reads).toBeGreaterThan(1);
	});

	it('exits 3 when --watch runs out of --wait', async () => {
		const ctx = ctxFor(siteFetch(() => QUARANTINED));
		await expect(
			runHeal(ctx, ORIGIN, {
				watch: true,
				interval: 0,
				wait: 0,
				globals: globalsFor(ctx)
			})
		).rejects.toThrow(/--wait/);
		expect(ctx.io.json<HealReport>().timedOut).toBe(true);
	});

	it('refuses a token the site rejects, naming what to do about it', async () => {
		const ctx = ctxFor((async () => new Response('', { status: 401 })) as unknown as FetchLike);
		expect(await run(ctx, ['heal', ORIGIN, '--token', 'wrong', '--site', ORIGIN])).toBe(
			EXIT.USAGE
		);
		expect(ctx.io.stderr.join('\n')).toContain('site claim');
	});
});

/**
 * The drift check, against the sibling rather than against drangler's own copy.
 *
 * `QUARANTINE_STRIKES` and `RUNGS` are the worker's, and they are repeated here so the report reads
 * `3 of 3` rather than a bare count. Skips when the sibling is absent and FAILS under
 * `REQUIRE_SIBLINGS=1`, the same asymmetry `tests/workspace-artifacts.spec.ts` uses.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPAIR = resolve(HERE, '..', '..', 'worker', 'src', 'ops', 'repair.ts');
const repairSource = existsSync(REPAIR) ? readFileSync(REPAIR, 'utf8') : null;
if (repairSource === null && process.env.REQUIRE_SIBLINGS) {
	throw new Error(
		`no worker checkout at ${REPAIR}, and REQUIRE_SIBLINGS says this lane has one.`
	);
}

describe.skipIf(repairSource === null)('the ladder tracks the worker', () => {
	it('agrees on the strike count', () => {
		const declared = /QUARANTINE_STRIKES\s*=\s*(\d+)/.exec(repairSource as string)?.[1];
		expect(Number(declared)).toBe(QUARANTINE_STRIKES);
	});

	it('agrees on the rungs and their order', () => {
		const block = (repairSource as string).slice(
			(repairSource as string).indexOf('RUNGS = ['),
			(repairSource as string).indexOf('] as const')
		);
		expect([...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1])).toEqual(RUNGS);
	});
});

/**
 * The three repair classes, and the gate each one carries.
 *
 * The class decides the gate rather than the flag doing it, so a repair added later cannot arrive
 * without one. A meter-class repair on a site already shedding load spends the meter it is shedding
 * on, and a schema or serves repair has no rollback a CLI can reach.
 */
describe('the repair classes', () => {
	const NORMAL = { yes: true, snapshot: 'undecided' as const, degraded: null };
	const REDUCED = { level: 'reduced', driver: 'rows-written', fraction: 0.83 };

	/** the worker documents three words for this; a parallel vocabulary here would be a fourth */
	it('classifies every repair in the three words the worker documents', () => {
		for (const [id, repair] of Object.entries(REPAIRS)) {
			expect(repair.id, id).toBe(id);
			expect(['safe', 'rebuild', 'stateful']).toContain(repair.klass);
			expect(repair.blastRadius, id).not.toBe('');
			expect(repair.rollback, id).not.toBe('');
		}
	});

	/**
	 * `/replica` is diagnostic-only and stays that way.
	 *
	 * A lane that withdrew asks the primary for a fresh copy itself and the primary queues it, so
	 * there is nothing for an operator to drive; the same route also carries the path a lane uses to
	 * commit a batch it executed speculatively, which belongs to the pool rather than to whoever
	 * holds the owner token.
	 */
	it('offers no repair that reaches /replica', () => {
		expect(Object.keys(REPAIRS)).not.toContain('readmit');
	});

	it('refuses anything without --yes, naming the blast radius', () => {
		const gate = gateRepair(REPAIRS['bump'] as Repair, { ...NORMAL, yes: false });
		expect(gate).toMatchObject({ allowed: false, flag: '--yes' });
		expect(gate.reason).toContain('WHOLE SITE');
	});

	it('lets a repair with its own rollback through on --yes alone', () => {
		expect(gateRepair(REPAIRS['release'] as Repair, NORMAL).allowed).toBe(true);
		expect(gateRepair(REPAIRS['replay'] as Repair, NORMAL).allowed).toBe(true);
		// unpin is stateful and re-pinnable, so it needs consent and nothing more
		expect(gateRepair(REPAIRS['unpin'] as Repair, NORMAL).allowed).toBe(true);
	});

	it('refuses the rebuild class on a site that is already shedding load', () => {
		const gate = gateRepair(REPAIRS['armfill'] as Repair, { ...NORMAL, degraded: REDUCED });
		expect(gate.allowed).toBe(false);
		expect(gate.reason).toContain('rows-written');
		// a repair that spends no meter is unaffected
		expect(
			gateRepair(REPAIRS['release'] as Repair, { ...NORMAL, degraded: REDUCED }).allowed
		).toBe(true);
	});

	/** the only rollback a CLI has for a hook_update_N is the snapshot it took, and there is no default */
	it('refuses a repair nothing else undoes until a snapshot decision is stated', () => {
		const undecided = gateRepair(REPAIRS['updb'] as Repair, NORMAL);
		expect(undecided).toMatchObject({
			allowed: false,
			flag: '--snapshot <dir> or --no-snapshot'
		});
		expect(undecided.reason).toContain('updbRollback');

		expect(
			gateRepair(REPAIRS['updb'] as Repair, { ...NORMAL, snapshot: 'taken' }).allowed
		).toBe(true);
		expect(
			gateRepair(REPAIRS['unpin'] as Repair, { ...NORMAL, snapshot: 'declined' }).allowed
		).toBe(true);
	});
});

describe('the write repairs', () => {
	const routed = (over: Record<string, unknown> = {}) => {
		const calls: string[] = [];
		const fn = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
			const url = new URL(String(input));
			calls.push(`${String(init.method ?? 'GET')} ${url.pathname}${url.search}`);
			if (url.pathname === '/serve') {
				return new Response('<html></html>', {
					headers: { 'x-cfw-cache': 'MISS', ...((over.headers as object) ?? {}) }
				});
			}
			return new Response(JSON.stringify(over[url.pathname] ?? healthBody()), {
				headers: { 'content-type': 'application/json' }
			});
		};
		return Object.assign(fn, { calls }) as unknown as FetchLike & { calls: string[] };
	};

	it('drives each repair at its own route', async () => {
		const fetch = routed();
		const ctx = ctxFor(fetch);
		await runHeal(ctx, ORIGIN, {
			replay: true,
			armfill: true,
			bump: true,
			globals: globalsFor(ctx, { yes: true })
		});
		expect(fetch.calls).toContain('POST /migrate');
		expect(fetch.calls).toContain('POST /armfill');
		expect(fetch.calls.join(' ')).toContain('POST /bump?reason=drangler+heal');
	});

	// a bump re-renders the whole site, and reading that afterwards is reading it too late
	it('prints the blast radius before it sends the request', async () => {
		const fetch = routed();
		const ctx = ctxFor(fetch);
		await runHeal(ctx, ORIGIN, { bump: true, globals: globalsFor(ctx, { yes: true }) });
		expect(ctx.io.stderr.join('\n')).toContain('THE WHOLE SITE re-renders');
	});

	/**
	 * `unpreview` is the wrong tool for a stuck pin and reaches the network; `unpin` does not.
	 *
	 * `unpreview` re-syncs to the branch head, so it needs a ref advertisement -- and a remote that
	 * is down or whose token expired holds its own pin in place, while a pinned site takes no pushes
	 * and no polls. `unpin` releases without a sync: the site keeps serving what it was already
	 * serving and the poller owns the branch again, so the next successful poll converges it.
	 */
	it('releases a preview pin through unpin rather than unpreview', async () => {
		const fetch = routed({ '/git': { ok: true, previewOf: null, was: '9', synced: false } });
		const ctx = ctxFor(fetch);
		await runHeal(ctx, ORIGIN, {
			unpin: 'generic:o/r@main',
			globals: globalsFor(ctx, { yes: true })
		});
		const call = fetch.calls.find((c) => c.includes('/git')) as string;
		expect(call).toContain('action=unpin');
		expect(call).toContain('id=generic%3Ao%2Fr%40main');
		expect(call).not.toContain('unpreview');
		expect(ctx.io.json<HealReport>().repairs[0]).toMatchObject({
			id: 'unpin',
			klass: 'stateful',
			performed: true
		});
	});

	it('needs --yes for an unpin, and no snapshot decision', async () => {
		const ctx = ctxFor(routed());
		await expect(
			runHeal(ctx, ORIGIN, { unpin: 'generic:o/r@main', globals: globalsFor(ctx) })
		).rejects.toBeInstanceOf(UsageError);
		expect(ctx.io.json<HealReport>().repairs[0]?.detail).toContain('--yes');
	});

	it('invalidates the tags it was given', async () => {
		const fetch = routed();
		const ctx = ctxFor(fetch);
		await runHeal(ctx, ORIGIN, {
			invalidate: 'node:12',
			globals: globalsFor(ctx, { yes: true })
		});
		expect(fetch.calls.join(' ')).toContain('tags=node%3A12');
	});

	it('exits 2 when a repair is refused, naming the flag that would allow it', async () => {
		const ctx = ctxFor(routed());
		await expect(
			runHeal(ctx, ORIGIN, { bump: true, globals: globalsFor(ctx) })
		).rejects.toBeInstanceOf(UsageError);
		expect(ctx.io.json<HealReport>().repairs[0]).toMatchObject({
			id: 'bump',
			performed: false
		});
	});

	it('refuses a meter repair while the site is shedding load', async () => {
		const fetch = routed({
			headers: {
				'x-cfw-degrade': 'reduced',
				'x-cfw-degrade-driver': 'rows-written',
				'x-cfw-degrade-at': '0.9'
			}
		});
		const ctx = ctxFor(fetch);
		await expect(
			runHeal(ctx, ORIGIN, { armfill: true, globals: globalsFor(ctx, { yes: true }) })
		).rejects.toThrow(/rows-written/);
		expect(fetch.calls).not.toContain('POST /armfill');
	});
});

/**
 * `--auto` is the closest thing to unattended repair, and it is narrow.
 *
 * It performs only the repairs that declare they may run unattended and stops at the first that does
 * not. A `--auto` that escalated would be a supervisor, and the object already has one.
 */
describe('heal --auto', () => {
	it('performs what may run unattended and stops at the first thing that may not', async () => {
		const calls: string[] = [];
		const fetch = (async (input: unknown, init: RequestInit = {}) => {
			const url = new URL(String(input));
			calls.push(`${String(init.method ?? 'GET')} ${url.pathname}`);
			if (url.pathname === '/serve') {
				return new Response('', { headers: { 'x-cfw-cache': 'MISS' } });
			}
			return new Response(JSON.stringify(healthBody()), {
				headers: { 'content-type': 'application/json' }
			});
		}) as unknown as FetchLike;
		const ctx = ctxFor(fetch);
		await expect(
			runHeal(ctx, ORIGIN, {
				auto: true,
				bump: true,
				globals: globalsFor(ctx, { yes: true })
			})
		).rejects.toBeInstanceOf(UsageError);
		const report = ctx.io.json<HealReport>();
		expect(report.repairs.at(-1)).toMatchObject({ id: 'bump', performed: false });
		expect(report.repairs.at(-1)?.detail).toContain('may run unattended');
		expect(calls).not.toContain('POST /bump');
	});

	it('still needs --yes, because release() is explicit and never automatic', async () => {
		const ctx = ctxFor(siteFetch(() => QUARANTINED));
		await expect(
			runHeal(ctx, ORIGIN, { auto: true, globals: globalsFor(ctx) })
		).rejects.toThrow(/--yes/);
	});
});
