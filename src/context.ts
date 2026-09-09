import { createInterface } from 'node:readline/promises';
import type { FetchLike } from './health/probe';
import { nodeRunner, type CommandRunner } from './host/exec';
import { nodeFiles, type FileHost } from './host/files';
import { consoleIo, type Io } from './io';

/**
 * stdin, and the only seam a command reads input through.
 *
 * **Null means there was nobody to ask**: no TTY, or three unusable answers in a row. A command
 * that gets null must exit 2 naming the flag that supplies the answer, because a wizard blocking on
 * a pipe is a hung CI job. The question goes to stderr so stdout still carries one report.
 */
export type Ask = (question: string, choices?: readonly string[]) => Promise<string | null>;

/**
 * Everything a command is allowed to touch.
 *
 * Commands take a context and nothing else, so the gate lane substitutes every seam at once and no
 * spec reaches a process, a socket, a clock, a terminal or the filesystem. A command that reached
 * for a global would be the one place the suite could not cover.
 */
export interface Context {
	io: Io;
	files: FileHost;
	runner: CommandRunner;
	fetch: FetchLike;
	ask: Ask;
	env: NodeJS.ProcessEnv;
	cwd: string;
	now: () => Date;
}

/** how many unusable answers a prompt tolerates before it gives up and lets the caller refuse */
const ASK_ATTEMPTS = 3;

export function nodeAsk(): Ask {
	return async (question, choices) => {
		if (process.stdin.isTTY !== true) return null;
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		try {
			for (let attempt = 0; attempt < ASK_ATTEMPTS; attempt++) {
				const answer = (await rl.question(`${question} `)).trim();
				if (choices === undefined ? answer !== '' : choices.includes(answer)) return answer;
				process.stderr.write(
					choices === undefined
						? 'an answer is required\n'
						: `one of: ${choices.join(', ')}\n`
				);
			}
			return null;
		} finally {
			rl.close();
		}
	};
}

export function defaultContext(overrides: Partial<Context> = {}): Context {
	return {
		io: consoleIo(),
		files: nodeFiles(),
		runner: nodeRunner(),
		fetch: globalThis.fetch,
		ask: nodeAsk(),
		env: process.env,
		cwd: process.cwd(),
		now: () => new Date(),
		...overrides
	};
}
