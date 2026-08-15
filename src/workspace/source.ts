import { UsageError } from '../errors';

/**
 * Where a workspace is cloned from when nothing says otherwise.
 *
 * A URL rather than a bundled copy of the tree, and that is the whole compromise this file exists
 * to make: drangler runs `drupflare/worker`'s own build pipeline inside a checkout of it instead of
 * carrying a second implementation of the pack format, the payload manifest and the asset plan.
 * `docs/workspaces.md` records what that costs.
 */
export const DEFAULT_WORKER_SOURCE = 'https://github.com/drupflare/worker.git';

/** which ref a clone lands on; the repository's default branch */
export const DEFAULT_WORKER_REF = 'master';

export interface WorkerSource {
	/** the argument handed to `git clone`, unchanged */
	url: string;
	ref: string;
	/** a path on this machine rather than something git has to reach over a network */
	local: boolean;
	/** which input decided it, so a report never presents a default as a choice */
	from: 'flag' | 'env' | 'default';
}

/** `scheme://...` or scp-style `user@host:path`, both of which git resolves over a network */
function looksRemote(value: string): boolean {
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) || /^[^/\s]+@[^/\s]+:/.test(value);
}

/**
 * Resolves where the worker checkout comes from: the flag, then the environment, then the default.
 *
 * A LOCAL PATH IS A FIRST-CLASS SOURCE, not a test affordance. `git clone /path/to/worker` is an
 * ordinary clone of a repository that happens to be on this disk, which is what makes every step
 * below `clone` exercisable before `drupflare/worker` is published -- and what lets somebody run
 * this against a fork without publishing one.
 */
export function resolveSource(env: NodeJS.ProcessEnv, flag?: string, ref?: string): WorkerSource {
	const fromEnv = env.DRANGLER_WORKER_SOURCE;
	const url = flag ?? fromEnv ?? DEFAULT_WORKER_SOURCE;
	if (url.trim() === '') throw new UsageError('--source was given an empty value');
	return {
		url,
		ref: ref ?? env.DRANGLER_WORKER_REF ?? DEFAULT_WORKER_REF,
		local: !looksRemote(url),
		from: flag !== undefined ? 'flag' : fromEnv !== undefined ? 'env' : 'default'
	};
}

/**
 * The argv for the clone.
 *
 * `--depth 1` only on a remote: git ignores it for a local clone and prints a warning saying so, and
 * a step whose command prints a warning on every ordinary run trains people to skip reading them.
 */
export function cloneArgs(source: WorkerSource, into: string): string[] {
	return [
		'clone',
		...(source.local ? [] : ['--depth', '1']),
		'--branch',
		source.ref,
		source.url,
		into
	];
}
