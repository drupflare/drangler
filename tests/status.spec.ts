import { describe, expect, it } from 'vitest';
import { runStatus } from '../src/commands/status';
import { FindingError } from '../src/errors';
import { memoryFiles } from '../src/host/files';
import { fakeFetch, testContext } from './helpers';

/**
 * `status` answers "what is deployed here", from a deployed site.
 *
 * It used to scan nine sibling git checkouts of the drupflare source. That could only ever succeed
 * on a machine maintaining drupflare itself, and it was the FIRST command in the help output, so the
 * first thing a new user ran failed. These cases pin the replacement to a user's situation: one
 * public request, no credential, no checkout required.
 */

const identity = {
	'x-cfw-v': '1',
	'x-cfw-cache': 'MISS',
	'x-cfw-generation': '42',
	'x-cfw-plan': 'free',
	'x-cfw-php-booted': '1'
};

/**
 * `/serve` answers with the identity headers; `/stats` 404s, which is a correctly closed site;
 * `/firstrun` reports a claimed one, which is the state a site spends its life in.
 */
const deployed = (headers: Record<string, string> = identity, statsStatus = 404, claimed = true) =>
	fakeFetch((url) => {
		if (url.includes('/stats')) return new Response('not found', { status: statsStatus });
		if (url.includes('/firstrun')) {
			return new Response(
				JSON.stringify({
					ok: true,
					configured: claimed,
					firstRunAt: claimed ? 1755000000000 : null
				}),
				{ status: 200 }
			);
		}
		return new Response('<html></html>', { status: 200, headers });
	});

describe('status', () => {
	it('reports the deployed identity from one public request', async () => {
		const ctx = testContext({ fetch: deployed() });
		await runStatus(ctx, 'site.example', {});
		const text = ctx.io.text();
		expect(text).toContain('plan');
		expect(text).toContain('free');
		expect(text).toContain('generation');
		expect(text).toContain('42');
		expect(text).toContain('v1');
	});

	it('bypasses the edge, because a cache tier carries no plan header', async () => {
		const fetch = deployed();
		await runStatus(testContext({ fetch }), 'site.example', {});
		expect(fetch.urls[0]).toContain('edge=0');
	});

	it('needs no local files at all', async () => {
		const ctx = testContext({ fetch: deployed(), files: memoryFiles({}) });
		await expect(runStatus(ctx, 'site.example', {})).resolves.toBeUndefined();
		expect(ctx.io.json === undefined).toBe(false);
	});

	it('reads a wrangler config when the user kept their checkout', async () => {
		const ctx = testContext({
			fetch: deployed(),
			cwd: '/home/me/site',
			files: memoryFiles({
				'/home/me/site/wrangler.jsonc':
					'{"name":"my-blog","main":"src/site.ts","compatibility_date":"2026-08-01"}'
			})
		});
		await runStatus(ctx, 'site.example', { json: true });
		expect(ctx.io.json<{ config: { name: string } }>().config.name).toBe('my-blog');
	});

	it('treats an unreadable config as no config rather than an error', async () => {
		const ctx = testContext({
			fetch: deployed(),
			cwd: '/home/me/site',
			files: memoryFiles({ '/home/me/site/wrangler.jsonc': '{' })
		});
		await runStatus(ctx, 'site.example', { json: true });
		expect(ctx.io.json<{ config: unknown }>().config).toBeNull();
	});

	it('says the plan is unknown rather than free when a cache tier answered', async () => {
		const ctx = testContext({
			fetch: deployed({ 'x-cfw-cache': 'EDGE', 'x-cfw-v': '1' })
		});
		await runStatus(ctx, 'site.example', { json: true });
		const status = ctx.io.json<{ plan: string | null; notes: string[] }>();
		expect(status.plan).toBeNull();
		expect(status.notes.join(' ')).toContain('unknown rather than free');
	});

	it('reports an unversioned header contract without failing', async () => {
		const ctx = testContext({ fetch: deployed({ 'x-cfw-cache': 'HIT' }) });
		await runStatus(ctx, 'site.example', {});
		expect(ctx.io.text()).toContain('unversioned');
	});

	it('exits with a finding when the diagnostic routes are open', async () => {
		const ctx = testContext({ fetch: deployed(identity, 200) });
		await expect(runStatus(ctx, 'site.example', {})).rejects.toThrow(FindingError);
		expect(ctx.io.text()).toContain('should be closed');
	});

	it('reports a claimed site and the timestamp it carries', async () => {
		const ctx = testContext({ fetch: deployed() });
		await runStatus(ctx, 'site.example', { json: true });
		const status = ctx.io.json<{ claimed: string; firstRunAt: number | null }>();
		expect(status.claimed).toBe('claimed');
		expect(status.firstRunAt).toBe(1755000000000);
	});

	// the state a site is in for the minutes between a deploy and its owner arriving, and the one
	// state where somebody else can take it
	it('exits with a finding on an unclaimed site and says how to close the window', async () => {
		const ctx = testContext({ fetch: deployed(identity, 404, false) });
		await expect(runStatus(ctx, 'site.example', {})).rejects.toThrow(FindingError);
		const text = ctx.io.text();
		expect(text).toContain('claimed');
		expect(text).toContain('unclaimed');
		expect(text).toContain('POST /firstrun');
	});

	it('separates a site it could not ask from one nobody has claimed', async () => {
		const ctx = testContext({
			fetch: fakeFetch((url) =>
				url.includes('/serve')
					? new Response('<html></html>', { status: 200, headers: identity })
					: new Response('not found', { status: 404 })
			)
		});
		await runStatus(ctx, 'site.example', { json: true });
		const status = ctx.io.json<{ claimed: string; notes: string[] }>();
		expect(status.claimed).toBe('unknown');
		expect(status.notes.join(' ')).toContain('predate the route');
	});

	it('exits with a finding when the site does not answer', async () => {
		const ctx = testContext({
			fetch: fakeFetch(() => {
				throw new Error('ENOTFOUND');
			})
		});
		await expect(runStatus(ctx, 'site.example', {})).rejects.toThrow(/ENOTFOUND/);
	});
});
