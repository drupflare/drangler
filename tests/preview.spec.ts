import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
	ownDuplicate,
	PREVIEW_MIN_WORKER,
	previewName,
	publishRootFiles,
	refuseOldWorker,
	runPreviewCommand,
	verify
} from '../src/commands/preview';
import { FindingError, UsageError } from '../src/errors';
import { nodeRunner, type CommandResult, type CommandRunner } from '../src/host/exec';
import { memoryFiles, nodeFiles } from '../src/host/files';
import {
	assetHeadersFile,
	buildSiteDb,
	devVarLine,
	dialectOf,
	FILE_CHUNK_BYTES,
	missingLibraries,
	parseConfigOverrides,
	parseHtaccess,
	previewCommands,
	privateFilesCommand,
	publishableRootFiles,
	readOnlyTransport,
	refuseRemote,
	trustedHosts,
	walkFiles
} from '../src/migrate/preview';
import { surveyPlan } from '../src/migrate/survey';
import type { Transport } from '../src/migrate/transport';
import { fakeFetch, ok, testContext, testGlobals } from './helpers';

const ROOT = '/var/www/html';

/** an excerpt of the .htaccess drupal/core scaffolds, enough to exercise every stock shape */
const STOCK_HTACCESS = [
	'<FilesMatch "\\.(engine|inc|install|make|module|profile|po|sh|.*sql|theme|twig|tpl(\\.php)?|xtmpl|yml)(~|\\.sw[op]|\\.bak|\\.orig|\\.save)?$|^(\\.(?!well-known).*|Entries.*|Repository|Root|Tag|Template|composer\\.(json|lock)|web\\.config|yarn\\.lock|package\\.json)$|^#.*#$|\\.php(~|\\.sw[op]|\\.bak|\\.orig|\\.save)$">',
	'  <IfModule mod_authz_core.c>',
	'    Require all denied',
	'  </IfModule>',
	'</FilesMatch>',
	'Options -Indexes',
	'<IfModule mod_rewrite.c>',
	'  RewriteEngine on',
	'  RewriteRule ^ - [E=protossl]',
	'  RewriteCond %{HTTPS} on',
	'  RewriteRule ^ - [E=protossl:s]',
	'  RewriteRule "/\\.|^\\.(?!well-known/)" - [F]',
	'  # RewriteRule ^ http%{ENV:protossl}://www.%{HTTP_HOST}%{REQUEST_URI} [L,R=301]',
	'  RewriteCond %{REQUEST_FILENAME} !-f',
	'  RewriteCond %{REQUEST_FILENAME} !-d',
	'  RewriteCond %{REQUEST_URI} !=/favicon.ico',
	'  RewriteRule ^ index.php [L]',
	'</IfModule>',
	'<IfModule mod_headers.c>',
	'  Header always set X-Content-Type-Options nosniff',
	'</IfModule>'
].join('\n');

/** wrangler's bundled dotenv 16.3.1 value handling, which is what reads .dev.vars */
function wranglerDotenv(src: string): Record<string, string> {
	const LINE =
		/(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;
	const obj: Record<string, string> = {};
	for (const m of src.matchAll(LINE)) {
		let value = (m[2] ?? '').trim();
		const quote = value[0];
		value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2');
		if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
		obj[m[1]!] = value;
	}
	return obj;
}

/** a transport that records every command and answers from a table */
function recording(
	answers: Record<string, CommandResult> = {},
	downloads: Record<string, Uint8Array> = {}
) {
	const calls: string[] = [];
	const transport: Transport = {
		label: 'fake',
		async exec(command) {
			calls.push(command);
			return answers[command] ?? { code: 127, stdout: '', stderr: 'not scripted' };
		},
		async download(command, out) {
			calls.push(command);
			const bytes = downloads[command];
			// an unscripted code tree is a site that does not have one, which is how tar reports it
			if (bytes === undefined && command.startsWith('tar -cf - -C ')) {
				return {
					code: 2,
					stderr: 'tar: x: Cannot stat: No such file or directory',
					bytes: 0
				};
			}
			if (bytes === undefined) return { code: 127, stderr: 'not scripted', bytes: 0 };
			mkdirSync(join(out, '..'), { recursive: true });
			writeFileSync(out, bytes);
			return { code: 0, stderr: '', bytes: bytes.length };
		}
	};
	return { transport, calls };
}

const scratch: string[] = [];
const tmp = () => {
	const dir = mkdtempSync(join(tmpdir(), 'drangler-preview-'));
	scratch.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the read-only allow-list', () => {
	it('passes every command preview can send, for any valid root', () => {
		for (const root of ['/var/www/html', '/srv/drupal/web', '/opt/site-1.2_x']) {
			for (const command of previewCommands(root)) {
				expect(refuseRemote(command), command).toBeNull();
			}
		}
		// the survey plan is a subset, so a command added there is covered the day it lands
		expect(previewCommands(ROOT)).toEqual(
			expect.arrayContaining(surveyPlan(ROOT).map((s) => s.command))
		);
	});

	it.each([
		['rm -rf /var/www/html'],
		['cd /var/www/html && rm settings.php'],
		['cd /var/www/html && drush cr'],
		['cd /var/www/html && drush sql:dump --result-file=/tmp/site.sql'],
		['cd /var/www/html && drush sql:dump --gzip'],
		['cd /var/www/html && drush sql:query "DELETE FROM node"'],
		['cd /var/www/html && drush sql:query "SELECT 1; DROP TABLE node"'],
		['cd /var/www/html && drush sql:query "SELECT * INTO OUTFILE \'/tmp/x\' FROM users"'],
		['cd /var/www/html && drush sql:query "SELECT $(id)"'],
		['php -v > /tmp/out'],
		['php -r "unlink(1);"'],
		['tar -cf /tmp/files.tar -C /var/www/html/sites/default files'],
		['tar -xf - -C /var/www/html'],
		['find /var/www/html -type f -delete'],
		['cat /etc/passwd | wc -l'],
		['du -sk /var/www/html; rm -rf /'],
		['php -v & rm x'],
		['php -v || rm x'],
		['echo `id`'],
		["php -m 'x'"],
		['du -sk /var/www/html\nrm x'],
		['du -sk ../etc'],
		['']
	])('refuses %j', (command) => {
		expect(refuseRemote(command)).not.toBeNull();
	});

	it('refuses before the host sees anything', async () => {
		const { transport, calls } = recording();
		const guarded = readOnlyTransport(transport);
		await expect(guarded.exec('rm -rf /')).rejects.toThrow(UsageError);
		await expect(guarded.download('drush sql:dump --result-file=/x', '/tmp/x')).rejects.toThrow(
			UsageError
		);
		expect(calls).toEqual([]);
		await guarded.exec('php -v');
		expect(calls).toEqual(['php -v']);
	});
});

describe('dialectOf', () => {
	it('maps every driver drush reports that has a converter, and nothing else', () => {
		expect(dialectOf('mysql')).toBe('mysql');
		expect(dialectOf('mariadb')).toBe('mysql');
		expect(dialectOf('pgsql')).toBe('pgsql');
		expect(dialectOf('sqlite')).toBe('sqlite');
		expect(dialectOf('sqlsrv')).toBeNull();
		expect(dialectOf(null)).toBeNull();
	});
});

describe('privateFilesCommand', () => {
	it('resolves a path relative to the Drupal root, as settings.php usually writes it', () => {
		expect(privateFilesCommand('/var/www/html', '../private')).toBe(
			'tar -cf - -C /var/www private'
		);
		expect(privateFilesCommand('/var/www/html', '/srv/private-files')).toBe(
			'tar -cf - -C /srv private-files'
		);
	});

	it('refuses a path it cannot stream safely rather than quoting it into a command', () => {
		expect(privateFilesCommand('/var/www/html', '/srv/my files')).toBeNull();
		expect(privateFilesCommand('/var/www/html', '/srv/x;rm')).toBeNull();
	});
});

describe('missingLibraries', () => {
	it('names the libraries the duplicate lacks, never a Drupal extension or core', () => {
		const source = JSON.stringify({
			packages: [
				{ name: 'drupal/core', version: '11.2.0', type: 'drupal-core' },
				{ name: 'drupal/pathauto', version: '1.13.0', type: 'drupal-module' },
				{ name: 'stripe/stripe-php', version: 'v13.0.0', type: 'library' },
				{ name: 'symfony/http-foundation', version: 'v7.4.0', type: 'library' },
				{ name: 'composer/installers', version: 'v2.3.0', type: 'composer-plugin' },
				{ name: 'drupal/core-recommended', version: '11.2.0', type: 'metapackage' }
			]
		});
		const worker = JSON.stringify({
			packages: [{ name: 'symfony/http-foundation', version: 'v7.4.1', type: 'library' }]
		});
		expect(missingLibraries(source, worker)).toEqual([
			{ name: 'stripe/stripe-php', version: 'v13.0.0' }
		]);
		expect(missingLibraries('not json', worker)).toEqual([]);
	});

	it('leaves out drush and everything reachable only through it', () => {
		const source = JSON.stringify({
			packages: [
				{
					name: 'drush/drush',
					version: '13.0.0',
					type: 'library',
					require: { 'psy/psysh': '*', 'league/container': '*' }
				},
				{
					name: 'psy/psysh',
					version: 'v0.12.0',
					type: 'library',
					require: { 'nikic/php-parser': '*' }
				},
				{ name: 'nikic/php-parser', version: 'v5.0.0', type: 'library' },
				{ name: 'league/container', version: '4.2.0', type: 'library' },
				{
					name: 'stripe/stripe-php',
					version: 'v13.0.0',
					type: 'library',
					require: { 'league/container': '*' }
				}
			]
		});
		// league/container stays because a runtime package needs it too
		expect(missingLibraries(source, '{}').map((m) => m.name)).toEqual([
			'league/container',
			'stripe/stripe-php'
		]);
	});
});

describe('previewName', () => {
	it('always carries the preview prefix, so a deploy cannot name a real worker', () => {
		expect(previewName('Old.Example.com')).toBe('drupflare-preview-old-example-com');
		const long = previewName(`${'a'.repeat(80)}.example`);
		expect(long.startsWith('drupflare-preview-')).toBe(true);
		expect(long.length).toBeLessThanOrEqual(63);
		expect(long.endsWith('-')).toBe(false);
	});
});

describe('interaction', () => {
	const base = { host: 'deploy@old.example', root: ROOT };

	it('dry run prints every step and sends nothing', async () => {
		const { transport, calls } = recording();
		const ctx = testContext();
		await runPreviewCommand(ctx, {
			...base,
			transport,
			globals: testGlobals({ dryRun: true }, ctx)
		});
		expect(calls).toEqual([]);
		expect(ctx.io.text()).toContain('nothing was executed');
		expect(ctx.io.text()).toContain('tar -cf - -C /var/www/html/sites/default files');
	});

	it('dry run names every fixed command the real run can send', async () => {
		const ctx = testContext();
		await runPreviewCommand(ctx, {
			...base,
			transport: recording().transport,
			globals: testGlobals({ dryRun: true, json: true }, ctx)
		});
		const listed = ctx.io.json<{ remote: string[] }>().remote.join('\n');
		// the private-files and root-file streams name paths only a live run discovers
		const fixed = previewCommands(ROOT).filter(
			(c) =>
				!c.startsWith('tar -cf - -C /var/www private') &&
				!c.startsWith('tar -cf - -C /var private-files') &&
				!c.includes('google0123abcd.html') &&
				c !== `cd ${ROOT} && drush sql:dump`
		);
		for (const command of fixed) expect(listed).toContain(command);
	});

	it('refuses with no terminal, per step and with --full, before any command', async () => {
		for (const full of [false, true]) {
			const { transport, calls } = recording();
			const ctx = testContext();
			await expect(
				runPreviewCommand(ctx, { ...base, full, transport, globals: testGlobals({}, ctx) })
			).rejects.toThrow(/no terminal/);
			expect(calls).toEqual([]);
		}
	});

	it('ignores --yes; it still asks', async () => {
		const { transport, calls } = recording();
		const ctx = testContext();
		await expect(
			runPreviewCommand(ctx, { ...base, transport, globals: testGlobals({ yes: true }, ctx) })
		).rejects.toThrow(/no terminal/);
		expect(calls).toEqual([]);
	});

	it('--full runs nothing unless the host name is typed back exactly', async () => {
		const { transport, calls } = recording();
		const ctx = testContext({ ask: async () => 'old.exampel' });
		await expect(
			runPreviewCommand(ctx, {
				...base,
				full: true,
				transport,
				globals: testGlobals({}, ctx)
			})
		).rejects.toThrow(/nothing ran/);
		expect(calls).toEqual([]);
	});

	it('stops at the first step answered no and reports what did not run', async () => {
		const { transport, calls } = recording();
		const ctx = testContext({ ask: async () => 'n' });
		await runPreviewCommand(ctx, { ...base, transport, globals: testGlobals({}, ctx) });
		expect(calls).toEqual([]);
		expect(ctx.io.text()).toContain('stopped before survey');
	});
});

describe('settings overrides and root files', () => {
	it('carries literal $config overrides nested, and names the ones set by expression', () => {
		const php = [
			'<?php',
			"$databases['default']['default'] = ['password' => 'db-secret'];",
			"$config['system.site']['name'] = 'Agency Portal';",
			"$config['smtp.settings']['smtp_password'] = \"s3cr\\\"et\";",
			"$config['system.performance']['css']['preprocess'] = TRUE;",
			"$config['system.logging']['error_level'] = 'hide'; // prod",
			"$config['stripe.settings']['secret'] = getenv('STRIPE_SECRET');",
			"$settings['hash_salt'] = 'not-config';"
		].join('\n');
		const got = parseConfigOverrides(php);
		expect(got.config).toEqual({
			'system.site': { name: 'Agency Portal' },
			'smtp.settings': { smtp_password: 's3cr"et' },
			'system.performance': { css: { preprocess: true } },
			'system.logging': { error_level: 'hide' }
		});
		expect(got.expressions).toEqual(['stripe.settings.secret']);
		// the database credential and $settings never ride along
		expect(JSON.stringify(got)).not.toContain('db-secret');
		expect(JSON.stringify(got)).not.toContain('not-config');
	});

	it('publishes only static types from the docroot, never scaffold or a leaked backup', () => {
		const listing = [
			'/var/www/html/index.php',
			'/var/www/html/.htaccess',
			'/var/www/html/robots.txt',
			'/var/www/html/README.md',
			'/var/www/html/google0123abcd.html',
			'/var/www/html/ads.txt',
			'/var/www/html/favicon.ico',
			'/var/www/html/backup.sql',
			'/var/www/html/.env',
			'/var/www/html/site.webmanifest'
		].join('\n');
		expect(publishableRootFiles(listing, '/var/www/html')).toEqual([
			'ads.txt',
			'favicon.ico',
			'google0123abcd.html',
			'robots.txt',
			'site.webmanifest'
		]);
	});

	it('copies root files into the assets and un-ignores each, since the list denies by default', () => {
		const files = memoryFiles({
			'/o/root/google0123abcd.html': 'google-site-verification',
			'/o/root/.well-known/security.txt': 'Contact: x',
			'/ws/assets/.assetsignore': '/*\n\n!/robots.txt\n'
		});
		const ctx = testContext({ files });
		publishRootFiles(ctx, '/o/root', '/ws', ['google0123abcd.html'], true);
		expect(files.readText('/ws/assets/google0123abcd.html')).toBe('google-site-verification');
		expect(files.readText('/ws/assets/.well-known/security.txt')).toBe('Contact: x');
		const ignore = files.readText('/ws/assets/.assetsignore').split('\n');
		expect(ignore).toEqual(
			expect.arrayContaining([
				'/*',
				'!/robots.txt',
				'!/google0123abcd.html',
				'!/.well-known/'
			])
		);
	});
});

describe('trustedHosts', () => {
	it('reads the array form, the push form and both escapes, and separates the wildcards', () => {
		const php = [
			"$settings['trusted_host_patterns'] = array(",
			"  '^example\\.org$',",
			'  "^www\\\\.example\\\\.org$",',
			"  '^.+\\.example\\.org$',",
			');',
			"$settings['trusted_host_patterns'][] = '^my-site\\.example\\.net$';"
		].join('\n');
		expect(trustedHosts(php)).toEqual({
			hosts: ['example.org', 'www.example.org', 'my-site.example.net'],
			patterns: ['^.+\\.example\\.org$']
		});
	});

	it('finds nothing in a settings file without the setting', () => {
		expect(trustedHosts("<?php\n$settings['hash_salt'] = 'x';")).toEqual({
			hosts: [],
			patterns: []
		});
	});
});

describe('buildSiteDb', () => {
	it('replays the dump and stores each file in chunks the worker reassembles by seq', () => {
		const dir = tmp();
		const big = new Uint8Array(FILE_CHUNK_BYTES * 2 + 7).map((_, i) => i % 251);
		const report = buildSiteDb(
			join(dir, 'site.sqlite'),
			'CREATE TABLE node (nid INTEGER); INSERT INTO node VALUES (1), (2);' +
				'CREATE TABLE file_managed (fid INTEGER); INSERT INTO file_managed VALUES (1);',
			[
				{ rel: 'photo.jpg', bytes: big },
				{ rel: 'empty.txt', bytes: new Uint8Array(0) }
			],
			1_000
		);
		expect(report).toMatchObject({
			nodes: 2,
			fileRows: 1,
			filesStored: 2,
			fileBytes: big.length
		});

		const db = new DatabaseSync(join(dir, 'site.sqlite'));
		const meta = db
			.prepare("SELECT size, mime, chunks FROM cfw_file WHERE uri = 'public://photo.jpg'")
			.get();
		expect(meta).toEqual({ size: big.length, mime: 'image/jpeg', chunks: 3 });
		const chunks = db
			.prepare(
				"SELECT bytes FROM cfw_file_chunk WHERE uri = 'public://photo.jpg' ORDER BY seq"
			)
			.all() as { bytes: Uint8Array }[];
		expect(Buffer.concat(chunks.map((c) => c.bytes))).toEqual(Buffer.from(big));
		// an empty file is one empty chunk, which is what the worker's own reader expects
		expect(
			db.prepare("SELECT chunks FROM cfw_file WHERE uri = 'public://empty.txt'").get()
		).toEqual({
			chunks: 1
		});
		db.close();
	});

	it('skips the trees Drupal regenerates', () => {
		const files = memoryFiles({
			'/f/a.png': 'x',
			'/f/inline/b.pdf': 'y',
			'/f/styles/thumbnail/a.png': 'z',
			'/f/css/c.css': 'z',
			'/f/php/twig/t.php': 'z',
			'/f/.htaccess': 'Deny from all',
			'/f/inline/.htaccess': 'Options -Indexes'
		});
		expect(walkFiles(files, '/f')).toEqual(['a.png', 'inline/b.pdf']);
	});

	it('leaves out a directory whose .htaccess denies every request, and names it', () => {
		const files = memoryFiles({
			'/f/a.png': 'x',
			'/f/config_abc/sync/.htaccess':
				'<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>',
			'/f/config_abc/sync/system.site.yml': 'name: secret',
			'/f/legacy/.htaccess': 'Deny from all',
			'/f/legacy/old.txt': 'x',
			'/f/open/.htaccess': 'Options -Indexes',
			'/f/open/c.pdf': 'x'
		});
		const protectedDirs: string[] = [];
		expect(walkFiles(files, '/f', '', protectedDirs)).toEqual(['a.png', 'open/c.pdf']);
		expect(protectedDirs.sort()).toEqual(['config_abc/sync', 'legacy']);
	});
});

describe('ownDuplicate', () => {
	const updbServer = (phases: string[]) => {
		let at = 0;
		return fakeFetch((url, init) => {
			if (url.includes('/firstrun')) return Response.json({ ok: true, ownerToken: 'tok' });
			if (url.includes('/updb')) {
				if (init?.method === 'POST') at = Math.min(at + 1, phases.length - 1);
				return Response.json({ run: { phase: phases[at], cursorSeq: at, maxSeq: 2 } });
			}
			return new Response('', { status: 404 });
		});
	};

	it('claims the migrated way, keeps the token owner-only, and runs updates to the end', async () => {
		const fetch = updbServer(['running', 'running', 'complete']);
		const files = memoryFiles();
		const ctx = testContext({ fetch, files });
		const summary = await ownDuplicate(ctx, 'http://localhost:8787', '/o', {
			globals: testGlobals({}, ctx)
		});
		expect(summary).toContain('updates complete after 2 beat(s)');
		expect(files.secrets.has('/o/owner-token')).toBe(true);
		expect(fetch.urls.filter((u) => u.includes('/updb')).length).toBe(3);
	});

	it('fails the run on a halted chain', async () => {
		const ctx = testContext({ fetch: updbServer(['running', 'halted']) });
		await expect(
			ownDuplicate(ctx, 'http://localhost:8787', '/o', { globals: testGlobals({}, ctx) })
		).rejects.toThrow(FindingError);
	});

	it('says the updates were not run when the worker has no migrated claim', async () => {
		const ctx = testContext({
			fetch: fakeFetch(() =>
				Response.json({ ok: false, error: 'adminPass required' }, { status: 400 })
			)
		});
		const summary = await ownDuplicate(ctx, 'http://localhost:8787', '/o', {
			globals: testGlobals({}, ctx)
		});
		expect(summary).toContain('not claimed');
	});
});

describe('verify', () => {
	const survey = { nodes: 2, fileRows: 1 } as Parameters<typeof verify>[2];
	const db = { tables: 3, nodes: 2, fileRows: 1, filesStored: 1, fileBytes: 1, codeFiles: 0 };

	it('passes when the counts agree and the pages and a file answer', async () => {
		const ctx = testContext({ fetch: fakeFetch(() => new Response('', { status: 200 })) });
		const got = await verify(ctx, 'http://localhost:8787', survey, db, ['a.png']);
		expect(got.failed).toBeNull();
		expect(got.summary).toBe('5 of 5 checks passed');
	});

	it('with a source, a page the source also fails is a match, and a new failure is not', async () => {
		const fetch = fakeFetch((url) => {
			const source = url.startsWith('http://old.example');
			if (url.endsWith('/node/1')) return new Response('', { status: 500 });
			if (url.endsWith('/user/login'))
				return new Response('', { status: source ? 200 : 500 });
			return new Response('', { status: 200 });
		});
		const ctx = testContext({ fetch });
		const got = await verify(
			ctx,
			'http://localhost:8787',
			survey,
			db,
			['a.png'],
			'http://old.example'
		);
		expect(got.failed?.message).toContain('/user/login');
		expect(got.failed?.message).not.toContain('/node/1');
		expect(fetch.urls).toContain('http://old.example/node/1');
	});

	it('reports every mismatch before failing', async () => {
		const fetch = fakeFetch(
			(url) => new Response('', { status: url.endsWith('/a.png') ? 404 : 200 })
		);
		const ctx = testContext({ fetch });
		const got = await verify(ctx, 'http://localhost:8787', survey, { ...db, nodes: 1 }, [
			'a.png'
		]);
		expect(got.failed).toBeInstanceOf(FindingError);
		expect(got.failed?.message).toContain('nodes');
		expect(got.failed?.message).toContain('/sites/default/files/a.png');
		expect(ctx.io.stderr.join('\n')).toContain('MISMATCH');
	});
});

describe('the flow through install', () => {
	it('surveys, dumps, streams files and lands a database that carries both', async () => {
		const out = tmp();
		const workspace = join(out, 'worker');
		mkdirSync(workspace, { recursive: true });
		writeFileSync(
			join(workspace, 'package.json'),
			JSON.stringify({ name: '@drupflare/worker' })
		);

		// a real tar of a real files tree, so the stream is bytes and not a fixture string
		const src = tmp();
		mkdirSync(join(src, 'files', 'inline'), { recursive: true });
		mkdirSync(join(src, 'files', 'styles'), { recursive: true });
		writeFileSync(
			join(src, 'files', 'inline', 'logo.png'),
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1])
		);
		writeFileSync(join(src, 'files', 'styles', 'derived.png'), 'regenerated');
		execFileSync('tar', ['-cf', join(src, 'files.tar'), '-C', src, 'files']);
		// a custom module with a binary asset and a test tree, neither of which the mount carries
		const mod = join(src, 'modules', 'custom', 'agency');
		mkdirSync(join(mod, 'tests'), { recursive: true });
		mkdirSync(join(mod, 'images'), { recursive: true });
		writeFileSync(
			join(mod, 'agency.info.yml'),
			'name: Agency\ntype: module\ncore_version_requirement: ^11\n'
		);
		writeFileSync(join(mod, 'agency.module'), '<?php\nfunction agency_help() {}\n');
		writeFileSync(join(mod, 'tests', 'AgencyTest.php'), '<?php\n');
		writeFileSync(
			join(mod, 'images', 'logo.png'),
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe])
		);
		execFileSync('tar', ['-cf', join(src, 'modules.tar'), '-C', src, 'modules']);
		mkdirSync(join(src, 'private'), { recursive: true });
		writeFileSync(join(src, 'private', 'invoice.pdf'), '%PDF-1.4 private');
		execFileSync('tar', ['-cf', join(src, 'private.tar'), '-C', src, 'private']);

		const dump = [
			'CREATE TABLE `node` (`nid` int(10) unsigned NOT NULL, PRIMARY KEY (`nid`));',
			'INSERT INTO `node` VALUES (1),(2);',
			'CREATE TABLE `file_managed` (`fid` int(10) unsigned NOT NULL, `uri` varchar(255) NOT NULL);',
			"INSERT INTO `file_managed` VALUES (1,'public://inline/logo.png');",
			// wider than the Durable Object statement ceiling; a preview must keep it
			'CREATE TABLE `node__body` (`entity_id` int(10) unsigned NOT NULL, `body_value` longtext);',
			`INSERT INTO \`node__body\` VALUES (1,'${'x'.repeat(150_000)}');`
		].join('\n');
		const answers: Record<string, CommandResult> = {
			'php -v': ok('PHP 8.3.6 (cli)'),
			'php -m': ok('[PHP Modules]\npdo_mysql\n'),
			[`cd ${ROOT} && drush status --format=json`]: ok(
				JSON.stringify({
					'drupal-version': '11.2.0',
					'db-driver': 'mysql',
					root: ROOT,
					private: '../private'
				})
			),
			[`cd ${ROOT} && drush pm:list --status=enabled --type=module --format=json`]: ok(
				JSON.stringify({ node: {}, file: {} })
			),
			[`cd ${ROOT} && drush sql:query "SELECT COUNT(*) FROM node"`]: ok('2'),
			[`cd ${ROOT} && drush sql:query "SELECT COUNT(*) FROM file_managed"`]: ok('1'),
			[`cat ${ROOT}/sites/default/settings.php`]: ok(
				"<?php\n$settings['redis.connection']['host'] = 'cache.internal';\n"
			),
			[`cat ${ROOT}/.htaccess`]: ok(
				`${STOCK_HTACCESS}\nRedirect 301 /about-us /about\nHeader always set X-Frame-Options "SAMEORIGIN"\n`
			),
			[`cat ${ROOT}/core/assets/scaffold/files/htaccess`]: ok(STOCK_HTACCESS)
		};
		const { transport, calls } = recording(answers, {
			[`cd ${ROOT} && drush sql:dump --extra-dump=--hex-blob`]: new TextEncoder().encode(
				dump
			),
			[`tar -cf - -C ${ROOT}/sites/default files`]: new Uint8Array(
				readFileSync(join(src, 'files.tar'))
			),
			[`tar -cf - -C ${ROOT} modules`]: new Uint8Array(
				readFileSync(join(src, 'modules.tar'))
			),
			['tar -cf - -C /var/www private']: new Uint8Array(
				readFileSync(join(src, 'private.tar'))
			)
		});

		const spawned: string[] = [];
		const real = nodeRunner();
		const runner: CommandRunner = {
			run: (file, args, opts) => real.run(file, args, opts),
			runToFile: (file, args, o, opts) => real.runToFile(file, args, o, opts),
			spawn: async (file, args) => {
				spawned.push([file, ...args].join(' '));
				return 0;
			}
		};
		// yes to every step up to and including install; no to bringing it up
		const ctx = testContext({
			files: nodeFiles(),
			runner,
			ask: async (question) => (question.startsWith('Bring Up') ? 'n' : 'y')
		});
		await runPreviewCommand(ctx, {
			host: 'deploy@old.example',
			root: ROOT,
			out,
			transport,
			globals: testGlobals({}, ctx)
		});

		expect(calls.every((c) => refuseRemote(c) === null)).toBe(true);
		expect(ctx.io.text()).toContain('stopped before up');
		expect(spawned).toEqual(['bun run assets:sql']);

		const installed = new DatabaseSync(join(workspace, 'assets/drupal/site.sqlite'));
		expect(installed.prepare('SELECT COUNT(*) AS n FROM node').get()).toEqual({ n: 2 });
		expect(installed.prepare('SELECT length(body_value) AS n FROM node__body').get()).toEqual({
			n: 150_000
		});
		expect(
			installed.prepare('SELECT path, package FROM cfw_module_file ORDER BY path').all()
		).toEqual([
			{ path: 'modules/custom/agency/agency.info.yml', package: 'migrated/agency' },
			{ path: 'modules/custom/agency/agency.module', package: 'migrated/agency' }
		]);
		const devVars = readFileSync(join(workspace, '.dev.vars'), 'utf8');
		expect(devVars).toContain("REDIS_URL='redis://cache.internal:6379'\n");
		expect(JSON.parse(wranglerDotenv(devVars)['REDIRECTS']!)).toEqual([
			{ from: '/about-us', to: '/about', status: 301 },
			{ from: '/about-us/*', to: '/about/*', status: 301 }
		]);
		expect(readFileSync(join(workspace, 'assets/_headers'), 'utf8')).toBe(
			'/*\n  X-Frame-Options: SAMEORIGIN\n'
		);
		expect(readFileSync(join(workspace, 'assets/.assetsignore'), 'utf8')).toContain(
			'!/_headers\n'
		);
		expect(readFileSync(join(out, 'code-skipped.txt'), 'utf8')).toContain('logo.png');
		expect(
			installed.prepare("SELECT uri, size FROM cfw_file WHERE uri LIKE 'private://%'").all()
		).toEqual([{ uri: 'private://invoice.pdf', size: 16 }]);
		const stored = installed
			.prepare("SELECT uri FROM cfw_file WHERE uri LIKE 'public://%' ORDER BY uri")
			.all();
		expect(stored).toEqual([{ uri: 'public://inline/logo.png' }]);
		installed.close();
	});
});

describe('the settings step', () => {
	it('carries a phpredis connection as REDIS_URL and reports the source files without printing it', async () => {
		const out = tmp();
		const workspace = join(out, 'worker');
		mkdirSync(workspace, { recursive: true });
		writeFileSync(
			join(workspace, 'package.json'),
			JSON.stringify({ name: '@drupflare/worker' })
		);
		const src = tmp();
		mkdirSync(join(src, 'files'), { recursive: true });
		writeFileSync(join(src, 'files', 'a.txt'), 'a');
		execFileSync('tar', ['-cf', join(src, 'files.tar'), '-C', src, 'files']);
		const mod = join(src, 'modules', 'contrib', 'legacy');
		mkdirSync(mod, { recursive: true });
		writeFileSync(
			join(mod, 'legacy.info.yml'),
			'name: Legacy\ncore_version_requirement: ^10\n'
		);
		writeFileSync(join(mod, 'legacy.module'), '<?php\n$x = bcadd(1, 2);\n');
		execFileSync('tar', ['-cf', join(src, 'modules.tar'), '-C', src, 'modules']);

		const answers: Record<string, CommandResult> = {
			'php -v': ok('PHP 8.3.6 (cli)'),
			'php -m': ok('[PHP Modules]\npdo_mysql\n'),
			[`cd ${ROOT} && drush status --format=json`]: ok(
				JSON.stringify({ 'drupal-version': '10.4.0', 'db-driver': 'mysql', root: ROOT })
			),
			[`cd ${ROOT} && drush pm:list --status=enabled --type=module --format=json`]: ok(
				JSON.stringify({ node: {}, legacy: {} })
			),
			[`cat ${ROOT}/sites/default/settings.php`]: ok(
				[
					'<?php',
					"$settings['redis.connection']['interface'] = 'PhpRedis';",
					"$settings['redis.connection']['host'] = 'cache.internal';",
					"$settings['redis.connection']['password'] = 'hunter2';",
					"$settings['memcache']['servers'] = [];",
					"$config['system.site']['name'] = 'Old';",
					"$settings['trusted_host_patterns'] = [",
					"  '^www\\.old\\.example$',",
					"  '^.+\\.old\\.example$',",
					'];'
				].join('\n')
			)
		};
		const { transport } = recording(answers, {
			[`cd ${ROOT} && drush sql:dump --extra-dump=--hex-blob`]: new TextEncoder().encode(
				'CREATE TABLE `node` (`nid` int(10) unsigned NOT NULL);'
			),
			[`tar -cf - -C ${ROOT}/sites/default files`]: new Uint8Array(
				readFileSync(join(src, 'files.tar'))
			),
			[`tar -cf - -C ${ROOT} modules`]: new Uint8Array(readFileSync(join(src, 'modules.tar')))
		});
		const real = nodeRunner();
		const runner: CommandRunner = {
			run: (file, args, opts) => real.run(file, args, opts),
			runToFile: (file, args, o, opts) => real.runToFile(file, args, o, opts),
			spawn: async () => 0
		};
		const ctx = testContext({
			files: nodeFiles(),
			runner,
			ask: async (question) => (question.startsWith('Build the SQLite') ? 'n' : 'y')
		});
		await runPreviewCommand(ctx, {
			host: 'deploy@old.example',
			root: ROOT,
			out,
			transport,
			globals: testGlobals({}, ctx)
		});

		const secrets = JSON.parse(readFileSync(join(out, 'secrets.json'), 'utf8')) as Record<
			string,
			string
		>;
		expect(secrets['REDIS_URL']).toBe('redis://:hunter2@cache.internal:6379');
		expect(JSON.parse(secrets['DRUPAL_CONFIG']!)).toEqual({ 'system.site': { name: 'Old' } });
		const text = ctx.io.text();
		expect(text).not.toContain('hunter2');
		expect(text).toContain('legacy (core_version_requirement ^10)');
		expect(text).toContain('modules/contrib/legacy/legacy.module:2');
		expect(text).toContain('settings-memcache');
		expect(text).toContain('redis.connection carried as REDIS_URL');
		expect(text).toContain('1 hostname(s) from trusted_host_patterns (domains.txt)');
		expect(readFileSync(join(out, 'domains.txt'), 'utf8')).toBe(
			'drangler domain add www.old.example\nnot one host, choose one by hand: ^.+\\.old\\.example$\n'
		);
	});
});

describe('parseHtaccess', () => {
	it('finds nothing in the stock file, so a site that never edited it carries no rules', () => {
		expect(parseHtaccess(STOCK_HTACCESS, STOCK_HTACCESS)).toEqual({
			redirects: [],
			headers: [],
			unparsed: []
		});
	});

	it('translates unconditional redirects and headers into the worker lever shapes', () => {
		const rules = parseHtaccess(
			[
				STOCK_HTACCESS.replace(
					'RewriteEngine on',
					[
						'RewriteEngine on',
						'RewriteRule ^old-page$ /new-page [R=301,L]',
						'RewriteRule ^blog/(.*)$ /news/$1 [R=301,L]',
						'RewriteRule ^legacy\\.php$ home [R,L]',
						'RewriteRule ^trailing/?$ /t [R=308]'
					].join('\n')
				),
				'Redirect 301 /about-us /about',
				'RedirectPermanent /team/ /people/',
				'RedirectMatch 302 ^/promo$ https://shop.example.com/sale',
				'Header always set X-Frame-Options "SAMEORIGIN"',
				'Header set Cache-Control "no-cache"'
			].join('\n'),
			STOCK_HTACCESS
		);
		expect(rules.redirects).toEqual([
			{ from: '/old-page', to: '/new-page', status: 301 },
			{ from: '/blog/*', to: '/news/*', status: 301 },
			{ from: '/legacy.php', to: '/home', status: 302 },
			{ from: '/trailing', to: '/t', status: 308 },
			{ from: '/about-us', to: '/about', status: 301 },
			{ from: '/about-us/*', to: '/about/*', status: 301 },
			{ from: '/team', to: '/people/', status: 301 },
			{ from: '/team/*', to: '/people/*', status: 301 },
			{ from: '/promo', to: 'https://shop.example.com/sale', status: 302 }
		]);
		expect(rules.headers).toEqual([
			{ path: '/*', set: { 'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': 'no-cache' } }
		]);
		expect(rules.unparsed).toEqual([]);
	});

	it('reports what the worker cannot express, verbatim and with its conditions', () => {
		const rules = parseHtaccess(
			[
				'RewriteCond %{HTTP_HOST} ^example\\.com$ [NC]',
				'RewriteRule ^ https://www.example.com%{REQUEST_URI} [L,R=301]',
				'RewriteRule ^old$ /new [R=301]',
				'RewriteRule ^app/(.*)$ /index.php?q=$1 [L,QSA]',
				'RewriteRule ^(a|b)$ /c [R=301]',
				'RedirectMatch 301 ^/p/([0-9]+)$ /post/$1',
				'Redirect gone /retired',
				'Redirect 303 /see /other',
				'Header set Set-Cookie "a=b"',
				'Header set X-Env "1" env=prod',
				'Header unset Server',
				'<FilesMatch "\\.pdf$">',
				'  <IfModule mod_headers.c>',
				'    Header set X-Robots-Tag "noindex"',
				'  </IfModule>',
				'</FilesMatch>',
				'ErrorDocument 404 /404.html'
			].join('\n')
		);
		expect(rules.redirects).toEqual([{ from: '/old', to: '/new', status: 301 }]);
		expect(rules.headers).toEqual([]);
		expect(rules.unparsed).toEqual([
			'RewriteCond %{HTTP_HOST} ^example\\.com$ [NC]\nRewriteRule ^ https://www.example.com%{REQUEST_URI} [L,R=301]',
			'RewriteRule ^app/(.*)$ /index.php?q=$1 [L,QSA]',
			'RewriteRule ^(a|b)$ /c [R=301]',
			'RedirectMatch 301 ^/p/([0-9]+)$ /post/$1',
			'Redirect gone /retired',
			'Redirect 303 /see /other',
			'Header set Set-Cookie "a=b"',
			'Header set X-Env "1" env=prod',
			'Header unset Server',
			'<FilesMatch "\\.pdf$">\n<IfModule mod_headers.c>\nHeader set X-Robots-Tag "noindex"\n</IfModule>\n</FilesMatch>',
			'ErrorDocument 404 /404.html'
		]);
	});

	it('keeps the worker ceiling and reports the rules past it', () => {
		const lines = Array.from({ length: 102 }, (_, i) => `RewriteRule ^p${i}$ /q${i} [R=301]`);
		const rules = parseHtaccess(lines.join('\n'));
		expect(rules.redirects).toHaveLength(100);
		expect(rules.unparsed).toEqual([
			'past the 100-rule limit: /p100 -> /q100',
			'past the 100-rule limit: /p101 -> /q101'
		]);
	});

	it('joins a line continued with a backslash', () => {
		expect(parseHtaccess('Redirect 301 \\\n  /a /b').redirects[0]).toEqual({
			from: '/a',
			to: '/b',
			status: 301
		});
	});
});

describe('assetHeadersFile', () => {
	it('writes the headers in the asset layer _headers format', () => {
		expect(assetHeadersFile([{ path: '/*', set: { A: '1', 'B-C': 'x y' } }])).toBe(
			'/*\n  A: 1\n  B-C: x y\n'
		);
	});
});

describe('devVarLine', () => {
	it('round-trips a JSON value through the dotenv wrangler reads, quotes and apostrophes included', () => {
		const value = JSON.stringify({ 'system.site': { name: 'Bob\'s "site"\nline' } });
		const line = devVarLine('DRUPAL_CONFIG', value);
		expect(JSON.parse(wranglerDotenv(line)['DRUPAL_CONFIG']!)).toEqual(JSON.parse(value));
	});

	it('the old double-quoted form corrupted that same value, which is why it changed', () => {
		const value = JSON.stringify({ a: 'x"y' });
		expect(() =>
			JSON.parse(wranglerDotenv(`DRUPAL_CONFIG=${JSON.stringify(value)}`)['DRUPAL_CONFIG']!)
		).toThrow();
	});

	it('writes a plain value in single quotes, and in double quotes when it holds one', () => {
		expect(devVarLine('REDIS_URL', 'redis://h:6379')).toBe("REDIS_URL='redis://h:6379'");
		expect(wranglerDotenv(devVarLine('X', "it's"))['X']).toBe("it's");
	});

	it('refuses a value no quoting can carry', () => {
		expect(() => devVarLine('X', `it's "both"`)).toThrow(/cannot be written/);
	});
});

describe('refuseOldWorker', () => {
	const at = (version: unknown) => {
		const ctx = testContext({ files: memoryFiles() });
		ctx.files.writeText('/ws/package.json', JSON.stringify({ version }));
		return () => refuseOldWorker(ctx, '/ws');
	};

	it('refuses a checkout older than the first release preview runs on, naming the move', () => {
		expect(at('1.0.2')).toThrow(UsageError);
		expect(at('1.0.2')).toThrow(`drangler update --to v${PREVIEW_MIN_WORKER}`);
		expect(at('0.9.0')).toThrow(UsageError);
	});

	it('compares numerically, so 1.0.10 is newer than 1.0.3', () => {
		expect(at('1.0.3')).not.toThrow();
		expect(at('1.0.10')).not.toThrow();
		expect(at('1.1.0')).not.toThrow();
	});

	it('lets through a checkout with no version to read', () => {
		expect(at(undefined)).not.toThrow();
		expect(() => refuseOldWorker(testContext({ files: memoryFiles() }), '/none')).not.toThrow();
	});
});
