import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runModifyStatus, runModifyUpload } from '../../src/commands/modify';
import { defaultContext, type Context } from '../../src/context';
import { nodeFiles } from '../../src/host/files';
import { bufferIo, type BufferIo } from '../../src/io';
import { detectProject, packageOf } from '../../src/modify/detect';
import { planBuild, runPlan } from '../../src/workspace/build';
import { readState } from '../../src/workspace/layout';
import { resolveSource } from '../../src/workspace/source';
import { testGlobals } from '../helpers';
import { cloneGate, resolvePayload, WORKER_REF, WORKER_SOURCE } from './helpers/clone';
import { startFixtureWorker, type RunningWorker } from './helpers/worker';

const skip = (await cloneGate()) || (await resolvePayload()) === null;

const PORT = 8901;
const PACKAGE = 'cfw_modify_probe';

/**
 * Uploading a module into a real site, over a real `wrangler dev`.
 *
 * The gate lane drives the same functions against a memory filesystem and a fake site, which proves
 * the negotiation, the batching and every verdict. What it cannot prove is the part that only
 * exists off this machine: that the paths `selectPackageFiles()` mounts are the paths the object
 * writes into `cfw_module_file`, that the hashes drangler computes are the hashes `storeBlobs()`
 * re-computes, and that a revision drangler commits comes back on `action=status`.
 *
 * **Skips when there is no release payload**, with the reason named. The pack is not buildable on a
 * clean checkout, so a lane that failed here would fail on the artifact rather than on the code.
 */
describe.skipIf(skip)('an upload into a real dev site', () => {
	let scratch: string;
	let workspace: string;
	let project: string;
	let worker: RunningWorker;
	let token: string;

	const ctxWith = (io: BufferIo, cwd: string): Context => ({
		...defaultContext(),
		io,
		files: nodeFiles(),
		cwd
	});

	beforeAll(async () => {
		scratch = mkdtempSync(join(tmpdir(), 'drangler-e2e-modify-'));
		workspace = join(scratch, 'worker');
		project = join(scratch, PACKAGE);

		// the smallest thing `moduleRoots()` will mount: an info file and one PHP file
		mkdirSync(join(project, 'src'), { recursive: true });
		writeFileSync(
			join(project, `${PACKAGE}.info.yml`),
			'name: Modify Probe\ntype: module\ncore_version_requirement: ^11\n'
		);
		writeFileSync(join(project, `${PACKAGE}.module`), '<?php\n// v1\n');
		writeFileSync(join(project, 'src', 'Probe.php'), '<?php\nclass Probe {}\n');

		const io = bufferIo();
		const ctx = ctxWith(io, scratch);
		const source = resolveSource(ctx.env, WORKER_SOURCE, WORKER_REF);
		await runPlan(
			ctx,
			planBuild(readState(ctx.files, workspace), source, {}),
			workspace,
			source
		);

		worker = await startFixtureWorker({
			dir: workspace,
			config: join(workspace, 'wrangler.jsonc'),
			port: PORT,
			probePath: '/serve'
		});

		// claimed the way a user claims one: a POST with a JSON body, and the token rides the reply.
		// NO `?site=`: the parameter is honoured only on a route that is not public, so a claim that
		// names one mints the token on a different object than every owner call would address
		const claim = await fetch(`${worker.origin}/firstrun`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ siteName: 'Modify E2E' }),
			signal: AbortSignal.timeout(300_000)
		});
		token = ((await claim.json()) as { ownerToken?: string }).ownerToken ?? '';
	}, 900_000);

	afterAll(() => {
		worker?.stop();
		if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
	});

	it('detects the project and mounts it where Drupal looks for a custom module', () => {
		const pkg = packageOf(detectProject(nodeFiles(), project));
		expect(pkg.name).toBe(PACKAGE);
		expect(pkg.mount).toBe(`modules/custom/${PACKAGE}`);
	});

	it('uploads a module and finds it on the site afterwards', async () => {
		expect(token).not.toBe('');
		const io = bufferIo();
		const ctx = ctxWith(io, project);
		const globals = testGlobals({ json: true }, ctx, {
			site: worker.origin,
			token
		});

		await runModifyUpload(ctx, { globals });
		const uploaded = io.json<{ applied: boolean; rolledBack: boolean; rev: string | null }>();
		expect(uploaded).toMatchObject({ applied: true, rolledBack: false });
		expect(uploaded.rev).toMatch(/^[0-9a-f]{64}$/);

		const statusIo = bufferIo();
		await runModifyStatus(ctxWith(statusIo, project), {
			globals: testGlobals({ json: true }, ctxWith(statusIo, project), {
				site: worker.origin,
				token
			})
		});
		const status = statusIo.json<{
			clean: boolean;
			local: { rev: string };
			live: { rev: string; files: number } | null;
		}>();
		// the revision id drangler computed locally is the one the site stored
		expect(status.live?.rev).toBe(uploaded.rev);
		expect(status.local.rev).toBe(uploaded.rev);
		expect(status.clean).toBe(true);
		expect(status.live?.files).toBe(3);
	}, 900_000);

	it('sends only the changed file on the second upload', async () => {
		writeFileSync(join(project, `${PACKAGE}.module`), '<?php\n// v2\n');
		const io = bufferIo();
		const ctx = ctxWith(io, project);
		await runModifyUpload(ctx, {
			globals: testGlobals({ json: true }, ctx, {
				site: worker.origin,
				token
			})
		});
		const report = io.json<{ plan: { have: string[]; want: string[] }; stored: number }>();
		expect(report.plan.have).toHaveLength(2);
		expect(report.plan.want).toHaveLength(1);
		expect(report.stored).toBe(1);
	}, 900_000);
});
