import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { memoryFiles } from '../src/host/files';
import {
	HYDRATE_COMMAND,
	REQUIRED_ARTIFACTS,
	inWorkspace,
	interpreterFiles,
	missingArtifacts
} from '../src/workspace/artifacts';
import { WORKER_SEAM, WORKSPACE, workerTree } from './helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELEASE_PAYLOAD = resolve(HERE, '..', '..', 'worker', 'scripts', 'release-payload.ts');

describe('inWorkspace', () => {
	it('joins without pulling a path module into the seam', () => {
		expect(inWorkspace('/ws/worker', 'assets/driver.json')).toBe(
			'/ws/worker/assets/driver.json'
		);
	});

	it('tolerates a trailing slash on the root', () => {
		expect(inWorkspace('/ws/worker/', 'a')).toBe('/ws/worker/a');
	});
});

describe('interpreterFiles', () => {
	it('derives the interpreter from the aliased seam, not from a hardcoded list', () => {
		expect(interpreterFiles(memoryFiles(workerTree()), WORKSPACE)).toEqual([
			'.interp/php8.5-worker.mjs',
			'.interp/php8.5.wasm.zst',
			'.interp/zstddec.wasm'
		]);
	});

	it('refuses a seam that imports from vendor/, which no payload can carry', () => {
		const files = memoryFiles(
			workerTree({
				[`${WORKSPACE}/src/runtime/php-binary-85.ts`]:
					"import blob from '../../vendor/static-o2/php8.3-worker.mjs.wasm';"
			})
		);
		expect(() => interpreterFiles(files, WORKSPACE)).toThrow(/vendor\//);
		expect(() => interpreterFiles(files, WORKSPACE)).toThrow(/one machine/);
	});

	it('returns nothing when the config declares no php-binary alias', () => {
		const files = memoryFiles(
			workerTree({ [`${WORKSPACE}/wrangler.jsonc`]: '{"main":"src/site.ts"}' })
		);
		expect(interpreterFiles(files, WORKSPACE)).toEqual([]);
	});

	it('returns nothing when the config or the seam is not there', () => {
		expect(interpreterFiles(memoryFiles({}), WORKSPACE)).toEqual([]);
		const tree = workerTree();
		delete tree[`${WORKSPACE}/src/runtime/php-binary-85.ts`];
		expect(interpreterFiles(memoryFiles(tree), WORKSPACE)).toEqual([]);
	});

	it('reads a jsonc config, comments and all', () => {
		const files = memoryFiles(
			workerTree({
				[`${WORKSPACE}/wrangler.jsonc`]:
					'{\n// which interpreter ships\n"alias": { "./runtime/php-binary.js": "./src/runtime/php-binary-85.ts" },\n}'
			})
		);
		expect(interpreterFiles(files, WORKSPACE)).toHaveLength(3);
	});

	it('ignores an import that is neither the interpreter nor vendor', () => {
		const files = memoryFiles(
			workerTree({
				[`${WORKSPACE}/src/runtime/php-binary-85.ts`]: WORKER_SEAM.split('\n')[0]!
			})
		);
		expect(interpreterFiles(files, WORKSPACE)).toEqual([]);
	});
});

describe('missingArtifacts', () => {
	it('finds nothing missing in a hydrated checkout', () => {
		expect(missingArtifacts(memoryFiles(workerTree()), WORKSPACE)).toEqual([]);
	});

	it('names every generated path a clean checkout lacks, with its producer', () => {
		const files = memoryFiles({
			[`${WORKSPACE}/package.json`]: JSON.stringify({ name: '@drupflare/worker' })
		});
		const missing = missingArtifacts(files, WORKSPACE);
		expect(missing.map((m) => m.path)).toEqual(REQUIRED_ARTIFACTS.map((a) => a.path));
		for (const entry of missing) expect(entry.produces).not.toBe('');
	});

	it('counts an EMPTY chunk directory as missing, because it deploys and serves nothing', () => {
		const tree = workerTree();
		delete tree[`${WORKSPACE}/assets/drupal-sql/manifest.json`];
		expect(missingArtifacts(memoryFiles(tree), WORKSPACE).map((m) => m.path)).toEqual([
			'assets/drupal-sql'
		]);
	});

	it('treats a chunk directory it cannot list as missing rather than as present', () => {
		const files = {
			...memoryFiles(workerTree()),
			readDir: () => {
				throw new Error('ENOTDIR');
			}
		};
		expect(missingArtifacts(files, WORKSPACE).map((m) => m.path)).toEqual([
			'assets/drupal-sql'
		]);
	});

	it('names a missing interpreter file, derived from the seam rather than listed', () => {
		const tree = workerTree();
		delete tree[`${WORKSPACE}/.interp/zstddec.wasm`];
		const missing = missingArtifacts(memoryFiles(tree), WORKSPACE);
		expect(missing).toEqual([
			{ path: '.interp/zstddec.wasm', produces: expect.stringContaining('build:wasm') }
		]);
	});

	it('does not fail the whole scan when the seam is unreadable; that is the config check', () => {
		const files = memoryFiles(
			workerTree({
				[`${WORKSPACE}/src/runtime/php-binary-85.ts`]:
					"import x from '../../vendor/a.wasm';"
			})
		);
		expect(missingArtifacts(files, WORKSPACE)).toEqual([]);
	});
});

/**
 * The drift check, against the sibling rather than against drangler's own list.
 *
 * `REQUIRED_ARTIFACTS` was moved out of `worker/scripts/release-payload.ts`, and the worker is
 * proposed to import it back rather than keep a second copy. Until that lands both files exist, so
 * this reads the sibling's source and fails when a path appears there and not here.
 *
 * **Skips when the sibling is absent, FAILS under `REQUIRE_SIBLINGS=1`.** Same asymmetry as
 * `tests/target-runtime.spec.ts`: on drangler-only CI it is worth nothing, and it earns its place on
 * the machine where the two repositories sit side by side, which is where the drift is introduced.
 */
const payloadSource = existsSync(RELEASE_PAYLOAD) ? readFileSync(RELEASE_PAYLOAD, 'utf8') : null;
if (payloadSource === null && process.env.REQUIRE_SIBLINGS) {
	throw new Error(
		`no worker checkout at ${RELEASE_PAYLOAD}, and REQUIRE_SIBLINGS says this lane has one. ` +
			'Check out drupflare/worker beside drangler, or unset REQUIRE_SIBLINGS.'
	);
}

describe.skipIf(payloadSource === null)('the required set tracks what the worker ships', () => {
	/** every `{ path: 'x' }` literal in the sibling's payload plan */
	function declaredPaths(source: string): string[] {
		const block = source.slice(
			source.indexOf('PAYLOAD_ASSETS'),
			source.indexOf('export type PayloadFile')
		);
		return [...block.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1] as string);
	}

	it('carries every asset and record the payload plan declares', () => {
		const declared = declaredPaths(payloadSource!);
		expect(declared.length).toBeGreaterThan(0);
		const here = new Set(REQUIRED_ARTIFACTS.map((a) => a.path));
		for (const path of declared) {
			expect(
				here,
				`${RELEASE_PAYLOAD} ships ${path} and REQUIRED_ARTIFACTS omits it`
			).toContain(path);
		}
	});

	it('names no path the payload plan does not', () => {
		const declared = new Set(declaredPaths(payloadSource!));
		for (const artifact of REQUIRED_ARTIFACTS) {
			expect(
				declared,
				`REQUIRED_ARTIFACTS names ${artifact.path} and ${RELEASE_PAYLOAD} does not ship it`
			).toContain(artifact.path);
		}
	});

	it('agrees with the sibling on which command produces each path', () => {
		const produced = new Map(
			[...payloadSource!.matchAll(/'([^']+)':\s*'(bun [^']+)'/g)].map((m) => [
				m[1] as string,
				m[2] as string
			])
		);
		for (const artifact of REQUIRED_ARTIFACTS) {
			const key = produced.has(artifact.path)
				? artifact.path
				: artifact.path.split('/').slice(0, 2).join('/');
			const theirs = produced.get(key);
			if (theirs === undefined) continue;
			expect(artifact.produces, `${artifact.path} producer drifted`).toBe(theirs);
		}
	});

	it('offers the one command that produces all of them', () => {
		expect(HYDRATE_COMMAND).toBe('bun run hydrate');
		expect(payloadSource!).toContain('scripts/hydrate.ts');
	});
});
