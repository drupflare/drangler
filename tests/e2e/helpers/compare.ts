import { DatabaseSync } from 'node:sqlite';
import { compose, composeOrThrow } from './docker';
import { SEED_ROWS, SEED_TABLE, type SeedRow } from './seed';

/**
 * One row as hex, which is the only form both engines render identically.
 *
 * Hex is not decoration. Every value the corpus cares about -- a NUL, a raw newline, a byte that is
 * not valid UTF-8 -- is destroyed or truncated by at least one of the two clients on the way out.
 * `HEX()` and `hex()` turn all of them into ASCII digits, so the comparison is between two strings
 * that cannot themselves be mangled.
 */
export interface HexRow {
	id: string;
	label: string;
	payload: string;
	note: string;
	amount: string;
	ratio: string;
}

const ORDERED_COLUMNS = ['id', 'label', 'payload', 'note', 'amount', 'ratio'] as const;

/** The seed rendered as the hex the comparators must both produce; the third independent reading. */
export function seedAsHex(): HexRow[] {
	return [...SEED_ROWS]
		.map((row: SeedRow) => ({
			id: row.id,
			label: row.label.hex,
			payload: row.payload.hex,
			note: row.note.hex,
			amount: row.amount,
			ratio: row.ratio
		}))
		.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/**
 * Reads the corpus out of MySQL through the mariadb client.
 *
 * Never through `mysqldump`. The dump is what the converter consumes, so reading the source through
 * it would put the mover on both sides of the comparison -- the exact shape of the bug
 * `worker/scripts/pack-sql.ts` records, where source and replay were both read through the same
 * NUL-truncating API and agreed at 117 of 1,697 bytes.
 */
export async function readMysql(database = 'drupal'): Promise<HexRow[]> {
	const select =
		`SELECT CAST(id AS CHAR), HEX(label), HEX(payload), HEX(note), ` +
		`CAST(amount AS CHAR), CAST(ratio AS CHAR) FROM ${SEED_TABLE} ORDER BY id`;
	const out = await composeOrThrow([
		'exec',
		'-T',
		'db',
		'mariadb',
		'-u',
		'root',
		'-prootpass',
		'--batch',
		'--skip-column-names',
		'--raw',
		database,
		'-e',
		select
	]);
	return out
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => {
			const cells = line.split('\t');
			const row: Record<string, string> = {};
			ORDERED_COLUMNS.forEach((name, i) => {
				row[name] = (cells[i] ?? '').trim() === 'NULL' ? '' : (cells[i] ?? '').trim();
			});
			return row as unknown as HexRow;
		})
		.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/**
 * Reads the corpus out of a SQLite file through `hex()`.
 *
 * `node:sqlite` returns a TEXT value as a JS string truncated at the first NUL, so every column is
 * asked for as hex rather than as itself. A reader that took the string would report the NUL rows
 * as passing and would be wrong in exactly the way the corpus is built to expose.
 */
export function readSqliteFile(path: string): HexRow[] {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return readSqliteHandle(db);
	} finally {
		db.close();
	}
}

export function readSqliteHandle(db: DatabaseSync): HexRow[] {
	const rows = db
		.prepare(
			`SELECT CAST(id AS TEXT) AS id, hex(label) AS label, hex(payload) AS payload, ` +
				`hex(note) AS note, CAST(amount AS TEXT) AS amount, CAST(ratio AS TEXT) AS ratio ` +
				`FROM ${SEED_TABLE}`
		)
		.all() as unknown as HexRow[];
	return rows
		.map((r) => ({
			id: String(r.id),
			label: String(r.label ?? ''),
			payload: String(r.payload ?? ''),
			note: String(r.note ?? ''),
			amount: String(r.amount),
			ratio: String(r.ratio)
		}))
		.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/** Reads the corpus out of a live Durable Object through `/rows`, which `/export` does not use. */
export async function readDurableObject(origin: string, site: string): Promise<HexRow[]> {
	const url = new URL('/rows', origin);
	url.searchParams.set('site', site);
	url.searchParams.set('table', SEED_TABLE);
	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`/rows answered ${response.status}`);
	const body = (await response.json()) as { rows: Record<string, string>[] };
	return body.rows
		.map((r) => ({
			id: hexToText(String(r['id'] ?? '')),
			label: String(r['label'] ?? ''),
			payload: String(r['payload'] ?? ''),
			note: String(r['note'] ?? ''),
			amount: hexToText(String(r['amount'] ?? '')),
			ratio: hexToText(String(r['ratio'] ?? ''))
		}))
		.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

const hexToText = (hex: string): string => Buffer.from(hex, 'hex').toString('utf8');

/** Every table's row count in the object, for checking a whole dump rather than a sample of it. */
export async function readTableCounts(
	origin: string,
	site: string
): Promise<Record<string, number>> {
	const url = new URL('/counts', origin);
	url.searchParams.set('site', site);
	const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
	if (!response.ok) throw new Error(`/counts answered ${response.status}`);
	return ((await response.json()) as { counts: Record<string, number> }).counts;
}

/**
 * Counts the INSERTs a converted dump actually contains, per table.
 *
 * Read off the emitted SQL rather than off the converter's own tally, so "what it reported" and
 * "what it wrote" stay two different readings. A counter that trusted `ConvertResult.rows` would
 * agree with itself no matter what landed in the file.
 */
export function countEmittedRows(sql: string): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const line of sql.split('\n')) {
		const table = /^INSERT INTO "((?:[^"]|"")+)"/.exec(line)?.[1];
		if (table === undefined) continue;
		const name = table.replace(/""/g, '"');
		counts[name] = (counts[name] ?? 0) + 1;
	}
	return counts;
}

export interface Difference {
	id: string;
	column: string;
	expected: string;
	actual: string;
}

/**
 * Compares two readings on the columns whose BYTES must survive.
 *
 * `amount` and `ratio` are excluded and compared numerically by the caller: MySQL renders a
 * `DECIMAL(20,4)` as `1.5000` and SQLite's NUMERIC affinity renders the same value `1.5`, which is
 * a real property of the type mapping rather than a migration defect. Folding it in here would
 * either hide a byte difference behind a tolerance or fail every run for a known-good conversion.
 */
export function diffBytes(expected: readonly HexRow[], actual: readonly HexRow[]): Difference[] {
	const out: Difference[] = [];
	const byId = new Map(actual.map((r) => [r.id, r]));
	for (const row of expected) {
		const found = byId.get(row.id);
		if (found === undefined) {
			out.push({ id: row.id, column: '*', expected: 'present', actual: 'missing' });
			continue;
		}
		for (const column of ['label', 'payload', 'note'] as const) {
			if (row[column] !== found[column]) {
				out.push({ id: row.id, column, expected: row[column], actual: found[column] });
			}
		}
	}
	for (const row of actual) {
		if (!expected.some((e) => e.id === row.id)) {
			out.push({ id: row.id, column: '*', expected: 'absent', actual: 'unexpected row' });
		}
	}
	return out;
}

/** A readable failure: which row, which column, and the two hex strings side by side. */
export function describeDifferences(differences: readonly Difference[]): string {
	return differences
		.map(
			(d) =>
				`  id=${d.id} ${d.column}\n    expected ${d.expected || '(empty)'}\n    actual   ${d.actual || '(empty)'}`
		)
		.join('\n');
}

/** Loads SQL into MySQL through the client, so the destination read is not the write path. */
export async function loadMysql(sql: string, database = 'drupal'): Promise<void> {
	const result = await compose(
		['exec', '-T', 'db', 'mariadb', '-u', 'root', '-prootpass', database],
		{ input: sql, timeoutMs: 180_000 }
	);
	if (result.code !== 0) {
		throw new Error(`loading MySQL failed (${result.code}): ${result.stderr.slice(0, 2000)}`);
	}
}
