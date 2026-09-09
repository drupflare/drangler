import { describe, expect, it } from 'vitest';
import { runReconcile, type ReconcileReport } from '../src/commands/reconcile';
import { EXIT, FindingError, UsageError } from '../src/errors';
import type { FetchLike } from '../src/health/probe';
import { run } from '../src/run';
import { testContext, testGlobals, type TestContext } from './helpers';

const ORIGIN = 'https://mysite.example';
const TOKEN = 'tok-owner-1';

interface Recorded {
	url: string;
	method: string;
	authorization: string | null;
}

function recorder(handler: (call: Recorded, n: number) => unknown): FetchLike & {
	calls: Recorded[];
} {
	const calls: Recorded[] = [];
	const fn = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
		const headers = new Headers((init.headers ?? {}) as Record<string, string>);
		const call: Recorded = {
			url: String(input),
			method: String(init.method ?? 'GET'),
			authorization: headers.get('authorization')
		};
		calls.push(call);
		return new Response(JSON.stringify(handler(call, calls.length - 1)), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	};
	return Object.assign(fn, { calls }) as unknown as FetchLike & { calls: Recorded[] };
}

type Step = { id: string; since: number; describe: string; state: string; detail: string };

const step = (id: string, state: string, detail = '', since = 1): Step => ({
	id,
	since,
	describe: `what ${id} fixes`,
	state,
	detail
});

const body = (version: number, steps: Step[], extra: Record<string, unknown> = {}) => ({
	version,
	packVersion: 2,
	steps,
	...extra
});

const ctxFor = (fetch: FetchLike): TestContext => testContext({ fetch, cwd: '/work' });
const globalsFor = (ctx: TestContext, over = {}) =>
	testGlobals({ json: true, ...over }, ctx, { site: ORIGIN, token: TOKEN });

describe('reconcile status', () => {
	it('reads the standing with a GET, carrying the owner token as a header', async () => {
		const fetch = recorder(() => body(2, [step('page-max-age', 'applied')], { last: null }));
		const ctx = ctxFor(fetch);
		await runReconcile(ctx, undefined, { globals: globalsFor(ctx) });

		const call = fetch.calls[0] as Recorded;
		expect(call.method).toBe('GET');
		expect(new URL(call.url).pathname).toBe('/reconcile');
		expect(call.authorization).toBe(`Bearer ${TOKEN}`);
		expect(new URL(call.url).searchParams.get('site')).toBe('site');

		const report = ctx.io.json<ReconcileReport>();
		expect(report).toMatchObject({ version: 2, packVersion: 2, behind: 0, owed: 0 });
		expect(report.notes.join(' ')).toContain('at the version the deployed pack reconciles to');
	});

	/**
	 * A site behind the pack is not a failure on its own.
	 *
	 * The alarm chain drives one step per firing, so a status read that exited 3 for every owed step
	 * would report a fault on a site that is converging correctly.
	 */
	it('reports what is owed without exiting 3, and names the command that drives it', async () => {
		const fetch = recorder(() =>
			body(1, [
				step('page-max-age', 'applied'),
				step('driver-digest', 'owed', 'digest moved', 2)
			])
		);
		const ctx = ctxFor(fetch);
		await runReconcile(ctx, ORIGIN, { globals: globalsFor(ctx) });

		const report = ctx.io.json<ReconcileReport>();
		expect(report).toMatchObject({ version: 1, behind: 1, owed: 1, posts: 0, stuck: null });
		expect(report.notes.join(' ')).toContain('--run drives one now');
	});

	it('separates a deferred step from an owed one and says waiting is correct', async () => {
		const fetch = recorder(() =>
			body(0, [
				step('bake-clock', 'deferred', 'never claimed, so there is no real birthday yet')
			])
		);
		const ctx = ctxFor(fetch);
		await runReconcile(ctx, ORIGIN, { globals: globalsFor(ctx) });

		const report = ctx.io.json<ReconcileReport>();
		expect(report).toMatchObject({ owed: 0, deferred: 1, failed: 0 });
		expect(report.notes.join(' ')).toContain('waiting is correct');
	});

	it('renders the steps as a table when it is not printing JSON', async () => {
		const fetch = recorder(() => body(1, [step('driver-digest', 'owed', 'digest moved', 2)]));
		const ctx = ctxFor(fetch);
		await runReconcile(ctx, ORIGIN, { globals: globalsFor(ctx, { json: false }) });

		const text = ctx.io.text();
		expect(text).toContain('driver-digest');
		expect(text).toContain('digest moved');
		expect(text).toContain('1 of 2');
	});

	it('refuses without an owner token, naming the command that mints one', async () => {
		const ctx = ctxFor(recorder(() => body(2, [])));
		const globals = testGlobals({ json: true }, ctx, { site: ORIGIN });
		await expect(runReconcile(ctx, ORIGIN, { globals })).rejects.toBeInstanceOf(UsageError);
	});
});

describe('reconcile --run and --all', () => {
	it('drives exactly one step under --run', async () => {
		const fetch = recorder((call) =>
			call.method === 'POST'
				? body(2, [step('driver-digest', 'applied', '', 2)], {
						ran: { reconcile: { id: 'x' } }
					})
				: body(1, [step('driver-digest', 'owed', 'digest moved', 2)])
		);
		const ctx = ctxFor(fetch);
		await runReconcile(ctx, ORIGIN, { run: true, globals: globalsFor(ctx) });

		expect(fetch.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
		expect(ctx.io.json<ReconcileReport>()).toMatchObject({
			posts: 1,
			drove: 1,
			version: 2,
			owed: 0
		});
	});

	/**
	 * `ran` is THIS call's outcome and null when the site drove nothing, so it is the terminator.
	 *
	 * It replaced a version-plus-applied-count comparison, which existed only because the route used
	 * to answer a no-op with the payload from an earlier firing.
	 */
	it('drives under --all until the site answers that it drove nothing', async () => {
		const versions = [
			body(0, [step('a', 'owed', 'owed a'), step('b', 'owed', 'owed b')], {
				ran: { reconcile: { id: 'a' } }
			}),
			body(1, [step('a', 'applied'), step('b', 'owed', 'owed b')], {
				ran: { reconcile: { id: 'b' } }
			}),
			body(2, [step('a', 'applied'), step('b', 'applied')], {
				ran: null,
				skipped: 'already at the shipping version'
			})
		];
		let post = 0;
		const fetch = recorder((call) =>
			call.method === 'POST' ? versions[Math.min(post++, 2)] : versions[0]
		);
		const ctx = ctxFor(fetch);
		await runReconcile(ctx, ORIGIN, { all: true, globals: globalsFor(ctx) });

		const report = ctx.io.json<ReconcileReport>();
		expect(report).toMatchObject({ posts: 3, drove: 2, version: 2, owed: 0 });
		expect(report.skipped).toBe('already at the shipping version');
	});

	/**
	 * `skipped` on a site that is BEHIND is a refusal an operator has to act on.
	 *
	 * `RECONCILE=0` and a replica lane are the two the worker names, and both mean the fix an
	 * operator asked for did not arrive.
	 */
	it('exits 3 when the site refused to drive and is still behind', async () => {
		const fetch = recorder(() =>
			body(0, [step('driver-digest', 'owed', 'digest moved', 2)], {
				ran: null,
				skipped: 'RECONCILE is off'
			})
		);
		const ctx = ctxFor(fetch);
		await expect(
			runReconcile(ctx, ORIGIN, { all: true, globals: globalsFor(ctx) })
		).rejects.toMatchObject({ code: 'reconcile-refused', exitCode: EXIT.FINDING });

		const report = ctx.io.json<ReconcileReport>();
		expect(report).toMatchObject({ posts: 1, drove: 0, skipped: 'RECONCILE is off' });
		expect(report.notes.join(' ')).toContain('the site drove nothing: RECONCILE is off');
	});

	/**
	 * Behind AND driving nothing is not automatically a finding.
	 *
	 * A chain parked on a deferred step drives nothing for as long as the step cannot be decided,
	 * which on a site nobody claims is forever. Waiting there is correct, so this exits 0 while the
	 * two refusals above exit 3, and the site's own reason is repeated as it arrived.
	 */
	it('does not exit 3 when the chain is parked on a deferred step', async () => {
		const fetch = recorder(() =>
			body(0, [step('bake-clock', 'deferred', 'never claimed')], {
				ran: null,
				skipped: 'waiting on bake-clock: never claimed, so there is no real birthday yet',
				last: { reconcile: { waiting: 'bake-clock', reason: 'never claimed', version: 0 } }
			})
		);
		const ctx = ctxFor(fetch);
		await expect(
			runReconcile(ctx, ORIGIN, { all: true, globals: globalsFor(ctx) })
		).resolves.toBeUndefined();

		const report = ctx.io.json<ReconcileReport>();
		expect(report).toMatchObject({ behind: 2, drove: 0 });
		expect(report.notes.join(' ')).toContain(
			'the site drove nothing: waiting on bake-clock: never claimed'
		);
	});

	/**
	 * The parked case is read from the STEPS, not from the reason text.
	 *
	 * A site can park with the deferred step's own row already applied-looking to a reader; what
	 * decides it is nothing owed plus a `waiting` payload. Matching on the wording would turn a
	 * reworded message into a spurious exit 3.
	 */
	it('reads parked from the report structure rather than the reason wording', async () => {
		const fetch = recorder(() =>
			body(0, [step('bake-clock', 'deferred', 'never claimed')], {
				ran: null,
				skipped: 'some future rewording of the same condition',
				last: { reconcile: { waiting: 'bake-clock', reason: 'never claimed', version: 0 } }
			})
		);
		const ctx = ctxFor(fetch);
		await expect(
			runReconcile(ctx, ORIGIN, { all: true, globals: globalsFor(ctx) })
		).resolves.toBeUndefined();
	});

	it('stops and exits 3 when a driven step leaves the site still owing it', async () => {
		const fetch = recorder(() =>
			body(0, [step('page-max-age', 'failed', 'attempt 2: config 0, cache_config 0')], {
				ran: { reconcile: { id: 'page-max-age', error: 'kernel refused' } }
			})
		);
		const ctx = ctxFor(fetch);
		await expect(
			runReconcile(ctx, ORIGIN, { all: true, globals: globalsFor(ctx) })
		).rejects.toBeInstanceOf(FindingError);

		const report = ctx.io.json<ReconcileReport>();
		expect(report.stuck).toMatchObject({ id: 'page-max-age' });
		expect(report.posts).toBe(1);
		expect(report.notes.join(' ')).toContain('kernel refused');
	});

	it('sends nothing under --dry-run and says so', async () => {
		const fetch = recorder(() => body(1, [step('driver-digest', 'owed', 'digest moved', 2)]));
		const ctx = ctxFor(fetch);
		await runReconcile(ctx, ORIGIN, {
			run: true,
			globals: globalsFor(ctx, { dryRun: true })
		});
		expect(fetch.calls.map((c) => c.method)).toEqual(['GET']);
		expect(ctx.io.json<ReconcileReport>().notes.join(' ')).toContain('dry run');
	});

	it('reports the reason when the chain is waiting rather than failing', async () => {
		const fetch = recorder(() =>
			body(0, [step('bake-clock', 'deferred', 'never claimed')], {
				last: { reconcile: { waiting: 'bake-clock', reason: 'never claimed', version: 0 } }
			})
		);
		const ctx = ctxFor(fetch);
		await runReconcile(ctx, ORIGIN, { globals: globalsFor(ctx) });
		expect(ctx.io.json<ReconcileReport>().notes.join(' ')).toContain(
			'waiting on bake-clock: never claimed'
		);
	});

	// `ran` is this call's payload and `last` is the firing before it, so the newer one wins
	it('prefers this call outcome over the payload the site recorded earlier', async () => {
		const fetch = recorder((call) =>
			call.method === 'POST'
				? body(1, [step('a', 'applied')], {
						ran: { reconcile: { id: 'a', after: 'satisfied' } },
						last: { reconcile: { id: 'stale', error: 'from an earlier firing' } }
					})
				: body(0, [step('a', 'owed', 'owed a')])
		);
		const ctx = ctxFor(fetch);
		await runReconcile(ctx, ORIGIN, { run: true, globals: globalsFor(ctx) });

		const report = ctx.io.json<ReconcileReport>();
		expect(report.last).toMatchObject({ id: 'a' });
		expect(report.notes.join(' ')).not.toContain('from an earlier firing');
	});
});

describe('the parser wiring', () => {
	it('passes --run through and exits 0 on a current site', async () => {
		const fetch = recorder(() => body(2, [step('page-max-age', 'applied')]));
		const ctx = ctxFor(fetch);
		const code = await run(ctx, [
			'reconcile',
			ORIGIN,
			'--run',
			'--token',
			TOKEN,
			'--json',
			'--site-name',
			'site'
		]);
		expect(code).toBe(EXIT.OK);
		expect(fetch.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
	});

	it('answers a route refusal as a failure rather than a finding', async () => {
		const fetch = (async () =>
			new Response('{"error":"no"}', { status: 500 })) as unknown as FetchLike;
		const ctx = ctxFor(fetch);
		const code = await run(ctx, ['reconcile', ORIGIN, '--token', TOKEN, '--json']);
		expect(code).toBe(EXIT.FAILED);
		expect(JSON.parse(ctx.io.text()).error.code).toBe('reconcile');
	});
});
