import { describe, expect, it } from 'vitest';
import { DranglerError } from '../src/errors';
import { scriptedRunner } from '../src/host/exec';
import { memoryFiles } from '../src/host/files';
import { bufferIo } from '../src/io';
import { hydrateArgs, planBuild, runPlan, type BuildStepId } from '../src/workspace/build';
import { readState, type WorkspaceState } from '../src/workspace/layout';
import { resolveSource } from '../src/workspace/source';
import { ok, testContext, workerTree, WORKSPACE } from './helpers';

const SOURCE = resolveSource({}, '/src/worker');

/** the four steps in order, so an assertion names them rather than counting them */
const ORDER: BuildStepId[] = ['clone', 'refresh', 'install', 'hydrate'];

function stateOf(over: Partial<WorkspaceState> = {}): WorkspaceState {
	return {
		path: WORKSPACE,
		occupied: false,
		checkout: false,
		repository: false,
		installed: false,
		hydrated: false,
		...over
	};
}

const running = (state: WorkspaceState, opts = {}): BuildStepId[] =>
	planBuild(state, SOURCE, opts)
		.filter((s) => s.run)
		.map((s) => s.id);

describe('planBuild', () => {
	it('always emits the four steps in order, run or not', () => {
		expect(planBuild(stateOf(), SOURCE).map((s) => s.id)).toEqual(ORDER);
		expect(
			planBuild(stateOf({ checkout: true, installed: true, hydrated: true }), SOURCE).map(
				(s) => s.id
			)
		).toEqual(ORDER);
	});

	it('runs everything but refresh on an empty workspace', () => {
		expect(running(stateOf())).toEqual(['clone', 'install', 'hydrate']);
	});

	it('is the resume decision: a finished workspace runs nothing', () => {
		const state = stateOf({
			occupied: true,
			checkout: true,
			repository: true,
			installed: true,
			hydrated: true
		});
		expect(running(state)).toEqual([]);
		expect(planBuild(state, SOURCE).every((s) => !s.run)).toBe(true);
	});

	it('resumes an interrupted run at the step that did not finish', () => {
		const cloned = stateOf({ occupied: true, checkout: true, repository: true });
		expect(running(cloned)).toEqual(['install', 'hydrate']);

		const installed = stateOf({ ...cloned, installed: true });
		expect(running(installed)).toEqual(['hydrate']);
	});

	it('re-runs install and hydrate under --force, and never re-clones', () => {
		const state = stateOf({
			occupied: true,
			checkout: true,
			repository: true,
			installed: true,
			hydrated: true
		});
		expect(running(state, { force: true })).toEqual(['install', 'hydrate']);
	});

	it('always hydrates when a payload is named, even on a hydrated tree', () => {
		const state = stateOf({ checkout: true, installed: true, hydrated: true });
		expect(running(state, { from: '/tmp/p.tar.gz' })).toEqual(['hydrate']);
		expect(planBuild(state, SOURCE, { from: '/tmp/p.tar.gz' })[3]?.command).toEqual([
			'bun',
			'run',
			'hydrate',
			'--from=/tmp/p.tar.gz'
		]);
	});

	it('names no route by default, so `drangler dev` works with no flags', () => {
		// the checkout's `hydrate` resolves a payload and falls back to a source build when there is
		// none, and only it can see which happened. Before the first release the fallback IS the
		// path, so forcing `--payload-only` here would break the one command that has to work
		expect(planBuild(stateOf(), SOURCE)[3]?.command).toEqual(['bun', 'run', 'hydrate']);
		expect(hydrateArgs({})).toEqual([]);
	});

	it('asks for the source build when --from-source says to', () => {
		expect(planBuild(stateOf(), SOURCE, { fromSource: true })[3]?.command).toEqual([
			'bun',
			'run',
			'hydrate',
			'--from-source'
		]);
		expect(planBuild(stateOf(), SOURCE, { fromSource: true })[3]?.reason).toContain(
			'from source'
		);
	});

	it('forbids the source build when --payload-only says to', () => {
		expect(planBuild(stateOf(), SOURCE, { payloadOnly: true })[3]?.command).toEqual([
			'bun',
			'run',
			'hydrate',
			'--payload-only'
		]);
	});

	it('lets a named payload win over --from-source, because a tarball IS a payload', () => {
		expect(hydrateArgs({ from: '/tmp/p.tar.gz', fromSource: true })).toEqual([
			'--from=/tmp/p.tar.gz'
		]);
	});

	it('never passes two routes at once', () => {
		for (const opts of [
			{ fromSource: true },
			{ payloadOnly: true },
			{ from: '/tmp/p.tar.gz' },
			{ fromSource: true, payloadOnly: true }
		]) {
			expect(hydrateArgs(opts)).toHaveLength(1);
		}
	});

	it('refreshes only when asked and only when there is a .git to fetch from', () => {
		const withGit = stateOf({
			checkout: true,
			repository: true,
			installed: true,
			hydrated: true
		});
		expect(running(withGit, { refresh: true })).toEqual(['refresh']);

		const withoutGit = stateOf({ ...withGit, repository: false });
		expect(running(withoutGit, { refresh: true })).toEqual([]);
		expect(planBuild(withoutGit, SOURCE, { refresh: true })[1]?.reason).toContain('no .git');
	});

	it('does not refresh a checkout it is about to clone in the same run', () => {
		expect(running(stateOf(), { refresh: true })).toEqual(['clone', 'install', 'hydrate']);
		expect(planBuild(stateOf(), SOURCE, { refresh: true })[1]?.reason).toContain(
			'being cloned in this run'
		);
	});

	it('carries the clone argv, so a dry run is reviewable before anything happens', () => {
		expect(planBuild(stateOf(), SOURCE)[0]?.command).toEqual([
			'git',
			'clone',
			'--branch',
			'master',
			'/src/worker',
			WORKSPACE
		]);
	});

	it('gives every step a reason, including the skipped ones', () => {
		for (const step of planBuild(stateOf({ checkout: true }), SOURCE)) {
			expect(step.reason).not.toBe('');
		}
	});
});

describe('runPlan', () => {
	const cloneLine = `git clone --branch master /src/worker ${WORKSPACE}`;

	function scripted(over: Record<string, ReturnType<typeof ok>> = {}) {
		return scriptedRunner({
			[cloneLine]: ok(''),
			'bun install': ok(''),
			'bun run hydrate': ok('hydrated 87 files'),
			...over
		});
	}

	it('runs the steps in order, through spawn, in the right directory', async () => {
		const runner = scripted();
		const ctx = testContext({ runner, cwd: '/ws' });
		const report = await runPlan(ctx, planBuild(stateOf(), SOURCE), WORKSPACE, SOURCE);

		expect(runner.calls.map((c) => [c.file, ...c.args].join(' '))).toEqual([
			cloneLine,
			'bun install',
			'bun run hydrate'
		]);
		expect(runner.calls.every((c) => c.mode === 'spawn')).toBe(true);
		// the clone runs from the working directory, because its target does not exist yet
		expect(runner.calls[0]?.cwd).toBe('/ws');
		expect(runner.calls[1]?.cwd).toBe(WORKSPACE);
		expect(report.resumed).toBe(false);
	});

	it('reports a fully skipped plan as resumed and runs no subprocess', async () => {
		const runner = scripted();
		const ctx = testContext({ runner });
		const state = readState(memoryFiles(workerTree()), WORKSPACE);
		const report = await runPlan(ctx, planBuild(state, SOURCE), WORKSPACE, SOURCE);

		expect(runner.calls).toEqual([]);
		expect(report.resumed).toBe(true);
		expect(report.steps.every((s) => !s.run)).toBe(true);
	});

	it('stops at the first failing step and names the command', async () => {
		const runner = scripted({ 'bun install': { code: 1, stdout: '', stderr: 'no lockfile' } });
		const ctx = testContext({ runner });
		await expect(runPlan(ctx, planBuild(stateOf(), SOURCE), WORKSPACE, SOURCE)).rejects.toThrow(
			/install failed: `bun install` exited 1/
		);
		expect(runner.calls.map((c) => c.args[0])).not.toContain('run');
	});

	/**
	 * THE FIRST THING A NEW USER HITS, and the exit code alone is a dead end.
	 *
	 * `bun run hydrate` needs a published release payload. Until one exists there is nothing to
	 * fetch, so a fresh checkout fails here -- and the route that needs no payload is
	 * `build:local`. The e2e clone lane asserted this diagnostic and it had never been written, so
	 * that spec had been red since the day it landed.
	 */
	it('names the missing payload and the route that needs none when hydrate fails', async () => {
		const runner = scripted({ 'bun run hydrate': { code: 1, stdout: '', stderr: '' } });
		const ctx = testContext({ runner });
		await expect(runPlan(ctx, planBuild(stateOf(), SOURCE), WORKSPACE, SOURCE)).rejects.toThrow(
			/hydrate failed/
		);
		const said = (ctx.io as ReturnType<typeof bufferIo>).text();
		expect(said).toMatch(/no payload to hydrate from/);
		expect(said).toContain('bun run build:local');
	});

	it('says nothing about payloads when a DIFFERENT step fails', async () => {
		// the guidance is specific to hydrate; printing it for a failed `bun install` would send
		// the reader after the wrong problem
		const runner = scripted({ 'bun install': { code: 1, stdout: '', stderr: '' } });
		const ctx = testContext({ runner });
		await expect(
			runPlan(ctx, planBuild(stateOf(), SOURCE), WORKSPACE, SOURCE)
		).rejects.toThrow();
		expect((ctx.io as ReturnType<typeof bufferIo>).text()).not.toMatch(/no payload/);
	});

	it('refuses to refresh a checkout with uncommitted work in it', async () => {
		const runner = scriptedRunner({
			[`git -C ${WORKSPACE} status --porcelain`]: ok(' M wrangler.jsonc\n')
		});
		const state = stateOf({
			checkout: true,
			repository: true,
			installed: true,
			hydrated: true
		});
		const ctx = testContext({ runner });
		await expect(
			runPlan(ctx, planBuild(state, SOURCE, { refresh: true }), WORKSPACE, SOURCE)
		).rejects.toThrow(/uncommitted changes/);
		// nothing was fetched, so the tree is untouched
		expect(runner.calls.map((c) => c.args)).not.toContainEqual(
			expect.arrayContaining(['fetch'])
		);
	});

	it('fast-forwards after a clean fetch, and never resets', async () => {
		const runner = scriptedRunner({
			[`git -C ${WORKSPACE} status --porcelain`]: ok(''),
			[`git -C ${WORKSPACE} fetch origin master`]: ok(''),
			[`git -C ${WORKSPACE} merge --ff-only FETCH_HEAD`]: ok('Fast-forward')
		});
		const state = stateOf({
			checkout: true,
			repository: true,
			installed: true,
			hydrated: true
		});
		await runPlan(
			testContext({ runner }),
			planBuild(state, SOURCE, { refresh: true }),
			WORKSPACE,
			SOURCE
		);
		const lines = runner.calls.map((c) => c.args.join(' '));
		expect(lines).toContain(`-C ${WORKSPACE} merge --ff-only FETCH_HEAD`);
		expect(lines.join('\n')).not.toContain('reset');
	});

	it('reports a diverged checkout rather than rewriting it', async () => {
		const runner = scriptedRunner({
			[`git -C ${WORKSPACE} status --porcelain`]: ok(''),
			[`git -C ${WORKSPACE} fetch origin master`]: ok(''),
			[`git -C ${WORKSPACE} merge --ff-only FETCH_HEAD`]: {
				code: 128,
				stdout: '',
				stderr: 'Not possible to fast-forward'
			}
		});
		const state = stateOf({
			checkout: true,
			repository: true,
			installed: true,
			hydrated: true
		});
		await expect(
			runPlan(
				testContext({ runner }),
				planBuild(state, SOURCE, { refresh: true }),
				WORKSPACE,
				SOURCE
			)
		).rejects.toThrow(DranglerError);
	});

	it('reports a git status that could not run as its own failure', async () => {
		const runner = scriptedRunner({});
		const state = stateOf({
			checkout: true,
			repository: true,
			installed: true,
			hydrated: true
		});
		await expect(
			runPlan(
				testContext({ runner }),
				planBuild(state, SOURCE, { refresh: true }),
				WORKSPACE,
				SOURCE
			)
		).rejects.toThrow(/git status failed/);
	});

	it('falls back to the exit code when git said nothing at all', async () => {
		const state = stateOf({
			checkout: true,
			repository: true,
			installed: true,
			hydrated: true
		});
		const silent = scriptedRunner({
			[`git -C ${WORKSPACE} status --porcelain`]: { code: 4, stdout: '', stderr: '' }
		});
		await expect(
			runPlan(
				testContext({ runner: silent }),
				planBuild(state, SOURCE, { refresh: true }),
				WORKSPACE,
				SOURCE
			)
		).rejects.toThrow(/exit 4/);

		const merge = scriptedRunner({
			[`git -C ${WORKSPACE} status --porcelain`]: ok(''),
			[`git -C ${WORKSPACE} fetch origin master`]: ok(''),
			[`git -C ${WORKSPACE} merge --ff-only FETCH_HEAD`]: { code: 5, stdout: '', stderr: '' }
		});
		await expect(
			runPlan(
				testContext({ runner: merge }),
				planBuild(state, SOURCE, { refresh: true }),
				WORKSPACE,
				SOURCE
			)
		).rejects.toThrow(/exit 5/);
	});
});
