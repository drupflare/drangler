import { ConvertError, UsageError } from '../errors';

export type Dialect = 'mysql' | 'sqlite';

export interface ConvertOptions {
	from: Dialect;
	to: Dialect;
	/**
	 * Emit one INSERT per row instead of carrying a multi-row VALUES list through.
	 *
	 * On by default into SQLite, because a Durable Object refuses statement text over 100,000
	 * characters and a mysqldump packs rows until it hits its own megabyte-scale limit.
	 */
	splitRows?: boolean;
	/** record an unconvertible statement and continue, instead of refusing the whole dump */
	skipUnsupported?: boolean;
	/**
	 * Refuse any statement wider than this many characters.
	 *
	 * Defaults to the Durable Object ceiling when converting INTO SQLite, and to no limit otherwise.
	 * Measured rather than assumed: converting a real Drupal 11 dump and loading it into a Durable
	 * Object fails with `SQLITE_TOOBIG` on `cache_container`, whose single row is far over the limit.
	 * Without this the converter emits a dump that looks complete, replays fine into a plain SQLite,
	 * and dies part-way through the destination that actually matters.
	 */
	maxStatementChars?: number;
}

/**
 * Statement text a Durable Object will accept.
 *
 * Not drangler's number: it is `drupflare/worker`'s measured platform limit, and the reason its
 * export emits cache bins as structure only. Encoded here as a ceiling rather than as a table list,
 * because the ceiling is the rule and which tables breach it is a property of the site.
 */
export const DO_STATEMENT_CHARS = 100_000;

export interface SkippedStatement {
	reason: string;
	/** the first 160 characters, so a report can name the statement without printing a dump */
	preview: string;
}

export interface ConvertResult {
	sql: string;
	statements: number;
	tables: string[];
	indexes: number;
	rows: number;
	skipped: SkippedStatement[];
	/** conversions that succeeded but do not round-trip; each says what changed */
	lossy: string[];
	/** the widest statement emitted, so a caller can see how close the dump came to the ceiling */
	maxStatementChars: number;
	/** rows refused for width, by table, with the widest one measured */
	overLimit: { table: string; rows: number; widest: number }[];
}

// #region lexing

type Token =
	| { kind: 'ident'; name: string }
	| { kind: 'string'; value: string }
	| { kind: 'hex'; hex: string }
	| { kind: 'text'; text: string };

const preview = (statement: string): string => statement.replace(/\s+/g, ' ').trim().slice(0, 160);

/**
 * Splits a dump into statements.
 *
 * Written as a scanner rather than a split on `;` because a Drupal dump is full of semicolons inside
 * string values -- serialized PHP, rendered HTML, `.htaccess` bodies -- and a naive split truncates
 * every one of those rows into invalid SQL that still parses far enough to look plausible.
 */
export function splitStatements(sql: string, backslashEscapes: boolean): string[] {
	const out: string[] = [];
	let current = '';
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i] as string;
		const next = sql[i + 1];

		if (ch === '-' && next === '-') {
			while (i < sql.length && sql[i] !== '\n') i++;
			continue;
		}
		if (ch === '#') {
			while (i < sql.length && sql[i] !== '\n') i++;
			continue;
		}
		if (ch === '/' && next === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end === -1 ? sql.length : end + 2;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			const { text, end } = readQuoted(sql, i, ch, backslashEscapes);
			current += text;
			i = end;
			continue;
		}
		if (ch === ';') {
			if (current.trim() !== '') out.push(current.trim());
			current = '';
			i++;
			continue;
		}
		current += ch;
		i++;
	}
	if (current.trim() !== '') out.push(current.trim());
	return out;
}

/** Reads one quoted run starting at `start`, returning it with its quotes and the index after it. */
function readQuoted(
	sql: string,
	start: number,
	quote: string,
	backslashEscapes: boolean
): { text: string; end: number } {
	let i = start + 1;
	let text = quote;
	while (i < sql.length) {
		const ch = sql[i] as string;
		if (backslashEscapes && quote !== '`' && ch === '\\' && i + 1 < sql.length) {
			text += ch + (sql[i + 1] as string);
			i += 2;
			continue;
		}
		if (ch === quote) {
			// a doubled quote is the quote character, in every dialect here
			if (sql[i + 1] === quote) {
				text += quote + quote;
				i += 2;
				continue;
			}
			return { text: text + quote, end: i + 1 };
		}
		text += ch;
		i++;
	}
	return { text, end: i };
}

/** Splits one statement into identifiers, literals and everything else. */
export function tokenize(statement: string, from: Dialect): Token[] {
	const backslashEscapes = from === 'mysql';
	const identQuote = from === 'mysql' ? '`' : '"';
	const tokens: Token[] = [];
	let text = '';
	let i = 0;
	const flush = () => {
		if (text !== '') tokens.push({ kind: 'text', text });
		text = '';
	};
	while (i < statement.length) {
		const ch = statement[i] as string;
		if (ch === identQuote) {
			const { text: raw, end } = readQuoted(statement, i, identQuote, false);
			flush();
			tokens.push({
				kind: 'ident',
				name: raw
					.slice(1, -1)
					.split(identQuote + identQuote)
					.join(identQuote)
			});
			i = end;
			continue;
		}
		if (ch === "'") {
			const { text: raw, end } = readQuoted(statement, i, "'", backslashEscapes);
			flush();
			tokens.push({
				kind: 'string',
				value:
					from === 'mysql'
						? decodeMysqlString(raw.slice(1, -1))
						: raw.slice(1, -1).split("''").join("'")
			});
			i = end;
			continue;
		}
		if (
			from === 'mysql' &&
			ch === '0' &&
			(statement[i + 1] === 'x' || statement[i + 1] === 'X')
		) {
			const match = /^0[xX]([0-9a-fA-F]*)/.exec(statement.slice(i));
			if (match?.[1] !== undefined && match[1].length > 0) {
				flush();
				tokens.push({ kind: 'hex', hex: match[1] });
				i += match[0].length;
				continue;
			}
		}
		if (from === 'sqlite' && (ch === 'x' || ch === 'X') && statement[i + 1] === "'") {
			const match = /^[xX]'([0-9a-fA-F]*)'/.exec(statement.slice(i));
			if (match?.[1] !== undefined) {
				flush();
				tokens.push({ kind: 'hex', hex: match[1] });
				i += match[0].length;
				continue;
			}
		}
		text += ch;
		i++;
	}
	flush();
	return tokens;
}

// #endregion

// #region literals

/** Applies MySQL's backslash escapes, so the value in hand is the value in the column. */
export function decodeMysqlString(raw: string): string {
	let out = '';
	let i = 0;
	while (i < raw.length) {
		const ch = raw[i] as string;
		if (ch === "'" && raw[i + 1] === "'") {
			out += "'";
			i += 2;
			continue;
		}
		if (ch !== '\\') {
			out += ch;
			i++;
			continue;
		}
		const esc = raw[i + 1];
		i += 2;
		switch (esc) {
			case '0':
				out += '\0';
				break;
			case 'n':
				out += '\n';
				break;
			case 'r':
				out += '\r';
				break;
			case 't':
				out += '\t';
				break;
			case 'b':
				out += '\b';
				break;
			case 'Z':
				// ASCII 26, which MySQL escapes because Windows reads it as end-of-file
				out += '\x1a';
				break;
			case undefined:
				out += '\\';
				break;
			default:
				// \\ \' \" \% \_ and anything else: the character itself
				out += esc;
		}
	}
	return out;
}

const hexOf = (value: string): string =>
	[...Buffer.from(value, 'utf8')].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * A SQLite literal for one decoded value.
 *
 * A value carrying a NUL becomes `CAST(x'..' AS TEXT)`, because SQLite's parser ends a string literal
 * at the NUL and the rest of the row becomes syntax. That is the same refusal `dumpDatabase()` makes
 * in `drupflare/worker`, arrived at from the same property of the parser rather than copied.
 */
export function encodeSqliteString(value: string): string {
	if (value.includes('\0')) return `CAST(x'${hexOf(value)}' AS TEXT)`;
	return `'${value.split("'").join("''")}'`;
}

/**
 * A MySQL literal for one decoded value.
 *
 * The backslash is the whole reason this is not a pass-through: SQLite stores `\` as itself and MySQL
 * reads it as an escape, so a Windows path or a regex in a config row silently loses a character
 * unless it is doubled here.
 */
export function encodeMysqlString(value: string): string {
	let out = '';
	for (const ch of value) {
		if (ch === '\\') out += '\\\\';
		else if (ch === "'") out += "''";
		else if (ch === '\0') out += '\\0';
		else out += ch;
	}
	return `'${out}'`;
}

// #endregion

// #region schema

const MYSQL_TYPE_MAP: readonly (readonly [RegExp, string])[] = [
	[/^(tiny|small|medium|big)?int\b/i, 'INTEGER'],
	[/^serial\b/i, 'INTEGER'],
	[/^bit\b/i, 'INTEGER'],
	[/^bool(ean)?\b/i, 'INTEGER'],
	[/^(decimal|numeric|fixed)\b/i, 'NUMERIC'],
	[/^(float|double|real)\b/i, 'REAL'],
	[/^(tiny|medium|long)?blob\b/i, 'BLOB'],
	[/^(var)?binary\b/i, 'BLOB'],
	[/^(tiny|medium|long)?text\b/i, 'TEXT'],
	[/^(var)?char\b/i, 'TEXT'],
	[/^(enum|set)\b/i, 'TEXT'],
	[/^json\b/i, 'TEXT'],
	[/^(date|datetime|timestamp|time|year)\b/i, 'TEXT']
];

/**
 * SQLite storage class to a MySQL column type.
 *
 * Every entry is a WIDENING, and each one is a bug the e2e lane caught by loading a converted dump
 * into a real MariaDB rather than by reading it:
 *
 * - `INTEGER` passed through unchanged means MySQL `INT`, which is 32 bits. SQLite's INTEGER is 64,
 *   so `9223372036854775807` was silently out of range -- caught only because the container runs
 *   `STRICT_TRANS_TABLES`; on a default install it would have been clamped and the dump would have
 *   "succeeded".
 * - `NUMERIC` passed through means `DECIMAL(10,0)`, whose scale is ZERO, so `1.5000` restores as
 *   `2`. SQLite carries no declared scale to copy, so the width here is a choice and is reported.
 * - `TEXT` and `BLOB` are widened to their LONG forms because SQLite has no length limit and MySQL's
 *   plain `TEXT` silently truncates at 65,535 bytes.
 */
const SQLITE_TYPE_MAP: Record<string, string> = {
	INTEGER: 'BIGINT',
	INT: 'BIGINT',
	REAL: 'DOUBLE',
	TEXT: 'LONGTEXT',
	BLOB: 'LONGBLOB',
	NUMERIC: 'DECIMAL(30,10)'
};

/** Whether a MySQL type needs a prefix length before it can take part in a key. */
const NEEDS_KEY_PREFIX = /^(LONG|MEDIUM|TINY)?(TEXT|BLOB)$/i;

/** what MySQL indexes of a LONGTEXT column; 191 is the utf8mb4-safe width Drupal itself uses */
const KEY_PREFIX = 191;

export function sqliteTypeToMysql(declared: string): { type: string; invented: boolean } {
	const bare = declared
		.trim()
		.toUpperCase()
		.replace(/\s*\(.*$/, '');
	const mapped = SQLITE_TYPE_MAP[bare];
	if (mapped === undefined) return { type: declared.trim().toUpperCase(), invented: false };
	return { type: mapped, invented: bare === 'NUMERIC' };
}

/** MySQL declared type to a SQLite storage class. Unknown types keep their name and are reported. */
export function mysqlTypeToSqlite(declared: string): string | null {
	for (const [pattern, mapped] of MYSQL_TYPE_MAP) {
		if (pattern.test(declared.trim())) return mapped;
	}
	return null;
}

/** Splits a parenthesised body on commas that are not inside parens or quotes. */
export function splitTopLevel(body: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = '';
	let i = 0;
	while (i < body.length) {
		const ch = body[i] as string;
		if (ch === "'" || ch === '`' || ch === '"') {
			const { text, end } = readQuoted(body, i, ch, true);
			current += text;
			i = end;
			continue;
		}
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			out.push(current.trim());
			current = '';
			i++;
			continue;
		}
		current += ch;
		i++;
	}
	if (current.trim() !== '') out.push(current.trim());
	return out;
}

const ident = (name: string, dialect: Dialect): string =>
	dialect === 'mysql' ? `\`${name.split('`').join('``')}\`` : `"${name.split('"').join('""')}"`;

/** Column names out of a `(a, b(191), c)` key list, with any MySQL prefix length dropped. */
function keyColumns(list: string): { names: string[]; prefixed: boolean } {
	let prefixed = false;
	const names = splitTopLevel(list.replace(/^\(|\)$/g, '')).map((part) => {
		const cleaned = part.trim().replace(/\s+(ASC|DESC)$/i, '');
		const withLength = /^`?([^`(]+)`?\s*\(\s*\d+\s*\)$/.exec(cleaned);
		if (withLength?.[1] !== undefined) {
			prefixed = true;
			return withLength[1].trim();
		}
		return cleaned.replace(/^`|`$/g, '').replace(/^"|"$/g, '');
	});
	return { names, prefixed };
}

interface TableSchema {
	name: string;
	columns: Map<string, string>;
}

/**
 * The index of the `)` that closes the `(` at `open`, or -1.
 *
 * Written after the e2e lane converted a real Drupal dump and produced invalid SQL. The previous
 * version took `lastIndexOf(')')`, which is correct until a table carries a MySQL table-level
 * comment: `router` ends `) ENGINE=InnoDB COMMENT='Maps paths to various callbacks (access, page
 * and title)'`, so the last `)` in the statement sits inside a string literal after the column list.
 * The body then swallowed the table options and SQLite answered `no such column: "alias`)`.
 *
 * Depth and quote aware for the same reason `splitStatements` is: a DEFAULT value or a comment can
 * contain either character.
 */
export function matchingParen(text: string, open: number): number {
	let depth = 0;
	let i = open;
	while (i < text.length) {
		const ch = text[i] as string;
		if (ch === "'" || ch === '`' || ch === '"') {
			i = readQuoted(text, i, ch, true).end;
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')') {
			depth--;
			if (depth === 0) return i;
		}
		i++;
	}
	return -1;
}

// #endregion

// #region statement conversion

interface ConvertState {
	opts: Required<Pick<ConvertOptions, 'splitRows' | 'skipUnsupported'>> & ConvertOptions;
	schema: Map<string, TableSchema>;
	skipped: SkippedStatement[];
	lossy: string[];
	tables: string[];
	indexes: number;
	rows: number;
	maxStatementChars: number;
	overLimit: Map<string, { rows: number; widest: number }>;
	/** null means no ceiling applies to this target */
	limit: number | null;
}

/** Statements a dump carries that have no meaning in the target and are dropped without comment. */
const NOISE =
	/^(SET\b|LOCK TABLES\b|UNLOCK TABLES\b|USE\b|START TRANSACTION\b|COMMIT\b|BEGIN\b|PRAGMA\b|DELIMITER\b|\/\*)/i;

function unsupported(state: ConvertState, statement: string, reason: string): void {
	if (!state.opts.skipUnsupported) throw new ConvertError(reason, preview(statement));
	state.skipped.push({ reason, preview: preview(statement) });
}

/**
 * Converts one `CREATE TABLE`, returning the table statement plus the indexes it implied.
 *
 * MySQL index names live in the table's namespace and SQLite's live in the database's, so every index
 * is renamed `<table>__<index>`. Two tables with a `name` key are ordinary in a Drupal schema and
 * would collide on the second `CREATE INDEX` without this.
 */
function convertCreateTable(state: ConvertState, statement: string, to: Dialect): string[] {
	const open = statement.indexOf('(');
	const close = open === -1 ? -1 : matchingParen(statement, open);
	if (open === -1 || close < open) {
		unsupported(state, statement, 'CREATE TABLE with no column list');
		return [];
	}
	const head = statement.slice(0, open);
	const nameMatch = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([^`"\s(]+)[`"]?/i.exec(head);
	const table = nameMatch?.[1];
	if (table === undefined) {
		unsupported(state, statement, 'CREATE TABLE with no parseable name');
		return [];
	}

	const columns: string[] = [];
	const constraints: string[] = [];
	const after: string[] = [];
	const schema: TableSchema = { name: table, columns: new Map() };
	let autoIncrementPk: string | null = null;
	// an inline `PRIMARY KEY` lifted off a TEXT/BLOB column, which MySQL refuses to accept there
	const lifted: string[] = [];

	for (const item of splitTopLevel(statement.slice(open + 1, close))) {
		const keyMatch =
			/^(PRIMARY\s+KEY|UNIQUE\s+(?:KEY|INDEX)|FULLTEXT\s+(?:KEY|INDEX)|SPATIAL\s+(?:KEY|INDEX)|KEY|INDEX|CONSTRAINT|FOREIGN\s+KEY|CHECK)\b/i.exec(
				item
			);
		if (keyMatch === null) {
			const column = convertColumn(state, table, item, to, schema, lifted);
			if (column !== null) columns.push(column);
			if (column !== null && /AUTO_?INCREMENT/i.test(item)) {
				autoIncrementPk = /^[`"]?([^`"\s]+)/.exec(item)?.[1] ?? null;
			}
			continue;
		}
		const keyword = keyMatch[1]?.toUpperCase().replace(/\s+/g, ' ') ?? '';
		if (keyword.startsWith('FULLTEXT') || keyword.startsWith('SPATIAL')) {
			state.lossy.push(
				`${table}: dropped a ${keyword} index; SQLite has no equivalent and full-text search needs an FTS table`
			);
			continue;
		}
		if (keyword === 'PRIMARY KEY') {
			const list = item.slice(item.indexOf('('));
			const { names } = keyColumns(list);
			// an AUTO_INCREMENT column carries its own PRIMARY KEY in SQLite; a second one is an error
			if (
				to === 'sqlite' &&
				autoIncrementPk !== null &&
				names.length === 1 &&
				names[0] === autoIncrementPk
			) {
				continue;
			}
			constraints.push(
				`PRIMARY KEY (${names.map((n) => keyPart(state, table, n, to, schema)).join(', ')})`
			);
			continue;
		}
		if (keyword === 'CONSTRAINT' || keyword === 'FOREIGN KEY' || keyword === 'CHECK') {
			constraints.push(rewriteIdentifiers(item, to));
			continue;
		}
		const unique = keyword.startsWith('UNIQUE');
		const nameMatchKey = /^(?:UNIQUE\s+)?(?:KEY|INDEX)\s+[`"]?([^`"\s(]+)[`"]?/i.exec(item);
		const list = item.slice(item.indexOf('('));
		const { names, prefixed } = keyColumns(list);
		const indexName = `${table}__${nameMatchKey?.[1] ?? names.join('_')}`;
		if (prefixed) {
			state.lossy.push(
				`${table}: dropped the prefix length on ${indexName}; SQLite indexes the whole value`
			);
		}
		after.push(
			`CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${ident(indexName, to)} ON ${ident(table, to)} (${names
				.map((n) => keyPart(state, table, n, to, schema))
				.join(', ')});`
		);
		state.indexes++;
	}

	state.schema.set(table, schema);
	state.tables.push(table);
	const body = [...columns, ...constraints, ...lifted].join(',\n\t');
	const suffix = to === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
	return [`CREATE TABLE ${ident(table, to)} (\n\t${body}\n)${suffix};`, ...after];
}

/**
 * One column in a key, with a prefix length when MySQL requires one.
 *
 * MySQL refuses `PRIMARY KEY (cid)` outright when `cid` is a TEXT or BLOB column -- `ERROR 1170:
 * BLOB/TEXT column used in key specification without a key length` -- which the e2e lane hit as soon
 * as it loaded a converted export into a real MariaDB. Adding the prefix keeps every byte of the
 * value and narrows only what the index covers, which is what Drupal's own schema does.
 *
 * Reported as lossy on a PRIMARY KEY or UNIQUE index, because uniqueness is then enforced over the
 * first {@link KEY_PREFIX} characters and two rows differing only past that point stop being
 * distinct. That is a semantic change, not a formatting one.
 */
function keyPart(
	state: ConvertState,
	table: string,
	column: string,
	to: Dialect,
	schema: TableSchema
): string {
	const quoted = ident(column, to);
	if (to !== 'mysql') return quoted;
	const type = schema.columns.get(column) ?? state.schema.get(table)?.columns.get(column) ?? '';
	if (!NEEDS_KEY_PREFIX.test(type)) return quoted;
	state.lossy.push(
		`${table}.${column}: indexed on its first ${KEY_PREFIX} characters, because MySQL cannot key a ${type} without a prefix; the stored value is unchanged, but uniqueness now applies to the prefix`
	);
	return `${quoted}(${KEY_PREFIX})`;
}

/** One column definition, with the dialect-only modifiers removed and the type mapped. */
function convertColumn(
	state: ConvertState,
	table: string,
	item: string,
	to: Dialect,
	schema: TableSchema,
	lifted: string[] = []
): string | null {
	const nameMatch = /^[`"]?([^`"\s]+)[`"]?\s+(.*)$/s.exec(item.trim());
	if (nameMatch?.[1] === undefined || nameMatch[2] === undefined) {
		unsupported(state, item, `column definition in ${table} could not be parsed`);
		return null;
	}
	const name = nameMatch[1];
	let rest = nameMatch[2].trim();

	// the second word is allowed ONLY for the two real two-word types. `[A-Za-z]+(\s+[A-Za-z]+)?`
	// looks equivalent and is not: it reads `INTEGER PRIMARY` out of `INTEGER PRIMARY KEY` and
	// `NUMERIC NOT` out of `NUMERIC NOT NULL`, so the type never matched the map and every widening
	// was skipped while the output stayed accidentally valid. Found by loading a converted export
	// into a real MariaDB, where a 64-bit id then did not fit MySQL's 32-bit INT
	const typeMatch = /^([A-Za-z]+)(\s+PRECISION|\s+VARYING)?(\s*\([^)]*\))?/i.exec(rest);
	const declared = typeMatch?.[0] ?? rest;
	rest = rest.slice(declared.length).trim();

	let type: string;
	if (to === 'sqlite') {
		const mapped = mysqlTypeToSqlite(declared);
		if (mapped === null) {
			unsupported(state, item, `no SQLite storage class for the type \`${declared.trim()}\``);
			return null;
		}
		type = mapped;
		// found by the e2e lane: MySQL renders DECIMAL(20,4) as `1.5000` and SQLite's NUMERIC
		// affinity renders the same value `1.5`, so the scale is not carried across
		if (mapped === 'NUMERIC' && /\(\s*\d+\s*,\s*[1-9]/.test(declared)) {
			state.lossy.push(
				`${table}.${name}: \`${declared.trim()}\` became NUMERIC; SQLite has no declared scale, so the value survives and its rendering loses trailing zeroes`
			);
		}
	} else {
		const mapped = sqliteTypeToMysql(declared);
		type = mapped.type;
		if (mapped.invented) {
			state.lossy.push(
				`${table}.${name}: SQLite NUMERIC carries no declared scale, so it became ${type}; a value needing more than 10 decimal places would round`
			);
		}
	}
	schema.columns.set(name, type);

	// dialect-only decoration; none of it changes what a value is
	rest = rest
		.replace(/\bunsigned\b/gi, '')
		.replace(/\bzerofill\b/gi, '')
		.replace(/\bCHARACTER\s+SET\s+[^\s,]+/gi, '')
		.replace(/\bCOLLATE\s+[^\s,]+/gi, '')
		.replace(/\bCOMMENT\s+'(?:[^'\\]|\\.|'')*'/gi, '')
		.replace(/\bON\s+UPDATE\s+CURRENT_TIMESTAMP(?:\(\d*\))?/gi, '')
		.trim();

	if (to === 'sqlite') {
		rest = rest.replace(/\bAUTO_INCREMENT\b/gi, '').trim();
		if (/AUTO_INCREMENT/i.test(item) && type === 'INTEGER') {
			return `${ident(name, to)} INTEGER PRIMARY KEY AUTOINCREMENT`;
		}
	} else {
		rest = rest.replace(/\bAUTOINCREMENT\b/gi, 'AUTO_INCREMENT');
		// MySQL refuses an inline PRIMARY KEY on a TEXT or BLOB column; it moves to a table-level
		// constraint with a prefix length, which is the only form it will accept
		if (NEEDS_KEY_PREFIX.test(type) && /\bPRIMARY\s+KEY\b/i.test(rest)) {
			rest = rest.replace(/\bPRIMARY\s+KEY\b/gi, '').trim();
			lifted.push(`PRIMARY KEY (${keyPart(state, table, name, to, schema)})`);
			// a MySQL key column cannot be nullable, and SQLite's own PK column already was not
			if (!/\bNOT\s+NULL\b/i.test(rest)) rest = `NOT NULL ${rest}`.trim();
		}
	}

	rest = rest.replace(/\s{2,}/g, ' ').trim();
	return `${ident(name, to)} ${type}${rest === '' ? '' : ` ${rest}`}`;
}

/**
 * A standalone `CREATE INDEX`, with the same prefix rule the inline keys get.
 *
 * A SQLite export emits its indexes as separate statements rather than inside the table, so without
 * this the prefix fix would cover a MySQL-sourced dump and miss every Worker-sourced one -- the half
 * that matters for off-boarding.
 */
function convertStandaloneIndex(state: ConvertState, statement: string, to: Dialect): string {
	const parsed =
		/^(CREATE\s+(?:UNIQUE\s+)?INDEX\s+)([`"]?)([^`"\s(]+)\2(\s+ON\s+)([`"]?)([^`"\s(]+)\5\s*\(([^)]*)\)/i.exec(
			statement
		);
	if (parsed === null || to !== 'mysql') return rewriteIdentifiers(statement, to);
	const [, head, , indexName, on, , table, list] = parsed;
	const schema = state.schema.get(String(table)) ?? { name: String(table), columns: new Map() };
	const { names } = keyColumns(`(${String(list)})`);
	const parts = names.map((n) => keyPart(state, String(table), n, to, schema));
	return `${String(head).toUpperCase().replace(/\s+/g, ' ')}${ident(String(indexName), to)}${String(on).toUpperCase().replace(/\s+/g, ' ')}${ident(String(table), to)} (${parts.join(', ')})`;
}

/**
 * Rewrites identifier quoting and literal escaping without changing anything else.
 *
 * The one structural rewrite is `CAST(x'..' AS TEXT)`. SQLite emits that form for a TEXT value
 * carrying a NUL -- the parser would otherwise end the string literal at the NUL -- and MySQL has no
 * `TEXT` cast target at all, so the statement is a syntax error there. A bare hex literal assigned
 * into a text column stores the same bytes, which is what MySQL wants and what the comparator then
 * reads back as identical.
 */
export function rewriteIdentifiers(input: string, to: Dialect): string {
	const from: Dialect = to === 'sqlite' ? 'mysql' : 'sqlite';
	const statement =
		to === 'mysql'
			? input.replace(/CAST\(\s*[xX]'([0-9a-fA-F]*)'\s+AS\s+TEXT\s*\)/g, "x'$1'")
			: input;
	return tokenize(statement, from)
		.map((token) => {
			if (token.kind === 'ident') return ident(token.name, to);
			if (token.kind === 'string') {
				return to === 'sqlite'
					? encodeSqliteString(token.value)
					: encodeMysqlString(token.value);
			}
			if (token.kind === 'hex') {
				if (to === 'sqlite') return `x'${token.hex}'`;
				// MySQL has no zero-length hex literal: `0x` is parsed as an identifier and the
				// statement fails with `Unknown column '0x'`. An empty byte string is the empty
				// string, which is still distinct from NULL
				return token.hex === '' ? "''" : `0x${token.hex}`;
			}
			return token.text;
		})
		.join('');
}

/**
 * Converts one INSERT, optionally one row per statement.
 *
 * A mysqldump packs as many rows into a statement as its own buffer allows. Carried through
 * unchanged, a single statement routinely passes 100,000 characters, which is exactly the ceiling a
 * Durable Object refuses -- so the default into SQLite is to split.
 */
function convertInsert(state: ConvertState, statement: string, to: Dialect): string[] {
	const valuesAt = /\bVALUES\b/i.exec(statement);
	if (valuesAt === null) {
		unsupported(state, statement, 'INSERT with no VALUES list');
		return [];
	}
	if (/\bON\s+DUPLICATE\s+KEY\b/i.test(statement)) {
		unsupported(
			state,
			statement,
			'INSERT ... ON DUPLICATE KEY UPDATE has no SQLite equivalent'
		);
		return [];
	}
	const head = rewriteIdentifiers(statement.slice(0, valuesAt.index), to).trim();
	const tail = statement.slice(valuesAt.index + valuesAt[0].length);
	const groups = splitTopLevel(tail).map((g) => g.trim());
	state.rows += groups.length;

	const converted = groups.map((g) => rewriteIdentifiers(g, to));
	const table = /INTO\s+[`"]?([^`"\s(]+)/i.exec(head)?.[1] ?? 'unknown';
	const emitted =
		!state.opts.splitRows || converted.length === 1
			? [`${head} VALUES ${converted.join(', ')};`]
			: converted.map((g) => `${head} VALUES ${g};`);
	return emitted.filter((line) => keepWidth(state, table, line));
}

/**
 * Whether one emitted statement fits the target's ceiling.
 *
 * Refuses by WIDTH rather than by table name. Which tables breach the limit is a property of the
 * site -- on a stock Drupal 11 it is `cache_container`, whose service-container row alone is far
 * over -- so a list of table names would be a guess about somebody else's content. The ceiling is
 * the rule; the tables are the consequence, and the report names the ones that were actually hit.
 */
function keepWidth(state: ConvertState, table: string, line: string): boolean {
	state.maxStatementChars = Math.max(state.maxStatementChars, line.length);
	const limit = state.limit;
	if (limit === null || line.length <= limit) return true;
	const existing = state.overLimit.get(table) ?? { rows: 0, widest: 0 };
	state.overLimit.set(table, {
		rows: existing.rows + 1,
		widest: Math.max(existing.widest, line.length)
	});
	state.rows--;
	if (!state.opts.skipUnsupported) {
		throw new ConvertError(
			`a row of \`${table}\` is ${line.length.toLocaleString('en-US')} characters, over the ` +
				`${limit.toLocaleString('en-US')}-character ceiling the target accepts. It replays into a ` +
				'plain SQLite and fails part-way into a Durable Object with SQLITE_TOOBIG. Re-run with ' +
				'--skip-unsupported to drop these rows, or raise --max-statement-chars if the target has ' +
				'no such limit',
			preview(line)
		);
	}
	state.skipped.push({
		reason: `row too wide for ${table}: ${line.length.toLocaleString('en-US')} characters against a ${limit.toLocaleString('en-US')} ceiling`,
		preview: preview(line)
	});
	return false;
}

// #endregion

/**
 * Converts a whole dump between MySQL and SQLite.
 *
 * Refuses rather than guesses. Anything it cannot represent is a `ConvertError` naming the statement,
 * and `--skip-unsupported` downgrades that to a recorded skip; a converter that silently dropped a
 * trigger would produce a dump that restores cleanly and behaves differently, which is the worst of
 * the three outcomes.
 */
export function convertDump(input: string, opts: ConvertOptions): ConvertResult {
	if (opts.from === opts.to) {
		throw new UsageError(`--from and --to are both ${opts.from}; there is nothing to convert`);
	}
	const to = opts.to;
	const state: ConvertState = {
		opts: {
			...opts,
			splitRows: opts.splitRows ?? to === 'sqlite',
			skipUnsupported: opts.skipUnsupported ?? false
		},
		schema: new Map(),
		skipped: [],
		lossy: [],
		tables: [],
		indexes: 0,
		rows: 0,
		maxStatementChars: 0,
		overLimit: new Map(),
		// 0 or a negative value turns the ceiling off explicitly; absent means the target's default
		limit:
			opts.maxStatementChars === undefined
				? to === 'sqlite'
					? DO_STATEMENT_CHARS
					: null
				: opts.maxStatementChars > 0
					? opts.maxStatementChars
					: null
	};

	const out: string[] = [];
	for (const statement of splitStatements(input, opts.from === 'mysql')) {
		if (NOISE.test(statement)) continue;

		if (/^CREATE\s+(TEMPORARY\s+)?TABLE\b/i.test(statement)) {
			out.push(...convertCreateTable(state, statement, to));
			continue;
		}
		if (/^INSERT\b|^REPLACE\b/i.test(statement)) {
			out.push(...convertInsert(state, statement, to));
			continue;
		}
		if (/^DROP\s+(TABLE|INDEX|VIEW)\b/i.test(statement)) {
			out.push(`${rewriteIdentifiers(statement, to)};`);
			continue;
		}
		if (/^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(statement)) {
			out.push(`${convertStandaloneIndex(state, statement, to)};`);
			state.indexes++;
			continue;
		}
		if (
			/^CREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|VIEW|PROCEDURE|FUNCTION|EVENT)\b/i.test(statement)
		) {
			unsupported(
				state,
				statement,
				`${/TRIGGER|VIEW|PROCEDURE|FUNCTION|EVENT/i.exec(statement)?.[0]?.toUpperCase()} is not converted; its body is dialect-specific`
			);
			continue;
		}
		if (/^ALTER\s+TABLE\b/i.test(statement)) {
			unsupported(
				state,
				statement,
				'ALTER TABLE is not converted; SQLite supports only a subset and the difference is silent'
			);
			continue;
		}
		unsupported(state, statement, 'unrecognised statement');
	}

	// A MySQL dump MUST declare its charset. Without it the client connects on its own default --
	// latin1 on a stock MariaDB build -- and every 4-byte character is refused with
	// `Incorrect string value`, or silently mangled on a non-strict server. mysqldump emits the same
	// line for the same reason; the e2e lane found it by restoring an emoji.
	if (to === 'mysql' && out.length > 0) out.unshift('SET NAMES utf8mb4;');

	const sql = out.join('\n');
	return {
		sql: sql === '' ? '' : `${sql}\n`,
		statements: out.length,
		tables: state.tables,
		indexes: state.indexes,
		rows: state.rows,
		skipped: state.skipped,
		lossy: state.lossy,
		maxStatementChars: state.maxStatementChars,
		overLimit: [...state.overLimit]
			.map(([table, m]) => ({ table, ...m }))
			.sort((a, b) => b.widest - a.widest)
	};
}
