import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Reads every string key outside Drupal's cache bins, with its time to live, in one round trip.
 *
 * One fixed script, allow-listed by exact equality in `refuseRemote()`, so what runs on the host is
 * never built from input. It only reads: SCAN, TYPE, GET and PTTL. Keys and values leave hex
 * encoded, because a value may be binary and the stream is text. It stops at 5,000 keys and skips
 * a value over 64 KiB, and says how many of each, so a copy never claims to hold more than it does.
 *
 * Written with single quotes inside, no backslash and no dollar sign, so it can sit inside the
 * double quotes the allow-list's tokenizer accepts.
 */
export const REDIS_STATE_SCRIPT =
	"local function hex(s) return (string.gsub(s, '.', function(c) return string.format('%02x', string.byte(c)) end)) end " +
	"local out = {} local other = {} local big = 0 local trunc = false local cursor = '0' " +
	"repeat local r = redis.call('SCAN', cursor, 'COUNT', 1000) cursor = r[1] " +
	"for _, k in ipairs(r[2]) do if string.sub(k, 1, 13) ~= 'drupal.redis.' then " +
	"local t = redis.call('TYPE', k)['ok'] " +
	"if t == 'string' then local v = redis.call('GET', k) " +
	'if #v > 65536 then big = big + 1 elseif #out >= 5000 then trunc = true ' +
	"else out[#out + 1] = {hex(k), hex(v), redis.call('PTTL', k)} end " +
	'else other[t] = (other[t] or 0) + 1 end end end ' +
	"until cursor == '0' " +
	'return cjson.encode({keys = out, other = other, big = big, truncated = trunc})';

/** the widest `name` the `key_value_expire` table holds, which the shim also observes */
const NAME_MAX = 128;

/** the never marker the shim stores for a key with no expiry */
export const NO_EXPIRY = 2147483647;

/** the collection prefix the shim reads; the Redis database number follows it */
export const COLLECTION_PREFIX = 'cfw_redis.';

export interface RedisRow {
	key: Buffer;
	value: Buffer;
	/** unix seconds, or null for a key that never expires */
	expire: number | null;
}

export interface RedisCarry {
	rows: RedisRow[];
	/** keys of a type the stand-in does not answer for, by type, which do not travel */
	other: Record<string, number>;
	/** string values over 64 KiB, which do not travel */
	big: number;
	/** the script stopped at its key cap */
	truncated: boolean;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function isUtf8(bytes: Buffer): boolean {
	try {
		utf8.decode(bytes);
		return true;
	} catch {
		return false;
	}
}

/**
 * The script's output as rows, or null when it did not answer (an auth error, a missing client).
 *
 * `now` is when the keys were read, so a key with 90 seconds left has an expiry 90 seconds after
 * that moment rather than after the moment the copy is first used.
 */
export function parseRedisState(stdout: string, now: number): RedisCarry | null {
	const body = stdout.trim();
	if (body === '' || !body.startsWith('{')) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== 'object') return null;
	const reply = parsed as {
		keys?: unknown;
		other?: unknown;
		big?: unknown;
		truncated?: unknown;
	};
	// cjson writes an empty Lua table as an object
	const list = Array.isArray(reply.keys) ? reply.keys : [];
	const rows: RedisRow[] = [];
	for (const entry of list as unknown[]) {
		if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
			continue;
		}
		const pttl = typeof entry[2] === 'number' ? entry[2] : -1;
		// -2 is a key that expired between the scan and the read
		if (pttl === -2) continue;
		rows.push({
			key: Buffer.from(entry[0], 'hex'),
			value: Buffer.from(entry[1], 'hex'),
			expire: pttl < 0 ? null : now + Math.ceil(pttl / 1000)
		});
	}
	const other =
		reply.other !== null && typeof reply.other === 'object' && !Array.isArray(reply.other)
			? Object.fromEntries(
					Object.entries(reply.other as Record<string, unknown>).filter(
						(pair): pair is [string, number] => typeof pair[1] === 'number'
					)
				)
			: {};
	return {
		rows,
		other,
		big: typeof reply.big === 'number' ? reply.big : 0,
		truncated: reply.truncated === true
	};
}

/** PHP's `serialize()` of a string: the byte length, not the character count */
function phpString(value: string): string {
	return `s:${Buffer.byteLength(value)}:"${value}";`;
}

/**
 * The row name for a key, as the shim computes it: the key itself, or a digest of its bytes when it
 * is longer than the column or is not valid UTF-8.
 */
export function redisName(key: Buffer): string {
	return key.length <= NAME_MAX && isUtf8(key)
		? key.toString('utf8')
		: `sha256:${createHash('sha256').update(key).digest('hex')}`;
}

/**
 * The `value` column the shim reads: a serialized array holding the key and the value.
 *
 * Both are base64 encoded with a `b` marker when EITHER is not valid UTF-8, because the bridge to
 * the database carries text; the shim applies the same rule on write.
 */
export function packRedisRow(row: Pick<RedisRow, 'key' | 'value'>): string {
	const binary = !isUtf8(Buffer.concat([row.key, row.value]));
	return binary
		? `a:3:{${phpString('k')}${phpString(row.key.toString('base64'))}${phpString('v')}${phpString(row.value.toString('base64'))}${phpString('b')}b:1;}`
		: `a:2:{${phpString('k')}${phpString(row.key.toString('utf8'))}${phpString('v')}${phpString(row.value.toString('utf8'))}}`;
}

/**
 * Writes the rows into `key_value_expire`, in the collection the shim reads for database 0.
 *
 * The table is created when the dump did not carry it, because core only creates it on first use
 * and a site that never used it has none. Returns how many rows were written.
 */
export function insertRedisRows(db: DatabaseSync, rows: readonly RedisRow[]): number {
	db.exec(`CREATE TABLE IF NOT EXISTS key_value_expire (
		collection TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', value BLOB NOT NULL,
		expire INTEGER NOT NULL DEFAULT ${NO_EXPIRY}, PRIMARY KEY (collection, name))`);
	db.exec('CREATE INDEX IF NOT EXISTS key_value_expire_expire ON key_value_expire (expire)');
	const insert = db.prepare(
		'INSERT OR REPLACE INTO key_value_expire (collection, name, value, expire) VALUES (?, ?, ?, ?)'
	);
	for (const row of rows) {
		insert.run(
			`${COLLECTION_PREFIX}0`,
			redisName(row.key),
			packRedisRow(row),
			row.expire ?? NO_EXPIRY
		);
	}
	return rows.length;
}
