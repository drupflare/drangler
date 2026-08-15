import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors';
import { memoryFiles } from '../src/host/files';
import {
	assertUsable,
	DEFAULT_WORKSPACE,
	isWorkerCheckout,
	readState,
	resolveWorkspace,
	WORKER_PACKAGE
} from '../src/workspace/layout';
import {
	cloneArgs,
	DEFAULT_WORKER_REF,
	DEFAULT_WORKER_SOURCE,
	resolveSource
} from '../src/workspace/source';
import { testContext, workerTree, WORKSPACE } from './helpers';

describe('isWorkerCheckout', () => {
	it('reads the package name, not the presence of a wrangler config', () => {
		const files = memoryFiles({
			'/other/wrangler.jsonc': '{}',
			'/other/package.json': JSON.stringify({ name: 'somebody-elses-worker' })
		});
		expect(isWorkerCheckout(files, '/other')).toBe(false);
	});

	it('accepts a checkout that names the package', () => {
		expect(isWorkerCheckout(memoryFiles(workerTree()), WORKSPACE)).toBe(true);
	});

	it('is false for an absent or unparseable package.json rather than throwing', () => {
		expect(isWorkerCheckout(memoryFiles({}), '/nope')).toBe(false);
		expect(isWorkerCheckout(memoryFiles({ '/x/package.json': '{' }), '/x')).toBe(false);
	});
});

describe('resolveWorkspace', () => {
	it('takes the flag first', () => {
		const ctx = testContext({ env: { DRANGLER_WORKSPACE: '/from/env' } });
		expect(resolveWorkspace(ctx, { workspace: '/from/flag' })).toEqual({
			path: '/from/flag',
			origin: 'flag'
		});
	});

	it('resolves a relative flag against the working directory', () => {
		const ctx = testContext({ cwd: '/home/me' });
		expect(resolveWorkspace(ctx, { workspace: 'sites/blog' }).path).toBe('/home/me/sites/blog');
	});

	it('takes the environment over the working directory, because a setting beats an inference', () => {
		const ctx = testContext({
			cwd: WORKSPACE,
			files: memoryFiles(workerTree()),
			env: { DRANGLER_WORKSPACE: '/from/env' }
		});
		expect(resolveWorkspace(ctx)).toEqual({ path: '/from/env', origin: 'env' });
	});

	it('uses the working directory when it is itself a worker checkout', () => {
		const ctx = testContext({ cwd: WORKSPACE, files: memoryFiles(workerTree()) });
		expect(resolveWorkspace(ctx)).toEqual({ path: WORKSPACE, origin: 'cwd' });
	});

	it('falls back to the default, under the working directory', () => {
		const ctx = testContext({ cwd: '/home/me' });
		expect(resolveWorkspace(ctx)).toEqual({
			path: `/home/me/${DEFAULT_WORKSPACE}`,
			origin: 'default'
		});
	});

	it('ignores an empty environment value rather than resolving to the working directory', () => {
		const ctx = testContext({ cwd: '/home/me', env: { DRANGLER_WORKSPACE: '  ' } });
		expect(resolveWorkspace(ctx).origin).toBe('default');
	});

	it('refuses an empty flag', () => {
		expect(() => resolveWorkspace(testContext(), { workspace: '' })).toThrow(UsageError);
	});
});

describe('readState', () => {
	it('reports a hydrated checkout as ready on every axis', () => {
		expect(readState(memoryFiles(workerTree()), WORKSPACE)).toEqual({
			path: WORKSPACE,
			occupied: true,
			checkout: true,
			repository: true,
			installed: true,
			hydrated: true
		});
	});

	it('reports an absent workspace as empty rather than throwing', () => {
		expect(readState(memoryFiles({}), '/nope')).toMatchObject({
			occupied: false,
			checkout: false,
			repository: false,
			installed: false,
			hydrated: false
		});
	});

	it('is not hydrated when a generated artifact is missing', () => {
		const tree = workerTree();
		delete tree[`${WORKSPACE}/assets/driver.json`];
		expect(readState(memoryFiles(tree), WORKSPACE)).toMatchObject({
			checkout: true,
			hydrated: false
		});
	});

	it('is not installed when node_modules is absent', () => {
		const tree = workerTree();
		delete tree[`${WORKSPACE}/node_modules/.bin/wrangler`];
		expect(readState(memoryFiles(tree), WORKSPACE).installed).toBe(false);
	});

	it('survives a readDir that throws, which a file where a directory belongs does on a real disk', () => {
		const files = {
			...memoryFiles(workerTree()),
			readDir: () => {
				throw new Error('ENOTDIR');
			}
		};
		expect(readState(files, WORKSPACE)).toMatchObject({ occupied: false, installed: false });
	});

	it('is not a repository when .git is absent, which a tarball checkout is', () => {
		const tree = workerTree();
		delete tree[`${WORKSPACE}/.git/HEAD`];
		expect(readState(memoryFiles(tree), WORKSPACE)).toMatchObject({
			checkout: true,
			repository: false
		});
	});
});

describe('assertUsable', () => {
	it('refuses a populated directory that is not a checkout', () => {
		const files = memoryFiles({ '/home/me/src/notes.txt': 'mine' });
		expect(() => assertUsable(readState(files, '/home/me/src'))).toThrow(UsageError);
		expect(() => assertUsable(readState(files, '/home/me/src'))).toThrow(WORKER_PACKAGE);
	});

	it('allows an empty directory, which is where a clone goes', () => {
		expect(() => assertUsable(readState(memoryFiles({}), '/ws/fresh'))).not.toThrow();
	});

	it('allows an existing checkout', () => {
		expect(() => assertUsable(readState(memoryFiles(workerTree()), WORKSPACE))).not.toThrow();
	});
});

describe('resolveSource', () => {
	it('defaults to the published repository, and says the default was a default', () => {
		expect(resolveSource({})).toEqual({
			url: DEFAULT_WORKER_SOURCE,
			ref: DEFAULT_WORKER_REF,
			local: false,
			from: 'default'
		});
	});

	it('takes the flag over the environment', () => {
		const source = resolveSource({ DRANGLER_WORKER_SOURCE: '/env/worker' }, '/flag/worker');
		expect(source).toMatchObject({ url: '/flag/worker', local: true, from: 'flag' });
	});

	it('reads the environment when there is no flag', () => {
		expect(resolveSource({ DRANGLER_WORKER_SOURCE: '/env/worker' })).toMatchObject({
			url: '/env/worker',
			local: true,
			from: 'env'
		});
	});

	it('reads the ref from the flag, then the environment, then the default', () => {
		expect(resolveSource({}, undefined, 'v1.2.0').ref).toBe('v1.2.0');
		expect(resolveSource({ DRANGLER_WORKER_REF: 'next' }).ref).toBe('next');
		expect(resolveSource({}).ref).toBe(DEFAULT_WORKER_REF);
	});

	it.each([
		['https://github.com/drupflare/worker.git', false],
		['git@github.com:drupflare/worker.git', false],
		['ssh://git@example.com/worker.git', false],
		['/Users/me/drupflare/worker', true],
		['../worker', true],
		['./worker', true]
	])('classifies %s as local=%s', (url, local) => {
		expect(resolveSource({}, url).local).toBe(local);
	});

	it('refuses an empty source', () => {
		expect(() => resolveSource({}, '  ')).toThrow(UsageError);
	});
});

describe('cloneArgs', () => {
	it('shallow-clones a remote at the ref', () => {
		expect(cloneArgs(resolveSource({}), '/ws/worker')).toEqual([
			'clone',
			'--depth',
			'1',
			'--branch',
			DEFAULT_WORKER_REF,
			DEFAULT_WORKER_SOURCE,
			'/ws/worker'
		]);
	});

	it('drops --depth for a local path, which git ignores and warns about', () => {
		expect(cloneArgs(resolveSource({}, '/src/worker'), '/ws/worker')).toEqual([
			'clone',
			'--branch',
			DEFAULT_WORKER_REF,
			'/src/worker',
			'/ws/worker'
		]);
	});
});
