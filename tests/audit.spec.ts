import { describe, expect, it } from 'vitest';
import {
	AUDIT_GENESIS,
	canonicalEntry,
	entryHash,
	runAudit,
	verifyChain,
	type AuditEntry,
	type AuditReport
} from '../src/commands/audit';
import { DranglerError, EXIT, FindingError } from '../src/errors';
import type { FetchLike } from '../src/health/probe';
import { run } from '../src/run';
import { fakeFetch, testContext, testGlobals, type TestContext } from './helpers';

const ORIGIN = 'https://mysite.example';
const TOKEN = 'tok-owner-audit';

/** `n` chained entries, built the way the worker builds them */
function chain(n: number, from = 1, prev = AUDIT_GENESIS): AuditEntry[] {
	const out: AuditEntry[] = [];
	for (let seq = from; seq < from + n; seq++) {
		const body = {
			seq,
			at: 1_800_000_000_000 + seq,
			route: seq % 2 === 0 ? '/export?secrets=1' : '/install',
			method: 'POST',
			status: 200,
			actor: 'a1b2c3d4',
			prev
		};
		const entry = { ...body, hash: entryHash(body) };
		out.push(entry);
		prev = entry.hash;
	}
	return out;
}

const answer = (entries: AuditEntry[], over: Record<string, unknown> = {}) => ({
	ok: true,
	verified: true,
	ring: 1000,
	head: entries.length === 0 ? null : { seq: entries.at(-1)!.seq, hash: entries.at(-1)!.hash },
	floor: null,
	failedAttempts: { count: 0 },
	entries,
	...over
});

function site(body: unknown, status = 200): FetchLike & { urls: string[] } {
	return fakeFetch(
		() =>
			new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' }
			})
	);
}

const ctxFor = (fetch: FetchLike): TestContext => testContext({ fetch, cwd: '/work' });
const globalsFor = (ctx: TestContext, over = {}) =>
	testGlobals({ json: true, ...over }, ctx, { site: ORIGIN, token: TOKEN });

describe('the hash', () => {
	it('matches the vector the worker pins, so the two sides cannot drift', () => {
		const body = {
			seq: 1,
			at: 1_800_000_000_001,
			route: '/install?force=1',
			method: 'POST',
			status: 200,
			actor: 'a1b2c3d4',
			prev: AUDIT_GENESIS
		};
		expect(canonicalEntry(body)).toBe(
			'{"seq":1,"at":1800000000001,"route":"/install?force=1","method":"POST","status":200,' +
				`"actor":"a1b2c3d4","prev":"${AUDIT_GENESIS}"}`
		);
		expect(entryHash(body)).toBe(
			'7b03b07fd2e40697a9d49db6854268faaf9cc654d4127f12a15f7a062bc7d151'
		);
	});
});

describe('verifyChain', () => {
	it('accepts a chain, an empty log and a wrapped window anchored by its floor', () => {
		const entries = chain(4);
		expect(verifyChain(entries, null, { seq: 4, hash: entries[3]!.hash })).toEqual({
			verified: true,
			firstBadSeq: null
		});
		expect(verifyChain([], null, null).verified).toBe(true);
		const window = chain(3, 6, entries[0]!.hash);
		const floor = { seq: 5, hash: entries[0]!.hash };
		expect(verifyChain(window, floor, null).verified).toBe(true);
		// the same window with no floor is not anchored
		expect(verifyChain(window, null, null)).toEqual({ verified: false, firstBadSeq: 6 });
	});

	it('fails at the edited entry, at the next one when the hash is rewritten too, at a gap and a cut tail', () => {
		const entries = chain(4);
		const head = { seq: 4, hash: entries[3]!.hash };
		const edited = entries.map((e) => (e.seq === 2 ? { ...e, route: '/restore' } : e));
		expect(verifyChain(edited, null, head)).toEqual({ verified: false, firstBadSeq: 2 });

		const forged = { ...entries[1]!, actor: 'ffffffff' };
		forged.hash = entryHash(forged);
		expect(
			verifyChain(
				entries.map((e) => (e.seq === 2 ? forged : e)),
				null,
				head
			)
		).toEqual({
			verified: false,
			firstBadSeq: 3
		});
		expect(
			verifyChain(
				entries.filter((e) => e.seq !== 2),
				null,
				head
			)
		).toEqual({ verified: false, firstBadSeq: 3 });
		expect(verifyChain(entries.slice(0, 3), null, head)).toEqual({
			verified: false,
			firstBadSeq: 4
		});
		expect(verifyChain([entries[0], 'junk'], null, null)).toEqual({
			verified: false,
			firstBadSeq: 2
		});
	});
});

describe('audit', () => {
	it('reads /audit with the owner token and reports every entry', async () => {
		const entries = chain(3);
		const calls: { url: string; auth: string | null }[] = [];
		const fetch = fakeFetch((url, init) => {
			calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
			return Response.json(
				answer(entries, { failedAttempts: { count: 2, since: 1_800_000_000_000 } })
			);
		});
		const ctx = ctxFor(fetch);
		await runAudit(ctx, undefined, { globals: globalsFor(ctx) });

		expect(new URL(calls[0]!.url).pathname).toBe('/audit');
		expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
		const report = ctx.io.json<AuditReport>();
		expect(report.entries).toEqual(entries);
		expect(report.failedAttempts).toEqual({ count: 2, since: 1_800_000_000_000 });
		// not checked here unless asked, and the site's word is kept apart from ours
		expect(report).toMatchObject({ siteVerified: true, verified: null, firstBadSeq: null });
		expect(report.notes.join(' ')).toContain('--verify');
		expect(JSON.stringify(report)).not.toContain(TOKEN);
	});

	it('--verify recomputes the chain and says so', async () => {
		const ctx = ctxFor(site(answer(chain(5))));
		await runAudit(ctx, undefined, { verify: true, globals: globalsFor(ctx) });
		expect(ctx.io.json<AuditReport>()).toMatchObject({ verified: true, firstBadSeq: null });
	});

	it('--verify catches an edited log the site still calls verified, and exits 3', async () => {
		const entries = chain(5);
		const edited = entries.map((e) => (e.seq === 3 ? { ...e, status: 404 } : e));
		const ctx = ctxFor(site(answer(edited, { verified: true })));
		const failure = await runAudit(ctx, undefined, {
			verify: true,
			globals: globalsFor(ctx)
		}).catch((e: unknown) => e);

		expect(failure).toBeInstanceOf(FindingError);
		expect(failure).toMatchObject({ code: 'audit-broken', exitCode: EXIT.FINDING });
		expect((failure as Error).message).toContain('seq 3');
		const report = ctx.io.json<AuditReport>();
		expect(report).toMatchObject({ siteVerified: true, verified: false, firstBadSeq: 3 });
		expect(report.notes.join(' ')).toContain('this check is the one to believe');
	});

	it('does not exit 3 without --verify, whatever the entries hold', async () => {
		const entries = chain(2).map((e) => ({ ...e, route: '/restore' }));
		const ctx = ctxFor(site(answer(entries)));
		await runAudit(ctx, undefined, { globals: globalsFor(ctx) });
		expect(ctx.io.json<AuditReport>().verified).toBeNull();
	});

	it('verifies a wrapped ring from its floor and reports that it wrapped', async () => {
		const dropped = chain(5);
		const window = chain(4, 6, dropped[4]!.hash);
		const ctx = ctxFor(site(answer(window, { floor: { seq: 5, hash: dropped[4]!.hash } })));
		await runAudit(ctx, undefined, { verify: true, globals: globalsFor(ctx) });
		const report = ctx.io.json<AuditReport>();
		expect(report.verified).toBe(true);
		expect(report.notes.join(' ')).toContain('wrapped');
	});

	it('reports an empty log without an error', async () => {
		const ctx = ctxFor(site(answer([])));
		await runAudit(ctx, undefined, { verify: true, globals: globalsFor(ctx) });
		expect(ctx.io.json<AuditReport>()).toMatchObject({
			verified: true,
			entries: [],
			head: null
		});
	});

	it('lists the newest --limit entries in text and says how many it left out', async () => {
		const ctx = ctxFor(site(answer(chain(6))));
		await runAudit(ctx, undefined, {
			limit: 2,
			verify: true,
			globals: globalsFor(ctx, { json: false })
		});
		const text = ctx.io.text();
		expect(text).toContain('chain verifies');
		expect(text).toContain('POST /export?secrets=1');
		expect(text).toContain('(4 older entries not shown)');
		// only the two newest rows are listed
		expect(text.match(/POST \//g)).toHaveLength(2);
	});

	it('names the missing route on a worker that predates the log', async () => {
		const ctx = ctxFor(site({ error: 'not found' }, 404));
		const failure = await runAudit(ctx, undefined, { globals: globalsFor(ctx) }).catch(
			(e: unknown) => e
		);
		expect(failure).toBeInstanceOf(DranglerError);
		expect(failure).toMatchObject({ code: 'audit', next: 'drangler update' });
		expect((failure as Error).message).toContain('predates the owner audit log');
	});

	it('refuses a --limit that is not a whole number', async () => {
		const ctx = ctxFor(site(answer([])));
		await expect(
			runAudit(ctx, undefined, { limit: '0', globals: globalsFor(ctx) })
		).rejects.toMatchObject({ exitCode: EXIT.USAGE });
	});

	it('is a command on the program, and a broken chain is exit 3 through it', async () => {
		const entries = chain(3).map((e) => (e.seq === 2 ? { ...e, route: '/export' } : e));
		const ctx = ctxFor(site(answer(entries)));
		const code = await run(ctx, ['audit', ORIGIN, '--verify', '--json', '--token', TOKEN]);
		expect(code).toBe(EXIT.FINDING);
		// under --json stdout carries the report, then the error object
		expect(ctx.io.text()).toContain('audit-broken');
	});
});
