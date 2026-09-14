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
export interface WorkerLaunch {
	/** the directory wrangler runs in; the fixture worker unless a lane brings its own */
	dir?: string;
	/** the config, absolute or relative to `dir` */
	config?: string;
	port?: number;
	/** the path a readiness probe requests; a worker with no `/serve` needs a different one */
	probePath?: string;
}

export async function startFixtureWorker(
	portOrLaunch: number | WorkerLaunch = 8899
): Promise<RunningWorker> {
	const launch: WorkerLaunch =
		typeof portOrLaunch === 'number' ? { port: portOrLaunch } : portOrLaunch;
	const dir = launch.dir ?? FIXTURE_DIR;
	const config = launch.config ?? join(FIXTURE_DIR, 'wrangler.jsonc');
	const port = launch.port ?? 8899;
	const probePath = launch.probePath ?? '/serve?site=probe';
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
			config,
			'--port',
			String(port),
			'--inspector-port',
			String(port + 1000),
			'--persist-to',
			join(stateDir, 'state'),
			'--local'
		],
		{ cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }
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
					await fetch(`${origin}${probePath}`, {
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

/**
 * Claims a REAL worker's site and returns the token it minted.
 *
 * **`startFixtureWorker` returns when the PORT answers, which is not when the SITE can answer.**
 * The first request boots the interpreter and `/firstrun` writes Drupal config through it, so a
 * single POST into that window comes back without an `ownerToken` and the caller reads an empty
 * string. Measured on CI: the run that failed spent 8.5s in `heal-real.spec.ts` where the passing
 * one spent 18s, and the whole report was `expected '' not to be ''`, which names nothing. Waiting
 * here rather than probing harder in the launcher, because "can this site mint a token" is the
 * question these specs actually need answered and `/serve` cannot answer it.
 *
 * A 409 is TERMINAL, never retried: the site is already claimed and no amount of waiting mints a
 * second token.
 *
 * No `?site=`, which is the property the real-worker lane exists to hold: `resolveSite()` honours
 * the parameter only on a route that is not public, so a claim naming one mints the token on a
 * different object than every owner call after it would address.
 */
export async function claimRealSite(
	origin: string,
	siteName: string,
	timeoutMs = 600_000
): Promise<string> {
	const started = Date.now();
	let last = 'nothing came back';
	for (;;) {
		try {
			const response = await fetch(`${origin}/firstrun`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ siteName }),
				signal: AbortSignal.timeout(300_000)
			});
			const body = await response.text();
			last = `HTTP ${response.status}: ${body.slice(0, 400)}`;
			if (response.status === 409) {
				throw new Error(`${origin} is already claimed, so nothing here can mint. ${last}`);
			}
			const minted = (JSON.parse(body) as { ownerToken?: string }).ownerToken;
			if (typeof minted === 'string' && minted !== '') return minted;
		} catch (e) {
			if (e instanceof Error && e.message.includes('already claimed')) throw e;
			last = e instanceof Error ? e.message : String(e);
		}
		const waited = Math.round((Date.now() - started) / 1000);
		if (Date.now() - started > timeoutMs) {
			throw new Error(
				`${origin}/firstrun minted no owner token in ${waited}s. Last answer: ${last}`
			);
		}
		await new Promise((r) => setTimeout(r, 2_000));
	}
}

/** The FIXTURE site's owner token, which it mints on a GET and keys by `?site=`. */
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
