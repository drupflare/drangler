import { describe, expect, it } from 'vitest';
import {
	runSiteClaim,
	runSiteInvalidate,
	runSiteUpdb,
	runSiteUpgrade,
	type SiteClaimReport,
	type UpdbReport,
	type UpgradeReport
} from '../src/commands/site';
import { EXIT, FindingError, UsageError } from '../src/errors';
import type { FetchLike } from '../src/health/probe';
import { memoryFiles, type MemoryFiles } from '../src/host/files';
import { pause } from '../src/owner';
import { run } from '../src/run';
import { testContext, testGlobals, type TestContext } from './helpers';

const ORIGIN = 'https://mysite.example';
const TOKEN = 'tok-owner-1';
const HOME = '/home/me';
const GLOBAL = `${HOME}/.config/drangler/config.json`;

interface Recorded {
	url: string;
	method: string;
	body: string | null;
	authorization: string | null;
}

/** a fetch that records the METHOD and the BODY, which is what the claim contract is about */
function recorder(
	handler: (url: URL, call: Recorded) => Response
): FetchLike & { calls: Recorded[] } {
	const calls: Recorded[] = [];
	const fn = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
		const headers = new Headers((init.headers ?? {}) as Record<string, string>);
		const call: Recorded = {
			url: String(input),
			method: String(init.method ?? 'GET'),
			body: typeof init.body === 'string' ? init.body : null,
			authorization: headers.get('authorization')
		};
		calls.push(call);
		return handler(new URL(call.url), call);
	};
	return Object.assign(fn, { calls }) as unknown as FetchLike & { calls: Recorded[] };
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function ctxFor(fetch: FetchLike, files: MemoryFiles = memoryFiles({})): TestContext {
	return testContext({ fetch, files, env: { HOME }, cwd: '/work' });
}

const globalsFor = (ctx: TestContext, over = {}) =>
	testGlobals({ json: true, ...over }, ctx, { site: ORIGIN, token: TOKEN });

describe('site claim', () => {
	/**
	 * The password rides a JSON BODY and never a query string.
	 *
	 * The route refuses `?pass=` outright and says why: a query string lands in tail, in
	 * observability and in every intermediary. Asserting the absence here is what stops a future
	 * convenience flag from putting it back.
	 */
	it('posts a body, never a ?pass=, and reports what the site minted once', async () => {
		const fetch = recorder(() =>
			json({ ok: true, adminPass: 'minted-pass', ownerToken: 'minted-token' })
		);
		const ctx = ctxFor(fetch);
		await runSiteClaim(ctx, undefined, {
			title: 'My Site',
			save: true,
			globals: globalsFor(ctx)
		});

		const call = fetch.calls[0] as Recorded;
		expect(call.method).toBe('POST');
		expect(new URL(call.url).searchParams.has('pass')).toBe(false);
		expect(JSON.parse(call.body as string)).toEqual({ siteName: 'My Site' });

		const report = ctx.io.json<SiteClaimReport>();
		expect(report).toMatchObject({
			claimed: true,
			adminPass: 'minted-pass',
			ownerToken: 'minted-token',
			saved: GLOBAL
		});
	});

	/**
	 * The claim and every owner call after it must address ONE Durable Object.
	 *
	 * `resolveSite()` on the worker honours `?site=` only on a route that is not public. `/firstrun`
	 * is public, so a claim naming a site mints the token on the object the HOST resolves to, while
	 * `/health` and `/modify` are told the name and address a different one -- which answers 401 for
	 * a token that is perfectly valid. A built-in default of `'site'` therefore worked against
	 * `wrangler dev` on localhost, whose host derives to the same fallback, and broke every
	 * deployment. The e2e lane measured it the first time a release payload existed to run against.
	 */
	it('names no site of its own, so the claim and the owner calls reach one object', async () => {
		const fetch = recorder(() => json({ ok: true, ownerToken: 'minted-token' }));
		const ctx = ctxFor(fetch);
		await runSiteClaim(ctx, undefined, { globals: globalsFor(ctx) });
		expect(new URL((fetch.calls[0] as Recorded).url).searchParams.has('site')).toBe(false);
	});

	it('sends the site only when the caller named one', async () => {
		const fetch = recorder(() => json({ ok: true, ownerToken: 'minted-token' }));
		const ctx = ctxFor(fetch);
		await runSiteClaim(ctx, undefined, {
			globals: testGlobals({ json: true }, ctx, {
				site: ORIGIN,
				token: TOKEN,
				siteName: 'blog'
			})
		});
		expect(new URL((fetch.calls[0] as Recorded).url).searchParams.get('site')).toBe('blog');
	});

	it('writes the token restricted, keyed by origin, and keeps the ones already there', async () => {
		const files = memoryFiles({
			[GLOBAL]: JSON.stringify({ sites: { 'https://other.example': { ownerToken: 'keep' } } })
		});
		const fetch = recorder(() => json({ ok: true, ownerToken: 'minted-token' }));
		const ctx = ctxFor(fetch, files);
		await runSiteClaim(ctx, ORIGIN, { save: true, globals: globalsFor(ctx) });

		const written = JSON.parse(files.written.get(GLOBAL) as string) as {
			sites: Record<string, { ownerToken: string }>;
		};
		expect(written.sites['https://other.example']?.ownerToken).toBe('keep');
		expect(written.sites[ORIGIN]?.ownerToken).toBe('minted-token');
		expect(files.secrets.has(GLOBAL)).toBe(true);
	});

	it('writes nothing when there is no terminal to ask on and no --save', async () => {
		const files = memoryFiles({});
		const fetch = recorder(() => json({ ok: true, ownerToken: 'minted-token' }));
		const ctx = ctxFor(fetch, files);
		await runSiteClaim(ctx, ORIGIN, { globals: globalsFor(ctx) });
		expect(files.written.size).toBe(0);
		expect(ctx.io.json<SiteClaimReport>().saved).toBeNull();
	});

	// a script has to be able to tell "I claimed it" from "somebody else did"
	it('exits 3 on a 409, and says the site was already claimed', async () => {
		const fetch = recorder(() =>
			json({ ok: false, error: 'already configured', firstRunAt: 1 }, 409)
		);
		const ctx = ctxFor(fetch);
		await expect(
			runSiteClaim(ctx, ORIGIN, { globals: globalsFor(ctx) })
		).rejects.toBeInstanceOf(FindingError);
		expect(ctx.io.json<SiteClaimReport>()).toMatchObject({
			alreadyClaimed: true,
			claimed: false
		});
	});

	/**
	 * The site's own `?pass=` refusal, surfaced rather than swallowed.
	 *
	 * drangler never sends one, so this can only arrive from something else pointed at the same
	 * origin; the route answers 400 carrying `how`, and repeating that verbatim is what turns a
	 * failed command into a fixed one.
	 */
	it('repeats the route remedy when the site refuses a password in a query string', async () => {
		const fetch = recorder(() =>
			json(
				{
					ok: false,
					error: 'refusing a password in a query string; it is logged by tail, observability and every intermediary',
					how: 'POST /firstrun with a JSON body: {"adminPass":"...","siteName":"..."}'
				},
				400
			)
		);
		const ctx = ctxFor(fetch);
		await expect(runSiteClaim(ctx, ORIGIN, { globals: globalsFor(ctx) })).rejects.toThrow(
			/query string/
		);
		expect(ctx.io.json<SiteClaimReport>().notes.join(' ')).toContain('JSON body');
	});

	it('refuses --force without a token, because force on a claimed site is a takeover', async () => {
		const ctx = ctxFor(recorder(() => json({ ok: true })));
		await expect(
			runSiteClaim(ctx, ORIGIN, {
				force: true,
				globals: testGlobals({ json: true }, ctx, { site: ORIGIN })
			})
		).rejects.toBeInstanceOf(UsageError);
	});

	it('sends nothing under --dry-run', async () => {
		const fetch = recorder(() => json({ ok: true }));
		const ctx = ctxFor(fetch);
		await runSiteClaim(ctx, ORIGIN, { globals: globalsFor(ctx, { dryRun: true }) });
		expect(fetch.calls).toEqual([]);
	});
});

describe('site updb', () => {
	const running = {
		run: { phase: 'running', cursorSeq: 3, maxSeq: 9, haltReason: null },
		byState: { done: 2, pending: 7 },
		remaining: 7
	};

	it('reads the cursor with a GET and drives one beat with --step', async () => {
		// the POST advances the cursor, because a beat that leaves it where it was is a stall
		const advanced = {
			run: { phase: 'running', cursorSeq: 4, maxSeq: 9, haltReason: null },
			byState: { done: 3, pending: 6 },
			remaining: 6
		};
		const fetch = recorder((url, call) =>
			call.method === 'POST'
				? json({ updb: { ok: true, phase: 'running' }, status: advanced })
				: json(running)
		);
		const ctx = ctxFor(fetch);
		await runSiteUpdb(ctx, ORIGIN, { globals: globalsFor(ctx) });
		expect((fetch.calls[0] as Recorded).method).toBe('GET');
		expect(ctx.io.json<UpdbReport>()).toMatchObject({
			phase: 'running',
			cursor: 3,
			max: 9,
			remaining: 7,
			stepped: false
		});

		// a beat run reads the phase first, because a terminal chain must not be beaten at all
		const stepping = ctxFor(fetch);
		await runSiteUpdb(stepping, ORIGIN, { step: true, globals: globalsFor(stepping) });
		expect(fetch.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
		expect(stepping.io.json<UpdbReport>()).toMatchObject({
			beats: 1,
			phase: 'running',
			cursor: 4
		});
	});

	it('sends the owner token as a bearer, never in the query', async () => {
		const fetch = recorder(() => json(running));
		const ctx = ctxFor(fetch);
		await runSiteUpdb(ctx, ORIGIN, { globals: globalsFor(ctx) });
		const call = fetch.calls[0] as Recorded;
		expect(call.authorization).toBe(`Bearer ${TOKEN}`);
		expect(call.url).not.toContain(TOKEN);
	});

	it('reports a site with no run rather than inventing a phase', async () => {
		const ctx = ctxFor(recorder(() => json({ run: null, units: [] })));
		await runSiteUpdb(ctx, ORIGIN, { globals: globalsFor(ctx) });
		expect(ctx.io.json<UpdbReport>()).toMatchObject({ phase: null, cursor: null });
	});

	it('exits 3 on a halted chain and names the reason', async () => {
		const ctx = ctxFor(
			recorder(() =>
				json({
					run: { phase: 'halted', cursorSeq: 4, maxSeq: 9, haltReason: 'update-failed' },
					byState: {},
					remaining: 5
				})
			)
		);
		await expect(runSiteUpdb(ctx, ORIGIN, { globals: globalsFor(ctx) })).rejects.toThrow(
			/update-failed/
		);
	});

	it('refuses without a token, naming the command that mints one', async () => {
		const ctx = ctxFor(recorder(() => json({})));
		await expect(
			runSiteUpdb(ctx, ORIGIN, { globals: testGlobals({}, ctx, { site: ORIGIN }) })
		).rejects.toThrow(/site claim/);
	});
});

describe('site invalidate', () => {
	it('invalidates tags by default and bumps the generation with --bump', async () => {
		const fetch = recorder((url) =>
			url.pathname === '/bump'
				? json({ ok: true, generation: 8 })
				: json({ ok: true, generationBefore: 7, generationAfter: 8 })
		);
		const ctx = ctxFor(fetch);
		await runSiteInvalidate(ctx, ORIGIN, { globals: globalsFor(ctx) });
		expect(new URL((fetch.calls[0] as Recorded).url).searchParams.get('tags')).toBe('rendered');

		const bumping = ctxFor(fetch);
		await runSiteInvalidate(bumping, ORIGIN, { bump: true, globals: globalsFor(bumping) });
		expect(new URL((fetch.calls[1] as Recorded).url).pathname).toBe('/bump');
		expect(bumping.io.json<{ generationAfter: number }>().generationAfter).toBe(8);
	});

	it('splits a tag list and drops the blanks', async () => {
		const fetch = recorder(() => json({ ok: true, generationAfter: 2 }));
		const ctx = ctxFor(fetch);
		await runSiteInvalidate(ctx, ORIGIN, {
			tags: 'node:12, , rendered',
			globals: globalsFor(ctx)
		});
		expect(new URL((fetch.calls[0] as Recorded).url).searchParams.get('tags')).toBe(
			'node:12,rendered'
		);
	});
});

describe('site upgrade', () => {
	/** a fresh object answers 503 with `x-cfw-migrate` until its replay cursor is done */
	const replaying = (chunk: string) =>
		new Response('', {
			status: 503,
			headers: { 'x-cfw-migrate': chunk, 'x-cfw-migrate-state': 'running' }
		});
	const served = () => new Response('<html></html>', { headers: { 'x-cfw-cache': 'MISS' } });

	it('polls the replay to completion, then reads the update chain', async () => {
		let serves = 0;
		const fetch = recorder((url) => {
			if (url.pathname === '/serve') {
				serves++;
				return serves < 3 ? replaying(`${serves}/62`) : served();
			}
			return json({ run: { phase: 'complete', cursorSeq: 9, maxSeq: 9 }, remaining: 0 });
		});
		const ctx = ctxFor(fetch);
		await runSiteUpgrade(ctx, ORIGIN, {
			deploy: false,
			interval: 0,
			globals: globalsFor(ctx)
		});
		const report = ctx.io.json<UpgradeReport>();
		expect(report).toMatchObject({ deployed: false, migrateDone: true, timedOut: false });
		expect(report.migrateChunk).toBe('2/62');
		expect(report.updb?.phase).toBe('complete');
	});

	/** both halves are cursor-driven, so a run that ran out of --wait continues rather than restarts */
	it('exits 3 when the replay outlives --wait, and says the next run continues', async () => {
		const fetch = recorder((url) =>
			url.pathname === '/serve' ? replaying('4/62') : json({ run: null })
		);
		const ctx = ctxFor(fetch);
		await expect(
			runSiteUpgrade(ctx, ORIGIN, {
				deploy: false,
				interval: 0,
				wait: 0,
				globals: globalsFor(ctx)
			})
		).rejects.toBeInstanceOf(FindingError);
		const report = ctx.io.json<UpgradeReport>();
		expect(report.timedOut).toBe(true);
		expect(report.notes.join(' ')).toContain('continues rather than restarting');
	});

	it('steps the update chain until it reaches a terminal phase', async () => {
		let beats = 0;
		const fetch = recorder((url) => {
			if (url.pathname === '/serve') return served();
			if (beats++ < 2) {
				return json({
					run: { phase: 'running', cursorSeq: beats, maxSeq: 3 },
					remaining: 3 - beats
				});
			}
			return json({ run: { phase: 'complete', cursorSeq: 3, maxSeq: 3 }, remaining: 0 });
		});
		const ctx = ctxFor(fetch);
		await runSiteUpgrade(ctx, ORIGIN, {
			deploy: false,
			interval: 0,
			globals: globalsFor(ctx)
		});
		expect(ctx.io.json<UpgradeReport>().updb?.phase).toBe('complete');
	});
});

describe('the parser', () => {
	it('refuses a bare word where an origin belongs, naming --site-name', async () => {
		const ctx = ctxFor(recorder(() => json({})));
		expect(await run(ctx, ['site', 'claim', '--site', 'blog'])).toBe(EXIT.USAGE);
		expect(ctx.io.stderr.join('\n')).toContain('--site-name');
	});

	it('names the command that mints a token when none is configured', async () => {
		const ctx = ctxFor(recorder(() => json({})));
		expect(await run(ctx, ['site', 'updb', ORIGIN])).toBe(EXIT.USAGE);
		expect(ctx.io.stderr.join('\n')).toContain('site claim');
	});
});

/**
 * The text render, which every other case skips by asking for `--json`.
 *
 * The two are built from the same object, so a render that threw would be invisible to a suite that
 * only ever read the JSON. These run each command once with the render on.
 */
describe('the text render', () => {
	it('prints the claim, the password and where the token went', async () => {
		const ctx = ctxFor(
			recorder(() => json({ ok: true, adminPass: 'minted-pass', ownerToken: 'minted-token' }))
		);
		await runSiteClaim(ctx, ORIGIN, { save: true, globals: globalsFor(ctx, { json: false }) });
		expect(ctx.io.text()).toContain('admin password  minted-pass');
		expect(ctx.io.text()).toContain(GLOBAL);
	});

	it('prints the updb cursor and the unit states', async () => {
		const ctx = ctxFor(
			recorder(() =>
				json({
					run: { phase: 'running', cursorSeq: 3, maxSeq: 9, haltReason: null },
					byState: { done: 2, pending: 7 },
					remaining: 7
				})
			)
		);
		await runSiteUpdb(ctx, ORIGIN, { globals: globalsFor(ctx, { json: false }) });
		expect(ctx.io.text()).toContain('cursor     3 of 9');
		expect(ctx.io.text()).toContain('pending');
	});

	it('prints the generation a purge moved', async () => {
		const ctx = ctxFor(
			recorder(() => json({ ok: true, generationBefore: 7, generationAfter: 8 }))
		);
		await runSiteInvalidate(ctx, ORIGIN, { globals: globalsFor(ctx, { json: false }) });
		expect(ctx.io.text()).toContain('generation  7 -> 8');
	});

	it('prints the upgrade rows, including the replay it waited on', async () => {
		let serves = 0;
		const ctx = ctxFor(
			recorder((url) => {
				if (url.pathname === '/serve') {
					serves++;
					return serves < 2
						? new Response('', { status: 503, headers: { 'x-cfw-migrate': '9/62' } })
						: new Response('', { headers: { 'x-cfw-cache': 'MISS' } });
				}
				return json({ run: { phase: 'complete', cursorSeq: 1, maxSeq: 1 }, remaining: 0 });
			})
		);
		await runSiteUpgrade(ctx, ORIGIN, {
			deploy: false,
			interval: 0,
			globals: globalsFor(ctx, { json: false })
		});
		expect(ctx.io.text()).toContain('done (last chunk 9/62)');
		expect(ctx.io.stderr.join('\n')).toContain('replaying the database, chunk 9/62');
	});
});

describe('refusals the flags own', () => {
	it('refuses a --wait that is not a number of milliseconds', async () => {
		const ctx = ctxFor(recorder(() => json({ ok: true })));
		await expect(
			runSiteUpgrade(ctx, ORIGIN, {
				deploy: false,
				wait: 'soon',
				globals: globalsFor(ctx)
			})
		).rejects.toThrow(/--wait must be a number/);
	});

	it('purges nothing under --dry-run and says so', async () => {
		const fetch = recorder(() => json({ ok: true }));
		const ctx = ctxFor(fetch);
		await runSiteInvalidate(ctx, ORIGIN, {
			bump: true,
			globals: globalsFor(ctx, { dryRun: true, json: false })
		});
		expect(fetch.calls).toEqual([]);
		expect(ctx.io.text()).toContain('dry run');
	});

	it('polls nothing under --dry-run', async () => {
		const fetch = recorder(() => json({ ok: true }));
		const ctx = ctxFor(fetch);
		await runSiteUpgrade(ctx, ORIGIN, {
			globals: globalsFor(ctx, { dryRun: true, json: true })
		});
		expect(fetch.calls).toEqual([]);
		expect(ctx.io.json<UpgradeReport>().polls).toBe(0);
	});

	// a route that answered with something other than JSON still has to report what it said
	it('reports a non-JSON refusal rather than throwing on the parse', async () => {
		const ctx = ctxFor(recorder(() => new Response('<html>502</html>', { status: 502 })));
		await expect(runSiteClaim(ctx, ORIGIN, { globals: globalsFor(ctx) })).rejects.toThrow(
			/502/
		);
	});

	it('raises a 401 as a usage error wherever it happens', async () => {
		const ctx = ctxFor(recorder(() => new Response('', { status: 401 })));
		await expect(runSiteUpdb(ctx, ORIGIN, { globals: globalsFor(ctx) })).rejects.toThrow(
			/refused the owner token/
		);
	});

	it('reports an origin that could not be reached at all', async () => {
		const ctx = ctxFor((async () => {
			throw new Error('ENOTFOUND');
		}) as unknown as FetchLike);
		await expect(runSiteUpdb(ctx, ORIGIN, { globals: globalsFor(ctx) })).rejects.toThrow(
			/ENOTFOUND/
		);
	});

	it('waits when an interval is asked for', async () => {
		const started = Date.now();
		await pause(5);
		expect(Date.now() - started).toBeGreaterThanOrEqual(4);
		await pause(0);
	});
});

/**
 * `--steps` runs a bounded number of beats and stops on an OBSERVATION.
 *
 * A beat can execute a `hook_update_N`, so there is no unbounded loop and no default snapshot
 * decision above one beat: `updbRollback()` exists on the worker and no route reaches it, which
 * makes the snapshot the only rollback a CLI has.
 */
describe('site updb --steps', () => {
	const run = (phases: { phase: string; cursor: number }[]) => {
		let i = 0;
		return recorder((url, call) => {
			const at = phases[Math.min(i, phases.length - 1)] as { phase: string; cursor: number };
			if (call.method === 'POST') i++;
			const next = phases[Math.min(i, phases.length - 1)] as {
				phase: string;
				cursor: number;
			};
			const status = {
				run: {
					phase: call.method === 'POST' ? next.phase : at.phase,
					cursorSeq: call.method === 'POST' ? next.cursor : at.cursor,
					maxSeq: 9,
					haltReason: next.phase === 'halted' ? 'update-failed' : null
				},
				byState: {},
				remaining: 9 - (call.method === 'POST' ? next.cursor : at.cursor)
			};
			return call.method === 'POST' ? json({ updb: { ok: true }, status }) : json(status);
		});
	};

	it('drives at most n beats and stops when the phase turns terminal', async () => {
		const fetch = run([
			{ phase: 'running', cursor: 1 },
			{ phase: 'running', cursor: 2 },
			{ phase: 'complete', cursor: 3 }
		]);
		const ctx = ctxFor(fetch);
		await runSiteUpdb(ctx, ORIGIN, {
			steps: 5,
			noSnapshot: true,
			globals: globalsFor(ctx)
		});
		const report = ctx.io.json<UpdbReport>();
		expect(report.phase).toBe('complete');
		// two beats reached `complete`; the remaining three of --steps 5 were never spent
		expect(report.beats).toBe(2);
	});

	it('stops mid-count on a halted phase and exits 3', async () => {
		const ctx = ctxFor(
			run([
				{ phase: 'running', cursor: 1 },
				{ phase: 'halted', cursor: 2 }
			])
		);
		await expect(
			runSiteUpdb(ctx, ORIGIN, { steps: 9, noSnapshot: true, globals: globalsFor(ctx) })
		).rejects.toThrow(/update-failed/);
		expect(ctx.io.json<UpdbReport>().beats).toBe(1);
	});

	/** a beat that leaves the cursor where it was will leave it there every time */
	it('exits 3 on a cursor that did not move, rather than spending the rest of the count', async () => {
		const ctx = ctxFor(run([{ phase: 'running', cursor: 4 }]));
		await expect(
			runSiteUpdb(ctx, ORIGIN, { steps: 20, noSnapshot: true, globals: globalsFor(ctx) })
		).rejects.toThrow(/not advancing/);
		expect(ctx.io.json<UpdbReport>().beats).toBe(1);
	});

	it('refuses more than one beat without a snapshot decision', async () => {
		const ctx = ctxFor(run([{ phase: 'running', cursor: 1 }]));
		await expect(
			runSiteUpdb(ctx, ORIGIN, { steps: 3, globals: globalsFor(ctx) })
		).rejects.toThrow(/--snapshot <dir> or --no-snapshot/);
	});

	it('needs no snapshot decision for a single beat', async () => {
		const ctx = ctxFor(
			run([
				{ phase: 'running', cursor: 1 },
				{ phase: 'complete', cursor: 2 }
			])
		);
		await runSiteUpdb(ctx, ORIGIN, { step: true, globals: globalsFor(ctx) });
		expect(ctx.io.json<UpdbReport>().beats).toBe(1);
	});

	it('refuses a --steps that is not a whole number of beats', async () => {
		const ctx = ctxFor(run([{ phase: 'running', cursor: 1 }]));
		await expect(
			runSiteUpdb(ctx, ORIGIN, { steps: 'lots', globals: globalsFor(ctx) })
		).rejects.toThrow(/whole number/);
	});
});
