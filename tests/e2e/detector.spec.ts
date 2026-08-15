import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitStatements } from '../../src/migrate/convert';
import {
	countEmittedRows,
	describeDifferences,
	diffBytes,
	loadMysql,
	readDurableObject,
	readMysql,
	readTableCounts,
	seedAsHex
} from './helpers/compare';
import { composeOrThrow, dockerGate } from './helpers/docker';
import { SEED_TABLE } from './helpers/seed';
import { stackUp } from './helpers/stack';
import { seedWorker, startFixtureWorker, type RunningWorker } from './helpers/worker';

const skip = await dockerGate();

/**
 * Proof that the lane can fail.
 *
 * Every assertion in the other three specs is only worth what its detector is worth, and a detector
 * is untested until something it is supposed to catch is put in front of it. Each case here plants a
 * defect the real path could plausibly have -- a silently skipped table, a value truncated at a NUL,
 * a row count that disagrees with the rows -- and asserts the comparator goes RED.
 *
 * The defects are planted in the DATA, never by patching the converter. A test that reached into the
 * mover to break it would prove the mover can be broken, not that the checker notices.
 */
describe.skipIf(skip)('the detectors detect', () => {
	let worker: RunningWorker;

	const ddl = `CREATE TABLE ${SEED_TABLE} (
		id INTEGER PRIMARY KEY,
		label TEXT NOT NULL,
		payload BLOB,
		note TEXT,
		amount NUMERIC NOT NULL,
		ratio REAL NOT NULL
	);`;

	const insertsFor = (rows = seedAsHex()): string[] =>
		rows.map(
			(row) =>
				`INSERT INTO ${SEED_TABLE} (id, label, payload, note, amount, ratio) VALUES (` +
				`${row.id}, CAST(x'${row.label}' AS TEXT), ${row.payload === '' ? "x''" : `x'${row.payload}'`}, ` +
				`CAST(x'${row.note}' AS TEXT), ${row.amount}, ${row.ratio});`
		);

	beforeAll(async () => {
		await stackUp();
		worker = await startFixtureWorker(8902);
	}, 900_000);

	afterAll(() => worker?.stop());

	it('a clean load is green, so the red cases below mean something', async () => {
		await seedWorker(worker.origin, 'clean', [ddl, ...insertsFor()]);
		const differences = diffBytes(seedAsHex(), await readDurableObject(worker.origin, 'clean'));
		expect(differences, describeDifferences(differences)).toEqual([]);
	});

	/**
	 * The defect this lane exists for: a migration that skips a table and reports success.
	 *
	 * The schema arrives, the rows do not, and every status line is green. Nothing in the mover's own
	 * output distinguishes this from a table that legitimately had no rows.
	 */
	it('catches a table whose rows were silently skipped', async () => {
		await seedWorker(worker.origin, 'skipped-table', [ddl]);
		const actual = await readDurableObject(worker.origin, 'skipped-table');
		expect(actual).toHaveLength(0);

		const differences = diffBytes(seedAsHex(), actual);
		expect(differences).toHaveLength(seedAsHex().length);
		expect(differences.every((d) => d.actual === 'missing')).toBe(true);
	});

	/** The same defect one row at a time, which a spot check on the first row would miss. */
	it('catches a single dropped row in the middle of a table', async () => {
		const rows = seedAsHex();
		const kept = rows.filter((r) => r.id !== '2');
		await seedWorker(worker.origin, 'dropped-row', [ddl, ...insertsFor(kept)]);

		const differences = diffBytes(rows, await readDurableObject(worker.origin, 'dropped-row'));
		expect(differences).toEqual([
			{ id: '2', column: '*', expected: 'present', actual: 'missing' }
		]);
	});

	/**
	 * The `pack-sql.ts` failure, reproduced.
	 *
	 * A TEXT value read as a JS string stops at the first NUL, so `a\0b` becomes `a`. The comparator
	 * must see that, and it can only see it because it reads `hex()` on both sides rather than the
	 * column. A checker that took the string would compare `a` against `a` and agree.
	 */
	it('catches a value truncated at its first NUL', async () => {
		const rows = seedAsHex();
		const truncated = rows.map((r) => (r.id === '2' ? { ...r, note: r.note.slice(0, 2) } : r));
		await seedWorker(worker.origin, 'nul-truncated', [ddl, ...insertsFor(truncated)]);

		const differences = diffBytes(
			rows,
			await readDurableObject(worker.origin, 'nul-truncated')
		);
		expect(differences).toEqual([
			{ id: '2', column: 'note', expected: '610062', actual: '61' }
		]);
		// and the shape of the bug is exactly "the prefix before the NUL survived"
		expect(differences[0]?.expected.startsWith(differences[0]?.actual ?? '')).toBe(true);
	});

	/** A blob whose trailing bytes were lost; hex is what makes this visible at all. */
	it('catches a blob that lost its trailing bytes', async () => {
		const rows = seedAsHex();
		const clipped = rows.map((r) =>
			r.id === '1' ? { ...r, payload: r.payload.slice(0, 4) } : r
		);
		await seedWorker(worker.origin, 'clipped-blob', [ddl, ...insertsFor(clipped)]);

		const differences = diffBytes(rows, await readDurableObject(worker.origin, 'clipped-blob'));
		expect(differences.map((d) => d.column)).toEqual(['payload']);
	});

	/** An extra row nobody asked for, which a one-directional comparison would not report. */
	it('catches a row the source never had', async () => {
		const extra = `INSERT INTO ${SEED_TABLE} (id, label, payload, note, amount, ratio) VALUES (77, 'ghost', x'00', '', 0, 0);`;
		await seedWorker(worker.origin, 'extra-row', [ddl, ...insertsFor(), extra]);

		const differences = diffBytes(
			seedAsHex(),
			await readDurableObject(worker.origin, 'extra-row')
		);
		expect(differences).toEqual([
			{ id: '77', column: '*', expected: 'absent', actual: 'unexpected row' }
		]);
	});

	/**
	 * The reported-versus-actual check, planted at the report rather than at the data.
	 *
	 * A mover that emitted five INSERTs and loaded four is the same defect seen from the other side.
	 */
	it('catches a row count that disagrees with the rows', async () => {
		const statements = insertsFor();
		const claimed = countEmittedRows(
			statements
				.map((s) => s.replace(`INSERT INTO ${SEED_TABLE}`, `INSERT INTO "${SEED_TABLE}"`))
				.join('\n')
		);
		await seedWorker(worker.origin, 'miscounted', [ddl, ...statements.slice(0, -1)]);

		const actual = await readTableCounts(worker.origin, 'miscounted');
		expect(claimed[SEED_TABLE]).toBe(5);
		expect(actual[SEED_TABLE]).toBe(4);
		expect(actual[SEED_TABLE]).not.toBe(claimed[SEED_TABLE]);
	});

	/**
	 * A lossy conversion on the MySQL side: the emoji mangled by a latin1 connection.
	 *
	 * This is the failure that `SET NAMES utf8mb4` fixes, and it is planted by removing that line
	 * from a dump that is otherwise correct. Without the comparator reading `HEX()`, a mangled
	 * multi-byte character comes back as a plausible-looking string.
	 */
	it('catches a multi-byte value mangled by the wrong connection charset', async () => {
		await composeOrThrow([
			'exec',
			'-T',
			'db',
			'mariadb',
			'-u',
			'root',
			'-prootpass',
			'-e',
			'DROP DATABASE IF EXISTS planted; CREATE DATABASE planted'
		]);
		const mysqlDdl = `CREATE TABLE ${SEED_TABLE} (
			id BIGINT NOT NULL PRIMARY KEY,
			label LONGTEXT NOT NULL,
			payload LONGBLOB,
			note LONGTEXT,
			amount DECIMAL(30,10) NOT NULL,
			ratio DOUBLE NOT NULL
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
		const rows = seedAsHex();
		const inserts = rows.map(
			(r) =>
				`INSERT INTO ${SEED_TABLE} (id, label, payload, note, amount, ratio) VALUES (` +
				`${r.id}, 0x${r.label}, ${r.payload === '' ? "''" : `0x${r.payload}`}, ` +
				// the plant: the emoji row's note goes in as a latin1-mangled byte string
				`${r.id === '9007199254740993' ? "'emoji and a final sigma: ??'" : r.note === '' ? "''" : `0x${r.note}`}, ` +
				`${r.amount}, ${r.ratio});`
		);
		await loadMysql(['SET NAMES utf8mb4;', mysqlDdl, ...inserts].join('\n'), 'planted');

		const differences = diffBytes(rows, await readMysql('planted'));
		expect(differences.map((d) => ({ id: d.id, column: d.column }))).toEqual([
			{ id: '9007199254740993', column: 'note' }
		]);
	});

	it('the splitter used to feed the object is not the one being checked', () => {
		// a statement whose text contains both a semicolon and a newline inside a value
		const tricky = `INSERT INTO "t" VALUES ('a;b\nc');`;
		expect(splitStatements(tricky, false)).toHaveLength(1);
	});
});
