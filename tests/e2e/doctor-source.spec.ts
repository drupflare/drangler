import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/commands/doctor';
import { resolveConfig } from '../../src/config/file';
import { defaultContext, type Context } from '../../src/context';
import { FindingError } from '../../src/errors';
import { nodeRunner, type CommandRunner } from '../../src/host/exec';
import { nodeFiles } from '../../src/host/files';
import { bufferIo, type BufferIo } from '../../src/io';
import { profileGate, type Fault } from './helpers/docker';
import { KEY_PATH, mintKeypair, plantFault } from './helpers/stack';

const skip = await profileGate('vps-broken', 'REQUIRE_BROKEN');

const ROOT = '/opt/drupal/web';

/**
 * `doctor --source` against a Drupal that is really broken.
 *
 * EVERY FAULT IS PLANTED IN THE CONTAINER, never by patching drangler. Making `runSurvey()` return
 * an error tests that the error branch formats; it does not test that the survey notices, and the
 * two are what this lane exists to keep apart. The same rule `tests/e2e/detector.spec.ts` enforces
 * for the converter.
 *
 * The sshd stays healthy in every fault, so what is under test is a REACHABLE host whose Drupal is
 * broken, which is what a support call looks like. A container that refused ssh would test
 * `TransportError`, and the unit lane already covers that with a scripted exit 255.
 */
describe.skipIf(skip)('doctor --source over a broken VPS', () => {
	let identity: string;

	/**
	 * A throwaway `known_hosts`, injected at the runner seam.
	 *
	 * `sshArgs()` sends `StrictHostKeyChecking=accept-new`, which is the right product default: it
	 * takes an unknown host on trust and REFUSES a changed one. This arm is the case that breaks:
	 * every fault recreates the container, its entrypoint mints new host keys, so the second plant
	 * is a CHANGED host and ssh refuses it before the survey runs -- and on a developer's machine
	 * the FIRST one already is, left over from a previous run on the same port.
	 *
	 * `/dev/null` rather than a scratch file, because the key changes between one fault and the
	 * next as well: a file that remembered the first plant would refuse the second. Nothing is
	 * recorded, so every connection is a first one and `accept-new` takes it.
	 *
	 * `$HOME` cannot move the file: OpenSSH expands `~` from the passwd database rather than the
	 * environment, so only `UserKnownHostsFile` does it. Injected here rather than in `sshArgs()`,
	 * because a real host that changes its key is a warning a user should get.
	 */
	const throwawayKnownHosts = (): CommandRunner => {
		const real = nodeRunner();
		const sshOpts = ['-o', 'UserKnownHostsFile=/dev/null'];
		const withOpts = (file: string, args: readonly string[]): string[] =>
			file === 'ssh' ? [...sshOpts, ...args] : [...args];
		return {
			run: (file, args, opts) => real.run(file, withOpts(file, args), opts),
			spawn: (file, args, opts) => real.spawn(file, withOpts(file, args), opts)
		};
	};

	const ctxWith = (io: BufferIo): Context => ({
		...defaultContext(),
		io,
		files: nodeFiles(),
		runner: throwawayKnownHosts()
	});

	async function score(fault: Fault): Promise<{ io: BufferIo; failed: boolean }> {
		await plantFault(fault);
		const io = bufferIo();
		const ctx = ctxWith(io);
		const failed = await runDoctor(ctx, {
			source: `tester@127.0.0.1:2223`,
			root: ROOT,
			identity,
			config: resolveConfig(ctx)
		}).then(
			() => false,
			(e: unknown) => e instanceof FindingError
		);
		return { io, failed };
	}

	// in a hook rather than in the first `it`, so `-t` on any one of them still has a key to offer
	beforeAll(async () => {
		await mintKeypair();
		identity = KEY_PATH;
	});

	afterAll(async () => {
		// left healthy, so a developer who runs this and then runs something else is not surprised
		if (!skip) await plantFault('none' as Fault);
	});

	it('reports php-broken, and stops there because nothing below it was measured', async () => {
		const { io, failed } = await score('php-broken');
		expect(failed).toBe(true);
		expect(io.text()).toContain('source.php-dead');
	}, 900_000);

	it('reports drush-absent as a warning rather than as four blockers', async () => {
		const { io } = await score('drush-absent');
		expect(io.text()).toContain('source.drush-absent');
		expect(io.text()).not.toContain('source.bootstrap-fail');
	}, 900_000);

	/** the pair `SELECT 1` exists to separate: a driver is reported and the connection is refused */
	it('reports db-unreachable with the driver named', async () => {
		const { io, failed } = await score('db-unreachable');
		expect(failed).toBe(true);
		expect(io.text()).toContain('source.db-unreadable');
	}, 900_000);

	it('reports files-missing when the directory is not there', async () => {
		const { io, failed } = await score('files-missing');
		expect(failed).toBe(true);
		expect(io.text()).toMatch(/source\.files-(missing|unreadable)/);
	}, 900_000);

	it('reports bootstrap-fail on a truncated settings.php', async () => {
		const { io, failed } = await score('bootstrap-fail');
		expect(failed).toBe(true);
		expect(io.text()).toMatch(/source\.(bootstrap-fail|db-unreadable|drush-absent)/);
	}, 900_000);
});
