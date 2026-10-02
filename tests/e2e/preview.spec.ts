import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PREVIEW_MIN_WORKER, runPreviewCommand } from '../../src/commands/preview';
import { defaultContext, type Context } from '../../src/context';
import { nodeRunner, type CommandRunner } from '../../src/host/exec';
import { nodeFiles } from '../../src/host/files';
import { bufferIo } from '../../src/io';
import { refuseRemote } from '../../src/migrate/preview';
import { testGlobals } from '../helpers';
import { composeOrThrow, dockerGate, sh } from './helpers/docker';
import { DRUPAL_ROOT, KEY_PATH, SSH_HOST, SSH_PORT, SSH_USER, stackUp } from './helpers/stack';

const skip = await dockerGate();
const PORT = 8799;
const SEEDED = process.env.DRANGLER_E2E_PREVIEW_OUT;

/** the source database and trees, hashed from inside the containers, so the comparison touches nothing */
async function sourceDigest(label: string): Promise<string> {
	const db = await composeOrThrow(
		[
			'exec',
			'-T',
			'db',
			'sh',
			'-c',
			// Drupal refreshes its own cache tables on any bootstrap, drush included, so they are left out
			// kept in the container as /tmp/pv-<label>.sql so a mismatch can be diffed
			`mariadb-dump -u root -prootpass --skip-dump-date --skip-comments --skip-extended-insert drupal | grep -v '^INSERT INTO \`cache' | sed -E 's/ AUTO_INCREMENT=[0-9]+//' > /tmp/pv-${label}.sql && sha256sum < /tmp/pv-${label}.sql`
		],
		{ timeoutMs: 300_000 }
	);
	const tree = await composeOrThrow(
		[
			'exec',
			'-T',
			'drupal',
			'sh',
			'-c',
			// css, js, php and styles under files are rebuilt by any render, the same way the cache bins are
			`cd ${DRUPAL_ROOT} && find sites/default/files modules themes -type f -not -path 'sites/default/files/css/*' -not -path 'sites/default/files/js/*' -not -path 'sites/default/files/php/*' -not -path 'sites/default/files/styles/*' -exec sha256sum {} + | sort > /tmp/pv-${label}.tree && sha256sum < /tmp/pv-${label}.tree`
		],
		{ timeoutMs: 300_000 }
	);
	return `${db.trim()} ${tree.trim()}`;
}

/**
 * `drangler preview` against a real Drupal over real ssh, brought up on a real `wrangler dev`.
 *
 * The unit lane drives every step over a fake transport. What only this can show is that the
 * commands the allow-list passes are ones a real host answers, that the migrated database and files
 * boot as a drupflare site, and that the source is byte-identical afterwards.
 */
describe.skipIf(skip)('preview', () => {
	let out: string;
	let wrangler: ChildProcess | null = null;
	let before: string;
	const sent: string[] = [];
	const io = bufferIo();

	beforeAll(async () => {
		// a pre-seeded directory lets the run use a worker tree with no published payload yet
		out = SEEDED ?? mkdtempSync(join(tmpdir(), 'drangler-e2e-pv-'));
		await stackUp();
		await sh('ssh-keygen', ['-R', `[${SSH_HOST}]:${SSH_PORT}`], { timeoutMs: 30_000 });
		// a public file the check can fetch back through the duplicate
		await composeOrThrow([
			'exec',
			'-T',
			'drupal',
			'sh',
			'-c',
			`echo preview-probe > ${DRUPAL_ROOT}/sites/default/files/preview-probe.txt`
		]);
		// automated cron runs on the first page view after its interval, and --source-url views pages
		await composeOrThrow([
			'exec',
			'-T',
			'drupal',
			'sh',
			'-c',
			`cd ${DRUPAL_ROOT} && drush config:set automated_cron.settings interval 0 -y`
		]);
		before = await sourceDigest('before');

		const real = nodeRunner();
		const runner: CommandRunner = {
			...real,
			run: (file, args, opts) => {
				if (file === 'ssh') sent.push(String(args.at(-1)));
				return real.run(file, args, opts);
			},
			runToFile: (file, args, o, opts) => {
				if (file === 'ssh') sent.push(String(args.at(-1)));
				return real.runToFile(file, args, o, opts);
			},
			// wrangler dev never exits on its own, so it is held here and stopped once the check ran
			spawn: (file, args, opts) => {
				if (file !== 'bunx' || !args.includes('dev')) return real.spawn(file, args, opts);
				return new Promise((resolve) => {
					wrangler = spawn(file, [...args], {
						cwd: opts?.cwd,
						env: opts?.env ?? process.env,
						stdio: 'inherit'
					});
					wrangler.on('close', (code) => resolve(code ?? 143));
				});
			}
		};
		const ctx: Context = {
			...defaultContext(),
			io: {
				out: io.out,
				err: (text) => {
					io.err(text);
					if (text.includes('the duplicate is running at')) wrangler?.kill('SIGINT');
				}
			},
			files: nodeFiles(),
			runner,
			ask: async () => SSH_HOST,
			env: {
				...process.env,
				// the oldest release preview accepts, so the pin cannot fall below the gate again
				DRANGLER_WORKER_REF: process.env.DRANGLER_WORKER_REF ?? `v${PREVIEW_MIN_WORKER}`
			}
		};
		try {
			await runPreviewCommand(ctx, {
				host: `${SSH_USER}@${SSH_HOST}:${SSH_PORT}`,
				root: DRUPAL_ROOT,
				identity: KEY_PATH,
				out,
				full: true,
				port: PORT,
				sourceUrl: 'http://localhost:8180',
				globals: testGlobals({}, ctx)
			});
		} finally {
			// the step table and every check, pass or fail, so a red run names what it saw
			console.log([...io.stdout, ...io.stderr].join('\n'));
		}
	}, 3_600_000);

	afterAll(() => {
		wrangler?.kill('SIGKILL');
		if (out && SEEDED === undefined) rmSync(out, { recursive: true, force: true });
	});

	it('sent the host only commands the allow-list passes', () => {
		expect(sent.length).toBeGreaterThan(10);
		for (const command of sent) expect(refuseRemote(command), command).toBeNull();
	});

	it('brought the duplicate up and every check passed', () => {
		const report = io.text();
		expect(report).toMatch(/verify\s+(\d+) of \1 checks passed/);
	});

	it('left the source byte-identical', async () => {
		expect(await sourceDigest('after')).toBe(before);
	});
});
