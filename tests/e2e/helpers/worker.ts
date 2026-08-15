import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E2E_DIR } from './docker';

export const FIXTURE_DIR = join(E2E_DIR, 'fixture-worker');

export interface RunningWorker {
	origin: string;
	stop(): void;
}

/**
 * Boots the fixture worker on a scratch `--persist-to`, and deletes that directory on the way out.
 *
 * Copied from `drupflare/worker`'s `scripts/e2e-lifecycle.ts`, and copied for its reason rather
 * than its shape: **a Durable Object namespace persists.** `wrangler dev` writes to
 * `.wrangler/state/v3/do/` and nothing prunes it -- measured in that repo at 970 MB for one
 * namespace -- so a run that used the default location would leave its seeded corpus behind and the
 * next run's assertions would be made against yesterday's data.
 *
 * The same guard is kept too: the scratch path is checked before anything is removed, because the
 * cost of a bug in the path construction is deleting a real directory rather than a temporary one.
 */
export async function startFixtureWorker(port = 8899): Promise<RunningWorker> {
	const stateDir = join(tmpdir(), `drangler-e2e-worker-${Date.now().toString(36)}`);
	const logFile = join(stateDir, 'dev.log');
	mkdirSync(stateDir, { recursive: true });

	// a bug in the path above must not be able to reach anything real
	if (
		!stateDir.includes('drangler-e2e-worker-') ||
		stateDir === '/' ||
		stateDir === process.cwd()
	) {
		throw new Error(`refusing to use ${stateDir} as a scratch directory`);
	}

	const dev: ChildProcess = spawn(
		'bunx',
		[
			'wrangler',
			'dev',
			'-c',
			join(FIXTURE_DIR, 'wrangler.jsonc'),
			'--port',
			String(port),
			'--inspector-port',
			String(port + 1000),
			'--persist-to',
			join(stateDir, 'state'),
			'--local'
		],
		{ cwd: FIXTURE_DIR, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	// stopped before the directory goes, because wrangler keeps writing for a moment after SIGTERM
	// and an append into a deleted path is an uncaught ENOENT that fails the run from outside a test
	let logging = true;
	const append = (chunk: unknown) => {
		if (!logging) return;
		try {
			appendFileSync(logFile, String(chunk));
		} catch {
			logging = false;
		}
	};
	dev.stdout?.on('data', append);
	dev.stderr?.on('data', append);

	const stop = () => {
		logging = false;
		dev.stdout?.removeAllListeners('data');
		dev.stderr?.removeAllListeners('data');
		if (dev.exitCode === null) dev.kill('SIGTERM');
		rmSync(stateDir, { recursive: true, force: true });
	};

	const started = Date.now();
	for (;;) {
		if (dev.exitCode !== null) {
			const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
			stop();
			throw new Error(`wrangler dev exited with ${dev.exitCode}\n${log.slice(-4000)}`);
		}
		if (Date.now() - started > 180_000) {
			const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
			stop();
			throw new Error(`wrangler dev did not become ready in 180s\n${log.slice(-4000)}`);
		}
		const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
		const ready = /Ready on (https?:\/\/[^\s]+)/.exec(log);
		if (ready?.[1] !== undefined) {
			const origin = ready[1].replace(/\/+$/, '');
			// wrangler prints Ready before the first request will always succeed; one probe settles it
			for (let i = 0; i < 40; i++) {
				try {
					await fetch(`${origin}/serve?site=probe`, {
						signal: AbortSignal.timeout(3000)
					});
					return { origin, stop };
				} catch {
					await new Promise((r) => setTimeout(r, 500));
				}
			}
			stop();
			throw new Error(`${origin} printed Ready but never answered`);
		}
		await new Promise((r) => setTimeout(r, 400));
	}
}

/** The site's owner token, the way a real user gets one: once, from `/firstrun`. */
export async function ownerToken(origin: string, site: string): Promise<string> {
	const url = new URL('/firstrun', origin);
	url.searchParams.set('site', site);
	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`/firstrun answered ${response.status}`);
	return ((await response.json()) as { ownerToken: string }).ownerToken;
}

/**
 * Loads statements into the object under test.
 *
 * Test scaffolding, not a drangler command: drangler is read-only against a deployed site and has
 * no counterpart to `/restore`. The statements arrive already separated because a value in the
 * corpus contains a newline and another contains a semicolon, so splitting them at the far end
 * would corrupt exactly the rows the corpus exists to protect.
 */
export async function seedWorker(
	origin: string,
	site: string,
	statements: readonly string[]
): Promise<number> {
	const url = new URL('/seed', origin);
	url.searchParams.set('site', site);
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(statements),
		signal: AbortSignal.timeout(180_000)
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`/seed answered ${response.status}: ${text.slice(0, 2000)}`);
	}
	return (JSON.parse(text) as { applied: number }).applied;
}
