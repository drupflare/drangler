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
 */
export function memoryFiles(seed: Record<string, string> = {}): MemoryFiles {
	const files = new Map<string, string>(Object.entries(seed));
	const written = new Map<string, string>();

	const isDir = (path: string): boolean => {
		const prefix = path.endsWith('/') ? path : `${path}/`;
		for (const key of files.keys()) if (key.startsWith(prefix)) return true;
		return false;
	};

	return {
		written,
		exists: (path) => files.has(path) || isDir(path),
		readText: (path) => {
			const hit = files.get(path);
			if (hit === undefined) throw new Error(`ENOENT: ${path}`);
			return hit;
		},
		writeText: (path, text) => {
			files.set(path, text);
			written.set(path, text);
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
		size: (path) => {
			const hit = files.get(path);
			if (hit === undefined) throw new Error(`ENOENT: ${path}`);
			return Buffer.byteLength(hit, 'utf8');
		}
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
