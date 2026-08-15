import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DirEntry {
	name: string;
	directory: boolean;
}

/**
 * The filesystem seam.
 *
 * Same reasoning as `CommandRunner`: the workspace scan, the secret scan and every read of a survey
 * or a dump go through this, so a spec builds a tree in a plain object.
 */
export interface FileHost {
	exists(path: string): boolean;
	readText(path: string): string;
	writeText(path: string, text: string): void;
	/** raw bytes, because a database and a files tree are not text and a decode would corrupt them */
	readBytes(path: string): Uint8Array;
	writeBytes(path: string, bytes: Uint8Array): void;
	readDir(path: string): DirEntry[];
	size(path: string): number;
}

/** The real filesystem. `writeText` creates the parent directory, which every caller wants. */
export function nodeFiles(): FileHost {
	return {
		exists: (path) => existsSync(path),
		readText: (path) => readFileSync(path, 'utf8'),
		writeText: (path, text) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text, 'utf8');
		},
		readBytes: (path) => new Uint8Array(readFileSync(path)),
		writeBytes: (path, bytes) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, bytes);
		},
		readDir: (path) =>
			readdirSync(path, { withFileTypes: true }).map((e) => ({
				name: e.name,
				directory: e.isDirectory()
			})),
		size: (path) => statSync(path).size
	};
}

export interface MemoryFiles extends FileHost {
	/** every path written, so a spec can assert on output without a temp directory */
	readonly written: Map<string, string>;
}

/**
 * A filesystem over a flat path map.
 *
 * Directory listings are derived from the keys, so a fixture declares files only and the tree falls
 * out; a fixture that had to declare its directories too would drift from the files in it.
 *
 * IT HOLDS BYTES, not strings, and a seeded string is UTF-8 encoded on the way in. That is what
 * `nodeFiles` does, so `size()` and `readBytes().length` agree here for the same reason they agree
 * on a real disk. Storing the string and encoding on read would make a binary fixture -- a database,
 * a pack -- read back as something other than what was written.
 */
export function memoryFiles(seed: Record<string, string> = {}): MemoryFiles {
	const files = new Map<string, Uint8Array>(
		Object.entries(seed).map(([path, text]) => [
			path,
			new Uint8Array(Buffer.from(text, 'utf8'))
		])
	);
	const written = new Map<string, string>();

	const isDir = (path: string): boolean => {
		const prefix = path.endsWith('/') ? path : `${path}/`;
		for (const key of files.keys()) if (key.startsWith(prefix)) return true;
		return false;
	};

	const read = (path: string): Uint8Array => {
		const hit = files.get(path);
		if (hit === undefined) throw new Error(`ENOENT: ${path}`);
		return hit;
	};

	return {
		written,
		exists: (path) => files.has(path) || isDir(path),
		readText: (path) => Buffer.from(read(path)).toString('utf8'),
		writeText: (path, text) => {
			files.set(path, new Uint8Array(Buffer.from(text, 'utf8')));
			written.set(path, text);
		},
		readBytes: (path) => read(path),
		writeBytes: (path, bytes) => {
			files.set(path, new Uint8Array(bytes));
			written.set(path, Buffer.from(bytes).toString('utf8'));
		},
		readDir: (path) => {
			const prefix = path.endsWith('/') ? path : `${path}/`;
			const seen = new Map<string, boolean>();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				const slash = rest.indexOf('/');
				const name = slash === -1 ? rest : rest.slice(0, slash);
				if (name !== '') seen.set(name, slash !== -1 || (seen.get(name) ?? false));
			}
			if (seen.size === 0 && !files.has(path)) throw new Error(`ENOENT: ${path}`);
			return [...seen].map(([name, directory]) => ({ name, directory }));
		},
		size: (path) => read(path).length
	};
}

/** Reads and parses JSON, returning null for both "absent" and "unparseable". */
export function readJson<T>(files: FileHost, path: string): T | null {
	if (!files.exists(path)) return null;
	try {
		return JSON.parse(files.readText(path)) as T;
	} catch {
		return null;
	}
}

export { join };
