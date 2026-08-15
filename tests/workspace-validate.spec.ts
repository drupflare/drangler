import { describe, expect, it } from 'vitest';
import { scriptedRunner, type CommandResult } from '../src/host/exec';
import { memoryFiles } from '../src/host/files';
import {
	ceilingVerdict,
	FREE_CEILING,
	PAID_CEILING,
	parseWranglerGzipBytes
} from '../src/workspace/bundle';
import {
	ALL_CHECKS,
	GATES,
	validateWorkspace,
	type CheckId,
	type ValidationCheck
} from '../src/workspace/validate';
import { fail, ok, testContext, WORKER_CONFIG, workerTree, WORKSPACE } from './helpers';

const DRY_RUN = `bunx wrangler deploy -c wrangler.jsonc --dry-run --outdir ${WORKSPACE}/dist/dry-run`;
const SCRUB = 'bun run assets:scrub:check';

function runner(over: Record<string, CommandResult> = {}) {
	return scriptedRunner({
		[SCRUB]: ok('sites/default/settings.php  clean'),
		[DRY_RUN]: ok('Total Upload: 11000.00 KiB / gzip: 2818.80 KiB'),
		...over
	});
}

const green = (over: Record<string, string> = {}, script: Record<string, CommandResult> = {}) =>
	testContext({ files: memoryFiles(workerTree(over)), runner: runner(script) });

const byId = (checks: ValidationCheck[], id: CheckId): ValidationCheck =>
	checks.find((c) => c.id === id)!;

describe('parseWranglerGzipBytes', () => {
	it('converts KiB, which is what wrangler prints and the ceiling is not', () => {
		expect(parseWranglerGzipBytes('Total Upload: 11000.00 KiB / gzip: 2818.80 KiB')).toBe(
			2_886_451
		);
	});

	it('converts MiB and bare bytes too', () => {
		expect(parseWranglerGzipBytes('gzip: 3.50 MiB')).toBe(3_670_016);
		expect(parseWranglerGzipBytes('gzip: 900 B')).toBe(900);
	});

	it('returns undefined when the line is absent, which means the run failed', () => {
		expect(parseWranglerGzipBytes('Error: no such config')).toBeUndefined();
	});
});

describe('ceilingVerdict', () => {
	it('reports headroom against both ceilings', () => {
		expect(ceilingVerdict(2_885_427)).toEqual({
			bytes: 2_885_427,
			fitsFree: true,
			fitsPaid: true,
			freeHeadroom: 260_301,
			paidHeadroom: PAID_CEILING - 2_885_427
		});
	});

	it('treats the ceiling itself as fitting, and one byte over as not', () => {
		expect(ceilingVerdict(FREE_CEILING)).toMatchObject({ fitsFree: true, freeHeadroom: 0 });
		expect(ceilingVerdict(FREE_CEILING + 1)).toMatchObject({
			fitsFree: false,
			freeHeadroom: -1
		});
	});

	it('reports the default seam overshoot as over free and under paid', () => {
		expect(ceilingVerdict(3_856_138)).toMatchObject({
			fitsFree: false,
			fitsPaid: true,
			freeHeadroom: -710_410
		});
	});
});

describe('GATES', () => {
	it('gates dev on less than deploy, because dev never uploads', () => {
		expect(GATES.dev).toEqual(['workspace', 'artifacts', 'config']);
		expect(GATES.deploy).toEqual(ALL_CHECKS);
		expect(GATES.deploy).toContain('bundle');
		expect(GATES.dev).not.toContain('bundle');
		expect(GATES.dev).not.toContain('scrub');
	});
});

describe('validateWorkspace', () => {
	it('passes every check on a hydrated checkout', async () => {
		const report = await validateWorkspace(green(), WORKSPACE);
		expect(report.ok).toBe(true);
		expect(report.failed).toEqual([]);
		expect(report.skipped).toEqual([]);
		expect(report.checks.map((c) => c.id)).toEqual(ALL_CHECKS);
	});

	it('runs only the subset it is given', async () => {
		const report = await validateWorkspace(green(), WORKSPACE, { only: GATES.dev });
		expect(report.checks.map((c) => c.id)).toEqual(['workspace', 'artifacts', 'config']);
	});

	it('names an absent workspace and the command that makes one', async () => {
		const report = await validateWorkspace(
			testContext({ files: memoryFiles({}), runner: runner() }),
			'/ws/nope',
			{ only: ['workspace'] }
		);
		const check = byId(report.checks, 'workspace');
		expect(check).toMatchObject({ ran: true, ok: false });
		expect(check.fix).toBe('drangler build --workspace /ws/nope');
	});

	it('names each missing artifact with the command that produces it', async () => {
		const tree = workerTree();
		delete tree[`${WORKSPACE}/assets/driver.json`];
		delete tree[`${WORKSPACE}/.interp/zstddec.wasm`];
		const ctx = testContext({ files: memoryFiles(tree), runner: runner() });

		const report = await validateWorkspace(ctx, WORKSPACE, { only: ['artifacts'] });
		const check = byId(report.checks, 'artifacts');
		expect(check.ok).toBe(false);
		expect(check.detail).toContain('assets/driver.json <- bun run assets:driver');
		expect(check.detail).toContain('.interp/zstddec.wasm <- bun run build:wasm');
		expect(check.fix).toBe(`cd ${WORKSPACE} && bun run hydrate`);
	});

	it('does not claim to have checked artifacts when there is no checkout to look in', async () => {
		const report = await validateWorkspace(
			testContext({ files: memoryFiles({}), runner: runner() }),
			'/ws/nope',
			{ only: ['artifacts'] }
		);
		expect(byId(report.checks, 'artifacts')).toMatchObject({ ran: false, ok: false });
		expect(report.skipped).toEqual(['artifacts']);
		expect(report.failed).toEqual([]);
	});

	it('fails on a config blocker and passes with only warnings', async () => {
		const blocked = green({
			[`${WORKSPACE}/wrangler.jsonc`]: JSON.stringify({
				...JSON.parse(WORKER_CONFIG),
				vars: { PW_DIAGNOSTICS: '1' }
			})
		});
		const report = await validateWorkspace(blocked, WORKSPACE, { only: ['config'] });
		expect(byId(report.checks, 'config')).toMatchObject({ ran: true, ok: false });
		expect(byId(report.checks, 'config').detail).toContain('PW_DIAGNOSTICS');

		const clean = await validateWorkspace(green(), WORKSPACE, { only: ['config'] });
		expect(byId(clean.checks, 'config').ok).toBe(true);
	});

	it('reports a missing config as not checked, naming the file it looked for', async () => {
		const tree = workerTree();
		delete tree[`${WORKSPACE}/wrangler.jsonc`];
		const report = await validateWorkspace(
			testContext({ files: memoryFiles(tree), runner: runner() }),
			WORKSPACE,
			{ only: ['config'] }
		);
		expect(byId(report.checks, 'config')).toMatchObject({ ran: false, ok: false });
		expect(byId(report.checks, 'config').detail).toContain('no wrangler.jsonc at');
	});

	it('lists the warnings when there are no blockers', async () => {
		const ctx = green({
			[`${WORKSPACE}/wrangler.jsonc`]: JSON.stringify({
				...JSON.parse(WORKER_CONFIG),
				compatibility_flags: []
			})
		});
		const report = await validateWorkspace(ctx, WORKSPACE, { only: ['config'] });
		expect(byId(report.checks, 'config')).toMatchObject({ ran: true, ok: true, fix: null });
		expect(byId(report.checks, 'config').detail).toContain('warning: no `nodejs_compat` flag');
		expect(byId(report.checks, 'config').title).toContain('warning(s)');
	});

	it('reports an unparseable config as not checked rather than as a pass', async () => {
		const ctx = green({ [`${WORKSPACE}/wrangler.jsonc`]: '{' });
		const report = await validateWorkspace(ctx, WORKSPACE, { only: ['config'] });
		expect(byId(report.checks, 'config')).toMatchObject({ ran: false, ok: false });
		expect(report.skipped).toEqual(['config']);
	});

	it('scores whichever config it is pointed at', async () => {
		const ctx = green({ [`${WORKSPACE}/wrangler.free.jsonc`]: WORKER_CONFIG });
		const report = await validateWorkspace(ctx, WORKSPACE, {
			only: ['config'],
			config: 'wrangler.free.jsonc'
		});
		expect(byId(report.checks, 'config').ok).toBe(true);
		expect(report.config).toBe('wrangler.free.jsonc');
	});

	it('runs the workers own scrubber rather than reading the pack here', async () => {
		const ctx = green();
		await validateWorkspace(ctx, WORKSPACE, { only: ['scrub'] });
		const call = (ctx.runner as ReturnType<typeof runner>).calls[0]!;
		expect([call.file, ...call.args].join(' ')).toBe(SCRUB);
		expect(call.cwd).toBe(WORKSPACE);
	});

	it('reads exit 1 as a shipped secret and exit 2 as a check that could not run', async () => {
		const seeded = await validateWorkspace(
			green(
				{},
				{ [SCRUB]: { code: 1, stdout: 'settings.php  hash_salt  PRESENT', stderr: '' } }
			),
			WORKSPACE,
			{ only: ['scrub'] }
		);
		expect(byId(seeded.checks, 'scrub')).toMatchObject({ ran: true, ok: false });
		expect(byId(seeded.checks, 'scrub').fix).toContain('bun run assets:scrub');

		const absent = await validateWorkspace(
			green({}, { [SCRUB]: fail(2, 'no per-file pack at assets/drupal-pf') }),
			WORKSPACE,
			{ only: ['scrub'] }
		);
		expect(byId(absent.checks, 'scrub')).toMatchObject({ ran: false, ok: false });
		expect(absent.skipped).toEqual(['scrub']);
	});

	it('prices the bundle from wranglers own printed figure', async () => {
		const report = await validateWorkspace(green(), WORKSPACE, { only: ['bundle'] });
		const check = byId(report.checks, 'bundle');
		expect(check).toMatchObject({ ran: true, ok: true });
		expect(check.detail).toContain('2,886,451 gzipped bytes against 3,145,728');
	});

	it('fails a bundle over the free ceiling and says by how much', async () => {
		const report = await validateWorkspace(
			green({}, { [DRY_RUN]: ok('gzip: 3765.76 KiB') }),
			WORKSPACE,
			{ only: ['bundle'] }
		);
		const check = byId(report.checks, 'bundle');
		expect(check).toMatchObject({ ran: true, ok: false });
		expect(check.title).toContain('OVER the free ceiling');
		expect(check.detail).toContain('it fits the paid ceiling');
	});

	it('reads a dry run that printed no figure as a check that could not be made', async () => {
		const report = await validateWorkspace(
			green({}, { [DRY_RUN]: fail(1, 'Error: Could not resolve "./runtime/php-binary.js"') }),
			WORKSPACE,
			{ only: ['bundle'] }
		);
		expect(byId(report.checks, 'bundle')).toMatchObject({ ran: false, ok: false });
		expect(byId(report.checks, 'bundle').detail).toContain('php-binary');
	});

	it('reads the gzip figure off stderr as well as stdout', async () => {
		const report = await validateWorkspace(
			green({}, { [DRY_RUN]: { code: 0, stdout: '', stderr: 'gzip: 2818.80 KiB' } }),
			WORKSPACE,
			{ only: ['bundle'] }
		);
		expect(byId(report.checks, 'bundle').ok).toBe(true);
	});
});
