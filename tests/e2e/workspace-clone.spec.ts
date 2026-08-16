import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBuildCommand } from '../../src/commands/workspace';
import { defaultContext, type Context } from '../../src/context';
import { EXIT } from '../../src/errors';
import { nodeFiles } from '../../src/host/files';
import { bufferIo, type BufferIo } from '../../src/io';
import { run } from '../../src/run';
import { interpreterFiles, REQUIRED_ARTIFACTS } from '../../src/workspace/artifacts';
import { planBuild, runPlan, type BuildReport } from '../../src/workspace/build';
import { isWorkerCheckout, readState, WORKER_PACKAGE } from '../../src/workspace/layout';
import { resolveSource } from '../../src/workspace/source';
import { validateWorkspace } from '../../src/workspace/validate';
import { cloneGate, resolvePayload, WORKER_REF, WORKER_SOURCE } from './helpers/clone';

const skip = await cloneGate();
const payload = skip ? null : await resolvePayload();

/**
 * The build path against the published repository, over a real network and a real disk.
 *
 * The gate lane drives these same functions against a scripted runner whose steps land the files
 * they really produce. That proves the step order, the resume decision and every verdict, and it
 * cannot prove the one thing that only exists off this machine: that `git clone` of
 * `drupflare/worker` lands a tree drangler recognises, that `bun install` resolves it from npm, and
 * that `interpreterFiles()` reads the alias the worker actually ships rather than the one in a
 * fixture.
 *
 * Ordered, and the order is the point: a clean checkout is asserted BEFORE it is hydrated, because
 * the window between `git clone` and `bun run hydrate` is where a user reads drangler's report.
 */
describe.skipIf(skip)('a live clone of drupflare/worker', () => {
	let scratch: string;
	let workspace: string;

	const ctxWith = (io: BufferIo): Context => ({
		...defaultContext(),
		io,
		files: nodeFiles(),
		cwd: scratch
	});

	beforeAll(() => {
		scratch = mkdtempSync(join(tmpdir(), 'drangler-e2e-clone-'));
		workspace = join(scratch, 'worker');
	});

	afterAll(() => {
		// ~850 MB, almost all of it the worker's node_modules; the lane owns this directory
		rmSync(scratch, { recursive: true, force: true });
	});

	it('plans a clone, an install and a hydrate, and under --dry-run runs none of them', async () => {
		const io = bufferIo();
		await runBuildCommand(ctxWith(io), {
			workspace,
			source: WORKER_SOURCE,
			ref: WORKER_REF,
			dryRun: true,
			json: true
		});
		const plan = io.json<{ steps: { id: string; run: boolean; command: string }[] }>();
		expect(plan.steps.filter((s) => s.run).map((s) => s.id)).toEqual([
			'clone',
			'install',
			'hydrate'
		]);
		expect(plan.steps[0]?.command).toContain(`--branch ${WORKER_REF} ${WORKER_SOURCE}`);
		expect(readState(nodeFiles(), workspace).occupied).toBe(false);
	});

	/**
	 * Stopped short of hydrate on purpose, through the real plan rather than a flag.
	 *
	 * There is no `--no-hydrate`, and there should not be: a half-built workspace is not a state a
	 * user asks for. The spec wants it because the next test reads it, so it filters the plan it
	 * would have run instead of adding a flag to the product for a test's benefit.
	 */
	it('clones the published repository and installs it from npm', async () => {
		const ctx = ctxWith(bufferIo());
		const source = resolveSource({}, WORKER_SOURCE, WORKER_REF);
		const steps = planBuild(readState(ctx.files, workspace), source);
		const report = await runPlan(
			ctx,
			steps.filter((s) => s.id !== 'hydrate'),
			workspace,
			source
		);

		expect(report.steps.filter((s) => s.run).map((s) => [s.id, s.code])).toEqual([
			['clone', 0],
			['install', 0]
		]);
		expect(
			isWorkerCheckout(ctx.files, workspace),
			`${workspace} is not a ${WORKER_PACKAGE}`
		).toBe(true);
		expect(readState(ctx.files, workspace)).toMatchObject({
			occupied: true,
			checkout: true,
			repository: true,
			installed: true,
			hydrated: false
		});
	}, 900_000);

	/**
	 * The report a user gets between `git clone` and `bun run hydrate`.
	 *
	 * The interpreter half is the assertion that could not be made anywhere else: the paths are
	 * derived from the alias in the checkout's own `wrangler.jsonc` and the `from` specifiers of the
	 * seam it points at, so this fails if the worker moves its binary and drangler's reader does not
	 * follow. A fixture would agree with itself forever.
	 */
	it('reads a clean checkout: a workspace, no generated tree, a config with no blockers', async () => {
		const ctx = ctxWith(bufferIo());
		const report = await validateWorkspace(ctx, workspace, {
			only: ['workspace', 'artifacts', 'config']
		});

		expect(report.skipped, 'every one of these three is answerable from disk').toEqual([]);
		expect(report.failed).toEqual(['artifacts']);

		const missing = report.checks.find((c) => c.id === 'artifacts')?.detail ?? '';
		for (const artifact of REQUIRED_ARTIFACTS) expect(missing).toContain(artifact.path);

		const interpreter = interpreterFiles(ctx.files, workspace);
		expect(interpreter.length, 'the shipped config aliases no php-binary seam').toBeGreaterThan(
			0
		);
		for (const path of interpreter) {
			expect(path).toMatch(/^\.interp\//);
			expect(missing).toContain(path);
		}
	});

	it('exits 3 from the command surface: the check ran and found something', async () => {
		const io = bufferIo();
		const code = await run(ctxWith(io), [
			'validate',
			'--workspace',
			workspace,
			'--only',
			'workspace,artifacts,config'
		]);
		expect(code).toBe(EXIT.FINDING);
		expect(io.text()).toContain('bun run hydrate');
	});

	it('resumes against a real disk: the clone and the install are already done', () => {
		const source = resolveSource({}, WORKER_SOURCE, WORKER_REF);
		const steps = planBuild(readState(nodeFiles(), workspace), source);
		expect(steps.filter((s) => s.run).map((s) => s.id)).toEqual(['hydrate']);
		expect(steps.find((s) => s.id === 'clone')?.reason).toContain('already a');
		expect(steps.find((s) => s.id === 'install')?.reason).toContain(
			'node_modules is populated'
		);
	});

	/**
	 * `drangler dev` has to work with no flags, so the default hands the decision to the checkout.
	 *
	 * Only `hydrate` can see whether a payload answered, and before the first release none does --
	 * so a default of `--payload-only` here would make the one command that has to work on a clean
	 * machine be the one command that cannot. The overrides still have to be flags the checkout
	 * accepts, and THAT is the cross-repo half: drangler chooses the string, the worker decides what
	 * it means, and a fixture on either side would agree with itself forever.
	 *
	 * The plan is asserted rather than run. A real source build is ~15 minutes, a 180 MB download and
	 * a Docker image, none of which belongs in a lane that already clones and installs.
	 */
	it('names no route by default, and every override it can name is one the checkout reads', () => {
		const source = resolveSource({}, WORKER_SOURCE, WORKER_REF);
		const state = readState(nodeFiles(), workspace);
		const hydrateStep = (opts = {}) =>
			planBuild(state, source, opts).find((s) => s.id === 'hydrate')?.command ?? [];

		expect(hydrateStep()).toEqual(['bun', 'run', 'hydrate']);
		expect(hydrateStep({ fromSource: true })).toContain('--from-source');
		expect(hydrateStep({ payloadOnly: true })).toContain('--payload-only');

		const hydrate = readFileSync(join(workspace, 'scripts/hydrate.ts'), 'utf8');
		for (const flag of ['--payload-only', '--from-source']) {
			expect(hydrate, `the checkout's hydrate.ts never reads ${flag}`).toContain(flag);
		}
	});

	/**
	 * With no payload the DEFAULT route is the source build, and the checkout has to say so.
	 *
	 * Asserted through `--payload-only`, which is the same resolution with the fallback turned off:
	 * it proves the checkout looked, found nothing, and named both the absence and the way forward.
	 * Letting the real default run here would spend fifteen minutes and a Docker image inside a lane
	 * whose subject is the handover, not the build.
	 */
	it.skipIf(payload !== null)(
		'reports the missing payload by name, and points at the route that needs none',
		async () => {
			const io = bufferIo();
			await expect(
				runBuildCommand(ctxWith(io), {
					workspace,
					source: WORKER_SOURCE,
					ref: WORKER_REF,
					payloadOnly: true,
					json: true
				})
			).rejects.toThrow(/hydrate failed/);

			const said = io.text();
			expect(said, 'the checkout must name the missing payload').toMatch(
				/no payload to hydrate from/
			);
			expect(said, 'and must name the route that needs no payload').toContain(
				'bun run build:local'
			);
			expect(readState(nodeFiles(), workspace).hydrated).toBe(false);
		},
		900_000
	);

	it.skipIf(payload === null)(
		`hydrates from the ${payload?.detail ?? 'payload'}`,
		async () => {
			const io = bufferIo();
			await runBuildCommand(ctxWith(io), {
				workspace,
				source: WORKER_SOURCE,
				ref: WORKER_REF,
				json: true,
				// a release is what `hydrate` resolves on its own; a local tarball has to be handed over
				...(payload?.kind === 'local' ? { from: payload.from } : {})
			});

			const report = io.json<BuildReport>();
			expect(report.resumed).toBe(false);
			expect(report.steps.filter((s) => s.run).map((s) => [s.id, s.code])).toEqual([
				['hydrate', 0]
			]);
			expect(readState(nodeFiles(), workspace).hydrated).toBe(true);
		},
		900_000
	);

	/**
	 * Every check reaches a verdict against a hydrated tree.
	 *
	 * `scrub` and `bundle` are the two that shell out into the checkout, so this is where the clone
	 * pays for itself: it proves the worker still answers `bun run assets:scrub:check` and still
	 * prints a gzip figure wrangler's own way. A `not run` here means drangler lost its grip on the
	 * checkout's scripts, which no fixture can notice.
	 */
	it.skipIf(payload === null)(
		'runs every check, and none of them reports "not run"',
		async () => {
			const ctx = ctxWith(bufferIo());
			const report = await validateWorkspace(ctx, workspace);
			expect(report.skipped, JSON.stringify(report.checks, null, 2)).toEqual([]);
			expect(report.failed.filter((id) => id !== 'scrub')).toEqual([]);
		},
		900_000
	);

	/**
	 * A PUBLISHED payload has to be deployable; a hand-built one is whatever was handed over.
	 *
	 * The difference is a real gate rather than a hedge. `scripts/release-payload.ts` refuses to pack
	 * a tree carrying a seeded credential, and the Release workflow hydrates the ATTACHED tarball and
	 * runs `bun run test` under `REQUIRE_ARTIFACTS=1`, where `tests/node/pack-secrets.spec.ts` scans
	 * the payload again -- so a release that fails `scrub` here is a release that should not exist.
	 * A tarball named by `DRANGLER_E2E_PAYLOAD` has passed neither, and asserting green on it would
	 * test the tester's tarball rather than the product.
	 */
	it.skipIf(payload?.kind !== 'release')(
		'a published payload deploys clean',
		async () => {
			const ctx = ctxWith(bufferIo());
			const report = await validateWorkspace(ctx, workspace);
			expect(report.failed, JSON.stringify(report.checks, null, 2)).toEqual([]);
			expect(report.ok).toBe(true);
		},
		900_000
	);
});
