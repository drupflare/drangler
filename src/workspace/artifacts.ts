import { stripJsonComments } from '../cloudflare/config';
import type { FileHost } from '../host/files';

/** one generated path a deployable checkout must carry, and the command that produces it */
export interface RequiredArtifact {
	path: string;
	/** true when the path is a directory whose contents are the artifact */
	dir?: boolean;
	/** the specific producer; `bun run hydrate` produces every one of them at once */
	produces: string;
}

/**
 * The generated tree `wrangler deploy` reads and a clean checkout does not have.
 *
 * MOVED HERE FROM `worker/scripts/release-payload.ts`, where the same set is `PAYLOAD_ASSETS`,
 * `PAYLOAD_RECORDS` and `PRODUCED_BY`. It is the answer to "what is missing and what do I run", and
 * that question belongs to whoever is trying to deploy rather than to whoever cuts the release.
 * `tests/workspace-artifacts.spec.ts` reads the sibling checkout and fails when the two disagree,
 * so this list is checked against the artifact rather than against itself.
 *
 * The interpreter is NOT here: which files it is depends on the alias in the checkout's own
 * `wrangler.jsonc`, so {@link interpreterFiles} derives it rather than naming it.
 */
export const REQUIRED_ARTIFACTS: readonly RequiredArtifact[] = [
	{ path: 'assets/driver.json', produces: 'bun run assets:driver' },
	{
		path: 'assets/prefill.json',
		produces: 'bun scripts/lift-prefill.ts (needs a running worker)'
	},
	// the Workers Assets tree, which answers /core/** without the Worker running. Absent, a site
	// deploys and serves Drupal with no stylesheets, scripts or fonts
	{ path: 'assets/core', dir: true, produces: 'bun run assets:static (needs drupal-src)' },
	{ path: 'assets/modules', dir: true, produces: 'bun run assets:static (needs drupal-src)' },
	{
		path: 'assets/drupal-pf/core.pf.json',
		produces: 'bun run assets:twig && bun run assets:core && bun run assets:pack'
	},
	{
		path: 'assets/drupal-pf/core.pf.bin',
		produces: 'bun run assets:twig && bun run assets:core && bun run assets:pack'
	},
	{
		path: 'assets/drupal-sql',
		dir: true,
		produces: 'bun run assets:sql (needs assets/drupal/site.sqlite)'
	},
	{ path: 'assets/drupal/twig-bake.json', produces: 'bun run assets:twig' }
];

/** the one command that produces all of {@link REQUIRED_ARTIFACTS}, from a published release */
export const HYDRATE_COMMAND = 'bun run hydrate';

/**
 * The same set, regenerated in the checkout instead of downloaded.
 *
 * Named beside {@link HYDRATE_COMMAND} because "there is no release yet" is a state a user can hit
 * and must be able to act on. It is not the default: it wants PHP, composer, node 24+, zstd and a
 * running Docker, so `drangler build` asks for it explicitly via `--from-source`.
 */
export const BUILD_LOCAL_COMMAND = 'bun run build:local';

/** a path that is not a workspace-relative file, so it cannot name something outside the checkout */
function isSafeRelative(path: string): boolean {
	return path !== '' && !path.startsWith('/') && !path.split('/').includes('..');
}

/** joins workspace-relative segments without pulling in `node:path`, which the seam does not use */
export function inWorkspace(root: string, path: string): string {
	return `${root.replace(/\/+$/, '')}/${path}`;
}

/**
 * The interpreter files the checkout's aliased binary seam imports.
 *
 * MOVED HERE FROM `worker/scripts/release-payload.ts`. Read out of the seam rather than hardcoded
 * because the seam has already moved once, 8.3 out of `vendor/` to 8.5 out of `.interp/`, and a
 * hardcoded list would have named a binary that is present on the build machine and in no payload.
 *
 * @returns workspace-relative paths, sorted; empty when the config declares no such alias.
 * @throws when the seam imports from `vendor/`, which holds hand-built binaries that exist on one
 *   machine, so the aliased config could never be deployed from a clean checkout.
 */
export function interpreterFiles(files: FileHost, root: string): string[] {
	const configPath = inWorkspace(root, 'wrangler.jsonc');
	if (!files.exists(configPath)) return [];
	const config = JSON.parse(stripJsonComments(files.readText(configPath))) as {
		alias?: Record<string, string>;
	};
	const seam = Object.values(config.alias ?? {}).find((t) => t.includes('php-binary'));
	if (seam === undefined) return [];

	const seamRelative = seam.replace(/^\.\//, '');
	const seamDir = seamRelative.split('/').slice(0, -1).join('/');
	const seamPath = inWorkspace(root, seamRelative);
	if (!files.exists(seamPath)) return [];
	const source = files.readText(seamPath);

	const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)]
		.map((m) => m[1])
		.filter((s): s is string => s !== undefined);
	const fromVendor = specifiers.filter((s) => s.includes('vendor/'));
	if (fromVendor.length > 0) {
		throw new Error(
			`${seamRelative} imports ${fromVendor.join(', ')} from vendor/, which holds hand-built ` +
				'binaries that exist on one machine. No release payload can carry them, so this ' +
				'checkout cannot be deployed. Point the alias at a seam whose imports resolve ' +
				'under .interp/.'
		);
	}
	return specifiers
		.filter((s) => s.includes('.interp/'))
		.map((s) => normalise(`${seamDir}/${s}`))
		.filter(isSafeRelative)
		.sort();
}

/** collapses `a/b/../c` and `./`, so a seam import resolves to a workspace-relative path */
function normalise(path: string): string {
	const out: string[] = [];
	for (const part of path.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') out.pop();
		else out.push(part);
	}
	return out.join('/');
}

/** one artifact that is not on disk, with the command that would produce it */
export interface MissingArtifact {
	path: string;
	produces: string;
}

/**
 * Which required artifacts a checkout does not have.
 *
 * A directory entry counts as present only when it holds something: `assets/drupal-sql/` survives a
 * half-finished pack as an empty directory, and an empty chunk set deploys and serves a site with no
 * database rather than failing.
 */
export function missingArtifacts(files: FileHost, root: string): MissingArtifact[] {
	const missing: MissingArtifact[] = [];
	for (const artifact of REQUIRED_ARTIFACTS) {
		const abs = inWorkspace(root, artifact.path);
		const present =
			files.exists(abs) && (artifact.dir !== true || readDirSafe(files, abs).length > 0);
		if (!present) missing.push({ path: artifact.path, produces: artifact.produces });
	}
	for (const path of interpreterFilesSafe(files, root)) {
		if (!files.exists(inWorkspace(root, path))) {
			missing.push({
				path,
				produces: 'bun run build:wasm (needs docker and gh auth to drupflare/phasm)'
			});
		}
	}
	return missing;
}

/** an unreadable or absent config is a workspace problem, reported by its own check rather than here */
function interpreterFilesSafe(files: FileHost, root: string): string[] {
	try {
		return interpreterFiles(files, root);
	} catch {
		return [];
	}
}

function readDirSafe(files: FileHost, path: string): { name: string }[] {
	try {
		return files.readDir(path);
	} catch {
		return [];
	}
}
