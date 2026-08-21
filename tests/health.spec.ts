import { describe, expect, it } from 'vitest';
import { runHealth } from '../src/commands/health';
import { FindingError, ProbeError, UsageError } from '../src/errors';
import { classify, normaliseTarget, probeClaim, probeSite, serveUrl } from '../src/health/probe';
import { fakeFetch, testContext } from './helpers';

const workerHeaders = {
	'content-type': 'text/html; charset=utf-8',
	'x-cfw-cache': 'HIT',
	'x-cfw-generation': '12',
	'x-cfw-render-ms': '34',
	'x-cfw-serve-ms': '2',
	'x-cfw-php-booted': '1',
	'x-cfw-queue-depth': '0',
	'x-cfw-edge': 'MISS',
	'x-worker-ms': '5'
};

const workerFetch = (status = 200, headers: Record<string, string> = workerHeaders) =>
	fakeFetch(() => new Response('<html></html>', { status, headers }));

describe('normaliseTarget', () => {
	it('adds a scheme and strips a trailing slash', () => {
		expect(normaliseTarget('example.com')).toBe('https://example.com');
		expect(normaliseTarget('https://example.com/')).toBe('https://example.com');
	});

	it('keeps a base path', () => {
		expect(normaliseTarget('https://example.com/sub/')).toBe('https://example.com/sub');
	});

	it('refuses an empty or unparseable target', () => {
		expect(() => normaliseTarget('  ')).toThrow(UsageError);
		expect(() => normaliseTarget('http://')).toThrow(UsageError);
	});
});

describe('serveUrl', () => {
	it('builds the public route with the path and site as query parameters', () => {
		expect(serveUrl('https://x.dev', '/about', 'blog', false)).toBe(
			'https://x.dev/serve?path=%2Fabout&site=blog'
		);
	});

	it('adds edge=0 only when asked', () => {
		expect(serveUrl('https://x.dev', '/', 'site', true)).toContain('edge=0');
	});
});

describe('classify', () => {
	it('calls a queued 503 warming rather than degraded', () => {
		expect(classify(503, { 'x-cfw-queued': '1' }, 'worker')).toBe('warming');
		expect(classify(503, { 'x-cfw-cache': 'MISS' }, 'worker')).toBe('warming');
	});

	// the first command a user runs after a deploy met exactly this response and called it degraded:
	// a fresh object replays its database in chunks and its 503 carries neither of the two headers
	// above, only x-cfw-migrate
	it('calls a migrating 503 warming, with neither queued nor a cache tier on it', () => {
		expect(
			classify(
				503,
				{ 'x-cfw-migrate': 'starting', 'x-cfw-migrate-state': 'queued' },
				'worker'
			)
		).toBe('warming');
		expect(
			classify(503, { 'x-cfw-migrate': '31/62', 'x-cfw-migrate-state': 'running' }, 'worker')
		).toBe('warming');
	});

	it('calls an unqueued 5xx degraded', () => {
		expect(classify(500, { 'x-cfw-cache': 'HIT' }, 'worker')).toBe('degraded');
		expect(classify(404, { 'x-cfw-cache': 'DENY' }, 'worker')).toBe('degraded');
	});

	it('calls a worker with no x-cfw headers not-drupflare', () => {
		expect(classify(200, {}, 'worker')).toBe('not-drupflare');
		expect(classify(200, {}, 'vps')).toBe('ok');
	});
});

describe('probeSite', () => {
	it('reads every x-cfw header off a worker response', async () => {
		const fetch = workerFetch();
		const result = await probeSite({ fetch, now: () => 0 }, { target: 'x.dev' });
		expect(fetch.urls[0]).toBe('https://x.dev/serve?path=%2F&site=site');
		expect(result).toMatchObject({
			kind: 'worker',
			verdict: 'ok',
			status: 200,
			tier: 'HIT',
			generation: 12,
			renderMs: 34,
			workerMs: 5,
			phpBooted: true,
			queueDepth: 0
		});
		expect(result.cfw['x-cfw-render-ms']).toBe('34');
	});

	it('notes an edge answer and a cold object', async () => {
		const result = await probeSite(
			{ fetch: workerFetch(200, { 'x-cfw-cache': 'EDGE', 'x-cfw-php-booted': '0' }) },
			{ target: 'x.dev' }
		);
		expect(result.notes.join(' ')).toContain('edge cache');
	});

	it('notes a cold object on a non-edge answer', async () => {
		const result = await probeSite(
			{ fetch: workerFetch(200, { 'x-cfw-cache': 'MISS', 'x-cfw-php-booted': '0' }) },
			{ target: 'x.dev' }
		);
		expect(result.phpBooted).toBe(false);
		expect(result.notes.join(' ')).toContain('no interpreter booted');
	});

	it('falls back to a plain Drupal probe when no x-cfw header comes back', async () => {
		const fetch = fakeFetch((url) =>
			url.includes('/serve')
				? new Response('nope', { status: 404 })
				: new Response('<html></html>', {
						status: 200,
						headers: { 'x-generator': 'Drupal 11', 'x-drupal-cache': 'HIT' }
					})
		);
		const result = await probeSite({ fetch }, { target: 'x.dev', path: '/about' });
		expect(result.kind).toBe('vps');
		expect(result.generator).toBe('Drupal 11');
		expect(result.drupalCache).toBe('HIT');
		expect(fetch.urls[1]).toBe('https://x.dev/about');
		expect(result.notes.join(' ')).toContain('re-probed');
	});

	it('reports not-drupflare when the kind was pinned to worker', async () => {
		const result = await probeSite(
			{ fetch: fakeFetch(() => new Response('', { status: 200 })) },
			{ target: 'x.dev', kind: 'worker' }
		);
		expect(result.verdict).toBe('not-drupflare');
	});

	it('probes a VPS directly when asked, and flags a host it cannot confirm is Drupal', async () => {
		const fetch = fakeFetch(() => new Response('', { status: 200 }));
		const result = await probeSite({ fetch }, { target: 'vps.example', kind: 'vps' });
		expect(fetch.urls).toEqual(['https://vps.example/']);
		expect(result.kind).toBe('unknown');
		expect(result.notes.join(' ')).toContain('cannot confirm this is Drupal');
	});

	it('reports the diagnostic routes as gated on a 404', async () => {
		const fetch = fakeFetch((url) =>
			url.includes('/stats')
				? new Response('not found', { status: 404 })
				: new Response('', { status: 200, headers: workerHeaders })
		);
		const result = await probeSite({ fetch }, { target: 'x.dev', diagnostics: true });
		expect(result.diagnostics).toBe('gated');
	});

	it('warns when the diagnostic routes answer', async () => {
		const fetch = fakeFetch((url) =>
			url.includes('/stats')
				? new Response('{}', { status: 200 })
				: new Response('', { status: 200, headers: workerHeaders })
		);
		const result = await probeSite({ fetch }, { target: 'x.dev', diagnostics: true });
		expect(result.diagnostics).toBe('open');
		expect(result.notes.join(' ')).toContain('PW_DIAGNOSTICS');
	});

	it('measures wall clock from the injected clock', async () => {
		let t = 1000;
		const result = await probeSite(
			{ fetch: workerFetch(), now: () => (t += 7) },
			{ target: 'x.dev' }
		);
		expect(result.wallMs).toBe(7);
	});

	it('turns a network failure into a named error', async () => {
		const fetch = fakeFetch(() => {
			throw new Error('getaddrinfo ENOTFOUND');
		});
		await expect(probeSite({ fetch }, { target: 'x.dev' })).rejects.toThrow(ProbeError);
	});

	it('names the migration chunk instead of reporting an outage', async () => {
		const result = await probeSite(
			{
				fetch: workerFetch(503, {
					'x-cfw-migrate': '31/62',
					'x-cfw-migrate-state': 'running'
				})
			},
			{ target: 'x.dev' }
		);
		expect(result.verdict).toBe('warming');
		expect(result.notes.join(' ')).toContain('chunk 31/62 (running)');
	});
});

describe('probeClaim', () => {
	const firstrun = (body: unknown, status = 200) =>
		fakeFetch(() => new Response(JSON.stringify(body), { status }));

	it('reads an unclaimed site off the public /firstrun report', async () => {
		const fetch = firstrun({ ok: true, configured: false, firstRunAt: null });
		expect(await probeClaim({ fetch }, 'https://x.dev', 'site', 1000)).toEqual({
			state: 'unclaimed',
			firstRunAt: null
		});
		expect(fetch.urls[0]).toBe('https://x.dev/firstrun?site=site');
	});

	it('reads a claimed site and the timestamp it reports', async () => {
		const fetch = firstrun({ ok: true, configured: true, firstRunAt: 1755000000000 });
		expect(await probeClaim({ fetch }, 'https://x.dev', 'blog', 1000)).toEqual({
			state: 'claimed',
			firstRunAt: 1755000000000
		});
		expect(fetch.urls[0]).toContain('site=blog');
	});

	// unknown and unclaimed must not collapse: telling an owner their site is open when the route
	// simply did not answer sends them to reclaim something they already hold
	it('reports unknown for a non-200, a body that is not the report, and a dead network', async () => {
		const notFound = firstrun({}, 404);
		expect(await probeClaim({ fetch: notFound }, 'https://x.dev', 'site', 1000)).toEqual({
			state: 'unknown',
			firstRunAt: null
		});

		const wrongShape = fakeFetch(() => new Response('<html>hello</html>', { status: 200 }));
		expect((await probeClaim({ fetch: wrongShape }, 'https://x.dev', 'site', 1000)).state).toBe(
			'unknown'
		);

		const refused = firstrun({ ok: false, error: 'nope' });
		expect((await probeClaim({ fetch: refused }, 'https://x.dev', 'site', 1000)).state).toBe(
			'unknown'
		);

		const dead = fakeFetch(() => {
			throw new Error('ECONNREFUSED');
		});
		expect((await probeClaim({ fetch: dead }, 'https://x.dev', 'site', 1000)).state).toBe(
			'unknown'
		);
	});
});

describe('health command', () => {
	it('renders the worker fields and the raw headers', async () => {
		const ctx = testContext({ fetch: workerFetch() });
		await runHealth(ctx, 'x.dev', {});
		const text = ctx.io.text();
		expect(text).toContain('verdict');
		expect(text).toContain('wall clock, not cpuTime');
		expect(text).toContain('x-cfw-render-ms');
	});

	it('renders the VPS fields when probing a plain host', async () => {
		const ctx = testContext({
			fetch: fakeFetch(
				() => new Response('', { status: 200, headers: { 'x-generator': 'Drupal 11' } })
			)
		});
		await runHealth(ctx, 'vps.example', { kind: 'vps' });
		expect(ctx.io.text()).toContain('x-generator');
	});

	it('emits JSON on request', async () => {
		const ctx = testContext({ fetch: workerFetch() });
		await runHealth(ctx, 'x.dev', { json: true });
		expect(ctx.io.json<{ tier: string }>().tier).toBe('HIT');
	});

	it('exits with a finding when the site is degraded', async () => {
		const ctx = testContext({ fetch: workerFetch(500) });
		await expect(runHealth(ctx, 'x.dev', {})).rejects.toThrow(FindingError);
	});

	it('exits with a finding when the origin is not a drupflare worker', async () => {
		const ctx = testContext({ fetch: fakeFetch(() => new Response('', { status: 200 })) });
		await expect(runHealth(ctx, 'x.dev', { kind: 'worker' })).rejects.toThrow(
			/not a drupflare worker/
		);
	});

	it('reads the header contract version and stays quiet at the known one', async () => {
		const result = await probeSite(
			{ fetch: workerFetch(200, { ...workerHeaders, 'x-cfw-v': '1' }) },
			{ target: 'x.dev' }
		);
		expect(result.headerVersion).toBe(1);
		expect(result.notes.join(' ')).not.toContain('x-cfw-v');
	});

	it('warns when the contract version is ahead of what this build reads', async () => {
		const result = await probeSite(
			{ fetch: workerFetch(200, { ...workerHeaders, 'x-cfw-v': '2' }) },
			{ target: 'x.dev' }
		);
		expect(result.notes.join(' ')).toContain('a header that moved');
	});

	it('distinguishes a worker with no version marker from a renamed contract', async () => {
		const result = await probeSite({ fetch: workerFetch() }, { target: 'x.dev' });
		expect(result.headerVersion).toBeNull();
		expect(result.notes.join(' ')).toContain('predates the header contract marker');
	});

	it('refuses a timeout that is not a positive number', async () => {
		const ctx = testContext({ fetch: workerFetch() });
		await expect(runHealth(ctx, 'x.dev', { timeoutMs: Number('abc') })).rejects.toThrow(
			UsageError
		);
		await expect(runHealth(ctx, 'x.dev', { timeoutMs: 0 })).rejects.toThrow(/positive number/);
	});

	it('does not fail on a warming site', async () => {
		const ctx = testContext({
			fetch: workerFetch(503, { 'x-cfw-cache': 'MISS', 'x-cfw-queued': '1' })
		});
		await expect(runHealth(ctx, 'x.dev', {})).resolves.toBeUndefined();
		expect(ctx.io.text()).toContain('warming');
	});

	it('does not fail on a site that is still replaying its database', async () => {
		const ctx = testContext({
			fetch: workerFetch(503, {
				'x-cfw-migrate': 'starting',
				'x-cfw-migrate-state': 'queued',
				'x-cfw-edge': 'MISS'
			})
		});
		await expect(runHealth(ctx, 'x.dev', {})).resolves.toBeUndefined();
		expect(ctx.io.text()).toContain('warming');
		expect(ctx.io.text()).toContain('replaying the database');
	});
});
