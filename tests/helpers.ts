import type { Context } from '../src/context';
import type { FetchLike } from '../src/health/probe';
import { scriptedRunner, type CommandResult } from '../src/host/exec';
import { memoryFiles } from '../src/host/files';
import { bufferIo, type BufferIo } from '../src/io';

export interface TestContext extends Context {
	io: BufferIo;
}

/** A context with every seam replaced; no spec reaches a process, a socket or the filesystem. */
export function testContext(over: Partial<Context> = {}): TestContext {
	return {
		io: bufferIo(),
		files: memoryFiles(),
		runner: scriptedRunner({}),
		fetch: fakeFetch(() => new Response('', { status: 200 })),
		env: {},
		cwd: '/ws/worker',
		now: () => new Date('2026-08-14T00:00:00.000Z'),
		...over
	} as TestContext;
}

/** Wraps a handler as a `fetch`, recording every URL it was asked for. */
export function fakeFetch(
	handler: (url: string) => Response | Promise<Response>
): FetchLike & { urls: string[] } {
	const urls: string[] = [];
	const fn = async (input: unknown) => {
		const url = String(input);
		urls.push(url);
		return await handler(url);
	};
	return Object.assign(fn, { urls }) as unknown as FetchLike & { urls: string[] };
}

export const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
export const fail = (code: number, stderr = ''): CommandResult => ({ code, stdout: '', stderr });
