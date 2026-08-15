import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runConvertCommand } from '../../src/commands/migrate';
import { defaultContext } from '../../src/context';
import { bufferIo } from '../../src/io';
import { convertDump, splitStatements } from '../../src/migrate/convert';
import {
	countEmittedRows,
	describeDifferences,
	diffBytes,
	loadMysql,
	readDurableObject,
	readMysql,
	readSqliteFile,
	readTableCounts,
	seedAsHex
} from './helpers/compare';
import { composeOrThrow, dockerGate } from './helpers/docker';
import { SEED_SCHEMA, SEED_TABLE, seedCoverage, seedInserts } from './helpers/seed';
import { stackUp } from './helpers/stack';
import { seedWorker, startFixtureWorker, type RunningWorker } from './helpers/worker';

const skip = await dockerGate();

describe.skipIf(skip)('VPS to Worker', () => {
	let scratch: string;
	let worker: RunningWorker;
	let dumpPath: string;
	let convertedPath: string;

	beforeAll(async () => {
		scratch = mkdtempSync(join(tmpdir(), 'drangler-e2e-tw-'));
		dumpPath = join(scratch, 'source.sql');
		convertedPath = join(scratch, 'converted.sql');

		await stackUp();
		// the corpus lands beside a real Drupal schema, not in a database of its own
		await loadMysql(
			`DROP TABLE IF EXISTS ${SEED_TABLE};\n${SEED_SCHEMA}\n${seedInserts().join('\n')}`
		);

		// mysqldump is the mover's input. the comparator never reads it
		const dump = await composeOrThrow(
			[
				'exec',
				'-T',
				'db',
				'mariadb-dump',
				'-u',
				'root',
				'-prootpass',
				'--single-transaction',
				'--hex-blob',
				'drupal'
			],
			{ timeoutMs: 300_000 }
		);
		writeFileSync(dumpPath, dump, 'utf8');

		worker = await startFixtureWorker();
	}, 900_000);

	afterAll(() => {
		worker?.stop();
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	it('dumped a real Drupal database, not just the corpus', () => {
		const dump = readFileSync(dumpPath, 'utf8');
		expect(dump.length).toBeGreaterThan(100_000);
		// a standard profile install; if these are gone the dump is not of a real site
		for (const table of ['node_field_data', 'users_field_data', 'config', 'key_value']) {
			expect(dump).toContain(`CREATE TABLE \`${table}\``);
		}
		expect(dump).toContain(`CREATE TABLE \`${SEED_TABLE}\``);
	});

	it('the source database holds exactly the bytes the seed declares', async () => {
		const differences = diffBytes(seedAsHex(), await readMysql());
		expect(differences, describeDifferences(differences)).toEqual([]);
	});

	it('converts the whole dump without refusing a statement', async () => {
		const io = bufferIo();
		const ctx = { ...defaultContext(), io };
		// a real Drupal has rows a Durable Object refuses outright; --skip-unsupported drops those
		// rows and keeps their schema, and the report below names every one
		await expect(
			runConvertCommand(ctx, {
				in: dumpPath,
				out: convertedPath,
				from: 'mysql',
				to: 'sqlite',
				skipUnsupported: true
			})
		).rejects.toThrow(/statement\(s\) were not converted/);
		const report = io.text();
		expect(report).toContain('rows too wide for the target');
		expect(report).toContain('cache_container');

		const result = convertDump(readFileSync(dumpPath, 'utf8'), {
			from: 'mysql',
			to: 'sqlite',
			skipUnsupported: true
		});
		// a standard-profile Drupal 11 install is 47 tables here; the floor is deliberately under it
		expect(result.tables.length).toBeGreaterThan(40);
		expect(result.tables).toContain(SEED_TABLE);
	});

	it('the converted dump replays into a plain SQLite with the bytes intact', () => {
		const dbPath = join(scratch, 'replay.db');
		const db = new DatabaseSync(dbPath);
		try {
			db.exec(readFileSync(convertedPath, 'utf8'));
		} finally {
			db.close();
		}
		const differences = diffBytes(seedAsHex(), readSqliteFile(dbPath));
		expect(differences, describeDifferences(differences)).toEqual([]);
	});

	it('the converted dump loads into a real Durable Object with the bytes intact', async () => {
		const statements = splitStatements(readFileSync(convertedPath, 'utf8'), false);
		const applied = await seedWorker(worker.origin, 'to-worker', statements);
		expect(applied).toBe(statements.length);
		expect(applied).toBeGreaterThan(100);

		const actual = await readDurableObject(worker.origin, 'to-worker');
		const differences = diffBytes(seedAsHex(), actual);
		expect(differences, describeDifferences(differences)).toEqual([]);
	});

	it('what the migration REPORTED matches what actually moved', async () => {
		const reported = convertDump(readFileSync(dumpPath, 'utf8'), {
			from: 'mysql',
			to: 'sqlite',
			skipUnsupported: true
		});
		const inDo = await readDurableObject(worker.origin, 'to-worker');
		const corpusRows = reported.sql
			.split('\n')
			.filter((line) => line.startsWith(`INSERT INTO "${SEED_TABLE}"`)).length;
		expect(corpusRows).toBe(seedAsHex().length);
		expect(inDo).toHaveLength(corpusRows);

		// the report is checked against the destination rather than believed. For every table, the
		// number of INSERTs the converter says it emitted must equal the number of rows the object
		// actually holds -- a mover that silently dropped a table would still report success here
		// if the two were not compared
		expect(reported.overLimit.map((o) => o.table)).toContain('cache_container');
		const emitted = countEmittedRows(reported.sql);
		const actual = await readTableCounts(worker.origin, 'to-worker');
		for (const table of reported.tables) {
			expect(actual[table], `${table}: reported vs actual`).toBe(emitted[table] ?? 0);
		}
	});

	it('the object serves, and reports the header contract version', async () => {
		const url = new URL('/serve', worker.origin);
		url.searchParams.set('site', 'to-worker');
		url.searchParams.set('path', '/');
		const response = await fetch(url);
		expect(response.status).toBe(200);
		expect(response.headers.get('x-cfw-v')).toBe('1');
		expect(response.headers.get('x-cfw-cache')).toBe('HIT');
	});

	it('names what the corpus covered, so a gap is visible rather than assumed', () => {
		const coverage = seedCoverage();
		expect(coverage.length).toBe(15);
		const reasons = coverage.map((c) => c.why).join(' ');
		for (const property of ['NUL', 'newline', 'backslash', 'utf8mb4', 'double cannot hold']) {
			expect(reasons).toContain(property);
		}
	});
});
