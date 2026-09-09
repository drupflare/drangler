import { describe, expect, it } from 'vitest';
import { parseChecks } from '../src/commands/workspace';
import { EXIT } from '../src/errors';
import { scriptedRunner, type CommandResult, type ScriptedRunner } from '../src/host/exec';
import { memoryFiles } from '../src/host/files';
import { run } from '../src/run';
import { BACKUP_MANIFEST } from '../src/workspace/copy';
import { fail, ok, testContext, workerTree, WORKSPACE, type TestContext } from './helpers';

const DRY_RUN = `bunx wrangler deploy -c wrangler.jsonc --dry-run --outdir ${WORKSPACE}/dist/dry-run`;
const SCRUB = 'bun run assets:scrub:check';
const CLONE = `git clone --branch master /src/worker ${WORKSPACE}`;

const SOURCE_ENV = { DRANGLER_WORKSPACE: WORKSPACE, DRANGLER_WORKER_SOURCE: '/src/worker' };

/** the tree a clone leaves behind: the checkout, and nothing generated */
const CHECKOUT = ['package.json', '.git/HEAD', 'wrangler.jsonc', 'src/runtime/php-binary-85.ts'];

/**
 * A context whose scripted build steps LAND THEIR OUTPUT in the memory filesystem.
 *
 * A runner that returns 0 and writes nothing would let `dev` clone into an empty directory and then
 * pass its own gate, which is the opposite of what the gate is for. Each step produces the paths it
 * really produces, so the gate is scored against a tree the build actually made.
 */
function ctxFor(
	seed: Record<string, string>,
	script: Record<string, CommandResult> = {}
): TestContext & { runner: ScriptedRunner } {
	const files = memoryFiles(seed);
	const produce = (paths: (path: string) => boolean) => () => {
		for (const [path, text] of Object.entries(workerTree())) {
			if (paths(path.slice(WORKSPACE.length + 1)) && !files.exists(path)) {
				files.writeText(path, text);
			}
		}
		return ok('');
	};
	const runner = scriptedRunner({
		[CLONE]: produce((p) => CHECKOUT.includes(p)),
		'bun install': produce((p) => p.startsWith('node_modules/')),
		'bun run hydrate': produce((p) => p.startsWith('assets/') || p.startsWith('.interp/')),
		[SCRUB]: ok('clean'),
		[DRY_RUN]: ok('Total Upload: 11000.00 KiB / gzip: 2818.80 KiB'),
		'bunx wrangler dev -c wrangler.jsonc': ok(''),
		'bunx wrangler deploy -c wrangler.jsonc': ok(''),
		...script
	});
	return testContext({ files, runner, env: SOURCE_ENV }) as TestContext & {
		runner: ScriptedRunner;
	};
}

const lines = (runner: ScriptedRunner) => runner.calls.map((c) => [c.file, ...c.args].join(' '));

describe('drangler build', () => {
	it('clones, installs and hydrates an empty workspace, in that order', async () => {
		const ctx = ctxFor({});
		expect(await run(ctx, ['build'])).toBe(EXIT.OK);
		expect(lines(ctx.runner)).toEqual([CLONE, 'bun install', 'bun run hydrate']);
	});

	it('is resumable: a second build on a finished workspace runs no subprocess', async () => {
		const ctx = ctxFor(workerTree());
		expect(await run(ctx, ['build'])).toBe(EXIT.OK);
		expect(ctx.runner.calls).toEqual([]);
		expect(ctx.io.text()).toContain('nothing to do; the workspace was already built');
	});

	it('prints the plan and runs nothing under --dry-run', async () => {
		const ctx = ctxFor({});
		expect(await run(ctx, ['build', '--dry-run'])).toBe(EXIT.OK);
		expect(ctx.runner.calls).toEqual([]);
		expect(ctx.io.text()).toContain('nothing was executed');
		expect(ctx.io.text()).toContain(`$ ${CLONE}`);
	});

	it('takes the source from a flag, so a local checkout works before the repo is published', async () => {
		const ctx = testContext({ files: memoryFiles({}), env: {}, cwd: '/ws' });
		const runner = scriptedRunner({});
		const scoped = { ...ctx, runner };
		await run(scoped, [
			'build',
			'--workspace',
			WORKSPACE,
			'--source',
			'/elsewhere/worker',
			'--dry-run',
			'--json'
		]);
		expect(scoped.io.json<{ source: { url: string; local: boolean } }>().source).toMatchObject({
			url: '/elsewhere/worker',
			local: true
		});
	});

	it('passes a local payload through to hydrate', async () => {
		const ctx = ctxFor(workerTree(), { 'bun run hydrate --from=/tmp/p.tar.gz': ok('') });
		expect(await run(ctx, ['build', '--from=/tmp/p.tar.gz'])).toBe(EXIT.OK);
		expect(lines(ctx.runner)).toEqual(['bun run hydrate --from=/tmp/p.tar.gz']);
	});

	it('refuses a populated directory that is not a worker checkout', async () => {
		const ctx = ctxFor({ '/ws/mine/notes.txt': 'hello' });
		expect(await run(ctx, ['build', '--workspace', '/ws/mine'])).toBe(EXIT.USAGE);
		expect(ctx.io.stderr.join('\n')).toContain('never deletes a tree');
	});

	it('reports a failing step with the command that failed', async () => {
		const ctx = ctxFor({}, { 'bun install': fail(1, 'network') });
		expect(await run(ctx, ['build'])).toBe(EXIT.FAILED);
		expect(ctx.io.stderr.join('\n')).toContain('install failed: `bun install` exited 1');
	});

	it('emits the same object its text render is built from', async () => {
		const ctx = ctxFor(workerTree());
		await run(ctx, ['build', '--json']);
		expect(ctx.io.json<{ resumed: boolean }>().resumed).toBe(true);
	});

	/**
	 * The regression: each step wrote its progress line to stdout, so `build --json` printed
	 * `clone: git clone ...` in front of the object and `| jq` failed on any build that did work.
	 * The case above could not catch it, because a resumed build runs no step at all.
	 */
	it('leaves stdout parseable when steps run, with their progress on stderr', async () => {
		const ctx = ctxFor({});
		expect(await run(ctx, ['build', '--json'])).toBe(EXIT.OK);
		expect(ctx.io.json<{ resumed: boolean }>().resumed).toBe(false);
		expect(ctx.io.stderr.join('\n')).toContain(`clone: ${CLONE}`);
	});
});

describe('drangler validate', () => {
	it('passes on a hydrated workspace', async () => {
		const ctx = ctxFor(workerTree());
		expect(await run(ctx, ['validate'])).toBe(EXIT.OK);
		expect(ctx.io.text()).toContain('every check passed');
	});

	it('exits 3 with a finding, not 1, so a pipeline can tell the two apart', async () => {
		const ctx = ctxFor(workerTree(), { [SCRUB]: fail(1, 'hash_salt PRESENT') });
		expect(await run(ctx, ['validate'])).toBe(EXIT.FINDING);
		expect(ctx.io.stderr.join('\n')).toContain('1 check(s) failed: scrub');
	});

	it('exits 3 when a check could not run, rather than reporting a pass', async () => {
		const ctx = ctxFor(workerTree(), { [SCRUB]: fail(2, 'no per-file pack') });
		expect(await run(ctx, ['validate'])).toBe(EXIT.FINDING);
		expect(ctx.io.stderr.join('\n')).toContain('could not run: scrub');
		expect(ctx.io.text()).toContain('not run');
	});

	it('runs the subset --only names', async () => {
		const ctx = ctxFor(workerTree());
		await run(ctx, ['validate', '--only', 'workspace,artifacts', '--json']);
		expect(ctx.io.json<{ checks: { id: string }[] }>().checks.map((c) => c.id)).toEqual([
			'workspace',
			'artifacts'
		]);
		expect(ctx.runner.calls).toEqual([]);
	});

	it('rejects an unknown check name as usage rather than skipping it', async () => {
		const ctx = ctxFor(workerTree());
		expect(await run(ctx, ['validate', '--only', 'bundel'])).toBe(EXIT.USAGE);
		expect(ctx.io.stderr.join('\n')).toContain('unknown check(s) bundel');
	});

	it('prints the fix for every failing check', async () => {
		const tree = workerTree();
		delete tree[`${WORKSPACE}/assets/driver.json`];
		const ctx = ctxFor(tree);
		await run(ctx, ['validate', '--only', 'artifacts']);
		expect(ctx.io.text()).toContain('fix: cd /ws/worker && bun run hydrate');
	});
});

describe('parseChecks', () => {
	it('returns undefined for no flag, so the default set stays the default', () => {
		expect(parseChecks(undefined)).toBeUndefined();
	});

	it('trims and drops empties', () => {
		expect(parseChecks(' workspace , config ,')).toEqual(['workspace', 'config']);
	});
});

describe('drangler dev', () => {
	it('builds, gates and hands over to wrangler dev', async () => {
		const ctx = ctxFor({});
		expect(await run(ctx, ['dev'])).toBe(EXIT.OK);
		expect(lines(ctx.runner)).toEqual([
			CLONE,
			'bun install',
			'bun run hydrate',
			'bunx wrangler dev -c wrangler.jsonc'
		]);
	});

	it('reuses a built workspace instead of re-cloning, which is the resume property', async () => {
		const ctx = ctxFor(workerTree());
		expect(await run(ctx, ['dev'])).toBe(EXIT.OK);
		expect(lines(ctx.runner)).toEqual(['bunx wrangler dev -c wrangler.jsonc']);
	});

	it('does not price the bundle or scrub the pack, because dev uploads nothing', async () => {
		const ctx = ctxFor(workerTree(), { [SCRUB]: fail(1, 'hash_salt PRESENT') });
		expect(await run(ctx, ['dev'])).toBe(EXIT.OK);
		expect(lines(ctx.runner)).not.toContain(SCRUB);
		expect(lines(ctx.runner)).not.toContain(DRY_RUN);
	});

	it('stops before wrangler when the gate fails', async () => {
		const tree = workerTree();
		delete tree[`${WORKSPACE}/assets/driver.json`];
		const ctx = ctxFor(tree, { 'bun run hydrate': fail(0, '') });
		expect(await run(ctx, ['dev', '--no-build'])).toBe(EXIT.FINDING);
		expect(lines(ctx.runner)).toEqual([]);
		expect(ctx.io.stderr.join('\n')).toContain('assets/driver.json');
	});

	it('runs wrangler anyway under --skip-validate', async () => {
		const tree = workerTree();
		delete tree[`${WORKSPACE}/assets/driver.json`];
		const ctx = ctxFor(tree);
		expect(await run(ctx, ['dev', '--no-build', '--skip-validate'])).toBe(EXIT.OK);
		expect(lines(ctx.runner)).toEqual(['bunx wrangler dev -c wrangler.jsonc']);
	});

	it('passes everything after -- through to wrangler', async () => {
		const ctx = ctxFor(workerTree(), {
			'bunx wrangler dev -c wrangler.jsonc --port 8788 --remote': ok('')
		});
		expect(await run(ctx, ['dev', '--', '--port', '8788', '--remote'])).toBe(EXIT.OK);
		expect(lines(ctx.runner)).toEqual([
			'bunx wrangler dev -c wrangler.jsonc --port 8788 --remote'
		]);
	});

	it('reports a non-zero wrangler exit', async () => {
		const ctx = ctxFor(workerTree(), {
			'bunx wrangler dev -c wrangler.jsonc': fail(1, 'port in use')
		});
		expect(await run(ctx, ['dev'])).toBe(EXIT.FAILED);
		expect(ctx.io.stderr.join('\n')).toContain('wrangler dev exited 1');
	});
});

describe('drangler deploy', () => {
	it('gates on the bundle and the pack scrub before uploading anything', async () => {
		const ctx = ctxFor(workerTree());
		expect(await run(ctx, ['deploy'])).toBe(EXIT.OK);
		expect(lines(ctx.runner)).toEqual([
			SCRUB,
			DRY_RUN,
			'bunx wrangler deploy -c wrangler.jsonc'
		]);
	});

	it('refuses to deploy a pack that still ships a secret', async () => {
		const ctx = ctxFor(workerTree(), { [SCRUB]: fail(1, 'settings.php hash_salt PRESENT') });
		expect(await run(ctx, ['deploy'])).toBe(EXIT.FINDING);
		expect(lines(ctx.runner)).not.toContain('bunx wrangler deploy -c wrangler.jsonc');
		expect(ctx.io.stderr.join('\n')).toContain('served publicly');
	});

	it('refuses to deploy a bundle over the Worker size limit', async () => {
		const ctx = ctxFor(workerTree(), {
			[DRY_RUN]: ok('Total Upload: 70.00 MiB / gzip: 20000.00 KiB')
		});
		expect(await run(ctx, ['deploy'])).toBe(EXIT.FINDING);
		expect(ctx.io.stderr.join('\n')).toContain('OVER the Worker size limit');
		expect(lines(ctx.runner)).not.toContain('bunx wrangler deploy -c wrangler.jsonc');
	});

	// the gate that refused the shipping bundle: 3,990.8 KiB gzipped against a ceiling that is gone
	it('deploys a bundle whose gzip figure exceeds the ceiling Cloudflare deleted', async () => {
		const ctx = ctxFor(workerTree(), {
			[DRY_RUN]: ok('Total Upload: 13279.13 KiB / gzip: 3990.80 KiB')
		});
		expect(await run(ctx, ['deploy'])).toBe(EXIT.OK);
		expect(lines(ctx.runner)).toContain('bunx wrangler deploy -c wrangler.jsonc');
	});

	it('deploys whichever config it is pointed at', async () => {
		const ctx = ctxFor(
			workerTree({
				[`${WORKSPACE}/wrangler.paid.jsonc`]: workerTree()[`${WORKSPACE}/wrangler.jsonc`]!
			}),
			{
				'bun run assets:scrub:check': ok('clean'),
				[`bunx wrangler deploy -c wrangler.paid.jsonc --dry-run --outdir ${WORKSPACE}/dist/dry-run`]:
					ok('Total Upload: 11000.00 KiB / gzip: 2818.80 KiB'),
				'bunx wrangler deploy -c wrangler.paid.jsonc': ok('')
			}
		);
		expect(await run(ctx, ['deploy', '--config', 'wrangler.paid.jsonc'])).toBe(EXIT.OK);
		expect(lines(ctx.runner)).toContain('bunx wrangler deploy -c wrangler.paid.jsonc');
	});
});

describe('drangler migrate install', () => {
	const DB = `${WORKSPACE}/assets/drupal/site.sqlite`;
	const STAMP = `${WORKSPACE}/.drangler-backup/20260814T000000000Z`;

	it('lands a database and reports that nothing was overwritten', async () => {
		const ctx = ctxFor(workerTree({ '/in/site.sqlite': 'NEW' }));
		expect(await run(ctx, ['migrate', 'install', '--db', '/in/site.sqlite'])).toBe(EXIT.OK);
		expect(ctx.files.readText(DB)).toBe('NEW');
		expect(ctx.io.text()).toContain('nothing was overwritten');
	});

	it('backs up what it replaces and prints how to put it back', async () => {
		const ctx = ctxFor(workerTree({ '/in/site.sqlite': 'NEW', [DB]: 'OLD' }));
		expect(await run(ctx, ['migrate', 'install', '--db', '/in/site.sqlite'])).toBe(EXIT.OK);
		expect(ctx.files.readText(`${STAMP}/assets__drupal__site.sqlite`)).toBe('OLD');
		expect(ctx.io.text()).toContain(`drangler migrate restore --backup ${STAMP}`);
	});

	it('says the chunks are now stale, because a landed database does not ship on its own', async () => {
		const ctx = ctxFor(workerTree({ '/in/site.sqlite': 'NEW' }));
		await run(ctx, ['migrate', 'install', '--db', '/in/site.sqlite']);
		expect(ctx.io.text()).toContain('bun run assets:sql');
	});

	it('repacks when asked', async () => {
		const ctx = ctxFor(workerTree({ '/in/site.sqlite': 'NEW' }), {
			'bun run assets:sql': ok('')
		});
		expect(await run(ctx, ['migrate', 'install', '--db', '/in/site.sqlite', '--repack'])).toBe(
			EXIT.OK
		);
		expect(lines(ctx.runner)).toEqual(['bun run assets:sql']);
	});

	it('repacks after an --asset too, rather than ignoring the flag', async () => {
		const ctx = ctxFor(workerTree({ '/in/a': 'A' }), { 'bun run assets:sql': ok('') });
		expect(
			await run(ctx, ['migrate', 'install', '--asset', '/in/a=assets/a.json', '--repack'])
		).toBe(EXIT.OK);
		expect(lines(ctx.runner)).toEqual(['bun run assets:sql']);
	});

	it('names the backup when a repack fails, so the tree is recoverable', async () => {
		const ctx = ctxFor(workerTree({ '/in/site.sqlite': 'NEW', [DB]: 'OLD' }), {
			'bun run assets:sql': fail(1, 'node:sqlite missing')
		});
		expect(await run(ctx, ['migrate', 'install', '--db', '/in/site.sqlite', '--repack'])).toBe(
			EXIT.FAILED
		);
		expect(ctx.io.stderr.join('\n')).toContain(STAMP);
	});

	it('writes nothing under --dry-run', async () => {
		const ctx = ctxFor(workerTree({ '/in/site.sqlite': 'NEW', [DB]: 'OLD' }));
		expect(await run(ctx, ['migrate', 'install', '--db', '/in/site.sqlite', '--dry-run'])).toBe(
			EXIT.OK
		);
		expect(ctx.files.readText(DB)).toBe('OLD');
		expect(ctx.io.text()).toContain('dry run; nothing was written');
	});

	it('takes repeated --asset pairs', async () => {
		const ctx = ctxFor(workerTree({ '/in/a': 'A', '/in/b': 'B' }));
		expect(
			await run(ctx, [
				'migrate',
				'install',
				'--asset',
				'/in/a=assets/a.json',
				'--asset',
				'/in/b=assets/b.json'
			])
		).toBe(EXIT.OK);
		expect(ctx.files.readText(`${WORKSPACE}/assets/a.json`)).toBe('A');
		expect(ctx.files.readText(`${WORKSPACE}/assets/b.json`)).toBe('B');
	});

	it.each(['/in/a', '/in/a=', '=assets/a', '/in/a=/etc/passwd', '/in/a=../../etc/passwd'])(
		'refuses the asset pair `%s`',
		async (pair) => {
			const ctx = ctxFor(workerTree({ '/in/a': 'A' }));
			expect(await run(ctx, ['migrate', 'install', '--asset', pair])).toBe(EXIT.USAGE);
		}
	);

	it('refuses a workspace that is not a checkout', async () => {
		const ctx = ctxFor({ '/in/site.sqlite': 'NEW' });
		expect(await run(ctx, ['migrate', 'install', '--db', '/in/site.sqlite'])).toBe(EXIT.USAGE);
		expect(ctx.io.stderr.join('\n')).toContain('drangler build');
	});

	it('refuses an empty instruction rather than doing nothing quietly', async () => {
		const ctx = ctxFor(workerTree());
		expect(await run(ctx, ['migrate', 'install'])).toBe(EXIT.USAGE);
		expect(ctx.io.stderr.join('\n')).toContain('nothing to install');
	});

	it('names a source that is not there', async () => {
		const ctx = ctxFor(workerTree());
		expect(await run(ctx, ['migrate', 'install', '--db', '/in/gone.sqlite'])).toBe(EXIT.USAGE);
		expect(ctx.io.stderr.join('\n')).toContain('/in/gone.sqlite');
	});
});

describe('drangler migrate restore', () => {
	const DB = `${WORKSPACE}/assets/drupal/site.sqlite`;
	const STAMP = `${WORKSPACE}/.drangler-backup/20260814T000000000Z`;

	it('puts a backup set back', async () => {
		const ctx = ctxFor(workerTree({ '/in/site.sqlite': 'NEW', [DB]: 'OLD' }));
		await run(ctx, ['migrate', 'install', '--db', '/in/site.sqlite']);
		expect(ctx.files.readText(DB)).toBe('NEW');

		const back = ctxFor({});
		Object.assign(back, { files: ctx.files });
		expect(await run(back, ['migrate', 'restore', '--backup', STAMP])).toBe(EXIT.OK);
		expect(ctx.files.readText(DB)).toBe('OLD');
		expect(back.io.text()).toContain('1 file(s) restored');
	});

	it('refuses a directory that is not a backup set', async () => {
		const ctx = ctxFor(workerTree());
		expect(await run(ctx, ['migrate', 'restore', '--backup', WORKSPACE])).toBe(EXIT.USAGE);
		expect(ctx.io.stderr.join('\n')).toContain(BACKUP_MANIFEST);
	});
});

/**
 * Mounting a local module project into the dev site.
 *
 * One command rather than two: `dev` already clones the worker, hydrates 22 MB of packs and hands
 * the terminal to wrangler, and mounting a module needs all of that first. Two commands would mean
 * two workspaces, two hydrates and two wrangler processes on one port.
 */
describe('drangler dev --modify', () => {
	const MODULE = '/work/mantle2';

	const moduleTree = (): Record<string, string> => ({
		[`${MODULE}/mantle2.info.yml`]: 'name: mantle2\ntype: module\n',
		[`${MODULE}/mantle2.module`]: '<?php\n'
	});

	/** a dev site that answers `/firstrun` and the three `/modify` actions an upload drives */
	function devSite(): { fetch: typeof globalThis.fetch; calls: string[] } {
		const calls: string[] = [];
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
		const fn = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
			const url = new URL(String(input));
			calls.push(`${String(init.method ?? 'GET')} ${url.pathname}${url.search}`);
			if (url.pathname === '/firstrun') {
				return init.method === 'POST'
					? json({ ok: true, ownerToken: 'dev-token' })
					: json({ ok: true, configured: false });
			}
			const action = url.searchParams.get('action');
			if (action === 'plan') return json({ ok: true, have: [], want: [], counts: {} });
			if (action === 'blobs') return json({ ok: true, stored: 0, skipped: 0, bytes: 0 });
			return json({ ok: true, rev: 'a'.repeat(64), applied: true, rolledBack: false });
		};
		return { fetch: fn as unknown as typeof globalThis.fetch, calls };
	}

	/**
	 * A runner whose `spawn` stays up for a moment, the way a real `wrangler dev` does.
	 *
	 * The mount runs ALONGSIDE the server rather than before it, so a spawn that returns instantly
	 * would stop the mount before it reached its first request and the spec would assert nothing.
	 */
	function slowSpawn(inner: ScriptedRunner): ScriptedRunner {
		return Object.assign(Object.create(inner) as ScriptedRunner, {
			calls: inner.calls,
			run: inner.run,
			spawn: async (file: string, args: readonly string[], opts?: { cwd?: string }) => {
				const code = await inner.spawn(file, args, opts);
				await new Promise((resolve) => setTimeout(resolve, 25));
				return code;
			}
		});
	}

	it('builds, gates and runs wrangler in that order, with the mount alongside', async () => {
		const site = devSite();
		const ctx = ctxFor({ ...workerTree(), ...moduleTree() });
		Object.assign(ctx, { fetch: site.fetch, runner: slowSpawn(ctx.runner) });
		expect(await run(ctx, ['dev', '--modify', MODULE, '--interval', '0'])).toBe(EXIT.OK);
		expect(lines(ctx.runner)).toEqual(['bunx wrangler dev -c wrangler.jsonc']);
		expect(site.calls[0]).toBe('GET /firstrun?site=dev');
		expect(site.calls).toContain('POST /firstrun?site=dev');
		expect(site.calls.join(' ')).toContain('action=commit&package=mantle2');
	});

	// refused while there is still a terminal to read the refusal on
	it('refuses a directory that is no module project before wrangler takes the terminal', async () => {
		const ctx = ctxFor(workerTree());
		expect(await run(ctx, ['dev', '--modify', '/work/nothing'])).toBe(EXIT.USAGE);
		expect(lines(ctx.runner)).toEqual([]);
	});

	it('passes --port through and builds the dev origin from it', async () => {
		const site = devSite();
		const ctx = ctxFor(
			{ ...workerTree(), ...moduleTree() },
			{
				'bunx wrangler dev -c wrangler.jsonc --port 8788': ok('')
			}
		);
		Object.assign(ctx, { fetch: site.fetch, runner: slowSpawn(ctx.runner) });
		expect(
			await run(ctx, ['dev', '--modify', MODULE, '--port', '8788', '--interval', '0'])
		).toBe(EXIT.OK);
		expect(lines(ctx.runner)).toEqual(['bunx wrangler dev -c wrangler.jsonc --port 8788']);
	});

	it('`modify dev` is the same command with --modify pointed at the working directory', async () => {
		const site = devSite();
		const ctx = ctxFor({ ...workerTree(), ...moduleTree() });
		Object.assign(ctx, {
			fetch: site.fetch,
			runner: slowSpawn(ctx.runner),
			cwd: MODULE
		});
		expect(await run(ctx, ['modify', 'dev', '--interval', '0'])).toBe(EXIT.OK);
		expect(lines(ctx.runner)).toEqual(['bunx wrangler dev -c wrangler.jsonc']);
		expect(site.calls.join(' ')).toContain('package=mantle2');
	});

	it('says nothing was mounted when the dev site is already claimed and no token was given', async () => {
		const site = devSite();
		const claimed = {
			...site,
			fetch: (async (input: unknown, init: RequestInit = {}) => {
				const url = new URL(String(input));
				if (url.pathname === '/firstrun' && init.method !== 'POST') {
					return new Response(JSON.stringify({ ok: true, configured: true }), {
						headers: { 'content-type': 'application/json' }
					});
				}
				return await site.fetch(input as string, init);
			}) as unknown as typeof globalThis.fetch
		};
		const ctx = ctxFor({ ...workerTree(), ...moduleTree() });
		Object.assign(ctx, { fetch: claimed.fetch, runner: slowSpawn(ctx.runner) });
		expect(await run(ctx, ['dev', '--modify', MODULE, '--interval', '0'])).toBe(EXIT.OK);
		expect(ctx.io.stderr.join('\n')).toContain('already claimed');
	});
});
