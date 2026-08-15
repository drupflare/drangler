import { describe, expect, it } from 'vitest';
import { runSecretsScan } from '../src/commands/secrets';
import { FindingError, UsageError } from '../src/errors';
import { memoryFiles } from '../src/host/files';
import { CREDENTIAL_PATTERNS } from '../src/secrets/patterns';
import { MAX_FILE_BYTES, redact, scanPaths, scanText, SKIP_DIRS, walk } from '../src/secrets/scan';
import { testContext } from './helpers';

const SETTINGS = [
	'<?php',
	"$databases['default']['default'] = [",
	"  'password' => 'hunter2',",
	'];',
	"$settings['hash_salt'] = 'AbCdEf0123456789';"
].join('\n');

const DUMP = "INSERT INTO users_field_data VALUES (1,'$2y$12$" + 'a'.repeat(53) + "');";

describe('patterns', () => {
	it('has a unique id, kind and risk for every entry', () => {
		const ids = CREDENTIAL_PATTERNS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(CREDENTIAL_PATTERNS.every((p) => p.risk.length > 10)).toBe(true);
	});

	it('does not fire on an identifier without a value', () => {
		const inert = [
			"$settings['hash_salt'] = '';",
			'function password($x) {}',
			'const DATABASE_URL = process.env.DATABASE_URL;',
			'system.private_key is read by PrivateKey.php'
		].join('\n');
		expect(scanText('/inert.php', inert)).toEqual([]);
	});
});

describe('scanText', () => {
	it('finds the settings.php credentials with their line numbers', () => {
		const hits = scanText('/settings.php', SETTINGS);
		expect(hits.map((h) => h.id)).toEqual(['db-password', 'hash-salt']);
		expect(hits[0]?.line).toBe(3);
		expect(hits[1]?.line).toBe(5);
	});

	it('never returns the matched value', () => {
		const hits = scanText('/settings.php', SETTINGS);
		expect(hits.every((h) => !h.redacted.includes('hunter2'))).toBe(true);
		expect(hits.every((h) => !h.redacted.includes('AbCdEf0123456789'))).toBe(true);
		expect(hits[0]?.redacted).toContain('***');
	});

	it('finds a password hash in a dump', () => {
		expect(scanText('/dump.sql', DUMP).map((h) => h.id)).toEqual(['bcrypt']);
	});

	it('finds a PEM key, an AWS key id, a connection URL and a Cloudflare token', () => {
		const body = [
			'-----BEGIN RSA PRIVATE KEY-----',
			'AKIAABCDEFGHIJKLMNOP',
			'DATABASE_URL=mysql://user:pw@db.example/drupal',
			'CLOUDFLARE_API_TOKEN=' + 'z'.repeat(40)
		].join('\n');
		expect(
			scanText('/.env', body)
				.map((h) => h.id)
				.sort()
		).toEqual(['aws-key', 'cf-token', 'database-url', 'pem']);
	});

	it('finds the private_key state row', () => {
		expect(
			scanText(
				'/dump.sql',
				"INSERT INTO key_value VALUES ('system.private_key','s:43:\"x\";');"
			).map((h) => h.id)
		).toEqual(['private-key']);
	});
});

describe('redact', () => {
	it('truncates a very long line before redacting it', () => {
		const line = `${'x'.repeat(400)}'password' => 'secret'`;
		expect(redact(line, CREDENTIAL_PATTERNS[3]!)).toHaveLength(203);
	});
});

describe('walk', () => {
	it('descends the tree and skips the vendored directories', () => {
		const files = memoryFiles({
			'/a/one.php': '',
			'/a/sub/two.php': '',
			'/a/node_modules/dep/x.js': '',
			'/a/.git/config': ''
		});
		expect(walk(files, '/a')).toEqual(['/a/one.php', '/a/sub/two.php']);
	});

	it('returns a file path as itself', () => {
		expect(walk(memoryFiles({ '/a/one.php': '' }), '/a/one.php')).toEqual(['/a/one.php']);
	});

	it('covers every directory in the skip list', () => {
		const seed = Object.fromEntries([...SKIP_DIRS].map((d) => [`/a/${d}/x`, 'secret']));
		expect(walk(memoryFiles({ ...seed, '/a/keep': '' }), '/a')).toEqual(['/a/keep']);
	});
});

describe('scanPaths', () => {
	it('scans several roots and reports what it read', () => {
		const files = memoryFiles({ '/site/settings.php': SETTINGS, '/dump.sql': DUMP });
		const report = scanPaths(files, ['/site', '/dump.sql']);
		expect(report.scanned).toEqual(['/site/settings.php', '/dump.sql']);
		expect(report.hits).toHaveLength(3);
	});

	it('reports a path that does not exist rather than failing', () => {
		expect(scanPaths(memoryFiles({}), ['/nope']).skipped).toEqual([
			{ path: '/nope', reason: 'does not exist' }
		]);
	});

	it('skips a file over the size ceiling', () => {
		const files = memoryFiles({ '/big.sql': 'x' });
		const report = scanPaths({ ...files, size: () => MAX_FILE_BYTES + 1 }, ['/big.sql']);
		expect(report.skipped[0]?.reason).toContain('larger than');
		expect(report.scanned).toEqual([]);
	});

	it('skips a file it cannot stat or read', () => {
		const files = memoryFiles({ '/a.sql': 'x', '/b.sql': 'y' });
		const unstatable = {
			...files,
			size: (p: string) => {
				if (p === '/a.sql') throw new Error('EACCES');
				return 1;
			}
		};
		expect(scanPaths(unstatable, ['/a.sql']).skipped[0]?.reason).toBe('unreadable');
		const unreadable = {
			...files,
			readText: () => {
				throw new Error('EACCES');
			}
		};
		expect(scanPaths(unreadable, ['/b.sql']).skipped[0]?.reason).toBe('unreadable');
	});
});

describe('secrets scan command', () => {
	it('reports a clean tree and exits normally', async () => {
		const ctx = testContext({ files: memoryFiles({ '/a/index.php': '<?php echo 1;' }) });
		await expect(runSecretsScan(ctx, ['/a'], {})).resolves.toBeUndefined();
		expect(ctx.io.text()).toContain('hits');
	});

	it('exits with a finding and prints the risk, never the value', async () => {
		const ctx = testContext({ files: memoryFiles({ '/settings.php': SETTINGS }) });
		await expect(runSecretsScan(ctx, ['/settings.php'], {})).rejects.toThrow(FindingError);
		expect(ctx.io.text()).toContain('database password');
		expect(ctx.io.text()).not.toContain('hunter2');
	});

	it('lists what it skipped', async () => {
		const ctx = testContext({ files: memoryFiles({}) });
		await runSecretsScan(ctx, ['/nope'], {});
		expect(ctx.io.text()).toContain('does not exist');
	});

	it('emits JSON on request', async () => {
		const ctx = testContext({ files: memoryFiles({ '/dump.sql': DUMP }) });
		await expect(runSecretsScan(ctx, ['/dump.sql'], { json: true })).rejects.toThrow(
			FindingError
		);
		expect(ctx.io.json<{ hits: { kind: string }[] }>().hits[0]?.kind).toBe('password hash');
	});

	it('refuses with no paths at all', async () => {
		await expect(runSecretsScan(testContext(), [], {})).rejects.toThrow(UsageError);
	});
});
