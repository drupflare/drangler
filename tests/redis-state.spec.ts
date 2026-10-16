import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { refuseRemote } from '../src/migrate/preview';
import {
	COLLECTION_PREFIX,
	insertRedisRows,
	NO_EXPIRY,
	packRedisRow,
	parseRedisState,
	REDIS_STATE_SCRIPT,
	redisName
} from '../src/migrate/redis-state';

const hex = (text: string | Buffer) => Buffer.from(text).toString('hex');

describe('the script that reads the app keys', () => {
	it('is accepted by the allow-list only as itself, with the one argument it takes', () => {
		const command = `redis-cli eval "${REDIS_STATE_SCRIPT}" 0`;
		expect(refuseRemote(command)).toBeNull();
		expect(
			refuseRemote(`redis-cli eval "${REDIS_STATE_SCRIPT} redis.call('FLUSHALL')" 0`)
		).toMatch(/only scans/);
		expect(refuseRemote(`redis-cli eval "return redis.call('FLUSHALL')" 0`)).toMatch(
			/only scans/
		);
		expect(refuseRemote(`redis-cli eval "${REDIS_STATE_SCRIPT}" 1 x`)).toMatch(/only scans/);
	});

	it('only reads: SCAN, TYPE, GET and PTTL are the only commands it calls', () => {
		const called = [...REDIS_STATE_SCRIPT.matchAll(/redis\.call\('([A-Z]+)'/g)].map(
			(m) => m[1]
		);
		expect(new Set(called)).toEqual(new Set(['SCAN', 'TYPE', 'GET', 'PTTL']));
	});

	it('survives the tokenizer: no backslash, dollar sign, backtick or double quote inside', () => {
		expect(REDIS_STATE_SCRIPT).not.toMatch(/[\\$`"]/);
	});

	it('leaves the Drupal cache bins to regenerate, by their default prefix', () => {
		expect(REDIS_STATE_SCRIPT).toContain("'drupal.redis.'");
	});
});

describe('parseRedisState', () => {
	const NOW = 1_800_000_000;
	const reply = (keys: unknown[], extra: Record<string, unknown> = {}) =>
		JSON.stringify({ keys, other: {}, big: 0, truncated: false, ...extra });

	it('turns hex keys and values into bytes, and a ttl into an expiry from the moment it was read', () => {
		const state = parseRedisState(
			reply([
				[hex('cloud:points:1'), hex('{"p":5}'), 90_500],
				[hex('motd_cycle_index'), hex('3'), -1]
			]),
			NOW
		);
		expect(state?.rows).toHaveLength(2);
		expect(state?.rows[0]?.key.toString()).toBe('cloud:points:1');
		expect(state?.rows[0]?.value.toString()).toBe('{"p":5}');
		expect(state?.rows[0]?.expire).toBe(NOW + 91);
		expect(state?.rows[1]?.expire).toBeNull();
	});

	it('drops a key that expired between the scan and the read', () => {
		const state = parseRedisState(reply([[hex('gone'), hex('x'), -2]]), NOW);
		expect(state?.rows).toEqual([]);
	});

	it('reads an empty scan, which cjson writes as an object, as no keys', () => {
		expect(
			parseRedisState('{"keys":{},"other":{},"big":0,"truncated":false}', NOW)?.rows
		).toEqual([]);
	});

	it('carries the counts of what did not travel', () => {
		const state = parseRedisState(
			reply([], { other: { hash: 3, list: 1 }, big: 2, truncated: true }),
			NOW
		);
		expect(state).toMatchObject({ other: { hash: 3, list: 1 }, big: 2, truncated: true });
	});

	it("answers null for an error or a reply that is not the script's", () => {
		expect(parseRedisState('NOAUTH Authentication required.', NOW)).toBeNull();
		expect(parseRedisState('(error) ERR unknown command', NOW)).toBeNull();
		expect(parseRedisState('', NOW)).toBeNull();
		expect(parseRedisState('{not json', NOW)).toBeNull();
	});
});

describe('the rows as the shim reads them (golden strings are PHP serialize() output)', () => {
	it('packs a plain key and value as a two-element array', () => {
		expect(
			packRedisRow({ key: Buffer.from('cloud:points:1'), value: Buffer.from('{"p":5}') })
		).toBe('a:2:{s:1:"k";s:14:"cloud:points:1";s:1:"v";s:7:"{"p":5}";}');
	});

	it('counts bytes, not characters, in a multibyte key', () => {
		expect(packRedisRow({ key: Buffer.from('café'), value: Buffer.from('x') })).toBe(
			'a:2:{s:1:"k";s:5:"café";s:1:"v";s:1:"x";}'
		);
	});

	it('base64 encodes both and marks the row when either is not valid UTF-8', () => {
		expect(packRedisRow({ key: Buffer.from('b'), value: Buffer.from([0xff, 0xfe]) })).toBe(
			'a:3:{s:1:"k";s:4:"Yg==";s:1:"v";s:4:"//4=";s:1:"b";b:1;}'
		);
	});

	it('names a row by the key, or by a digest of its bytes when it is long or not UTF-8', () => {
		expect(redisName(Buffer.from('unsubscribe_token_abc'))).toBe('unsubscribe_token_abc');
		expect(redisName(Buffer.from('k'.repeat(128)))).toBe('k'.repeat(128));
		expect(redisName(Buffer.from('k'.repeat(200)))).toBe(
			'sha256:6de3c288691037361962041f2273f381658187e426187979e0273d026ea1b946'
		);
		expect(redisName(Buffer.concat([Buffer.from('b'), Buffer.from([0xff])]))).toBe(
			'sha256:7d1016b8ca164152081d146beee2d283458686459be947524a721f88e255c88e'
		);
	});
});

describe('insertRedisRows', () => {
	it('creates the table a site that never used it lacks, then writes the rows into database 0', () => {
		const db = new DatabaseSync(':memory:');
		const written = insertRedisRows(db, [
			{ key: Buffer.from('a'), value: Buffer.from('one'), expire: null },
			{ key: Buffer.from('b'), value: Buffer.from('two'), expire: 1_800_000_100 }
		]);
		expect(written).toBe(2);
		const rows = db
			.prepare('SELECT collection, name, expire FROM key_value_expire ORDER BY name')
			.all();
		expect(rows).toEqual([
			{ collection: `${COLLECTION_PREFIX}0`, name: 'a', expire: NO_EXPIRY },
			{ collection: `${COLLECTION_PREFIX}0`, name: 'b', expire: 1_800_000_100 }
		]);
		const value = db.prepare("SELECT value FROM key_value_expire WHERE name = 'a'").get();
		expect(value).toEqual({ value: 'a:2:{s:1:"k";s:1:"a";s:1:"v";s:3:"one";}' });
	});

	it('uses the table the dump already carries, and replaces a key it holds', () => {
		const db = new DatabaseSync(':memory:');
		db.exec(
			"CREATE TABLE key_value_expire (collection TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', value BLOB NOT NULL, expire INTEGER NOT NULL DEFAULT 2147483647, PRIMARY KEY (collection, name))"
		);
		db.exec(
			"INSERT INTO key_value_expire VALUES ('form_state', 'f', 'x', 5), ('cfw_redis.0', 'a', 'old', 5)"
		);
		insertRedisRows(db, [{ key: Buffer.from('a'), value: Buffer.from('new'), expire: null }]);
		expect(db.prepare('SELECT COUNT(*) AS n FROM key_value_expire').get()).toEqual({ n: 2 });
		expect(
			db.prepare("SELECT value FROM key_value_expire WHERE collection = 'cfw_redis.0'").get()
		).toEqual({ value: 'a:2:{s:1:"k";s:1:"a";s:1:"v";s:3:"new";}' });
	});
});
