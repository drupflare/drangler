import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { runConvertCommand } from '../src/commands/migrate';
import { ConvertError, FindingError, UsageError } from '../src/errors';
import { memoryFiles } from '../src/host/files';
import {
	byteaHex,
	convertDump,
	decodeCopyField,
	decodeMysqlString,
	encodeMysqlString,
	encodeSqliteString,
	mysqlTypeToSqlite,
	pgTypeToSqlite,
	rewriteIdentifiers,
	splitPgStatements,
	splitStatements,
	splitTopLevel,
	stripPgCasts,
	tokenize
} from '../src/migrate/convert';
import { testContext } from './helpers';

const toSqlite = (sql: string, over = {}) =>
	convertDump(sql, { from: 'mysql', to: 'sqlite', ...over });
const toMysql = (sql: string, over = {}) =>
	convertDump(sql, { from: 'sqlite', to: 'mysql', ...over });

describe('splitStatements', () => {
	it('does not split on a semicolon inside a string', () => {
		expect(splitStatements("INSERT INTO t VALUES ('a;b');\nSELECT 1;", true)).toEqual([
			"INSERT INTO t VALUES ('a;b')",
			'SELECT 1'
		]);
	});

	it('does not split on a semicolon inside a backslash-escaped quote', () => {
		expect(splitStatements("INSERT INTO t VALUES ('it\\'s; here');", true)).toHaveLength(1);
	});

	it('treats a doubled quote as the quote character', () => {
		expect(splitStatements("INSERT INTO t VALUES ('it''s; here');", false)).toHaveLength(1);
	});

	it('drops line and block comments, including the mysqldump conditional form', () => {
		expect(
			splitStatements('-- a comment\n# another\n/*!40101 SET NAMES utf8 */;\nSELECT 1;', true)
		).toEqual(['SELECT 1']);
	});

	it('keeps a trailing statement with no terminator', () => {
		expect(splitStatements('SELECT 1', true)).toEqual(['SELECT 1']);
	});

	it('tolerates an unterminated string rather than looping', () => {
		expect(splitStatements("SELECT 'unterminated", true)).toHaveLength(1);
		expect(splitStatements('SELECT 1 /* unterminated', true)).toEqual(['SELECT 1']);
	});
});

describe('tokenize', () => {
	it('separates identifiers, strings and hex literals', () => {
		expect(tokenize("INSERT INTO `t` VALUES ('a', 0xFF)", 'mysql')).toEqual([
			{ kind: 'text', text: 'INSERT INTO ' },
			{ kind: 'ident', name: 't' },
			{ kind: 'text', text: ' VALUES (' },
			{ kind: 'string', value: 'a' },
			{ kind: 'text', text: ', ' },
			{ kind: 'hex', hex: 'FF' },
			{ kind: 'text', text: ')' }
		]);
	});

	it('reads a SQLite blob literal', () => {
		expect(tokenize("VALUES (x'0a0b')", 'sqlite')).toContainEqual({ kind: 'hex', hex: '0a0b' });
	});

	it('leaves a bare zero alone', () => {
		expect(tokenize('VALUES (0)', 'mysql')).toEqual([{ kind: 'text', text: 'VALUES (0)' }]);
	});

	it('unescapes a doubled identifier quote', () => {
		expect(tokenize('SELECT `a``b`', 'mysql')).toContainEqual({ kind: 'ident', name: 'a`b' });
	});
});

describe('literals', () => {
	it('applies every MySQL escape', () => {
		expect(decodeMysqlString("a\\nb\\tc\\\\d\\'e\\0f\\Zg")).toBe("a\nb\tc\\d'e\0f\x1ag");
		expect(decodeMysqlString("it''s")).toBe("it's");
		expect(decodeMysqlString('trailing\\')).toBe('trailing\\');
		expect(decodeMysqlString('\\r\\b\\%')).toBe('\r\b%');
	});

	it('emits a NUL-bearing value as a cast blob, which SQLite can parse', () => {
		expect(encodeSqliteString('a\0b')).toBe("CAST(x'610062' AS TEXT)");
		expect(encodeSqliteString("it's")).toBe("'it''s'");
	});

	it('doubles a backslash on the way into MySQL, where it is an escape', () => {
		expect(encodeMysqlString('C:\\path')).toBe("'C:\\\\path'");
		expect(encodeMysqlString("it's")).toBe("'it''s'");
		expect(encodeMysqlString('a\0b')).toBe("'a\\0b'");
	});

	it('round-trips a value through both encoders', () => {
		const value = "a'b\\c\nd";
		expect(decodeMysqlString(encodeMysqlString(value).slice(1, -1))).toBe(value);
	});
});

describe('mysqlTypeToSqlite', () => {
	it('folds every integer width onto INTEGER', () => {
		for (const t of ['int(11)', 'bigint unsigned', 'tinyint(1)', 'serial', 'bool']) {
			expect(mysqlTypeToSqlite(t)).toBe('INTEGER');
		}
	});

	it('maps the text, blob, real and numeric families', () => {
		expect(mysqlTypeToSqlite('varchar(255)')).toBe('TEXT');
		expect(mysqlTypeToSqlite('longtext')).toBe('TEXT');
		expect(mysqlTypeToSqlite('json')).toBe('TEXT');
		expect(mysqlTypeToSqlite('datetime')).toBe('TEXT');
		expect(mysqlTypeToSqlite('longblob')).toBe('BLOB');
		expect(mysqlTypeToSqlite('varbinary(16)')).toBe('BLOB');
		expect(mysqlTypeToSqlite('double')).toBe('REAL');
		expect(mysqlTypeToSqlite('decimal(10,2)')).toBe('NUMERIC');
	});

	it('returns null for a type it does not know', () => {
		expect(mysqlTypeToSqlite('geometry')).toBeNull();
	});
});

describe('splitTopLevel', () => {
	it('ignores commas inside parentheses and strings', () => {
		expect(splitTopLevel("a int(11), b varchar(2), c enum('x,y')")).toEqual([
			'a int(11)',
			'b varchar(2)',
			"c enum('x,y')"
		]);
	});
});

describe('rewriteIdentifiers', () => {
	it('swaps the identifier quoting in both directions', () => {
		expect(rewriteIdentifiers('DROP TABLE IF EXISTS `node`', 'sqlite')).toBe(
			'DROP TABLE IF EXISTS "node"'
		);
		expect(rewriteIdentifiers('DROP TABLE IF EXISTS "node"', 'mysql')).toBe(
			'DROP TABLE IF EXISTS `node`'
		);
	});

	it('swaps the blob literal syntax', () => {
		expect(rewriteIdentifiers('VALUES (0xAB)', 'sqlite')).toBe("VALUES (x'AB')");
		expect(rewriteIdentifiers("VALUES (x'AB')", 'mysql')).toBe('VALUES (0xAB)');
	});
});

describe('MySQL to SQLite', () => {
	const CREATE = [
		'CREATE TABLE `node` (',
		"  `nid` int(10) unsigned NOT NULL AUTO_INCREMENT COMMENT 'the id',",
		"  `title` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',",
		'  `created` int(11) NOT NULL,',
		'  PRIMARY KEY (`nid`),',
		'  KEY `node__title` (`title`(191)),',
		'  UNIQUE KEY `uuid` (`title`)',
		') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;'
	].join('\n');

	it('maps types, drops the MySQL decoration and keeps the constraints', () => {
		const result = toSqlite(CREATE);
		expect(result.sql).toContain('"nid" INTEGER PRIMARY KEY AUTOINCREMENT');
		expect(result.sql).toContain('"title" TEXT NOT NULL DEFAULT \'\'');
		expect(result.sql).not.toMatch(/unsigned|CHARACTER SET|COLLATE|COMMENT|ENGINE/i);
		expect(result.tables).toEqual(['node']);
	});

	it('does not emit a second PRIMARY KEY beside the AUTOINCREMENT column', () => {
		expect(toSqlite(CREATE).sql.match(/PRIMARY KEY/g)).toHaveLength(1);
	});

	it('lifts every KEY out into a CREATE INDEX named for its table', () => {
		const result = toSqlite(CREATE);
		expect(result.sql).toContain('CREATE INDEX "node__node__title" ON "node" ("title")');
		expect(result.sql).toContain('CREATE UNIQUE INDEX "node__uuid" ON "node" ("title")');
		expect(result.indexes).toBe(2);
	});

	it('reports the dropped index prefix length as lossy', () => {
		expect(toSqlite(CREATE).lossy.join(' ')).toContain('prefix length');
	});

	it('keeps a composite PRIMARY KEY', () => {
		const result = toSqlite('CREATE TABLE `t` (`a` int, `b` int, PRIMARY KEY (`a`,`b`));');
		expect(result.sql).toContain('PRIMARY KEY ("a", "b")');
	});

	it('drops a FULLTEXT index and says so', () => {
		const result = toSqlite('CREATE TABLE `t` (`a` text, FULLTEXT KEY `ft` (`a`));');
		expect(result.sql).not.toContain('FULLTEXT');
		expect(result.lossy.join(' ')).toContain('FULLTEXT');
	});

	it('keeps a foreign key constraint', () => {
		const result = toSqlite(
			'CREATE TABLE `t` (`a` int, CONSTRAINT `fk` FOREIGN KEY (`a`) REFERENCES `u` (`b`));'
		);
		expect(result.sql).toContain('CONSTRAINT "fk" FOREIGN KEY ("a") REFERENCES "u" ("b")');
	});

	it('splits a multi-row INSERT so no statement meets the 100,000-character ceiling', () => {
		const result = toSqlite("INSERT INTO `t` (`a`) VALUES ('x'),('y'),('z');");
		expect(result.sql.split('\n').filter((l) => l.startsWith('INSERT'))).toHaveLength(3);
		expect(result.rows).toBe(3);
	});

	it('keeps the multi-row form when splitting is turned off', () => {
		const result = toSqlite("INSERT INTO `t` (`a`) VALUES ('x'),('y');", { splitRows: false });
		expect(result.sql.trim().split('\n')).toHaveLength(1);
	});

	it('re-encodes escaped values so nothing changes meaning', () => {
		const result = toSqlite("INSERT INTO `t` VALUES ('it\\'s', 'C:\\\\p', 0xDEAD);");
		expect(result.sql).toContain("'it''s'");
		expect(result.sql).toContain("'C:\\p'");
		expect(result.sql).toContain("x'DEAD'");
	});

	it('turns a NUL-bearing value into a cast blob', () => {
		expect(toSqlite("INSERT INTO `t` VALUES ('a\\0b');").sql).toContain(
			"CAST(x'610062' AS TEXT)"
		);
	});

	it('drops the session noise a mysqldump wraps itself in', () => {
		const result = toSqlite(
			'SET NAMES utf8mb4;\nLOCK TABLES `t` WRITE;\nUNLOCK TABLES;\nSTART TRANSACTION;\nCOMMIT;\nUSE `d`;'
		);
		expect(result.statements).toBe(0);
		expect(result.skipped).toEqual([]);
	});

	it('carries a DROP TABLE through', () => {
		expect(toSqlite('DROP TABLE IF EXISTS `node`;').sql.trim()).toBe(
			'DROP TABLE IF EXISTS "node";'
		);
	});
});

/**
 * Every case here is a regression test for a defect the docker e2e lane found by loading converted
 * SQL into a real MariaDB. Each one produced valid-looking output that a string assertion passed and
 * a database rejected, which is why they survived a unit suite until the lane existed.
 */
describe('SQLite to MySQL', () => {
	it('re-quotes, re-engines and restores AUTO_INCREMENT', () => {
		const result = toMysql(
			'CREATE TABLE "node" (\n"nid" INTEGER PRIMARY KEY AUTOINCREMENT,\n"title" TEXT NOT NULL\n);'
		);
		expect(result.sql).toContain('CREATE TABLE `node`');
		expect(result.sql).toContain('AUTO_INCREMENT');
		expect(result.sql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
	});

	it('declares the charset, or a 4-byte character is refused by the client', () => {
		expect(toMysql('CREATE TABLE "t" ("a" TEXT);').sql.split('\n')[0]).toBe(
			'SET NAMES utf8mb4;'
		);
		// nothing to declare it for
		expect(toMysql('').sql).toBe('');
	});

	it('widens INTEGER to BIGINT, because MySQL INTEGER is 32 bits', () => {
		expect(toMysql('CREATE TABLE "t" ("a" INTEGER NOT NULL);').sql).toContain(
			'`a` BIGINT NOT NULL'
		);
	});

	it('widens TEXT and BLOB to their LONG forms, which have no 65,535-byte limit', () => {
		const sql = toMysql('CREATE TABLE "t" ("a" TEXT, "b" BLOB, "c" REAL);').sql;
		expect(sql).toContain('`a` LONGTEXT');
		expect(sql).toContain('`b` LONGBLOB');
		expect(sql).toContain('`c` DOUBLE');
	});

	it('gives NUMERIC a scale, because MySQL defaults it to zero decimal places', () => {
		const result = toMysql('CREATE TABLE "t" ("a" NUMERIC NOT NULL);');
		expect(result.sql).toContain('`a` DECIMAL(30,10)');
		expect(result.lossy.join(' ')).toContain('carries no declared scale');
	});

	it('does not read a constraint keyword as the second word of a type', () => {
		// `INTEGER PRIMARY` and `NUMERIC NOT` both parsed as two-word types and skipped every mapping
		const sql = toMysql(
			'CREATE TABLE "t" ("a" INTEGER PRIMARY KEY, "b" NUMERIC NOT NULL);'
		).sql;
		expect(sql).toContain('`a` BIGINT PRIMARY KEY');
		expect(sql).toContain('`b` DECIMAL(30,10) NOT NULL');
	});

	it('still reads a genuine two-word type', () => {
		expect(toMysql('CREATE TABLE "t" ("a" DOUBLE PRECISION);').sql).toContain(
			'`a` DOUBLE PRECISION'
		);
	});

	it('lifts an inline PRIMARY KEY off a TEXT column, which MySQL refuses there', () => {
		const result = toMysql('CREATE TABLE "cache_data" ("cid" TEXT PRIMARY KEY, "data" BLOB);');
		expect(result.sql).toContain('`cid` LONGTEXT NOT NULL');
		expect(result.sql).not.toMatch(/`cid` LONGTEXT[^,]*PRIMARY KEY/);
		expect(result.sql).toContain('PRIMARY KEY (`cid`(191))');
		expect(result.lossy.join(' ')).toContain('uniqueness now applies to the prefix');
	});

	it('adds a prefix length to a table-level key over a TEXT column', () => {
		const result = toMysql('CREATE TABLE "t" ("a" TEXT, "b" INTEGER, PRIMARY KEY ("a", "b"));');
		expect(result.sql).toContain('PRIMARY KEY (`a`(191), `b`)');
	});

	it('adds a prefix length to a standalone CREATE INDEX too', () => {
		const result = toMysql(
			'CREATE TABLE "t" ("a" TEXT, "b" INTEGER);\nCREATE INDEX "i" ON "t" ("a");\nCREATE INDEX "j" ON "t" ("b");'
		);
		expect(result.sql).toContain('CREATE INDEX `i` ON `t` (`a`(191));');
		expect(result.sql).toContain('CREATE INDEX `j` ON `t` (`b`);');
		expect(result.indexes).toBe(2);
	});

	it('unwraps a NUL-bearing CAST, which MySQL has no TEXT cast target for', () => {
		const sql = toMysql('INSERT INTO "t" VALUES (CAST(x\'610062\' AS TEXT));').sql;
		expect(sql).toContain('VALUES (0x610062)');
		expect(sql).not.toContain('AS TEXT');
	});

	it('emits an empty byte string rather than a bare 0x, which MySQL reads as an identifier', () => {
		expect(toMysql('INSERT INTO "t" VALUES (x\'\');').sql).toContain("VALUES ('')");
		expect(toMysql('INSERT INTO "t" VALUES (x\'00\');').sql).toContain('VALUES (0x00)');
	});

	it('doubles a backslash on the way out', () => {
		expect(toMysql('INSERT INTO "t" VALUES (\'C:\\p\');').sql).toContain("'C:\\\\p'");
	});
});

describe('refusals', () => {
	it('refuses rather than guessing, naming the statement', () => {
		expect(() => toSqlite('CREATE TRIGGER t AFTER INSERT ON x BEGIN END;')).toThrow(
			ConvertError
		);
		try {
			toSqlite('ALTER TABLE `t` ADD COLUMN `a` int;');
		} catch (e) {
			expect((e as ConvertError).statement).toContain('ALTER TABLE');
		}
	});

	it('refuses a type it cannot map', () => {
		expect(() => toSqlite('CREATE TABLE `t` (`a` geometry NOT NULL);')).toThrow(/geometry/);
	});

	it('refuses an upsert', () => {
		expect(() =>
			toSqlite('INSERT INTO `t` VALUES (1) ON DUPLICATE KEY UPDATE `a` = 1;')
		).toThrow(/ON DUPLICATE KEY/);
	});

	it('refuses a CREATE TABLE with no column list, and one with no name', () => {
		expect(() => toSqlite('CREATE TABLE `t`;')).toThrow(/no column list/);
		expect(() => toSqlite('CREATE TABLE (a int);')).toThrow(/no parseable name/);
	});

	it('refuses an INSERT with no VALUES and an unrecognised statement', () => {
		expect(() => toSqlite('INSERT INTO `t` SELECT * FROM `u`;')).toThrow(/no VALUES/);
		expect(() => toSqlite('GRANT ALL ON x TO y;')).toThrow(/unrecognised/);
	});

	it('records instead of refusing when asked, and keeps going', () => {
		const result = toSqlite(
			'CREATE VIEW v AS SELECT 1;\nCREATE TABLE `t` (`a` int);\nALTER TABLE `t` ADD `b` int;',
			{ skipUnsupported: true }
		);
		expect(result.tables).toEqual(['t']);
		expect(result.skipped.map((s) => s.reason)).toEqual([
			'VIEW is not converted; its body is dialect-specific',
			'ALTER TABLE is not converted; SQLite supports only a subset and the difference is silent'
		]);
		expect(result.skipped[0]?.preview).toBe('CREATE VIEW v AS SELECT 1');
	});

	it('refuses a conversion with the same dialect on both sides', () => {
		expect(() => convertDump('', { from: 'mysql', to: 'mysql' })).toThrow(UsageError);
	});

	it('returns an empty string rather than a stray newline for an empty dump', () => {
		expect(toSqlite('').sql).toBe('');
	});
});

describe('the converted dump replays into a real SQLite', () => {
	const DUMP = [
		'-- MySQL dump 10.13',
		'/*!40101 SET NAMES utf8mb4 */;',
		'DROP TABLE IF EXISTS `node_field_data`;',
		'CREATE TABLE `node_field_data` (',
		'  `nid` int(10) unsigned NOT NULL AUTO_INCREMENT,',
		"  `title` varchar(255) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',",
		'  `body` longtext,',
		'  `weight` decimal(10,2) DEFAULT NULL,',
		'  `data` longblob,',
		'  PRIMARY KEY (`nid`),',
		'  KEY `title` (`title`(191))',
		') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;',
		"INSERT INTO `node_field_data` VALUES (1,'It\\'s here; ok','a\\\\b',1.50,0xDEAD),(2,'Second','x',NULL,NULL);"
	].join('\n');

	/**
	 * The one test that proves the output is SQL rather than a string that matched an assertion.
	 *
	 * Every other case here checks a substring, which cannot tell a valid statement from a plausible
	 * one; a converter whose whole job is producing SQL somebody else parses needs at least one case
	 * where the parser is real.
	 */
	it('creates the table, the index and the rows, with the values intact', () => {
		const db = new DatabaseSync(':memory:');
		try {
			db.exec(toSqlite(DUMP).sql);
			const rows = db
				.prepare(
					'SELECT nid, title, body, weight, typeof(nid) AS t, hex(data) AS d FROM node_field_data ORDER BY nid'
				)
				.all();
			expect(rows).toEqual([
				{
					nid: 1,
					title: "It's here; ok",
					body: 'a\\b',
					weight: 1.5,
					t: 'integer',
					d: 'DEAD'
				},
				// hex(NULL) is the empty string in SQLite, so the NULL shows in `weight` instead
				{ nid: 2, title: 'Second', body: 'x', weight: null, t: 'integer', d: '' }
			]);
			expect(
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'"
					)
					.all()
			).toEqual([{ name: 'node_field_data__title' }]);
		} finally {
			db.close();
		}
	});

	it('keeps a NUL-bearing value as text of the same bytes', () => {
		const db = new DatabaseSync(':memory:');
		try {
			db.exec(
				toSqlite("CREATE TABLE `t` (`a` longtext);\nINSERT INTO `t` VALUES ('a\\0b');").sql
			);
			const row = db.prepare('SELECT typeof(a) AS t, hex(a) AS h FROM t').get();
			expect(row).toEqual({ t: 'text', h: '610062' });
		} finally {
			db.close();
		}
	});
});

describe('PostgreSQL to SQLite', () => {
	const fromPg = (sql: string, over = {}) =>
		convertDump(sql, { from: 'pgsql', to: 'sqlite', ...over });

	// the shape pg_dump 16 writes for a Drupal site, trimmed to one table of each kind
	const DUMP = [
		'--',
		'-- PostgreSQL database dump',
		'--',
		'SET statement_timeout = 0;',
		"SELECT pg_catalog.set_config('search_path', '', false);",
		'CREATE FUNCTION public.greatest(numeric, numeric) RETURNS numeric',
		'    LANGUAGE sql AS $$SELECT CASE WHEN $1 > $2 THEN $1 ELSE $2 END;$$;',
		'SET default_table_access_method = heap;',
		'CREATE TABLE public.node_field_data (',
		'    nid integer NOT NULL,',
		"    title character varying(255) DEFAULT ''::character varying NOT NULL,",
		'    status smallint DEFAULT 1 NOT NULL,',
		'    promote boolean DEFAULT true,',
		'    weight numeric(10,2),',
		'    CONSTRAINT node_field_data_nid_check CHECK ((nid >= 0))',
		');',
		'ALTER TABLE public.node_field_data OWNER TO drupal;',
		'CREATE SEQUENCE public.node_field_data_nid_seq',
		'    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;',
		'ALTER SEQUENCE public.node_field_data_nid_seq OWNED BY public.node_field_data.nid;',
		'CREATE TABLE public.cache_default (',
		'    cid character varying(255) NOT NULL,',
		'    data bytea,',
		'    expire integer DEFAULT 0 NOT NULL,',
		'    tags text',
		');',
		"ALTER TABLE ONLY public.node_field_data ALTER COLUMN nid SET DEFAULT nextval('public.node_field_data_nid_seq'::regclass);",
		'COPY public.node_field_data (nid, title, status, promote, weight) FROM stdin;',
		"1\tIt's here; ok\t1\tt\t1.50",
		'2\ttwo\\nlines\t0\tf\t\\N',
		'\\.',
		'COPY public.cache_default (cid, data, expire, tags) FROM stdin;',
		'x\t\\\\x610062\t-1\tnode_list',
		'\\.',
		"SELECT pg_catalog.setval('public.node_field_data_nid_seq', 2, true);",
		'ALTER TABLE ONLY public.node_field_data',
		'    ADD CONSTRAINT node_field_data____pkey PRIMARY KEY (nid);',
		'ALTER TABLE ONLY public.cache_default',
		'    ADD CONSTRAINT cache_default____pkey PRIMARY KEY (cid);',
		'CREATE INDEX node_field_data__title__idx ON public.node_field_data USING btree (title);',
		'CREATE INDEX node_field_data__lower ON public.node_field_data USING btree (lower((title)::text));',
		''
	].join('\n');

	it('splits a dollar-quoted body and a COPY block without reading either as SQL', () => {
		const parts = splitPgStatements(DUMP);
		const fn = parts.find((p) => p.sql.startsWith('CREATE FUNCTION'));
		expect(fn?.sql).toContain('ELSE $2 END;$$');
		const copy = parts.find((p) => p.sql.startsWith('COPY public.node_field_data'));
		expect(copy?.copy).toEqual(["1\tIt's here; ok\t1\tt\t1.50", '2\ttwo\\nlines\t0\tf\t\\N']);
		// the row text never leaks into the statement after the block
		expect(parts.some((p) => p.sql.includes('two\\nlines') && !p.copy)).toBe(false);
	});

	it('replays into a real SQLite with the serial key, the bytes and the booleans intact', () => {
		const out = fromPg(DUMP);
		const db = new DatabaseSync(':memory:');
		try {
			db.exec(out.sql);
			expect(
				db
					.prepare(
						'SELECT nid, title, status, promote, weight FROM node_field_data ORDER BY nid'
					)
					.all()
			).toEqual([
				{ nid: 1, title: "It's here; ok", status: 1, promote: 1, weight: 1.5 },
				{ nid: 2, title: 'two\nlines', status: 0, promote: 0, weight: null }
			]);
			expect(
				db.prepare('SELECT typeof(data) AS t, hex(data) AS h FROM cache_default').get()
			).toEqual({
				t: 'blob',
				h: '610062'
			});
			// the next insert continues the sequence, which is what the dropped setval was for
			db.exec("INSERT INTO node_field_data (title) VALUES ('three')");
			expect(
				db.prepare("SELECT nid FROM node_field_data WHERE title = 'three'").get()
			).toEqual({ nid: 3 });
			expect(
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'"
					)
					.all()
			).toEqual([{ name: 'node_field_data__title__idx' }]);
		} finally {
			db.close();
		}
		expect(out.sql).toContain('"nid" INTEGER PRIMARY KEY AUTOINCREMENT');
		expect(out.tables).toEqual(['node_field_data', 'cache_default']);
		expect(out.rows).toBe(3);
		expect(out.lossy.some((l) => l.includes('greatest'))).toBe(true);
		expect(out.lossy.some((l) => l.includes('node_field_data__lower'))).toBe(true);
	});

	it('reads the --inserts form, E strings and bytea casts', () => {
		const out = fromPg(
			[
				'CREATE TABLE public.kv (name text NOT NULL, value bytea, ok boolean);',
				"INSERT INTO public.kv VALUES ('a', '\\x6869'::bytea, true), (E'b\\tc', NULL, false);",
				"INSERT INTO public.kv (name, value, ok) VALUES ('it''s', '\\x'::bytea, NULL);"
			].join('\n')
		);
		const db = new DatabaseSync(':memory:');
		try {
			db.exec(out.sql);
			expect(
				db.prepare('SELECT name, hex(value) AS v, ok FROM kv ORDER BY rowid').all()
			).toEqual([
				{ name: 'a', v: '6869', ok: 1 },
				{ name: 'b\tc', v: '', ok: 0 },
				{ name: "it's", v: '', ok: null }
			]);
		} finally {
			db.close();
		}
	});

	it('strips casts but not a :: inside a value', () => {
		expect(stripPgCasts("'a::b'::character varying")).toBe("'a::b'");
		expect(stripPgCasts("DEFAULT ''::character varying NOT NULL")).toBe("DEFAULT '' NOT NULL");
		expect(stripPgCasts('0::double precision')).toBe('0');
	});

	it('decodes COPY escapes and both bytea formats', () => {
		expect(decodeCopyField('\\N')).toBeNull();
		expect(decodeCopyField('a\\tb\\\\c\\101\\x41')).toBe('a\tb\\cAA');
		expect(byteaHex('\\x00FF')).toBe('00ff');
		expect(byteaHex('a\\000\\\\')).toBe('61005c');
	});

	it('maps the types Drupal and common modules declare, and refuses an array', () => {
		expect(pgTypeToSqlite('character varying(255)')).toBe('TEXT');
		expect(pgTypeToSqlite('bigint')).toBe('INTEGER');
		expect(pgTypeToSqlite('double precision')).toBe('REAL');
		expect(pgTypeToSqlite('timestamp without time zone')).toBe('TEXT');
		expect(pgTypeToSqlite('jsonb')).toBe('TEXT');
		expect(pgTypeToSqlite('bytea')).toBe('BLOB');
		expect(pgTypeToSqlite('integer[]')).toBeNull();
		expect(() => fromPg('CREATE TABLE t (tags text[]);')).toThrow(ConvertError);
	});

	it('refuses a target other than SQLite, and pgsql as a target', () => {
		expect(() => convertDump('', { from: 'pgsql', to: 'mysql' })).toThrow(UsageError);
		expect(() => convertDump('', { from: 'mysql', to: 'pgsql' })).toThrow(UsageError);
	});

	it('refuses a statement it does not know rather than dropping it', () => {
		expect(() =>
			fromPg('CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW EXECUTE FUNCTION f();')
		).toThrow(ConvertError);
		expect(
			fromPg('CREATE TRIGGER t BEFORE INSERT ON x EXECUTE FUNCTION f();', {
				skipUnsupported: true
			}).skipped
		).toHaveLength(1);
	});
});

describe('convert command', () => {
	const dump = 'CREATE TABLE `t` (`a` int(11) NOT NULL);\nINSERT INTO `t` VALUES (1),(2);';

	it('writes the converted dump and reports the counts', async () => {
		const files = memoryFiles({ '/in.sql': dump });
		const ctx = testContext({ files });
		await runConvertCommand(ctx, {
			in: '/in.sql',
			out: '/out.sql',
			from: 'mysql',
			to: 'sqlite'
		});
		expect(files.written.get('/out.sql')).toContain('CREATE TABLE "t"');
		expect(ctx.io.text()).toMatch(/written to\s+\/out\.sql/);
	});

	it('never puts the converted SQL into the JSON report', async () => {
		const ctx = testContext({ files: memoryFiles({ '/in.sql': dump }) });
		await runConvertCommand(ctx, { in: '/in.sql', from: 'mysql', to: 'sqlite', json: true });
		expect(ctx.io.json<{ sql?: string; rows: number }>()).not.toHaveProperty('sql');
		expect(ctx.io.json<{ rows: number }>().rows).toBe(2);
	});

	it('accepts mariadb as a spelling of mysql', async () => {
		const ctx = testContext({ files: memoryFiles({ '/in.sql': dump }) });
		await runConvertCommand(ctx, { in: '/in.sql', from: 'mariadb', to: 'sqlite' });
		expect(ctx.io.text()).toContain('mysql');
	});

	it('reaches the pgsql converter from the command, under every spelling drush and people use', async () => {
		const pg = 'CREATE TABLE public.t (a integer NOT NULL);\nINSERT INTO public.t VALUES (1);';
		for (const from of ['pgsql', 'postgres', 'postgresql']) {
			const files = memoryFiles({ '/in.sql': pg });
			const ctx = testContext({ files });
			await runConvertCommand(ctx, { in: '/in.sql', out: '/out.sql', from, to: 'sqlite' });
			expect(files.written.get('/out.sql')).toContain('CREATE TABLE "t"');
		}
	});

	it('refuses an unknown dialect and a missing input', async () => {
		const ctx = testContext({ files: memoryFiles({ '/in.sql': dump }) });
		await expect(
			runConvertCommand(ctx, { in: '/in.sql', from: 'oracle', to: 'sqlite' })
		).rejects.toThrow(/unknown dialect/);
		await expect(
			runConvertCommand(ctx, { in: '/none.sql', from: 'mysql', to: 'sqlite' })
		).rejects.toThrow(UsageError);
	});

	it('exits with a finding when statements were skipped', async () => {
		const ctx = testContext({
			files: memoryFiles({ '/in.sql': 'CREATE VIEW v AS SELECT 1;' })
		});
		await expect(
			runConvertCommand(ctx, {
				in: '/in.sql',
				from: 'mysql',
				to: 'sqlite',
				skipUnsupported: true
			})
		).rejects.toThrow(FindingError);
		expect(ctx.io.text()).toContain('skipped');
	});

	it('reports the lossy conversions in the text render', async () => {
		const ctx = testContext({
			// a plain TEXT column is no longer lossy on its own; being INDEXED is what costs something
			files: memoryFiles({ '/in.sql': 'CREATE TABLE "t" ("a" TEXT PRIMARY KEY);' })
		});
		await runConvertCommand(ctx, { in: '/in.sql', from: 'sqlite', to: 'mysql' });
		expect(ctx.io.text()).toContain('lossy');
		expect(ctx.io.text()).toContain('191');
	});
});
