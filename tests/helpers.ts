import type { Context } from '../src/context';
import type { FetchLike } from '../src/health/probe';
import { scriptedRunner, type CommandResult } from '../src/host/exec';
import { memoryFiles } from '../src/host/files';
import { bufferIo, type BufferIo } from '../src/io';

export interface TestContext extends Context {
	io: BufferIo;
}

/** A context with every seam replaced; no spec reaches a process, a socket or the filesystem. */
export function testContext(over: Partial<Context> = {}): TestContext {
	return {
		io: bufferIo(),
		files: memoryFiles(),
		runner: scriptedRunner({}),
		fetch: fakeFetch(() => new Response('', { status: 200 })),
		env: {},
		cwd: '/ws/worker',
		now: () => new Date('2026-08-14T00:00:00.000Z'),
		...over
	} as TestContext;
}

/** Wraps a handler as a `fetch`, recording every URL it was asked for. */
export function fakeFetch(
	handler: (url: string) => Response | Promise<Response>
): FetchLike & { urls: string[] } {
	const urls: string[] = [];
	const fn = async (input: unknown) => {
		const url = String(input);
		urls.push(url);
		return await handler(url);
	};
	return Object.assign(fn, { urls }) as unknown as FetchLike & { urls: string[] };
}

export const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
export const fail = (code: number, stderr = ''): CommandResult => ({ code, stdout: '', stderr });

/** the workspace path every workspace spec builds against; matches `testContext().cwd` */
export const WORKSPACE = '/ws/worker';

/** the canonical config, cut down to what drangler reads out of it */
export const WORKER_CONFIG = JSON.stringify({
	name: 'drupflare',
	main: 'src/site.ts',
	compatibility_date: '2026-08-01',
	compatibility_flags: ['nodejs_compat'],
	vars: { PLAN: 'free' },
	durable_objects: { bindings: [{ name: 'SITE', class_name: 'SitePhpDurableObject' }] },
	migrations: [{ tag: 'v1', new_sqlite_classes: ['SitePhpDurableObject'] }],
	assets: { directory: './assets', binding: 'ASSETS' },
	triggers: { crons: ['*/5 * * * *'] },
	alias: { './runtime/php-binary.js': './src/runtime/php-binary-85.ts' }
});

/** the shipping binary seam, whose `from` specifiers are what names the interpreter files */
export const WORKER_SEAM = [
	"import { wasmModuleFromZstd, zstdDecoderFromWasm } from '@drupflare/cartridge/inflate';",
	"import PHPFactory from '../../.interp/php8.5-worker.mjs';",
	"import blob from '../../.interp/php8.5.wasm.zst';",
	"import decoder from '../../.interp/zstddec.wasm';"
].join('\n');

/**
 * A hydrated `drupflare/worker` checkout, as far as drangler ever looks at one.
 *
 * Only the paths a check reads: the package name, the config, the binary seam, and every generated
 * artifact. A fixture that mirrored the whole 3.9 GB tree would assert nothing extra and rot on the
 * first file the worker adds.
 */
export function workerTree(over: Record<string, string> = {}): Record<string, string> {
	return {
		[`${WORKSPACE}/package.json`]: JSON.stringify({ name: '@drupflare/worker' }),
		[`${WORKSPACE}/.git/HEAD`]: 'ref: refs/heads/master',
		[`${WORKSPACE}/node_modules/.bin/wrangler`]: '#!/bin/sh',
		[`${WORKSPACE}/wrangler.jsonc`]: WORKER_CONFIG,
		[`${WORKSPACE}/src/runtime/php-binary-85.ts`]: WORKER_SEAM,
		[`${WORKSPACE}/assets/driver.json`]: '{}',
		[`${WORKSPACE}/assets/prefill.json`]: '{}',
		[`${WORKSPACE}/assets/core/misc/drupal.js`]: 'asset',
		[`${WORKSPACE}/assets/modules/system/system.css`]: 'asset',
		[`${WORKSPACE}/assets/drupal-pf/core.pf.json`]: '{}',
		[`${WORKSPACE}/assets/drupal-pf/core.pf.bin`]: 'packed',
		[`${WORKSPACE}/assets/drupal-sql/manifest.json`]: '{"chunks":79}',
		[`${WORKSPACE}/assets/drupal/twig-bake.json`]: '{}',
		[`${WORKSPACE}/.interp/php8.5-worker.mjs`]: 'glue',
		[`${WORKSPACE}/.interp/php8.5.wasm.zst`]: 'frame',
		[`${WORKSPACE}/.interp/zstddec.wasm`]: 'decoder',
		...over
	};
}
