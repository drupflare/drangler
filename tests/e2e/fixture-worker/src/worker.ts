/**
 * A Durable Object that speaks the drupflare worker's HTTP contract, and nothing else.
 *
 * **What this is for, and what it is not.** drangler's `migrate export` and `health` are HTTP
 * clients; testing them against a hand-written `Response` proves only that the test author and the
 * command agree. Booting this under `wrangler dev` puts them in front of real workerd and, more to
 * the point, a real Durable Object SQLite -- the actual storage engine with its actual limits, which
 * is the half of the round trip that cannot be simulated.
 *
 * It is NOT a reimplementation of `dumpDatabase()`, and the e2e lane does not claim to test that.
 * The real worker's dump has its own suite in its own repository. What is proven here is that
 * drangler reads a real envelope off a real socket, that its converted SQL is accepted by a real DO
 * SQLite, and that the bytes survive the whole path.
 *
 * `/__rows` exists so the comparator has a reading that does not come through `/__export`. Sharing
 * one reader between the mover and the checker is the mistake `pack-sql.ts` documents: both sides
 * read 117 of 1,697 bytes through the same truncating API and the digests agreed.
 */

interface Env {
	SITE: DurableObjectNamespace;
}

const HEADER_VERSION = '1';

/** tables whose rows regenerate; the envelope reports the resolved names rather than the rule */
const REGENERABLE = [/^cache(_|$)/, /^sessions$/, /^watchdog$/, /^cfw_page$/];

/** what a Durable Object accepts as one statement */
const STATEMENT_CHARS = 100_000;

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export class FixtureSite {
	private sql: SqlStorage;
	private generation = 1;

	constructor(private ctx: DurableObjectState) {
		this.sql = ctx.storage.sql;
	}

	/**
	 * The site's owner token, minted once and kept.
	 *
	 * Derived from the object id so it is stable across a restart and different per site, which is
	 * what makes "the token is for another site" a reachable failure in the lane.
	 */
	private ownerToken(): string {
		return `owner-${this.ctx.id.toString().slice(0, 16)}`;
	}

	private tables(): string[] {
		return this.sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf%' ESCAPE '\\' ORDER BY name"
			)
			.toArray()
			.map((r) => String(r['name']))
			.filter((n) => !n.startsWith('_cf'));
	}

	private columns(table: string): string[] {
		return this.sql
			.exec('SELECT name FROM pragma_table_info(?)', table)
			.toArray()
			.map((r) => String(r['name']));
	}

	/**
	 * Every value as `typeof()` plus `hex()`, never as the column itself.
	 *
	 * A Durable Object integer read is lossy above 2^53 and a TEXT read stops at a NUL, so a dump
	 * that read the column would lose the two things this corpus exists to carry.
	 */
	private literal(type: string, hex: string, real: number | null): string {
		if (type === 'null') return 'NULL';
		if (type === 'real') {
			const n = Number(real);
			return Number.isInteger(n) && Math.abs(n) < 1e21 ? `${n}.0` : String(n);
		}
		const bytes = Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
		if (type === 'integer') return new TextDecoder().decode(bytes);
		if (type === 'blob') return `x'${hex}'`;
		let text: string;
		try {
			text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			return `CAST(x'${hex}' AS TEXT)`;
		}
		return text.includes('\0') ? `CAST(x'${hex}' AS TEXT)` : `'${text.replace(/'/g, "''")}'`;
	}

	private dump(all: boolean): {
		sql: string;
		statements: number;
		chars: number;
		tables: Record<string, number>;
		structureOnly: string[];
		maxStatementChars: number;
		replayable: boolean;
	} {
		const lines: string[] = [];
		const counts: Record<string, number> = {};
		const structureOnly: string[] = [];

		for (const table of this.tables()) {
			const ddl = this.sql
				.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)
				.toArray()[0];
			lines.push(`DROP TABLE IF EXISTS ${ident(table)};`);
			lines.push(`${String(ddl?.['sql']).replace(/;+\s*$/, '')};`);
			counts[table] = 0;

			const regenerable = REGENERABLE.some((p) => p.test(table));
			if (regenerable && !all) {
				structureOnly.push(table);
				continue;
			}

			const columns = this.columns(table);
			if (columns.length === 0) continue;
			const select = columns
				.map(
					(c, i) =>
						`typeof(${ident(c)}) AS t${i}, hex(${ident(c)}) AS h${i}, ` +
						`CASE WHEN typeof(${ident(c)}) = 'real' THEN ${ident(c)} END AS r${i}`
				)
				.join(', ');
			for (const row of this.sql.exec(`SELECT ${select} FROM ${ident(table)}`).toArray()) {
				const values = columns.map((_, i) =>
					this.literal(
						String(row[`t${i}`]),
						String(row[`h${i}`] ?? ''),
						row[`r${i}`] as number | null
					)
				);
				lines.push(
					`INSERT INTO ${ident(table)} (${columns.map(ident).join(', ')}) VALUES (${values.join(', ')});`
				);
				counts[table] = (counts[table] ?? 0) + 1;
			}
		}

		const sql = lines.join('\n');
		const maxStatementChars = lines.reduce((max, line) => Math.max(max, line.length), 0);
		return {
			sql,
			statements: lines.length,
			chars: sql.length,
			tables: counts,
			structureOnly,
			maxStatementChars,
			replayable: maxStatementChars <= STATEMENT_CHARS
		};
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// stands in for /firstrun, which is where a real site's owner token is returned once
		if (url.pathname === '/__firstrun') {
			return Response.json({ ok: true, ownerToken: this.ownerToken() });
		}

		// a JSON array of whole statements, never one blob to re-split: a TEXT value in this corpus
		// contains a newline and another contains a semicolon, so any splitter here would be wrong
		if (url.pathname === '/__seed') {
			const statements = (await request.json()) as string[];
			let applied = 0;
			for (const statement of statements) {
				const trimmed = statement.trim().replace(/;$/, '');
				if (trimmed === '') continue;
				try {
					this.sql.exec(trimmed);
				} catch (e) {
					return Response.json(
						{
							ok: false,
							applied,
							failed: trimmed.slice(0, 400),
							error: e instanceof Error ? e.message : String(e)
						},
						{ status: 422 }
					);
				}
				applied++;
			}
			this.generation++;
			return Response.json({ ok: true, applied });
		}

		// the comparator's reading, and deliberately not the one `/__export` uses
		if (url.pathname === '/__rows') {
			const table = url.searchParams.get('table') ?? '';
			const columns = this.columns(table);
			const select = columns.map((c) => `hex(${ident(c)}) AS ${ident(c)}`).join(', ');
			const rows = this.sql
				.exec(
					`SELECT ${select} FROM ${ident(table)} ORDER BY hex(${ident(columns[0] ?? 'rowid')})`
				)
				.toArray();
			return Response.json({ columns, rows });
		}

		// every table's row count in one call, so a spec can check a whole dump rather than a sample
		if (url.pathname === '/__counts') {
			const counts: Record<string, number> = {};
			for (const table of this.tables()) {
				counts[table] = Number(
					this.sql.exec(`SELECT COUNT(*) AS c FROM ${ident(table)}`).toArray()[0]?.[
						'c'
					] ?? 0
				);
			}
			return Response.json({ counts });
		}

		// the OWNER tier: a per-site bearer token, not a diagnostic flag. An unauthenticated caller
		// gets 401 and a challenge, which is what tells drangler to ask for a token rather than to
		// tell the user their worker is missing the route
		if (url.pathname === '/__export') {
			const offered = /^Bearer\s+(.+)$/i.exec(
				request.headers.get('authorization') ?? ''
			)?.[1];
			if (offered !== this.ownerToken()) {
				return new Response('owner token required\n', {
					status: 401,
					headers: { 'www-authenticate': 'Bearer realm="drupflare"' }
				});
			}
			const { sql, ...meta } = this.dump(url.searchParams.get('all') === '1');
			if (!meta.replayable) {
				return new Response(
					`widest statement is ${meta.maxStatementChars} characters, over the ${STATEMENT_CHARS} ceiling`,
					{ status: 409 }
				);
			}
			return url.searchParams.get('body') === '1'
				? Response.json({ ...meta, sql })
				: Response.json({ ...meta, sqlOmitted: sql.length });
		}

		if (url.pathname === '/__serve') {
			const path = url.searchParams.get('path') ?? '/';
			const count = this.tables().length;
			return new Response(`<!doctype html><html><body><h1>${path}</h1></body></html>`, {
				headers: {
					'content-type': 'text/html; charset=utf-8',
					'x-cfw-v': HEADER_VERSION,
					'x-cfw-cache': count > 0 ? 'HIT' : 'MISS',
					'x-cfw-generation': String(this.generation),
					'x-cfw-rendered-at': '0',
					'x-cfw-render-ms': '0',
					'x-cfw-serve-ms': '0',
					'x-cfw-php-booted': '0',
					'x-cfw-queue-depth': '0'
				}
			});
		}

		return new Response('not found\n', { status: 404 });
	}
}

const ROUTES: Record<string, string> = {
	'/serve': '/__serve',
	'/export': '/__export',
	'/rows': '/__rows',
	'/counts': '/__counts',
	'/seed': '/__seed',
	'/firstrun': '/__firstrun'
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const inner = ROUTES[url.pathname];
		if (inner === undefined) return new Response('not found\n', { status: 404 });
		const site = url.searchParams.get('site') ?? 'site';
		const stub = env.SITE.get(env.SITE.idFromName(site));
		const target = new URL(request.url);
		target.pathname = inner;
		const response = await stub.fetch(new Request(target, request));
		const headers = new Headers(response.headers);
		if (url.pathname === '/serve') headers.set('x-cfw-edge', 'MISS');
		return new Response(response.body, { status: response.status, headers });
	}
};
