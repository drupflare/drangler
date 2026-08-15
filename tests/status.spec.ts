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

/** `/serve` answers with the identity headers; `/stats` 404s, which is a correctly closed site */
const deployed = (headers: Record<string, string> = identity, statsStatus = 404) =>
	fakeFetch((url) =>
		url.includes('/stats')
			? new Response('not found', { status: statsStatus })
			: new Response('<html></html>', { status: 200, headers })
	);

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

	it('exits with a finding when the site does not answer', async () => {
		const ctx = testContext({
			fetch: fakeFetch(() => {
				throw new Error('ENOTFOUND');
			})
		});
		await expect(runStatus(ctx, 'site.example', {})).rejects.toThrow(/ENOTFOUND/);
	});
});
