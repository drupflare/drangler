import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
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
	exec(command: string): Promise<CommandResult & { unknown?: UnknownOutcome }>;
	/** runs a command with its stdout written to a local file as bytes; a dump or a tar */
	download(command: string, out: string): Promise<Capture>;
}

/**
 * What a run is left with after ssh exited 255 and the command was sent again.
 *
 * ssh returns 255 for a refused connection and also after a command has started, and a remote
 * command can exit 255 itself, so the first attempt may have run to the end. `firstSha256` is what
 * the first attempt left on disk (null when it left nothing); `agreed` says whether the accepted
 * capture matches it byte for byte, which is the only evidence the first one was whole.
 */
export interface UnknownOutcome {
	attempts: number;
	firstSha256: string | null;
	agreed: boolean | null;
}

export interface Capture {
	code: number;
	stderr: string;
	bytes: number;
	/** the accepted capture's checksum; set only when an earlier attempt's outcome was unknown */
	sha256?: string;
	unknown?: UnknownOutcome;
}

async function checksum(path: string): Promise<string | null> {
	const hash = createHash('sha256');
	try {
		for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	} catch {
		return null;
	}
	return hash.digest('hex');
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
 * Sends the command again after exit 255, and reports that the first attempt's outcome is unknown.
 *
 * ssh exits 255 for everything from a refused connection to a dropped session, but it also exits 255
 * after the remote command has started, and the command may have run to completion. So a retry is
 * not proof that nothing happened, and what it leaves behind is an `unknown` record: how many
 * attempts, the checksum of whatever the first one wrote, and whether the accepted capture matches
 * it. Any exit code other than 255 means the command ran and its result is the answer, whatever the
 * answer was.
 *
 * Three attempts that all end in 255 are a `TransportError` that says the command may have run.
 * The bound is the second condition and never the only one.
 */
export function sshTransport(runner: CommandRunner, target: SshTarget): Transport {
	const gaveUp = (last: { stderr: string }, first: string | null) =>
		new TransportError(
			`ssh could not connect to ${destination(target)} in ${SSH_ATTEMPTS} attempts: ${last.stderr.trim() || 'no detail'}; the outcome of the command is unknown and it may have run${first === null ? '' : ` (the first attempt left ${first})`}`
		);
	return {
		label: destination(target),
		async exec(command) {
			let last: CommandResult = { code: 255, stdout: '', stderr: '' };
			for (let attempt = 1; attempt <= SSH_ATTEMPTS; attempt++) {
				last = await runner.run('ssh', sshArgs(target, command), { timeoutMs: 120_000 });
				if (last.code !== 255) {
					return attempt === 1
						? last
						: {
								...last,
								unknown: { attempts: attempt, firstSha256: null, agreed: null }
							};
				}
			}
			throw gaveUp(last, null);
		},
		async download(command, out) {
			let last = { code: 255, stderr: '', bytes: 0 };
			let first: string | null = null;
			for (let attempt = 1; attempt <= SSH_ATTEMPTS; attempt++) {
				last = await runner.runToFile('ssh', sshArgs(target, command), out, {
					timeoutMs: 6 * 60 * 60_000
				});
				if (last.code !== 255) {
					if (attempt === 1) return last;
					const sha256 = await checksum(out);
					return {
						...last,
						...(sha256 === null ? {} : { sha256 }),
						unknown: {
							attempts: attempt,
							firstSha256: first,
							agreed: first === null || sha256 === null ? null : first === sha256
						}
					};
				}
				if (attempt === 1) first = await checksum(out);
			}
			throw gaveUp(last, first);
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
		},
		async download(command) {
			throw new TransportError(`a transcript cannot replay a byte stream: ${command}`);
		}
	};
}

/** A transport that refuses every command; `--dry-run` uses it so a plan can never leak a connection. */
export function refusingTransport(label = 'dry-run'): Transport {
	return {
		label,
		async exec(command) {
			throw new TransportError(`dry run: refused to execute \`${command}\``);
		},
		async download(command) {
			throw new TransportError(`dry run: refused to execute \`${command}\``);
		}
	};
}
