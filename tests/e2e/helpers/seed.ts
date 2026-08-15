/**
 * The seed corpus, declared as BYTES rather than as SQL.
 *
 * Every value is written down here as hex and inserted with a `0x...` literal, so the seed path
 * shares no escaping code with the converter under test. A seed written as `'it\'s'` would be
 * asserting that MySQL and drangler agree about backslashes by using one of them to state the
 * expectation, which is the shared-instrument mistake in miniature.
 *
 * The expectations are therefore literal: `hex` is what MySQL's `HEX()` must return, what SQLite's
 * `hex()` must return after the migration, and what this file says the value is. Three readings,
 * one number.
 */

/** one seeded value: the bytes, and why it is in the corpus */
export interface SeedValue {
	/** uppercase hex of the exact bytes, which is what both engines' HEX()/hex() return */
	hex: string;
	/** the failure this value exists to catch */
	why: string;
}

const utf8 = (text: string): string => Buffer.from(text, 'utf8').toString('hex').toUpperCase();

const bytes = (...values: number[]): string => Buffer.from(values).toString('hex').toUpperCase();

export interface SeedRow {
	/** BIGINT, and three of them are outside what a double can hold exactly */
	id: string;
	label: SeedValue;
	payload: SeedValue;
	note: SeedValue;
	/** DECIMAL(20,4), as the exact decimal text both engines must render */
	amount: string;
	/** DOUBLE */
	ratio: string;
}

/**
 * The rows.
 *
 * `id` is a decimal string, never a JS number: `9007199254740993` is 2^53+1 and a double rounds it
 * to 2^53, so a test that held it as a number would compare two values that had already collided.
 */
export const SEED_ROWS: readonly SeedRow[] = [
	{
		id: '1',
		label: {
			hex: utf8("it's; a quote and a semicolon"),
			why: 'quote escaping and the statement splitter'
		},
		payload: {
			hex: bytes(0x00, 0x0a, 0x00, 0xff, 0x1a, 0x0d),
			why: 'NUL, raw newline, 0x1A and a high byte in a blob'
		},
		note: { hex: utf8('plain'), why: 'the control case' },
		amount: '1.5000',
		ratio: '0.5'
	},
	{
		id: '2',
		label: {
			hex: utf8('C:\\path\\to\\file'),
			why: 'MySQL reads a backslash as an escape and SQLite does not'
		},
		payload: {
			hex: bytes(0xde, 0xad, 0xbe, 0xef),
			why: 'a blob that is not valid UTF-8 at all'
		},
		note: {
			hex: bytes(0x61, 0x00, 0x62),
			why: 'a NUL inside TEXT, which ends a SQLite string literal'
		},
		amount: '-2.2500',
		ratio: '-1.25'
	},
	{
		id: '9007199254740993',
		label: {
			hex: utf8('2^53 + 1'),
			why: 'an integer a double cannot hold; the id itself is the assertion'
		},
		payload: { hex: bytes(0x00), why: 'a blob that is one NUL and nothing else' },
		note: {
			hex: utf8('emoji and a final sigma: \u{1F418}\u03C2'),
			why: '4-byte utf8mb4 and a Greek final sigma'
		},
		amount: '0.0001',
		ratio: '3'
	},
	{
		id: '9223372036854775807',
		label: { hex: utf8('BIGINT max'), why: 'the widest integer MySQL will store' },
		payload: { hex: '', why: 'a zero-length blob, which is not NULL' },
		note: { hex: utf8(''), why: 'an empty string, which is not NULL either' },
		amount: '99999999999999.9999',
		ratio: '0'
	},
	{
		id: '-9007199254740993',
		label: {
			hex: utf8('negative beyond 2^53'),
			why: 'the same rounding, on the other side of zero'
		},
		payload: {
			hex: bytes(0x0a, 0x0a, 0x0a),
			why: 'nothing but newlines, which a line-oriented parser would eat'
		},
		note: {
			hex: utf8('-- not a comment\n# nor this'),
			why: 'text that looks like SQL comments to a naive splitter'
		},
		amount: '0.0000',
		ratio: '-0'
	}
];

/** the table the corpus lives in; a real Drupal database surrounds it */
export const SEED_TABLE = 'drangler_e2e';

export const SEED_SCHEMA = `CREATE TABLE ${SEED_TABLE} (
	id BIGINT NOT NULL,
	label VARCHAR(255) NOT NULL,
	payload LONGBLOB NULL,
	note LONGTEXT NULL,
	amount DECIMAL(20,4) NOT NULL,
	ratio DOUBLE NOT NULL,
	PRIMARY KEY (id),
	KEY label_idx (label(64))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;

/** `0x` for a non-empty blob; MySQL rejects a bare `0x`, so an empty one is the empty string */
const blobLiteral = (hex: string): string => (hex === '' ? "''" : `0x${hex}`);

/**
 * The INSERT statements, built only from hex literals and decimal text.
 *
 * No value here passes through a quoting function, which is what keeps the seed independent of the
 * code that will later have to quote these same bytes correctly.
 */
export function seedInserts(): string[] {
	return SEED_ROWS.map(
		(row) =>
			`INSERT INTO ${SEED_TABLE} (id, label, payload, note, amount, ratio) VALUES (` +
			`${row.id}, ${blobLiteral(row.label.hex)}, ${blobLiteral(row.payload.hex)}, ` +
			`${blobLiteral(row.note.hex)}, ${row.amount}, ${row.ratio});`
	);
}

/** every value in the corpus, flattened, for a report that names what a run covered */
export function seedCoverage(): { row: string; column: string; why: string }[] {
	const out: { row: string; column: string; why: string }[] = [];
	for (const row of SEED_ROWS) {
		for (const column of ['label', 'payload', 'note'] as const) {
			out.push({ row: row.id, column, why: row[column].why });
		}
	}
	return out;
}
