import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/errors';
import { memoryFiles } from '../src/host/files';
import { run } from '../src/run';
import { testContext } from './helpers';

/**
 * The cutover checklist, driven through the parser.
 *
 * It prints and it runs nothing. Every item is something only the person doing the cutover can
 * observe, and there is no verdict for any of them.
 */
describe('drangler migrate cutover', () => {
	const ctxFor = () => testContext({ files: memoryFiles({}) });

	it('prints the checklist and exits 0 without touching anything', async () => {
		const ctx = ctxFor();
		expect(await run(ctx, ['migrate', 'cutover', '--checklist'])).toBe(EXIT.OK);
		expect(ctx.io.text()).toContain('maintenance mode');
		expect(ctx.io.text()).toContain('flip DNS');
	});

	it('carries the same steps under --json, as data', async () => {
		const ctx = ctxFor();
		expect(await run(ctx, ['migrate', 'cutover', '--json'])).toBe(EXIT.OK);
		const report = ctx.io.json<{ steps: { n: number }[]; unsafe: unknown[] }>();
		expect(report.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(report.unsafe).toHaveLength(3);
	});
});

describe('drangler migrate delta', () => {
	it('is reachable from the parser and names the re-seed', async () => {
		const ctx = testContext({ files: memoryFiles({}) });
		expect(await run(ctx, ['migrate', 'delta'])).toBe(EXIT.OK);
		expect(ctx.io.text()).toContain('UPDATE sequences');
	});
});
