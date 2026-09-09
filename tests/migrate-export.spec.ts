import { describe, expect, it } from 'vitest';
import { runExportCommand } from '../src/commands/migrate';
import { DranglerError, UsageError } from '../src/errors';
import type { FetchLike } from '../src/health/probe';
import { memoryFiles, type MemoryFiles } from '../src/host/files';
import { readCheckpoint } from '../src/migrate/checkpoint';
import { testContext, type TestContext } from './helpers';

const ORIGIN = 'https://mysite.example';
const TOKEN = 'tok-owner-1';
const CHECKPOINT = '.drangler/migration.json';

/** the statements a whole dump is made of, split across three chunks by the route */
const CHUNKS = [
	'CREATE TABLE node (nid INTEGER);\n',
	'INSERT INTO node VALUES (1);\n',
	'INSERT INTO node VALUES (2);\n'
];

interface ChunkedSite {
	fetch: FetchLike;
	cursors: string[];
	/** chunk index at which the connection drops, or -1 */
	failAt: { at: number };
}

/**
 * The worker's cursored dump.
 *
 * The cursor is opaque and goes back verbatim, and the route answers 409 on a shape mismatch because
 * two different dumps being spliced produce a file that looks whole and is not.
 */
function chunkedSite(over: { torn?: boolean; stalls?: boolean } = {}): ChunkedSite {
	const cursors: string[] = [];
	const failAt = { at: -1 };
	const fetch = (async (input: unknown): Promise<Response> => {
		const url = new URL(String(input));
		const cursor = url.searchParams.get('cursor') ?? 'start';
		cursors.push(cursor);
		if (over.torn === true && cursor !== 'start') {
			return new Response('the dump shape changed under this cursor', { status: 409 });
		}
		const index = cursor === 'start' ? 0 : Number(JSON.parse(cursor).at);
		if (failAt.at === index) return new Response('', { status: 502 });
		const done = index >= CHUNKS.length - 1;
		return new Response(
			JSON.stringify({
				ok: true,
				sql: CHUNKS[index],
				statements: 1,
				done,
				// a stalled route hands back the cursor it was given
				nextCursor: done
					? null
					: JSON.stringify({ at: over.stalls === true ? index : index + 1 }),
				tables: { node: 2 },
				replayable: true
			}),
			{ headers: { 'content-type': 'application/json' } }
		);
	}) as unknown as FetchLike;
	return { fetch, cursors, failAt };
}

function ctxFor(fetch: FetchLike, files: MemoryFiles = memoryFiles({})): TestContext {
	return testContext({ fetch, files, cwd: '/work' });
}

const base = { url: ORIGIN, token: TOKEN, site: 'site' };

describe('migrate export --chunked', () => {
	it('walks the cursor to the end and writes one dump', async () => {
		const site = chunkedSite();
		const files = memoryFiles({});
		const ctx = ctxFor(site.fetch, files);
		await runExportCommand(ctx, { ...base, chunked: true, out: '/out.sql', json: true });

		expect(files.readText('/out.sql')).toBe(CHUNKS.join(''));
		expect(ctx.io.json<{ chunks: number; statements: number }>()).toMatchObject({
			chunks: 3,
			statements: 3
		});
		expect(site.cursors[0]).toBe('start');
	});

	/** the resumed dump and the whole dump are the same bytes, or the resume is worth nothing */
	it('resumes from the recorded cursor and produces the same dump as one run', async () => {
		const whole = memoryFiles({});
		const first = ctxFor(chunkedSite().fetch, whole);
		await runExportCommand(first, { ...base, chunked: true, out: '/whole.sql' });

		// a run that dies after the second chunk, leaving its cursor behind
		const partial = memoryFiles({});
		const dying = chunkedSite();
		dying.failAt.at = 2;
		const broken = ctxFor(dying.fetch, partial);
		await expect(
			runExportCommand(broken, { ...base, chunked: true, out: '/part.sql' })
		).rejects.toBeInstanceOf(DranglerError);
		const saved = readCheckpoint(partial, CHECKPOINT);
		expect(saved?.phases['export']).toMatchObject({ state: 'partial' });
		expect(saved?.phases['export']?.cursor).toContain('"at":2');

		// and the resume, against the same checkpoint file
		const resumed = ctxFor(chunkedSite().fetch, partial);
		await runExportCommand(resumed, { ...base, resume: true, out: '/rest.sql', json: true });
		expect(partial.readText('/rest.sql')).toBe(CHUNKS[2]);
		expect(resumed.io.json<{ resumed: boolean }>().resumed).toBe(true);
		// the two halves together are the whole dump
		expect(`${CHUNKS[0]}${CHUNKS[1]}${partial.readText('/rest.sql')}`).toBe(
			whole.readText('/whole.sql')
		);
	});

	it('marks the phase done and records the digest when it finishes', async () => {
		const files = memoryFiles({});
		const ctx = ctxFor(chunkedSite().fetch, files);
		await runExportCommand(ctx, { ...base, chunked: true, out: '/out.sql' });
		const phase = readCheckpoint(files, CHECKPOINT)?.phases['export'];
		expect(phase).toMatchObject({ state: 'done', cursor: null, artifact: '/out.sql' });
		expect(phase?.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	/**
	 * The terminating observation is the cursor ADVANCING, not a chunk count.
	 *
	 * A chunk that comes back with the cursor it was given will come back that way every time, so a
	 * loop bounded only by a count would spend the whole bound learning nothing.
	 */
	it('exits on a cursor that did not move rather than looping', async () => {
		const ctx = ctxFor(chunkedSite({ stalls: true }).fetch);
		const failure = (await runExportCommand(ctx, {
			...base,
			chunked: true,
			out: '/out.sql'
		}).then(
			() => null,
			(e: unknown) => e as DranglerError
		)) as DranglerError;
		expect(failure.code).toBe('export-stalled');
		expect(failure.next).toBe('drangler migrate export --resume');
	});

	// the route's own refusal: continuing this cursor would splice two different dumps
	it('reports a 409 mid-cursor as torn rather than retrying it', async () => {
		const files = memoryFiles({
			[CHECKPOINT]: JSON.stringify({
				version: 1,
				fingerprint: '',
				direction: 'to-vps',
				startedAt: 'x',
				phases: { export: { state: 'partial', cursor: '{"at":1}' } }
			})
		});
		const ctx = ctxFor(chunkedSite({ torn: true }).fetch, files);
		const failure = (await runExportCommand(ctx, { ...base, resume: true }).then(
			() => null,
			(e: unknown) => e as DranglerError
		)) as DranglerError;
		expect(failure.code).toBe('export-torn');
		expect(failure.retryable).toBe(false);
	});

	it('refuses --resume with no checkpoint to resume from', async () => {
		const ctx = ctxFor(chunkedSite().fetch);
		await expect(runExportCommand(ctx, { ...base, resume: true })).rejects.toBeInstanceOf(
			UsageError
		);
	});

	it('passes --chunk-chars through to the route', async () => {
		const site = chunkedSite();
		const ctx = ctxFor(site.fetch);
		await runExportCommand(ctx, { ...base, chunked: true, chunkChars: 4096 });
		expect(site.cursors).toHaveLength(3);
	});
});

/** the unbounded single request is unchanged; --chunked is what opts into the cursor */
describe('the whole-dump path', () => {
	it('still issues one request when nothing asks for chunks', async () => {
		const seen: string[] = [];
		const fetch = (async (input: unknown) => {
			seen.push(String(input));
			return new Response(
				JSON.stringify({ sql: CHUNKS.join(''), statements: 3, replayable: true }),
				{ headers: { 'content-type': 'application/json' } }
			);
		}) as unknown as FetchLike;
		const ctx = ctxFor(fetch);
		await runExportCommand(ctx, { ...base, out: '/out.sql' });
		expect(seen).toHaveLength(1);
		expect(seen[0]).not.toContain('cursor=');
	});
});
