import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	runModifyEnable,
	runModifyRequire,
	runModifyRevisions,
	runModifyRollback,
	runModifyStatus,
	runModifyUpload
} from '../../src/commands/modify';
import { runSiteClaim, type SiteClaimReport } from '../../src/commands/site';
import { defaultContext, type Context } from '../../src/context';
import { nodeFiles } from '../../src/host/files';
import { bufferIo, type BufferIo } from '../../src/io';
import { detectProject, packageOf } from '../../src/modify/detect';
import { planBuild, runPlan } from '../../src/workspace/build';
import { readState } from '../../src/workspace/layout';
import { resolveSource } from '../../src/workspace/source';
import { testGlobals } from '../helpers';
import { cloneGate, resolvePayload, WORKER_REF, WORKER_SOURCE } from './helpers/clone';
import { sh } from './helpers/docker';
import { startFixtureWorker, type RunningWorker } from './helpers/worker';

/** a hydrated worker tree to serve as it is, when no published release matches the source */
const SEEDED = process.env.DRANGLER_E2E_WORKSPACE;
const skip =
	SEEDED === undefined ? (await cloneGate()) || (await resolvePayload()) === null : false;

const PORT = 8901;
const PACKAGE = 'cfw_modify_probe';
const PROBE_PATH = '/modify-probe';

/** production modules, pinned; one that enables and one whose own routing refuses to */
const CORPUS = {
	simpleOauth21: {
		repo: 'https://github.com/e0ipso/simple_oauth_21',
		sha: 'f2b73148a83c99697e2d7ba7fcd36084fe0f8c40',
		module: 'simple_oauth_21',
		requires: { name: 'drupal/simple_oauth', version: '^6.0.3' }
	},
	integrity: {
		repo: 'https://github.com/victorstack-ai/drupal-entity-reference-integrity',
		sha: '147497534a6e95bafb3d872711989a3548a6bc63',
		module: 'entity_reference_integrity',
		path: '/admin/reports/entity-reference-integrity'
	}
} as const;

const probeFiles = (marker: string): Record<string, string> => ({
	[`${PACKAGE}.info.yml`]: 'name: Modify Probe\ntype: module\ncore_version_requirement: ^11\n',
	[`${PACKAGE}.module`]: '<?php\n',
	[`${PACKAGE}.routing.yml`]: [
		`${PACKAGE}.show:`,
		`  path: '${PROBE_PATH}'`,
		'  defaults:',
		`    _controller: '\\Drupal\\${PACKAGE}\\Controller\\ProbeController::show'`,
		'  requirements:',
		"    _access: 'TRUE'",
		''
	].join('\n'),
	'src/Controller/ProbeController.php': [
		'<?php',
		`namespace Drupal\\${PACKAGE}\\Controller;`,
		'use Symfony\\Component\\HttpFoundation\\Response;',
		'class ProbeController {',
		'	public function show(): Response {',
		`		return new Response('${marker}', 200, ['Cache-Control' => 'no-store, private']);`,
		'	}',
		'}',
		''
	].join('\n')
});

const writeTree = (root: string, files: Record<string, string>) => {
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(join(root, rel, '..'), { recursive: true });
		writeFileSync(join(root, rel), text);
	}
};

/**
 * `drangler modify` against a real dev site, over a real `wrangler dev`.
 *
 * The gate lane proves the negotiation, the batching and every verdict against a fake site. This
 * lane proves what only a real site can: that an uploaded module's code is what the site then
 * serves, that a module which breaks the boot is refused and the previous revision keeps serving,
 * that a rollback puts the old code back, and that two pinned production modules go through
 * `require`, `upload` and `enable` the way a user drives them.
 *
 * **Skips when there is neither a release payload nor `DRANGLER_E2E_WORKSPACE`**, with the reason
 * named. A seeded workspace is a tree `bun run hydrate` or `bun run build:local` already completed.
 */
describe.skipIf(skip)('drangler modify against a real dev site', () => {
	let scratch: string;
	let workspace: string;
	let project: string;
	let worker: RunningWorker;
	let token: string;
	const revs: string[] = [];

	const ctxWith = (io: BufferIo, cwd: string): Context => ({
		...defaultContext(),
		io,
		files: nodeFiles(),
		cwd
	});
	const globalsFor = (ctx: Context, over: { yes?: boolean } = {}) =>
		testGlobals({ json: true, ...over }, ctx, { site: worker.origin, token });

	let failed = false;
	/** stops the current worker, printing its dev log when a case failed against it */
	function retire(): void {
		const log = worker?.stop(failed);
		failed = false;
		if (log) {
			console.error(`a case failed; the wrangler dev log is at ${log}`);
			console.error(readFileSync(log, 'utf8').slice(-12000));
		}
	}

	let launches = 0;
	/** a new worker on its own scratch state and port, claimed with drangler itself */
	async function freshSite(): Promise<void> {
		retire();
		worker = await startFixtureWorker({
			dir: workspace,
			config: join(workspace, 'wrangler.jsonc'),
			port: PORT + launches++,
			probePath: '/serve'
		});
		// the claim waits out the first-boot replay before it posts
		const io = bufferIo();
		const ctx = ctxWith(io, scratch);
		await runSiteClaim(ctx, worker.origin, {
			title: 'Modify E2E',
			globals: testGlobals({ json: true }, ctx, { site: worker.origin })
		});
		token = io.json<SiteClaimReport>().ownerToken ?? '';
	}

	/** runs one command, keeping its JSON even when it exits with an error */
	async function drive<T>(
		cwd: string,
		run: (ctx: Context, globals: ReturnType<typeof globalsFor>) => Promise<void>,
		over: { yes?: boolean } = {}
	): Promise<{ report: T; error: Error | null }> {
		const io = bufferIo();
		const ctx = ctxWith(io, cwd);
		let error: Error | null = null;
		try {
			await run(ctx, globalsFor(ctx, over));
		} catch (e) {
			error = e instanceof Error ? e : new Error(String(e));
		}
		return { report: io.json<T>(), error };
	}

	/**
	 * One read, retried through `warming`. The key keeps the URL stable across the retries, because
	 * a path the fill chain has not yet seen answers 503 until it has rendered it once, and differs
	 * per step, so no stored copy from an earlier step can answer for the code under test.
	 */
	async function page(path: string, key: string): Promise<{ status: number; body: string }> {
		const url = new URL(path, worker.origin);
		url.searchParams.set('e2e', key);
		const until = Date.now() + 180_000;
		for (;;) {
			const res = await fetch(url, {
				redirect: 'manual',
				signal: AbortSignal.timeout(300_000)
			});
			const body = await res.text();
			const warming =
				res.status === 503 &&
				(res.headers.has('x-cfw-queued') ||
					res.headers.has('x-cfw-migrate') ||
					res.headers.get('x-cfw-cache') === 'MISS');
			if (!warming || Date.now() > until) return { status: res.status, body };
			await new Promise((r) => setTimeout(r, 2_000));
		}
	}

	/** a failed render answers 500 with the exception in the body, and a bare status hides it */
	const expectStatus = (res: { status: number; body: string }, want: number) =>
		expect(res.status, res.body.slice(0, 800)).toBe(want);

	/** a pinned production checkout, or null when the network cannot reach it */
	async function checkout(repo: string, sha: string): Promise<string | null> {
		const dir = join(scratch, repo.split('/').pop()!);
		const clone = await sh('git', ['clone', '--quiet', repo, dir], { timeoutMs: 300_000 });
		if (clone.code !== 0) {
			if (process.env.REQUIRE_CLONE) throw new Error(`git clone ${repo}: ${clone.stderr}`);
			return null;
		}
		const pin = await sh('git', ['-C', dir, 'checkout', '--quiet', sha], {
			timeoutMs: 60_000
		});
		if (pin.code !== 0) throw new Error(`${repo} has no commit ${sha}: ${pin.stderr}`);
		return dir;
	}

	beforeAll(async () => {
		scratch = mkdtempSync(join(tmpdir(), 'drangler-e2e-modify-'));
		project = join(scratch, PACKAGE);
		writeTree(project, probeFiles('probe-v1'));

		if (SEEDED !== undefined) {
			workspace = resolve(SEEDED);
			if (!existsSync(join(workspace, 'wrangler.jsonc'))) {
				throw new Error(
					`DRANGLER_E2E_WORKSPACE names ${workspace}, which has no wrangler.jsonc`
				);
			}
		} else {
			workspace = join(scratch, 'worker');
			const ctx = ctxWith(bufferIo(), scratch);
			const source = resolveSource(ctx.env, WORKER_SOURCE, WORKER_REF);
			await runPlan(
				ctx,
				planBuild(readState(ctx.files, workspace), source, {}),
				workspace,
				source
			);
		}

		await freshSite();
	}, 900_000);

	afterEach(({ task }) => {
		if (task.result?.state === 'fail') failed = true;
	});

	afterAll(() => {
		retire();
		if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
	});

	describe('a module written for the test', () => {
		it('detects the project and mounts it where Drupal looks for a custom module', () => {
			const pkg = packageOf(detectProject(nodeFiles(), project));
			expect(pkg.name).toBe(PACKAGE);
			expect(pkg.mount).toBe(`modules/custom/${PACKAGE}`);
		});

		it('uploads it, and the revision drangler computed is the one the site stored', async () => {
			expect(token).not.toBe('');
			const up = await drive<{ applied: boolean; rolledBack: boolean; rev: string | null }>(
				project,
				(ctx, globals) => runModifyUpload(ctx, { globals })
			);
			expect(up.error).toBeNull();
			expect(up.report).toMatchObject({ applied: true, rolledBack: false });
			expect(up.report.rev).toMatch(/^[0-9a-f]{64}$/);
			revs.push(up.report.rev!);

			const status = await drive<{
				clean: boolean;
				local: { rev: string };
				live: { rev: string; files: number } | null;
			}>(project, (ctx, globals) => runModifyStatus(ctx, { globals }));
			expect(status.report.live?.rev).toBe(up.report.rev);
			expect(status.report.local.rev).toBe(up.report.rev);
			expect(status.report.clean).toBe(true);
			expect(status.report.live?.files).toBe(4);
		}, 900_000);

		it('serves its route only once it is enabled', async () => {
			expect((await page(PROBE_PATH, 'before-enable')).status).toBe(404);
			const on = await drive<{ modules: { module: string; enabled: boolean }[] }>(
				project,
				(ctx, globals) => runModifyEnable(ctx, [PACKAGE], { globals })
			);
			expect(on.error).toBeNull();
			expect(on.report.modules).toEqual([
				expect.objectContaining({ module: PACKAGE, enabled: true })
			]);
			expect(await page(PROBE_PATH, 'v1')).toEqual({ status: 200, body: 'probe-v1' });
		}, 900_000);

		it('sends only the changed file, and the site serves the new code', async () => {
			writeTree(project, probeFiles('probe-v2'));
			const up = await drive<{
				applied: boolean;
				rev: string | null;
				plan: { have: string[]; want: string[] };
				stored: number;
			}>(project, (ctx, globals) => runModifyUpload(ctx, { globals }));
			expect(up.error).toBeNull();
			expect(up.report.plan.have).toHaveLength(3);
			expect(up.report.plan.want).toHaveLength(1);
			expect(up.report.stored).toBe(1);
			revs.push(up.report.rev!);
			// the interpreter persists between requests, so an already-declared class is the risk here
			expect(await page(PROBE_PATH, 'v2')).toEqual({ status: 200, body: 'probe-v2' });
		}, 900_000);

		it('refuses a revision that breaks the boot and keeps the previous one serving', async () => {
			writeFileSync(join(project, `${PACKAGE}.module`), '<?php\nfunction (\n');
			const up = await drive<{
				applied: boolean;
				rolledBack: boolean;
				rev: string | null;
				error: string | null;
			}>(project, (ctx, globals) => runModifyUpload(ctx, { globals }));
			expect(up.error).not.toBeNull();
			expect(up.report.rolledBack).toBe(true);
			expect(up.report.error).not.toBeNull();

			const status = await drive<{ live: { rev: string } | null }>(project, (ctx, globals) =>
				runModifyStatus(ctx, { globals })
			);
			// the refused revision may be stored, but it must not be the active one
			expect(status.report.live?.rev, JSON.stringify({ refused: up.report, revs })).toBe(
				revs[1]
			);
			expect(await page(PROBE_PATH, 'refused')).toEqual({ status: 200, body: 'probe-v2' });
			expect((await page('/', 'refused')).status).toBe(200);
		}, 900_000);

		it('lists both good revisions and rolls back to the first', async () => {
			writeTree(project, probeFiles('probe-v2'));
			const listed = await drive<{ active: string | null; revisions: { rev: string }[] }>(
				project,
				(ctx, globals) => runModifyRevisions(ctx, { globals })
			);
			expect(listed.report.active, JSON.stringify({ listed: listed.report, revs })).toBe(
				revs[1]
			);
			expect(listed.report.revisions.map((r) => r.rev)).toEqual(
				expect.arrayContaining([revs[0], revs[1]])
			);

			const back = await drive<{ rev: string | null; applied: boolean }>(
				project,
				(ctx, globals) => runModifyRollback(ctx, { globals }),
				{ yes: true }
			);
			expect(back.error).toBeNull();
			expect(back.report.rev).toBe(revs[0]);
			expect(await page(PROBE_PATH, 'rollback')).toEqual({ status: 200, body: 'probe-v1' });
		}, 900_000);
	});

	describe('pinned production modules', () => {
		// a local workerd never collects a dropped interpreter, so each real contrib enable gets a
		// site of its own rather than stacking interpreters in one process
		beforeEach(freshSite, 900_000);

		it('requires simple_oauth, uploads simple_oauth_21 and enables it', async (t) => {
			const c = CORPUS.simpleOauth21;
			const dir = await checkout(c.repo, c.sha);
			if (dir === null) return t.skip();
			const routing = readFileSync(join(dir, `${c.module}.routing.yml`), 'utf8');
			const dashboard = /simple_oauth_21\.dashboard:\s*\n\s*path:\s*'?([^'\n]+)'?/.exec(
				routing
			)?.[1];
			expect(dashboard).toBeDefined();

			const req = await drive<{ packages: { installed: boolean; error: string | null }[] }>(
				dir,
				(ctx, globals) =>
					runModifyRequire(ctx, [c.requires.name], {
						version: c.requires.version,
						globals
					})
			);
			expect(req.error, JSON.stringify(req.report)).toBeNull();
			expect(req.report.packages[0]).toMatchObject({ installed: true, error: null });

			const up = await drive<{ applied: boolean }>(dir, (ctx, globals) =>
				runModifyUpload(ctx, { dir, globals })
			);
			expect(up.error).toBeNull();
			expect(up.report.applied).toBe(true);

			expect((await page(dashboard!, 'oauth-before')).status).toBe(404);
			const on = await drive<{ modules: { enabled: boolean; error: string | null }[] }>(
				dir,
				(ctx, globals) => runModifyEnable(ctx, [c.module], { globals })
			);
			expect(on.error).toBeNull();
			expect(on.report.modules[0]).toMatchObject({ enabled: true, error: null });
			// the route exists now and refuses an anonymous visitor
			expectStatus(await page(dashboard!, 'oauth-after'), 403);
			expectStatus(await page('/', 'oauth-after'), 200);
		}, 900_000);

		it('reports a module whose enable is refused and leaves the site serving', async (t) => {
			const c = CORPUS.integrity;
			const dir = await checkout(c.repo, c.sha);
			if (dir === null) return t.skip();

			const up = await drive<{ applied: boolean }>(dir, (ctx, globals) =>
				runModifyUpload(ctx, { dir, globals })
			);
			expect(up.error).toBeNull();
			expect(up.report.applied).toBe(true);

			const on = await drive<{ modules: { enabled: boolean; error: string | null }[] }>(
				dir,
				(ctx, globals) => runModifyEnable(ctx, [c.module], { globals })
			);
			expect(on.error).not.toBeNull();
			expect(on.report.modules[0]?.enabled).toBe(false);
			expect(on.report.modules[0]?.error).not.toBeNull();

			expectStatus(await page('/', 'integrity'), 200);
			expectStatus(await page(c.path, 'integrity'), 404);
		}, 900_000);
	});
});
