/** Where a command writes. Every command takes one, so the gate lane never touches a real stream. */
export interface Io {
	out(text: string): void;
	err(text: string): void;
}

/** The real streams, one line per call. */
export function consoleIo(): Io {
	return {
		out: (text) => process.stdout.write(`${text}\n`),
		err: (text) => process.stderr.write(`${text}\n`)
	};
}

export interface BufferIo extends Io {
	readonly stdout: string[];
	readonly stderr: string[];
	/** everything written to stdout, joined, for a spec that asserts on the whole render */
	text(): string;
	/** stdout parsed as one JSON document, for a spec driving `--json` */
	json<T = unknown>(): T;
}

/** An `Io` that keeps what was written; used by every spec and by nothing at runtime. */
export function bufferIo(): BufferIo {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		out: (text) => void stdout.push(text),
		err: (text) => void stderr.push(text),
		text: () => stdout.join('\n'),
		json: <T>() => JSON.parse(stdout.join('\n')) as T
	};
}
