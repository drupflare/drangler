import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SQLITE_MAGIC = 'SQLite format 3\u0000';

export interface EmptiedBins {
	bytes: Uint8Array;
	tables: number;
	rows: number;
}

/**
 * The same database with every `cache_*` table emptied, or null when the bytes are not SQLite.
 *
 * A source site's bins are wrong on the worker, and one of them is fatal: `cache_container` holds
 * a service container compiled against the source's absolute docroot, so the first real render
 * boots a graph full of paths that do not exist. Drupal rebuilds every bin on demand; the schema
 * stays so nothing has to recreate a table.
 */
export function emptyCacheBins(bytes: Uint8Array): EmptiedBins | null {
	if (Buffer.from(bytes.subarray(0, 16)).toString('latin1') !== SQLITE_MAGIC) return null;
	const dir = mkdtempSync(join(tmpdir(), 'drangler-bins-'));
	const path = join(dir, 'site.sqlite');
	try {
		writeFileSync(path, bytes);
		portCollation(path);
		const db = new DatabaseSync(path);
		let tables = 0;
		let rows = 0;
		try {
			const bins = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cache\\_%' ESCAPE '\\'"
				)
				.all() as { name: string }[];
			for (const { name } of bins) {
				const quoted = `"${name.replace(/"/g, '""')}"`;
				rows += Number(
					(db.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get() as { n: number }).n
				);
				db.exec(`DELETE FROM ${quoted}`);
				tables++;
			}
			db.exec('VACUUM');
		} finally {
			db.close();
		}
		return { bytes: new Uint8Array(readFileSync(path)), tables, rows };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Renames Drupal's `NOCASE_UTF8` collation to SQLite's `NOCASE` in the file's schema.
 *
 * Drupal's sqlite driver registers that collation when it connects, so a database it built names a
 * collation nothing else has, and `VACUUM` (or any write through an index on such a column) fails
 * with "no such collation sequence". The worker's packer makes the same rewrite, because `NOCASE` is
 * what the host accepts; `REINDEX` rebuilds each index under it.
 */
export function portCollation(path: string): number {
	const db = new DatabaseSync(path);
	try {
		// node 24.19 turns SQLITE_DBCONFIG_DEFENSIVE on by default, which refuses a sqlite_master write
		(db as { enableDefensive?: (on: boolean) => void }).enableDefensive?.(false);
		const named = Number(
			(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM sqlite_master WHERE sql LIKE '%NOCASE_UTF8%'"
					)
					.get() as { n: number }
			).n
		);
		if (named === 0) return 0;
		const version = Number(
			(db.prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version
		);
		db.exec('PRAGMA writable_schema=ON');
		db.exec(
			"UPDATE sqlite_master SET sql = replace(sql, 'NOCASE_UTF8', 'NOCASE') WHERE sql LIKE '%NOCASE_UTF8%'"
		);
		// the schema cookie has to move, or sqlite keeps its cached parse of the old text
		db.exec(`PRAGMA schema_version=${version + 1}`);
		db.exec('PRAGMA writable_schema=OFF');
		db.close();
		const reopened = new DatabaseSync(path);
		try {
			reopened.exec('REINDEX');
		} finally {
			reopened.close();
		}
		return named;
	} finally {
		if (db.isOpen) db.close();
	}
}

/**
 * Removes the `!/prefill.json` line from a workspace's asset list.
 *
 * The prefill is pages rendered from the site the pack shipped with, and the worker seeds its page
 * store from it. Over a migrated database it would answer the old site's pages as cache hits. An
 * unpublished prefill is a supported state: the site starts cold.
 */
export function unpublishPrefill(ignore: string): string {
	return ignore
		.split('\n')
		.filter((line) => line.trim() !== '!/prefill.json')
		.join('\n');
}

/**
 * The same database carrying code trees as `cfw_module_file` rows, or null when it is not SQLite.
 *
 * A migrated site whose install profile or modules are not in the pack cannot boot until their code
 * is there, and it cannot be claimed without booting, so the code has to arrive inside the database
 * rather than by a later owner-authenticated upload. The worker mounts these rows at boot.
 */
export function addCodeRows(
	bytes: Uint8Array,
	code: readonly { path: string; package: string; text: string }[],
	nowMs: number
): Uint8Array | null {
	if (Buffer.from(bytes.subarray(0, 16)).toString('latin1') !== SQLITE_MAGIC) return null;
	const dir = mkdtempSync(join(tmpdir(), 'drangler-code-'));
	const path = join(dir, 'site.sqlite');
	try {
		writeFileSync(path, bytes);
		const db = new DatabaseSync(path);
		try {
			db.exec(`CREATE TABLE IF NOT EXISTS cfw_module_file (
				path TEXT PRIMARY KEY, package TEXT NOT NULL, version TEXT NOT NULL,
				source TEXT NOT NULL, installed_at INTEGER NOT NULL)`);
			const row = db.prepare(
				`INSERT OR REPLACE INTO cfw_module_file (path, package, version, source, installed_at)
				 VALUES (?, ?, 'migrated', ?, ?)`
			);
			db.exec('BEGIN');
			for (const f of code) row.run(f.path, f.package, f.text, nowMs);
			db.exec('COMMIT');
		} finally {
			db.close();
		}
		return new Uint8Array(readFileSync(path));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
