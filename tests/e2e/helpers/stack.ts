import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPOSE_FILE, sh, shOrThrow } from './docker';

/** where a run's throwaway ssh keypair and scratch files live */
export const SCRATCH = join(tmpdir(), 'drangler-e2e');
export const KEY_PATH = join(SCRATCH, 'id_ed25519');

export const SSH_HOST = '127.0.0.1';
export const SSH_PORT = 2222;
export const SSH_USER = 'tester';
export const DRUPAL_ROOT = '/opt/drupal/web';

/**
 * Mints the run's ssh keypair.
 *
 * Generated rather than committed, and that is not ceremony: a private key in the repository would
 * be found by `drangler secrets scan`, which is one of the things this lane tests. A fixture that
 * trips the product's own detector teaches the detector to be ignored.
 */
export async function mintKeypair(): Promise<string> {
	mkdirSync(SCRATCH, { recursive: true });
	if (!existsSync(KEY_PATH)) {
		await shOrThrow('ssh-keygen', [
			'-t',
			'ed25519',
			'-N',
			'',
			'-C',
			'drangler-e2e',
			'-f',
			KEY_PATH
		]);
	}
	return (await shOrThrow('cat', [`${KEY_PATH}.pub`])).trim();
}

/**
 * Brings the stack up and waits for the Drupal container to report ready.
 *
 * `--wait` honours the compose healthcheck, which watches for the marker the entrypoint touches
 * only after drush is installed and the site is installed. Waiting on the port instead would
 * return while Drupal was still a database error page.
 */
export async function stackUp(timeoutMs = 900_000): Promise<void> {
	const pubkey = await mintKeypair();
	const started = Date.now();
	const up = await sh(
		'docker',
		[
			'compose',
			'-f',
			COMPOSE_FILE,
			'up',
			'-d',
			'--wait',
			'--wait-timeout',
			String(Math.floor(timeoutMs / 1000))
		],
		{ timeoutMs: timeoutMs + 60_000, env: { ...process.env, DRANGLER_E2E_SSH_PUBKEY: pubkey } }
	);
	if (up.code !== 0) {
		const logs = await sh(
			'docker',
			['compose', '-f', COMPOSE_FILE, 'logs', '--no-color', '--tail=120'],
			{
				timeoutMs: 60_000
			}
		);
		throw new Error(
			`compose up failed after ${Math.round((Date.now() - started) / 1000)}s (exit ${up.code})\n` +
				`DRANGLER_E2E_SSH_PUBKEY was ${pubkey.slice(0, 24)}...\n` +
				`${up.stderr}\n--- logs ---\n${logs.stdout}${logs.stderr}`
		);
	}
}

/** Tears the stack down, volumes included, so the next run installs Drupal from nothing. */
export async function stackDown(): Promise<void> {
	await sh('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v', '--remove-orphans'], {
		timeoutMs: 180_000
	});
	rmSync(SCRATCH, { recursive: true, force: true });
}

/** The env `docker compose` needs; the public key is interpolated into the service definition. */
export async function composeEnv(): Promise<NodeJS.ProcessEnv> {
	return { ...process.env, DRANGLER_E2E_SSH_PUBKEY: await mintKeypair() };
}
