import { UsageError } from '../errors';
import type { FileHost } from '../host/files';

/**
 * Turning `cfw_file_chunk` rows back into a `sites/default/files/` tree.
 *
 * The bytes DO leave in the dump: `worker/src/db/file-store.ts` keeps `public://` and `private://`
 * in `cfw_file` and `cfw_file_chunk`, and neither table is in the worker's `REGENERABLE_TABLES`, so
 * both are dumped with rows. What did not exist is anything that writes them back, which is why
 * `export-files` is a blocker until this has run.
 *
 * Pure parsing plus one `writeBytes` per file, so it needs no network and the whole of it is covered
 * against a memory filesystem.
 */

/** one file, reassembled from its chunks in sequence order */
export interface RecoveredFile {
	/** the stream URI as the site stored it, such as `public://inline-images/a.png` */
	uri: string;
	bytes: Uint8Array;
	/** where it lands under the files root */
	path: string;
}

export interface RecoverReport {
	files: RecoveredFile[];
	/** a uri whose chunks do not form a run from 0, which is a truncated dump rather than a file */
	incomplete: { uri: string; have: number; expected: number }[];
	totalBytes: number;
}

const INSERT = /INSERT\s+INTO\s+["`']?(cfw_file|cfw_file_chunk)["`']?\s*(\([^)]*\))?\s*VALUES\s*/i;

/**
 * Splits a dump into statements without breaking on a semicolon inside a literal.
 *
 * The converter already learned this: a semicolon inside serialized PHP is not a statement boundary,
 * and a splitter that used one dropped rows in a way nothing noticed until the far end.
 */
export function statementsOf(sql: string): string[] {
	const out: string[] = [];
	let current = '';
	let quote: string | null = null;
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i] as string;
		current += ch;
		if (quote !== null) {
			if (ch === '\\') {
				current += sql[i + 1] ?? '';
				i++;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === ';') {
			out.push(current.trim());
			current = '';
		}
	}
	if (current.trim() !== '') out.push(current.trim());
	return out.filter((s) => s !== '');
}

/** the values of one `VALUES (...)` tuple, as raw literal text */
export function tupleValues(tuple: string): string[] {
	const out: string[] = [];
	let current = '';
	let quote: string | null = null;
	let depth = 0;
	for (let i = 0; i < tuple.length; i++) {
		const ch = tuple[i] as string;
		if (quote !== null) {
			if (ch === '\\') {
				current += ch + (tuple[i + 1] ?? '');
				i++;
				continue;
			}
			if (ch === quote) quote = null;
			current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			out.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim() !== '') out.push(current.trim());
	return out;
}

/**
 * Decodes one SQL literal into bytes.
 *
 * The worker's export writes a value carrying NUL as `CAST(x'..' AS TEXT)` into SQLite and as a bare
 * hex literal into MySQL, and a chunk of a PNG carries NUL on nearly every row -- so hex is the
 * common case here rather than the exception.
 */
export function decodeLiteral(literal: string): Uint8Array {
	const raw = literal.trim();
	const hex = /^(?:CAST\s*\(\s*)?[xX]'([0-9a-fA-F]*)'|^0[xX]([0-9a-fA-F]+)$/.exec(raw);
	if (hex !== null) {
		const digits = hex[1] ?? hex[2] ?? '';
		const out = new Uint8Array(Math.floor(digits.length / 2));
		for (let i = 0; i < out.length; i++) {
			out[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
		}
		return out;
	}
	if (raw.startsWith("'") && raw.endsWith("'")) {
		const inner = raw
			.slice(1, -1)
			.replace(/''/g, "'")
			.replace(/\\n/g, '\n')
			.replace(/\\r/g, '\r')
			.replace(/\\t/g, '\t')
			.replace(/\\'/g, "'")
			.replace(/\\\\/g, '\\');
		return new Uint8Array(Buffer.from(inner, 'utf8'));
	}
	return new Uint8Array(Buffer.from(raw, 'utf8'));
}

interface Chunk {
	uri: string;
	seq: number;
	bytes: Uint8Array;
}

/**
 * Reads every `cfw_file_chunk` row out of a dump and reassembles the files.
 *
 * Column order is read from the INSERT's own column list when it has one, because a dump written by
 * a different tool may order them differently and positional parsing that guessed would silently
 * write the sequence number into the file.
 */
export function recoverFiles(sql: string): RecoverReport {
	const chunks = new Map<string, Chunk[]>();
	for (const statement of statementsOf(sql)) {
		const match = INSERT.exec(statement);
		if (match === null || match[1] !== 'cfw_file_chunk') continue;
		const columns = readColumns(match[2]);
		for (const tuple of tuplesOf(statement.slice(match.index + match[0].length))) {
			const values = tupleValues(tuple);
			const uri = text(pick(values, columns, 'uri', 0));
			const seq = Number(strip(pick(values, columns, 'seq', 1)));
			const bytes = decodeLiteral(pick(values, columns, 'data', 2));
			if (uri === '' || !Number.isFinite(seq)) continue;
			chunks.set(uri, [...(chunks.get(uri) ?? []), { uri, seq, bytes }]);
		}
	}

	const files: RecoveredFile[] = [];
	const incomplete: RecoverReport['incomplete'] = [];
	let totalBytes = 0;
	for (const [uri, parts] of [...chunks].sort(([a], [b]) => (a < b ? -1 : 1))) {
		parts.sort((a, b) => a.seq - b.seq);
		// a run that does not start at 0 or skips a sequence number is a TRUNCATED dump rather than
		// a file, and writing it would produce something that opens and is wrong
		const expected = (parts.at(-1)?.seq ?? -1) + 1;
		if (parts.length !== expected || parts.some((p, i) => p.seq !== i)) {
			incomplete.push({ uri, have: parts.length, expected });
			continue;
		}
		const size = parts.reduce((n, p) => n + p.bytes.length, 0);
		const bytes = new Uint8Array(size);
		let at = 0;
		for (const part of parts) {
			bytes.set(part.bytes, at);
			at += part.bytes.length;
		}
		files.push({ uri, bytes, path: pathOf(uri) });
		totalBytes += size;
	}
	return { files, incomplete, totalBytes };
}

/** `public://a/b.png` under `sites/default/files`, `private://` under its own root */
export function pathOf(uri: string): string {
	const match = /^([a-z0-9_]+):\/\/(.*)$/i.exec(uri);
	if (match === null) return uri.replace(/^\/+/, '');
	const rest = (match[2] as string).replace(/^\/+/, '');
	if (rest.includes('..')) {
		throw new UsageError(`refusing a path that climbs out of the files root: ${uri}`);
	}
	return match[1] === 'private' ? `private/${rest}` : `public/${rest}`;
}

function readColumns(list: string | undefined): string[] | null {
	if (list === undefined) return null;
	return list
		.replace(/^\(|\)$/g, '')
		.split(',')
		.map((c) =>
			c
				.trim()
				.replace(/^["`']|["`']$/g, '')
				.toLowerCase()
		);
}

function pick(values: string[], columns: string[] | null, name: string, fallback: number): string {
	const at = columns === null ? fallback : columns.indexOf(name);
	return values[at === -1 ? fallback : at] ?? '';
}

function strip(literal: string): string {
	return literal.trim().replace(/^'|'$/g, '');
}

function text(literal: string): string {
	return Buffer.from(decodeLiteral(literal)).toString('utf8');
}

/** every `(...)` tuple in a VALUES list, so a multi-row insert is read as several rows */
function tuplesOf(values: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = '';
	let quote: string | null = null;
	for (let i = 0; i < values.length; i++) {
		const ch = values[i] as string;
		if (quote !== null) {
			current += ch;
			if (ch === '\\') {
				current += values[i + 1] ?? '';
				i++;
			} else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === '(') {
			depth++;
			if (depth === 1) continue;
		}
		if (ch === ')') {
			depth--;
			if (depth === 0) {
				out.push(current);
				current = '';
				continue;
			}
		}
		if (depth > 0) current += ch;
	}
	return out;
}

/** writes every recovered file under `root`, and reports what it wrote */
export function writeRecovered(
	files: FileHost,
	root: string,
	report: RecoverReport
): { written: string[]; bytes: number } {
	const written: string[] = [];
	for (const file of report.files) {
		const path = `${root.replace(/\/+$/, '')}/${file.path}`;
		files.writeBytes(path, file.bytes);
		written.push(path);
	}
	return { written, bytes: report.totalBytes };
}
