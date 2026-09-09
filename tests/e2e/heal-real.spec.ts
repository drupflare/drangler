import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultContext, type Context } from '../../src/context';
import { readDegradation } from '../../src/health/probe';
import { summariseHealth } from '../../src/health/repair';
import { nodeFiles } from '../../src/host/files';
import { bufferIo } from '../../src/io';
import { planBuild, runPlan } from '../../src/workspace/build';
import { readState } from '../../src/workspace/layout';
import { resolveSource } from '../../src/workspace/source';
import { cloneGate, resolvePayload, WORKER_REF, WORKER_SOURCE } from './helpers/clone';
import { startFixtureWorker, type RunningWorker } from './helpers/worker';

const skip = (await cloneGate()) || (await resolvePayload()) === null;

const SITE = 'heal-real';
const PORT = 8905;

/**
 * The REAL worker's envelopes, against the parser that reads them.
 *
 * `heal.spec.ts` drives the same code against the fixture, which reports every state on demand
 * including the ones a live site reaches only after three consecutive critical findings. That
 * fixture is a second definition of the same contract, and this is what stops it drifting: the
 * failure `worker/tests/e2e/README.md` records for the tier vocabulary is that the first version of
 * an assertion was guessed.
 *
 * It asserts SHAPE rather than state. Reaching quarantine on a live site needs three consecutive
 * critical findings and a spec should not manufacture those.
 *
 * **Skips when there is no release payload**, with the reason named: the pack is not buildable on a
 * clean checkout, so failing here would fail on the artifact rather than on the code.
 */
describe.skipIf(skip)("the real worker's repair envelopes", () => {
	let scratch: string;
	let workspace: string;
	let worker: RunningWorker;
	let token: string;

	beforeAll(async () => {
		scratch = mkdtempSync(join(tmpdir(), 'drangler-e2e-heal-'));
		workspace = join(scratch, 'worker');
		const io = bufferIo();
		const ctx: Context = { ...defaultContext(), io, files: nodeFiles(), cwd: scratch };
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
			probePath: `/serve?site=${SITE}`
		});
		const claim = await fetch(`${worker.origin}/firstrun?site=${SITE}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ siteName: 'Heal Real' }),
			signal: AbortSignal.timeout(300_000)
		});
		token = ((await claim.json()) as { ownerToken?: string }).ownerToken ?? '';
	}, 900_000);

	afterAll(() => {
		worker?.stop();
		if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
	});

	const owner = async (path: string, params: Record<string, string> = {}) => {
		const url = new URL(path, worker.origin);
		url.searchParams.set('site', SITE);
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(120_000)
		});
		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>
		};
	};

	it('parses the /health envelope the real object emits', async () => {
		expect(token).not.toBe('');
		const reply = await owner('/health');
		expect(reply.status).toBe(200);
		const report = summariseHealth(worker.origin, reply.body, Date.now());
		// the fields the parser reads by name, on a site that has done nothing wrong
		expect(report.rung).toBe('observe');
		expect(report.quarantined).toBe(false);
		expect(typeof report.rollback.reason).toBe('string');
		expect(report.rollback.reason).not.toBe('');
	}, 900_000);

	it('parses the /updb envelope, including a site that has never run one', async () => {
		const reply = await owner('/updb');
		expect(reply.status).toBe(200);
		// `run` is null on a site nothing has needed an update on, and null is a state
		expect(Object.keys(reply.body)).toContain('run');
	}, 900_000);

	it('answers /replica with a stage the site scorer reads by name', async () => {
		const reply = await owner('/replica');
		expect(reply.status).toBeLessThan(500);
	}, 900_000);

	/** the headers are absent on `normal`, which is what makes their presence mean something */
	it('sets no degradation headers on a site that is not shedding load', async () => {
		const response = await fetch(`${worker.origin}/serve?site=${SITE}&edge=0`, {
			signal: AbortSignal.timeout(300_000)
		});
		const cfw: Record<string, string> = {};
		response.headers.forEach((value, name) => {
			if (name.toLowerCase().startsWith('x-cfw-')) cfw[name.toLowerCase()] = value;
		});
		expect(Object.keys(cfw).length).toBeGreaterThan(0);
		expect(readDegradation(cfw)).toBeNull();
	}, 900_000);

	it('refuses every one of those routes without the token', async () => {
		for (const path of ['/health', '/updb', '/replica']) {
			const url = new URL(path, worker.origin);
			url.searchParams.set('site', SITE);
			const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
			expect(response.status, path).toBe(401);
		}
	}, 900_000);
});
