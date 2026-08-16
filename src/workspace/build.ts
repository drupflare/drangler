import type { Context } from '../context';
import { DranglerError } from '../errors';
import type { WorkspaceState } from './layout';
import { cloneArgs, type WorkerSource } from './source';

export type BuildStepId = 'clone' | 'refresh' | 'install' | 'hydrate';

export interface BuildStep {
	id: BuildStepId;
	/** the argv, so a plan is reviewable before anything runs */
	command: string[];
	/** whether the step will actually be executed */
	run: boolean;
	/** why it will or will not, in a clause the report prints verbatim */
	reason: string;
}

export interface BuildOptions {
	/** redo the steps that are skippable, short of re-cloning */
	force?: boolean;
	/** fetch and fast-forward an existing checkout; refuses on a dirty tree */
	refresh?: boolean;
	/** a local payload tarball, passed through to `bun run hydrate --from=` */
	from?: string;
	/** regenerate the artifacts in the checkout rather than letting `hydrate` decide */
	fromSource?: boolean;
	/**
	 * Refuse to build from source; fail instead when there is no payload.
	 *
	 * For a lane that must not spend minutes on a toolchain build it did not ask for -- CI, a
	 * scripted provision. NOT the default: `drangler dev` has to work on a clean machine with no
	 * flags, and before the first release there is no payload to work from, so a default of
	 * `--payload-only` would make the one command that has to work be the one command that cannot.
	 */
	payloadOnly?: boolean;
}

/**
 * The ordered steps a build would run against a given workspace, and which of them are skipped.
 *
 * PURE, and this is the resume decision in one function: a second `drangler build` on a finished
 * workspace produces four skipped steps and touches nothing. `wrangler dev` is resumable because it
 * reuses its state directory; the equivalent here is that every step asks the disk whether its
 * output already exists rather than asking a lock file whether it already ran.
 *
 * `clone` is never re-run by `--force`. Replacing a checkout means deleting one, and drangler has no
 * delete seam; the honest answer to "I want a fresh clone" is a different `--workspace`.
 */
export function planBuild(
	state: WorkspaceState,
	source: WorkerSource,
	opts: BuildOptions = {}
): BuildStep[] {
	const force = opts.force === true;
	const steps: BuildStep[] = [];

	steps.push({
		id: 'clone',
		command: ['git', ...cloneArgs(source, state.path)],
		run: !state.checkout,
		reason: state.checkout
			? 'the workspace is already a drupflare/worker checkout'
			: `cloning ${source.url} at ${source.ref}`
	});

	const refreshable = state.checkout && state.repository;
	steps.push({
		id: 'refresh',
		command: ['git', '-C', state.path, 'fetch', 'origin', source.ref],
		run: opts.refresh === true && refreshable,
		reason:
			opts.refresh !== true
				? 'not asked for; pass --refresh to fetch and fast-forward'
				: !state.checkout
					? 'nothing to refresh; the workspace is being cloned in this run'
					: !state.repository
						? 'the workspace has no .git, so there is nothing to fetch from'
						: `fetching origin ${source.ref}`
	});

	steps.push({
		id: 'install',
		command: ['bun', 'install'],
		run: force || !state.installed,
		reason: force
			? 'forced'
			: state.installed
				? 'node_modules is populated'
				: 'node_modules is empty'
	});

	const from = opts.from;
	steps.push({
		id: 'hydrate',
		command: ['bun', 'run', 'hydrate', ...hydrateArgs(opts)],
		run: force || from !== undefined || !state.hydrated,
		reason: force
			? 'forced'
			: from !== undefined
				? `landing the payload at ${from}`
				: state.hydrated
					? 'every generated artifact is already on disk'
					: opts.fromSource === true
						? 'generated artifacts are missing; rebuilding them from source'
						: opts.payloadOnly === true
							? 'generated artifacts are missing; a payload is required'
							: 'generated artifacts are missing'
	});

	return steps;
}

/**
 * Which route the checkout's `hydrate` is told to take, if any.
 *
 * NOTHING BY DEFAULT, which is the whole design. `hydrate` already resolves a payload and falls back
 * to a source build when there is none, and that fallback is what makes `drangler dev` work on a
 * clean machine before any release has been cut -- the state this project is in today. Passing a
 * route here would override a decision the checkout is better placed to make, since only it can see
 * whether a payload answered.
 *
 * The three overrides are mutually exclusive and `--from` wins: a tarball that was handed over is a
 * payload, so asking for a source build alongside it is a contradiction rather than a refinement.
 */
export function hydrateArgs(opts: BuildOptions): string[] {
	if (opts.from !== undefined) return [`--from=${opts.from}`];
	if (opts.fromSource === true) return ['--from-source'];
	return opts.payloadOnly === true ? ['--payload-only'] : [];
}

/** what a build did, and what it left behind */
export interface BuildReport {
	workspace: string;
	source: { url: string; ref: string; local: boolean; from: string };
	steps: { id: BuildStepId; command: string; run: boolean; reason: string; code?: number }[];
	/** true when every step was skipped, which is the resume case */
	resumed: boolean;
}

/** how long each step is given before the runner gives up on it */
const STEP_TIMEOUT_MS: Record<BuildStepId, number> = {
	clone: 15 * 60_000,
	refresh: 5 * 60_000,
	install: 15 * 60_000,
	hydrate: 30 * 60_000
};

/**
 * Runs a plan, stopping at the first non-zero exit.
 *
 * Steps go through `spawn` rather than `run`: a clone and a hydrate are minutes of progress output
 * a user needs to see, and their output is never parsed. The one exception is the dirty-tree check
 * below, whose output IS the data.
 *
 * The step lines go to STDERR for the same reason: stdout carries the report, and `build --json`
 * promises one parseable object there.
 */
export async function runPlan(
	ctx: Context,
	steps: readonly BuildStep[],
	workspace: string,
	source: WorkerSource
): Promise<BuildReport> {
	const done: BuildReport['steps'] = [];
	for (const step of steps) {
		const rendered = step.command.join(' ');
		if (!step.run) {
			done.push({ id: step.id, command: rendered, run: false, reason: step.reason });
			continue;
		}
		if (step.id === 'refresh') await assertClean(ctx, workspace);

		// progress, not the report; on stdout it would sit in front of `build --json`'s one object
		ctx.io.err(`${step.id}: ${rendered}`);
		const [file, ...args] = step.command as [string, ...string[]];
		const code = await ctx.runner.spawn(file, args, {
			cwd: step.id === 'clone' ? ctx.cwd : workspace,
			timeoutMs: STEP_TIMEOUT_MS[step.id]
		});
		done.push({ id: step.id, command: rendered, run: true, reason: step.reason, code });
		if (code !== 0) {
			throw new DranglerError(
				'build-step',
				`${step.id} failed: \`${rendered}\` exited ${code}`
			);
		}
		if (step.id === 'refresh') await fastForward(ctx, workspace);
	}
	return {
		workspace,
		source: { url: source.url, ref: source.ref, local: source.local, from: source.from },
		steps: done,
		resumed: done.every((s) => !s.run)
	};
}

/**
 * Refuses to refresh a checkout with uncommitted work in it.
 *
 * A fetch is harmless; what follows it is not. Somebody who edited `wrangler.jsonc` in their
 * workspace is the normal case, and losing that to a refresh they asked for casually is the failure
 * this check exists to make impossible.
 */
async function assertClean(ctx: Context, workspace: string): Promise<void> {
	const status = await ctx.runner.run('git', ['-C', workspace, 'status', '--porcelain']);
	if (status.code !== 0) {
		throw new DranglerError(
			'refresh',
			`git status failed in ${workspace}: ${status.stderr.trim() || `exit ${status.code}`}`
		);
	}
	if (status.stdout.trim() !== '') {
		throw new DranglerError(
			'refresh-dirty',
			`${workspace} has uncommitted changes, so --refresh would move the tree out from under ` +
				'them. Commit or stash them first, or drop --refresh.'
		);
	}
}

/**
 * Fast-forward only.
 *
 * `merge --ff-only` fails rather than rewriting history or discarding a commit; `reset --hard` would
 * do both silently, and a CLI that resets somebody's checkout on their behalf has no way to undo it.
 */
async function fastForward(ctx: Context, workspace: string): Promise<void> {
	const merged = await ctx.runner.run('git', [
		'-C',
		workspace,
		'merge',
		'--ff-only',
		'FETCH_HEAD'
	]);
	if (merged.code !== 0) {
		throw new DranglerError(
			'refresh-diverged',
			`${workspace} cannot fast-forward onto the fetched ref: ` +
				`${merged.stderr.trim() || merged.stdout.trim() || `exit ${merged.code}`}`
		);
	}
}
