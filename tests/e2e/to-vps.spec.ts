import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runConvertCommand, runExportCommand } from '../../src/commands/migrate';
import { defaultContext } from '../../src/context';
import { bufferIo } from '../../src/io';
import { splitStatements } from '../../src/migrate/convert';
import {
	describeDifferences,
	diffBytes,
	loadMysql,
	readDurableObject,
	readMysql,
	seedAsHex
} from './helpers/compare';
import { composeOrThrow, dockerGate } from './helpers/docker';
import { SEED_TABLE } from './helpers/seed';
import { stackUp } from './helpers/stack';
import { ownerToken, seedWorker, startFixtureWorker, type RunningWorker } from './helpers/worker';

const skip = await dockerGate();

const SITE = 'to-vps';

/**
 * The off-boarding direction: a Durable Object out to a MySQL host.
 *
 * The object is seeded directly from the typed corpus rather than from the other direction's
 * output, so a failure here is this path's failure. Chaining the two would make every to-vps result
 * contingent on a to-worker bug.
 */
describe.skipIf(skip)('Worker to VPS', () => {
	let scratch: string;
	let worker: RunningWorker;
	let exportedPath: string;
	let convertedPath: string;

	beforeAll(async () => {
		scratch = mkdtempSync(join(tmpdir(), 'drangler-e2e-tv-'));
		exportedPath = join(scratch, 'worker.sql');
		convertedPath = join(scratch, 'vps.sql');

		await stackUp();
		worker = await startFixtureWorker(8901);

		// the corpus goes in as SQLite DDL plus hex literals; no converter involved on the way in
		const schema = `CREATE TABLE ${SEED_TABLE} (
			id INTEGER PRIMARY KEY,
			label TEXT NOT NULL,
			payload BLOB,
			note TEXT,
			amount NUMERIC NOT NULL,
			ratio REAL NOT NULL
		);`;
		const inserts = seedAsHex().map(
			(row) =>
				`INSERT INTO ${SEED_TABLE} (id, label, payload, note, amount, ratio) VALUES (` +
				`${row.id}, CAST(x'${row.label}' AS TEXT), ${row.payload === '' ? "x''" : `x'${row.payload}'`}, ` +
				`CAST(x'${row.note}' AS TEXT), ${row.amount}, ${row.ratio});`
		);
		// a cache bin too, so the export has something to report as structure-only
		const cache = [
			'CREATE TABLE cache_data (cid TEXT PRIMARY KEY, data BLOB);',
			"INSERT INTO cache_data (cid, data) VALUES ('a', x'00ff');"
		];
		await seedWorker(worker.origin, SITE, [schema, ...inserts, ...cache]);
	}, 900_000);

	afterAll(() => {
		worker?.stop();
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	it('the object holds exactly the bytes the seed declares', async () => {
		const differences = diffBytes(seedAsHex(), await readDurableObject(worker.origin, SITE));
		expect(differences, describeDifferences(differences)).toEqual([]);
	});

	it('refuses to export without the site owner token, and says which token', async () => {
		const io = bufferIo();
		const ctx = { ...defaultContext(), io, env: {} };
		await expect(
			runExportCommand(ctx, { url: worker.origin, site: SITE, out: exportedPath })
		).rejects.toThrow(/owner token.*firstrun.*ownerToken/s);
	});

	it('refuses a token minted for a different site', async () => {
		const io = bufferIo();
		const ctx = { ...defaultContext(), io, env: {} };
		const wrong = await ownerToken(worker.origin, 'some-other-site');
		await expect(
			runExportCommand(ctx, { url: worker.origin, site: SITE, token: wrong })
		).rejects.toThrow(/per SITE/);
	});

	it('exports through the real HTTP route and reports the envelope', async () => {
		const io = bufferIo();
		const ctx = { ...defaultContext(), io };
		const token = await ownerToken(worker.origin, SITE);
		await runExportCommand(ctx, { url: worker.origin, site: SITE, out: exportedPath, token });

		const report = io.text();
		expect(report).toContain('structure only (1)');
		expect(report).toContain('cache_data');
		expect(report).toMatch(/replayable\s+yes/);
		// read off the envelope, never restated by drangler
		expect(report).not.toContain('watchdog');

		const sql = readFileSync(exportedPath, 'utf8');
		expect(sql).toContain(`CREATE TABLE ${SEED_TABLE}`);
		expect(sql).toContain('CREATE TABLE cache_data');
		// structure only means the schema is there and the row is not
		expect(sql).not.toContain("'a'");
	});

	it('converts the export to MySQL and loads it into the real database', async () => {
		const io = bufferIo();
		const ctx = { ...defaultContext(), io };
		await runConvertCommand(ctx, {
			in: exportedPath,
			out: convertedPath,
			from: 'sqlite',
			to: 'mysql'
		});
		expect(io.text()).toContain('lossy');

		// a database of its own: the point is the corpus surviving, not overwriting the Drupal site
		await composeOrThrow([
			'exec',
			'-T',
			'db',
			'mariadb',
			'-u',
			'root',
			'-prootpass',
			'-e',
			'DROP DATABASE IF EXISTS restored; CREATE DATABASE restored'
		]);
		await loadMysql(readFileSync(convertedPath, 'utf8'), 'restored');
	});

	it('the restored MySQL holds exactly the bytes the seed declares', async () => {
		const differences = diffBytes(seedAsHex(), await readMysql('restored'));
		expect(differences, describeDifferences(differences)).toEqual([]);
	});

	it('what the export REPORTED matches what came out of it', async () => {
		const response = await fetch(`${worker.origin}/export?body=1&site=${SITE}`, {
			headers: { authorization: `Bearer ${await ownerToken(worker.origin, SITE)}` }
		});
		const body = (await response.json()) as {
			statements: number;
			tables: Record<string, number>;
			structureOnly: string[];
			sql: string;
		};
		// the envelope's statement count against the statements actually in the body
		expect(splitStatements(body.sql, false)).toHaveLength(body.statements);
		// the envelope's per-table row counts against the INSERTs actually emitted
		const emitted: Record<string, number> = {};
		for (const line of body.sql.split('\n')) {
			const table = /^INSERT INTO "([^"]+)"/.exec(line)?.[1];
			if (table !== undefined) emitted[table] = (emitted[table] ?? 0) + 1;
		}
		for (const [table, count] of Object.entries(body.tables)) {
			expect(emitted[table] ?? 0, `${table}: reported vs emitted`).toBe(count);
		}
		for (const table of body.structureOnly) {
			expect(emitted[table] ?? 0, `${table} was reported structure-only`).toBe(0);
		}
	});
});
