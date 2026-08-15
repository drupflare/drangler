import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = dirname(dirname(E2E_DIR));
export const COMPOSE_FILE = join(REPO_ROOT, 'docker', 'compose.yml');

export interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs a command and returns its result; a non-zero exit is data, never a throw. */
export function sh(
	file: string,
	args: readonly string[],
	opts: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<Run> {
	return new Promise((resolve) => {
		const child = execFile(
			file,
			[...args],
			{
				timeout: opts.timeoutMs ?? 300_000,
				maxBuffer: 256 * 1024 * 1024,
				encoding: 'buffer',
				env: opts.env ?? process.env
			},
			(error, stdout, stderr) => {
				const code =
					error && typeof (error as { code?: unknown }).code === 'number'
						? (error as unknown as { code: number }).code
						: error
							? 127
							: 0;
				resolve({
					code,
					stdout: Buffer.from(stdout).toString('utf8'),
					stderr: Buffer.from(stderr).toString('utf8')
				});
			}
		);
		if (opts.input !== undefined) {
			child.stdin?.end(opts.input);
		}
	});
}

/** Fails a command loudly, with both streams, because a silent compose failure is unreadable. */
export async function shOrThrow(
	file: string,
	args: readonly string[],
	opts: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
	const result = await sh(file, args, opts);
	if (result.code !== 0) {
		throw new Error(
			`${file} ${args.join(' ')} exited ${result.code}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
		);
	}
	return result.stdout;
}

/** `docker compose -f docker/compose.yml ...` */
export function compose(
	args: readonly string[],
	opts?: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }
) {
	return sh('docker', ['compose', '-f', COMPOSE_FILE, ...args], opts);
}

export function composeOrThrow(
	args: readonly string[],
	opts?: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }
) {
	return shOrThrow('docker', ['compose', '-f', COMPOSE_FILE, ...args], opts);
}

/**
 * Whether the e2e lane should skip itself.
 *
 * **Skip locally, fail when the lane declares it.** Copied from `drupflare/worker`'s
 * `tests/node/helpers/artifact-gate.ts` and `tests/e2e/helpers/endpoint.ts`, which argue it
 * directly: a developer without Docker should not see red, but a CI run that skipped is
 * indistinguishable from one that passed, and a step which can only skip is worse than no step.
 *
 * Gated on `REQUIRE_DOCKER` rather than on `CI`, for the reason the worker learned the hard way:
 * gating on `CI` alone puts the requirement into every lane including the push gate, and this lane
 * installs Drupal, which takes minutes. The nightly and dispatch lane sets `REQUIRE_DOCKER=1`; the
 * push gate never runs this at all.
 */
export async function dockerGate(): Promise<boolean> {
	const version = await sh('docker', ['version', '--format', '{{.Server.Version}}'], {
		timeoutMs: 15_000
	});
	const available = version.code === 0 && version.stdout.trim() !== '';
	if (available) return false;
	if (process.env.REQUIRE_DOCKER) {
		throw new Error(
			'e2e: no Docker daemon, and REQUIRE_DOCKER says this lane has one.\n' +
				`  docker version exited ${version.code}: ${version.stderr.trim() || 'no detail'}\n` +
				'Start Docker, or unset REQUIRE_DOCKER to narrow what this lane claims to cover.'
		);
	}
	return true;
}

/** Whether the compose stack is already up, so a spec can bring it up only when it has to. */
export async function stackRunning(service: string): Promise<boolean> {
	const ps = await compose(['ps', '--status=running', '--format', '{{.Service}}'], {
		timeoutMs: 30_000
	});
	return ps.code === 0 && ps.stdout.split('\n').some((line) => line.trim() === service);
}
