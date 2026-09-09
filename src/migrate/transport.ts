import { TransportError } from '../errors';
import type { CommandResult, CommandRunner } from '../host/exec';
import { destination, type SshTarget } from './target';

/**
 * How drangler reaches a remote host.
 *
 * Everything the migration path does to a VPS goes through this one method, so a survey can be
 * driven from a recorded transcript, a fixture or a live connection without the caller knowing
 * which. Nothing above this interface constructs an `ssh` command line.
 */
export interface Transport {
	/** a human label for the connection, used in reports */
	readonly label: string;
	exec(command: string): Promise<CommandResult>;
}

/**
 * Builds the `ssh` argv for one remote command.
 *
 * `BatchMode=yes` is the load-bearing flag: without it ssh will sit on a password prompt forever
 * inside a CLI that has already returned control, so a missing key hangs instead of failing. The
 * remote command is the last argument and is never concatenated into a shell string here.
 */
export function sshArgs(target: SshTarget, command: string): string[] {
	const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
	if (target.port !== null) args.push('-p', String(target.port));
	if (target.identity) args.push('-i', target.identity);
	args.push(destination(target), command);
	return args;
}

/**
 * A transport that runs the real `ssh` binary through the injected runner.
 *
 * Constructing one opens nothing; the first `exec()` is the first contact. That is what lets
 * `migrate survey --dry-run` build the whole command plan against a live target and print it without
 * a connection.
 */
export const SSH_ATTEMPTS = 3;

/**
 * Retries only a TRANSPORT failure, and terminates on an observation rather than on the count.
 *
 * ssh exits 255 for everything from a refused connection to a dropped session, and every one of them
 * is worth one more attempt: the remote command never ran, so a retry cannot double anything. The
 * terminating observation is **this step produced output** -- any exit code other than 255 means the
 * command ran and its result is the answer, whatever the answer was.
 *
 * A step that fails three times with the same stderr is a `TransportError`, which `runSurvey()`
 * already records in `survey.errors[]` before carrying on. The bound is the second condition and
 * never the only one.
 */
export function sshTransport(runner: CommandRunner, target: SshTarget): Transport {
	return {
		label: destination(target),
		async exec(command) {
			let last: CommandResult = { code: 255, stdout: '', stderr: '' };
			for (let attempt = 1; attempt <= SSH_ATTEMPTS; attempt++) {
				last = await runner.run('ssh', sshArgs(target, command), { timeoutMs: 120_000 });
				if (last.code !== 255) return last;
			}
			throw new TransportError(
				`ssh could not connect to ${destination(target)} in ${SSH_ATTEMPTS} attempts: ${last.stderr.trim() || 'no detail'}`
			);
		}
	};
}

/** A command and its recorded result, which is what `--replay` reads and what a spec writes. */
export type Transcript = Record<string, CommandResult>;

/**
 * A transport backed by a recorded transcript.
 *
 * Not only a test double: `migrate survey --replay` uses it so a survey captured on a machine that
 * can reach the VPS can be re-planned anywhere, and so a support conversation can work from the same
 * bytes the user saw.
 */
export function replayTransport(transcript: Transcript, label = 'replay'): Transport {
	return {
		label,
		async exec(command) {
			const hit = transcript[command];
			if (hit === undefined) {
				throw new TransportError(`the transcript has no entry for: ${command}`);
			}
			return hit;
		}
	};
}

/** A transport that refuses every command; `--dry-run` uses it so a plan can never leak a connection. */
export function refusingTransport(label = 'dry-run'): Transport {
	return {
		label,
		async exec(command) {
			throw new TransportError(`dry run: refused to execute \`${command}\``);
		}
	};
}
