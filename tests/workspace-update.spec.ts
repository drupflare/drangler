import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/errors';
import { scriptedRunner, type CommandResult, type ScriptedRunner } from '../src/host/exec';
import { memoryFiles } from '../src/host/files';
import { run } from '../src/run';
import { movedRef, resolveUpdateTarget } from '../src/workspace/update';
import { fail, ok, testContext, workerTree, WORKSPACE, type TestContext } from './helpers';

/**
 * `drangler update`.
 *
 * The command exists because `build --refresh` is not an update. `planBuild()` skips `install` and
 * `hydrate` when their outputs are on disk, so a refresh that moves the checkout to a new version
 * leaves the PREVIOUS version's `node_modules` and `assets/` in place and reports success -- the
 * same shape as `DRUPAL_VERSION=... build:local`, which was a no-op that reported success. So the
 * assertion that carries the weight here is not "it fetched", it is "it rebuilt BECAUSE the ref
 * moved, and did not when it had not".
 */

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const HEAD = `git -C ${WORKSPACE} rev-parse HEAD`;
const STATUS = `git -C ${WORKSPACE} status --porcelain`;
const FETCH = `git -C ${WORKSPACE} fetch origin master`;
const MERGE = `git -C ${WORKSPACE} merge --ff-only FETCH_HEAD`;
const DRY_RUN = `bunx wrangler deploy -c wrangler.jsonc --dry-run --outdir ${WORKSPACE}/dist/dry-run`;
const SCRUB = 'bun run assets:scrub:check';

const ENV = { DRANGLER_WORKSPACE: WORKSPACE, DRANGLER_WORKER_SOURCE: '/src/worker' };

/** `git rev-parse` answers OLD until the merge runs, then NEW; that IS the version move */
function movingHead(shas: readonly string[]): () => CommandResult {
	let call = 0;
	return () => ok(shas[Math.min(call++, shas.length - 1)] as string);
}

function ctxFor(
	shas: readonly string[],
	script: Record<string, CommandResult | (() => CommandResult)> = {},
	seed = workerTree()
): TestContext & { runner: ScriptedRunner } {
	const files = memoryFiles(seed);
	const runner = scriptedRunner({
		[HEAD]: movingHead(shas),
		[STATUS]: ok(''),
		[FETCH]: ok(''),
		[MERGE]: ok(''),
		'bun install': ok(''),
		'bun run hydrate': ok(''),
		[SCRUB]: ok('clean'),
		[DRY_RUN]: ok('gzip: 2818.80 KiB'),
		...script
	});
	return testContext({ files, runner, env: ENV }) as TestContext & { runner: ScriptedRunner };
}

const lines = (runner: ScriptedRunner) => runner.calls.map((c) => [c.file, ...c.args].join(' '));

describe('resolveUpdateTarget', () => {
	const checkout = {
		path: WORKSPACE,
		occupied: true,
		checkout: true,
		repository: true,
		installed: true,
		hydrated: true
	};

	it('takes the local checkout when no worker is named', () => {
		expect(resolveUpdateTarget(checkout, undefined).mode).toBe('local');
	});

	it('takes the deployment when one is named', () => {
		const target = resolveUpdateTarget(checkout, 'my-site');
		expect(target.mode).toBe('deployed');
		expect(target.worker).toBe('my-site');
	});

	it('names both ways out when there is neither', () => {
		expect(() => resolveUpdateTarget({ ...checkout, checkout: false }, undefined)).toThrow(
			/nothing to update/
		);
	});

	it('refuses an empty name rather than silently updating the checkout', () => {
		expect(() => resolveUpdateTarget(checkout, '  ')).toThrow(/empty/);
	});
});

describe('movedRef', () => {
	it('is false for an unchanged head, and for a reading it could not take', () => {
		expect(movedRef(OLD, OLD)).toBe(false);
		expect(movedRef('', NEW)).toBe(false);
		expect(movedRef(OLD, '')).toBe(false);
	});

	it('is true only when both readings exist and differ', () => {
		expect(movedRef(OLD, NEW)).toBe(true);
	});
});

describe('a local update', () => {
	it('rebuilds BECAUSE the checkout moved', async () => {
		const ctx = ctxFor([OLD, NEW]);
		const code = await run(ctx, ['update']);
		expect(code).toBe(EXIT.OK);
		const ran = lines(ctx.runner);
		expect(ran).toContain(FETCH);
		expect(ran).toContain(MERGE);
		// the assertion the command exists for: the previous version's artifacts are replaced
		expect(ran).toContain('bun install');
		expect(ran).toContain('bun run hydrate');
	});

	/**
	 * CONTROL. Without it, a command that always rebuilt would pass the case above, and an update
	 * that reinstalls on every run is a several-minute no-op somebody will learn to avoid.
	 */
	it('CONTROL: rebuilds nothing when the checkout did not move', async () => {
		const ctx = ctxFor([OLD, OLD]);
		expect(await run(ctx, ['update'])).toBe(EXIT.OK);
		const ran = lines(ctx.runner);
		expect(ran).toContain(FETCH);
		expect(ran).not.toContain('bun install');
		expect(ran).not.toContain('bun run hydrate');
		expect(ctx.io.text()).toContain('nothing to do');
	});

	it('reports the move as two readings rather than as a claim', async () => {
		const ctx = ctxFor([OLD, NEW]);
		await run(ctx, ['update']);
		expect(ctx.io.text()).toContain(OLD.slice(0, 12));
		expect(ctx.io.text()).toContain(NEW.slice(0, 12));
	});

	it('moves to a named version, not just to the tip', async () => {
		const tag = `git -C ${WORKSPACE} fetch origin v0.3.0`;
		const ctx = ctxFor([OLD, NEW], { [tag]: ok('') });
		expect(await run(ctx, ['update', '--to', 'v0.3.0'])).toBe(EXIT.OK);
		expect(lines(ctx.runner)).toContain(tag);
	});

	it('refuses a dirty tree, and fetches nothing', async () => {
		const ctx = ctxFor([OLD, NEW], { [STATUS]: ok(' M wrangler.jsonc') });
		expect(await run(ctx, ['update'])).not.toBe(EXIT.OK);
		expect(lines(ctx.runner)).not.toContain(FETCH);
	});

	it('refuses a hydrated tree that is not a checkout of anything', async () => {
		const seed = workerTree();
		delete seed[`${WORKSPACE}/.git/HEAD`];
		const ctx = ctxFor([OLD, NEW], {}, seed);
		expect(await run(ctx, ['update'])).toBe(EXIT.USAGE);
		expect(ctx.io.stderr.join('\n')).toMatch(/no \.git/);
	});

	it('runs nothing on a dry run', async () => {
		const ctx = ctxFor([OLD, NEW]);
		expect(await run(ctx, ['update', '--dry-run'])).toBe(EXIT.OK);
		expect(lines(ctx.runner)).not.toContain(FETCH);
		expect(ctx.io.text()).toContain('nothing was executed');
	});
});

describe('an update to a deployed worker', () => {
	const listed = (names: string[]) =>
		new Response(
			JSON.stringify({ success: true, errors: [], result: names.map((id) => ({ id })) }),
			{
				status: 200,
				headers: { 'content-type': 'application/json' }
			}
		);

	function deployCtx(names: string[], shas: readonly string[] = [OLD, NEW]) {
		const ctx = ctxFor(shas, {
			[`bunx wrangler deploy -c wrangler.jsonc --name my-site`]: ok('')
		});
		return testContext({
			files: ctx.files,
			runner: ctx.runner,
			env: { ...ENV, CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'acct' },
			fetch: async () => listed(names)
		}) as TestContext & { runner: ScriptedRunner };
	}

	it('deploys under the named worker after moving the checkout', async () => {
		const ctx = deployCtx(['my-site', 'something-else']);
		expect(await run(ctx, ['update', 'my-site'])).toBe(EXIT.OK);
		expect(lines(ctx.runner)).toContain(
			'bunx wrangler deploy -c wrangler.jsonc --name my-site'
		);
	});

	/**
	 * `update` moves an EXISTING deployment. Creating one is `deploy`, and without this check a
	 * mistyped name uploads a second worker under it and reports success.
	 */
	it('refuses a name the account does not have, and touches the checkout', async () => {
		const ctx = deployCtx(['something-else']);
		expect(await run(ctx, ['update', 'my-sight'])).toBe(EXIT.USAGE);
		expect(ctx.io.stderr.join('\n')).toMatch(/nothing to update/);
		// checked BEFORE the fetch, so a refusal never leaves the tree on an undeployed version
		expect(lines(ctx.runner)).not.toContain(FETCH);
	});

	it('does not deploy a workspace that fails the gate', async () => {
		const ctx = deployCtx(['my-site']);
		(ctx.runner as ScriptedRunner).calls.length = 0;
		const broken = ctxFor([OLD, NEW], { [DRY_RUN]: fail(1, 'workers.api.error') });
		const gated = testContext({
			files: broken.files,
			runner: broken.runner,
			env: { ...ENV, CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'acct' },
			fetch: async () => listed(['my-site'])
		}) as TestContext & { runner: ScriptedRunner };
		expect(await run(gated, ['update', 'my-site'])).not.toBe(EXIT.OK);
		expect(lines(gated.runner)).not.toContain(
			'bunx wrangler deploy -c wrangler.jsonc --name my-site'
		);
	});
});
