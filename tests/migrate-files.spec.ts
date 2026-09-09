import { describe, expect, it } from 'vitest';
import { runFilesCommand } from '../src/commands/migrate';
import { FindingError, UsageError } from '../src/errors';
import { memoryFiles } from '../src/host/files';
import {
	decodeLiteral,
	pathOf,
	recoverFiles,
	statementsOf,
	tupleValues
} from '../src/migrate/files';
import { testContext, testGlobals } from './helpers';

/** a chunk row as the worker's export writes it: hex, because uploads carry NUL on nearly every row */
const hex = (bytes: readonly number[]) =>
	`x'${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}'`;

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_TAIL = [0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52];

function dump(rows: string[]): string {
	return [
		'CREATE TABLE cfw_file_chunk (uri TEXT, seq INTEGER, data BLOB);',
		...rows.map((values) => `INSERT INTO cfw_file_chunk (uri, seq, data) VALUES (${values});`)
	].join('\n');
}

describe('the dump reader', () => {
	/** a semicolon inside a literal is not a statement boundary; the converter learned this once */
	it('does not split a statement on a semicolon inside a literal', () => {
		const sql = "INSERT INTO t VALUES ('a;b');\nINSERT INTO t VALUES ('c');";
		expect(statementsOf(sql)).toHaveLength(2);
		expect(statementsOf(sql)[0]).toContain('a;b');
	});

	it('splits a tuple on commas outside its literals', () => {
		expect(tupleValues("'public://a,b.png', 0, x'00'")).toEqual([
			"'public://a,b.png'",
			'0',
			"x'00'"
		]);
	});

	it('decodes hex, a bare 0x literal and a quoted string', () => {
		expect([...decodeLiteral("x'00ff'")]).toEqual([0, 255]);
		expect([...decodeLiteral('0x41')]).toEqual([65]);
		expect(Buffer.from(decodeLiteral("'hello'")).toString()).toBe('hello');
		// the empty hex literal, which the converter records as a real case
		expect([...decodeLiteral("x''")]).toEqual([]);
	});
});

describe('recoverFiles', () => {
	/** the whole point: the bytes leave in the dump and this is what writes them back */
	it('reassembles a chunked file byte for byte', () => {
		const report = recoverFiles(
			dump([
				`'public://images/logo.png', 0, ${hex(PNG_HEAD)}`,
				`'public://images/logo.png', 1, ${hex(PNG_TAIL)}`
			])
		);
		expect(report.files).toHaveLength(1);
		expect([...(report.files[0]?.bytes ?? [])]).toEqual([...PNG_HEAD, ...PNG_TAIL]);
		expect(report.totalBytes).toBe(16);
	});

	it('orders the chunks by sequence rather than by the order they appear', () => {
		const report = recoverFiles(
			dump([
				`'public://a.bin', 1, ${hex([2])}`,
				`'public://a.bin', 0, ${hex([1])}`,
				`'public://a.bin', 2, ${hex([3])}`
			])
		);
		expect([...(report.files[0]?.bytes ?? [])]).toEqual([1, 2, 3]);
	});

	/** a run with a hole is a TRUNCATED dump, and writing it produces a file that opens and is wrong */
	it('refuses a file with a missing chunk rather than writing a hole', () => {
		const report = recoverFiles(
			dump([`'public://a.bin', 0, ${hex([1])}`, `'public://a.bin', 2, ${hex([3])}`])
		);
		expect(report.files).toEqual([]);
		expect(report.incomplete[0]).toMatchObject({ uri: 'public://a.bin', have: 2, expected: 3 });
	});

	it('reads column order off the INSERT rather than assuming it', () => {
		const sql = `INSERT INTO cfw_file_chunk (seq, data, uri) VALUES (0, ${hex([7])}, 'public://x.bin');`;
		const report = recoverFiles(sql);
		expect(report.files[0]).toMatchObject({ uri: 'public://x.bin' });
		expect([...(report.files[0]?.bytes ?? [])]).toEqual([7]);
	});

	it('reads several rows out of one multi-row insert', () => {
		const sql = `INSERT INTO cfw_file_chunk VALUES ('public://a.bin', 0, ${hex([1])}), ('public://a.bin', 1, ${hex([2])});`;
		expect([...(recoverFiles(sql).files[0]?.bytes ?? [])]).toEqual([1, 2]);
	});

	it('ignores every table that is not the chunk store', () => {
		const sql = `INSERT INTO node VALUES (1, 'x');\nINSERT INTO cfw_file VALUES ('public://a.bin', 4);`;
		expect(recoverFiles(sql).files).toEqual([]);
	});
});

describe('pathOf', () => {
	it('puts public and private under their own roots', () => {
		expect(pathOf('public://images/logo.png')).toBe('public/images/logo.png');
		expect(pathOf('private://invoices/1.pdf')).toBe('private/invoices/1.pdf');
	});

	// a uri from a dump is untrusted input, and this one writes outside the tree it was given
	it('refuses a path that climbs out of the files root', () => {
		expect(() => pathOf('public://../../etc/passwd')).toThrow(UsageError);
	});
});

describe('migrate files --from-dump', () => {
	const SQL = '/work/worker.sql';

	it('writes the tree and reports what it wrote', () => {
		const files = memoryFiles({
			[SQL]: dump([
				`'public://images/logo.png', 0, ${hex(PNG_HEAD)}`,
				`'private://invoices/1.pdf', 0, ${hex([0x25, 0x50, 0x44, 0x46])}`
			])
		});
		const ctx = testContext({ files, cwd: '/work' });
		runFilesCommand(ctx, {
			fromDump: SQL,
			out: '/work/files',
			globals: testGlobals({ json: true }, ctx)
		});
		const report = ctx.io.json<{ written: string[]; totalBytes: number }>();
		expect(report.written).toEqual([
			'/work/files/private/invoices/1.pdf',
			'/work/files/public/images/logo.png'
		]);
		expect([...files.readBytes('/work/files/public/images/logo.png')]).toEqual(PNG_HEAD);
		expect(report.totalBytes).toBe(12);
	});

	it('writes nothing without --out, and nothing under --dry-run', () => {
		const files = memoryFiles({ [SQL]: dump([`'public://a.bin', 0, ${hex([1])}`]) });
		const ctx = testContext({ files, cwd: '/work' });
		runFilesCommand(ctx, { fromDump: SQL, globals: testGlobals({ json: true }, ctx) });
		expect(ctx.io.json<{ written: string[] }>().written).toEqual([]);

		const dry = testContext({ files, cwd: '/work' });
		runFilesCommand(dry, {
			fromDump: SQL,
			out: '/work/files',
			globals: testGlobals({ json: true, dryRun: true }, dry)
		});
		expect(files.exists('/work/files/public/a.bin')).toBe(false);
	});

	it('exits 3 on a truncated dump rather than writing a partial tree', () => {
		const files = memoryFiles({
			[SQL]: dump([`'public://a.bin', 1, ${hex([2])}`])
		});
		const ctx = testContext({ files, cwd: '/work' });
		expect(() =>
			runFilesCommand(ctx, {
				fromDump: SQL,
				out: '/work/files',
				globals: testGlobals({}, ctx)
			})
		).toThrow(FindingError);
		expect(ctx.io.text()).toContain('truncated');
	});

	it('refuses a dump that is not there', () => {
		const ctx = testContext({ files: memoryFiles({}), cwd: '/work' });
		expect(() =>
			runFilesCommand(ctx, { fromDump: SQL, globals: testGlobals({}, ctx) })
		).toThrow(UsageError);
	});
});
