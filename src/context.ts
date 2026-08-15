import type { FetchLike } from './health/probe';
import { nodeRunner, type CommandRunner } from './host/exec';
import { nodeFiles, type FileHost } from './host/files';
import { consoleIo, type Io } from './io';

/**
 * Everything a command is allowed to touch.
 *
 * Commands take a context and nothing else, so the gate lane substitutes all five seams at once and
 * no spec reaches a process, a socket, a clock or the filesystem. A command that reached for a global
 * would be the one place the suite could not cover.
 */
export interface Context {
	io: Io;
	files: FileHost;
	runner: CommandRunner;
	fetch: FetchLike;
	env: NodeJS.ProcessEnv;
	cwd: string;
	now: () => Date;
}

export function defaultContext(overrides: Partial<Context> = {}): Context {
	return {
		io: consoleIo(),
		files: nodeFiles(),
		runner: nodeRunner(),
		fetch: globalThis.fetch,
		env: process.env,
		cwd: process.cwd(),
		now: () => new Date(),
		...overrides
	};
}
