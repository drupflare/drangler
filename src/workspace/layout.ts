import { isAbsolute, resolve } from 'node:path';
import type { Context } from '../context';
import { UsageError } from '../errors';
import type { FileHost } from '../host/files';
import { inWorkspace, missingArtifacts } from './artifacts';

/** where a workspace lands when nothing names one, relative to the working directory */
export const DEFAULT_WORKSPACE = '.drupflare/worker';

/** the package a workspace has to be a checkout of */
export const WORKER_PACKAGE = '@drupflare/worker';

export interface WorkspaceOptions {
	workspace?: string;
}

/** where a workspace came from, so a report never presents an inference as an instruction */
export type WorkspaceOrigin = 'flag' | 'env' | 'cwd' | 'default';

export interface WorkspaceLocation {
	path: string;
	origin: WorkspaceOrigin;
}

/**
 * Whether a directory is a checkout of `drupflare/worker`.
 *
 * The package NAME, not the presence of `wrangler.jsonc`: every Workers project on the machine has
 * one of those, and building into somebody else's project would be the worst possible outcome of a
 * mistyped `--workspace`.
 */
export function isWorkerCheckout(files: FileHost, dir: string): boolean {
	const pkg = inWorkspace(dir, 'package.json');
	if (!files.exists(pkg)) return false;
	try {
		return (JSON.parse(files.readText(pkg)) as { name?: unknown }).name === WORKER_PACKAGE;
	} catch {
		return false;
	}
}

/**
 * Picks the workspace: the flag, then the environment, then the working directory, then the default.
 *
 * The working directory is only taken when it IS a worker checkout, which is what makes
 * `drangler dev` work from inside one without any flag. It sits below the environment variable on
 * purpose -- an explicit setting outranks an inference from where the shell happens to be.
 */
export function resolveWorkspace(ctx: Context, opts: WorkspaceOptions = {}): WorkspaceLocation {
	const at = (path: string, origin: WorkspaceOrigin): WorkspaceLocation => ({
		path: isAbsolute(path) ? path : resolve(ctx.cwd, path),
		origin
	});
	if (opts.workspace !== undefined) {
		if (opts.workspace.trim() === '')
			throw new UsageError('--workspace was given an empty value');
		return at(opts.workspace, 'flag');
	}
	const fromEnv = ctx.env.DRANGLER_WORKSPACE;
	if (fromEnv !== undefined && fromEnv.trim() !== '') return at(fromEnv, 'env');
	if (isWorkerCheckout(ctx.files, ctx.cwd)) return at(ctx.cwd, 'cwd');
	return at(DEFAULT_WORKSPACE, 'default');
}

/** what is already on disk at a workspace path, which is the whole input to the resume decision */
export interface WorkspaceState {
	path: string;
	/** the directory exists and holds at least one entry */
	occupied: boolean;
	/** `package.json` names `@drupflare/worker` */
	checkout: boolean;
	/** a `.git` directory, so `git fetch` has somewhere to fetch from */
	repository: boolean;
	/** `node_modules` holds something */
	installed: boolean;
	/** every required artifact is on disk */
	hydrated: boolean;
}

export function readState(files: FileHost, path: string): WorkspaceState {
	const occupied = files.exists(path) && entries(files, path).length > 0;
	const checkout = isWorkerCheckout(files, path);
	return {
		path,
		occupied,
		checkout,
		repository: files.exists(inWorkspace(path, '.git')),
		installed: entries(files, inWorkspace(path, 'node_modules')).length > 0,
		hydrated: checkout && missingArtifacts(files, path).length === 0
	};
}

function entries(files: FileHost, path: string): { name: string }[] {
	if (!files.exists(path)) return [];
	try {
		return files.readDir(path);
	} catch {
		return [];
	}
}

/**
 * Refuses a workspace that holds something other than a worker checkout.
 *
 * The one case worth failing loudly on: `--workspace ~/src` on a populated directory. drangler has
 * no delete seam and no intention of acquiring one, so the only safe answer is to name the
 * directory and stop.
 */
export function assertUsable(state: WorkspaceState): void {
	if (state.checkout || !state.occupied) return;
	throw new UsageError(
		`${state.path} holds files and is not a ${WORKER_PACKAGE} checkout. Point --workspace at ` +
			'an empty directory or at an existing checkout; drangler never deletes a tree to make ' +
			'room for one.'
	);
}
