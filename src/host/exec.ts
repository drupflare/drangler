import { execFile, spawn as spawnProcess } from 'node:child_process';

/** What a subprocess produced. A non-zero `code` is data, not an exception. */
export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

/**
 * The one seam every subprocess in drangler goes through.
 *
 * `git`, `ssh` and `wrangler` are all reached this way, so a spec injects one fake and covers all
 * three without a process, a network or a login.
 */
export interface CommandRunner {
	run(file: string, args: readonly string[], opts?: RunOptions): Promise<CommandResult>;
	/**
	 * Hands the terminal over to a subprocess and waits for its exit code.
	 *
	 * The split from `run` is about what the OUTPUT is for. `run` captures because the caller parses
	 * it -- `git status --porcelain`, wrangler's gzip line. `spawn` inherits because the caller wants
	 * the user to watch it: `wrangler dev` never exits on its own and `bun run hydrate` downloads
	 * 15 MB, so both would sit silent behind a buffer and a timeout.
	 */
	spawn(file: string, args: readonly string[], opts?: RunOptions): Promise<number>;
}

/** Real subprocesses. `execFile`, never a shell, so no argument is ever word-split. */
export function nodeRunner(): CommandRunner {
	return {
		spawn(file, args, opts = {}) {
			return new Promise((resolve) => {
				const child = spawnProcess(file, [...args], {
					cwd: opts.cwd,
					env: opts.env ?? process.env,
					stdio: 'inherit'
				});
				// a signalled child reports code null; 128+SIGTERM is what a shell would report
				child.on('close', (code, signal) => resolve(code ?? (signal === null ? 1 : 143)));
				child.on('error', () => resolve(127));
			});
		},
		run(file, args, opts = {}) {
			return new Promise((resolve) => {
				execFile(
					file,
					[...args],
					{
						cwd: opts.cwd,
						env: opts.env ?? process.env,
						timeout: opts.timeoutMs ?? 60_000,
						maxBuffer: 64 * 1024 * 1024,
						encoding: 'utf8'
					},
					(error, stdout, stderr) => {
						const code =
							error && typeof (error as { code?: unknown }).code === 'number'
								? (error as unknown as { code: number }).code
								: error
									? 127
									: 0;
						resolve({ code, stdout: String(stdout), stderr: String(stderr) });
					}
				);
			});
		}
	};
}

/** One recorded invocation, for a spec asserting on argv rather than on output. */
export interface RecordedCall {
	file: string;
	args: string[];
	/** which seam it came through, so a spec can assert step ORDER across both */
	mode: 'run' | 'spawn';
	cwd?: string;
}

export interface ScriptedRunner extends CommandRunner {
	readonly calls: RecordedCall[];
}

/**
 * A runner backed by a lookup table, keyed by the full command line.
 *
 * An unmatched command resolves to exit 127 rather than throwing: a missing binary is what the
 * caller has to handle anyway, and a spec that wants the throw asserts on the code.
 */
export function scriptedRunner(
	script: Record<string, CommandResult | ((args: readonly string[]) => CommandResult)>
): ScriptedRunner {
	const calls: RecordedCall[] = [];
	const lookup = (
		mode: 'run' | 'spawn',
		file: string,
		args: readonly string[],
		cwd?: string
	): CommandResult => {
		calls.push({ file, args: [...args], mode, ...(cwd === undefined ? {} : { cwd }) });
		const key = [file, ...args].join(' ');
		const hit = script[key];
		if (hit === undefined) {
			return { code: 127, stdout: '', stderr: `scripted runner has no entry for: ${key}` };
		}
		return typeof hit === 'function' ? hit(args) : hit;
	};
	return {
		calls,
		async run(file, args, opts = {}) {
			return lookup('run', file, args, opts.cwd);
		},
		async spawn(file, args, opts = {}) {
			return lookup('spawn', file, args, opts.cwd).code;
		}
	};
}
