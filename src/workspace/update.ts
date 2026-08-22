import { UsageError } from '../errors';
import type { WorkspaceState } from './layout';

/**
 * Which thing an `update` is updating.
 *
 * `local` moves the checkout; `deployed` moves it and then pushes the result to a named Worker.
 */
export type UpdateMode = 'local' | 'deployed';

export interface UpdateTarget {
	mode: UpdateMode;
	/** the Worker script name, on `deployed` only */
	worker: string | null;
	/** which input decided the mode, so the report never presents an inference as a choice */
	because: string;
}

/**
 * Picks the mode from what is on disk and what was asked for.
 *
 * Naming a Worker is the only thing that selects `deployed`. Without one, a checkout is updated in
 * place -- and with neither there is nothing to update, so both ways out are named rather than one
 * being guessed at.
 */
export function resolveUpdateTarget(
	state: WorkspaceState,
	worker: string | undefined
): UpdateTarget {
	const named = worker?.trim() ?? '';
	if (worker !== undefined && named === '') {
		throw new UsageError('the worker name was empty; drop it to update the local checkout');
	}
	if (named !== '') {
		return { mode: 'deployed', worker: named, because: `\`${named}\` was named` };
	}
	if (state.checkout) {
		return { mode: 'local', worker: null, because: `${state.path} is a worker checkout` };
	}
	throw new UsageError(
		`no worker was named and ${state.path} is not a drupflare/worker checkout, so there is ` +
			'nothing to update. Name a deployed worker to update it, run `drangler build` to make a ' +
			'local one, or point --workspace at an existing checkout.'
	);
}

/**
 * Whether the refresh actually moved the checkout.
 *
 * The whole reason `update` exists as its own command. `planBuild()` skips `install` and `hydrate`
 * when their outputs are on disk, and after a version change those outputs are the OLD version's --
 * so an update that fast-forwarded and stopped would report success and keep running the previous
 * pack. A moved HEAD is what forces them both.
 */
export function movedRef(before: string, after: string): boolean {
	return before.trim() !== '' && after.trim() !== '' && before.trim() !== after.trim();
}

/** short form for a report line; a full sha is noise next to a version */
export function shortSha(sha: string): string {
	return sha.trim().slice(0, 12);
}

export interface UpdateOutcome {
	mode: UpdateMode;
	worker: string | null;
	workspace: string;
	ref: string;
	/** the checkout's commit before and after, so "already current" is a reading and not a guess */
	from: string;
	to: string;
	moved: boolean;
	deployed: boolean;
}

/** the closing line, which has to distinguish "nothing to do" from "done" */
export function updateSummary(outcome: UpdateOutcome): string {
	if (outcome.mode === 'deployed') {
		return outcome.moved
			? `${outcome.worker} deployed at ${shortSha(outcome.to)}`
			: `${outcome.worker} redeployed; the checkout was already at ${shortSha(outcome.to)}`;
	}
	return outcome.moved
		? `updated ${shortSha(outcome.from)} -> ${shortSha(outcome.to)}; next: drangler dev`
		: `already at ${shortSha(outcome.to)}; nothing to do`;
}
