import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/errors';
import { scriptedRunner } from '../src/host/exec';
import { memoryFiles } from '../src/host/files';
import { buildProgram, VERSION } from '../src/program';
import { run } from '../src/run';
import { fakeFetch, ok, testContext } from './helpers';

const HELP_PATHS = [
	['init'],
	['status'],
	['doctor'],
	['build'],
	['validate'],
	['dev'],
	['deploy'],
	['health'],
	['reconcile'],
	['sweep'],
	['config'],
	['config', 'check'],
	['config', 'levers'],
	['config', 'where'],
	['cf'],
	['cf', 'whoami'],
	['cf', 'workers'],
	['cf', 'cpu'],
	['secrets'],
	['secrets', 'scan'],
	['migrate'],
	['migrate', 'survey'],
	['migrate', 'plan'],
	['migrate', 'export'],
	['migrate', 'convert'],
	['migrate', 'install'],
	['migrate', 'restore']
];

describe('help', () => {
	it.each(HELP_PATHS)('renders help for `drangler %s`', async (...path: string[]) => {
		const ctx = testContext();
		expect(await run(ctx, [...path, '--help'])).toBe(EXIT.OK);
		expect(ctx.io.text()).toContain(`Usage: drangler${path.map((p) => ` ${p}`).join('')} `);
	});

	it('reports the version', async () => {
		const ctx = testContext();
		expect(await run(ctx, ['--version'])).toBe(EXIT.OK);
		expect(ctx.io.text()).toBe(VERSION);
	});

	it('renders the root help too, which the bare invocation no longer reaches', async () => {
		const ctx = testContext();
		expect(await run(ctx, ['--help'])).toBe(EXIT.OK);
		expect(ctx.io.text()).toContain('Usage: drangler ');
	});

	// the description undercounted: `update` writes too, and the README already said five
	it('names every command that writes, rather than claiming to be read-only', () => {
		const description = buildProgram(testContext()).description();
		expect(description).toContain('Read-only apart from');
		for (const writer of ['build', 'dev', 'deploy', 'update', 'migrate install']) {
			expect(description).toContain(writer);
		}
	});
});

/**
 * `npm i -g @drupflare/drangler` installed a binary that could not run.
 *
 * `bin` pointed at `src/cli.ts` under a `#!/usr/bin/env bun` shebang, so on a machine with node and
 * no bun the installed command was a TypeScript file node refused with a confusing error. The bin is
 * a built `dist/cli.js` now, produced by `prepublishOnly`.
 */
describe('the published entrypoint', () => {
	const pkg = JSON.parse(
		readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
	) as {
		bin: Record<string, string>;
		files: string[];
		scripts: Record<string, string>;
	};

	it('points bin at the built entrypoint, and ships it', () => {
		expect(pkg.bin['drangler']).toBe('./dist/cli.js');
		expect(pkg.files).toContain('dist');
		// `exports` still points into src for library consumers
		expect(pkg.files).toContain('src');
	});

	it('builds that entrypoint before publishing, targeting node', () => {
		expect(pkg.scripts['build:dist']).toContain('--target=node');
		expect(pkg.scripts['prepublishOnly']).toContain('build:dist');
	});

	// bun copies the entry shebang into the bundle, so the source carries the one dist needs
	it('carries a node shebang, not a bun one', () => {
		const source = readFileSync(
			resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts'),
			'utf8'
		);
		expect(source.split('\n')[0]).toBe('#!/usr/bin/env node');
	});
});

describe('exit codes', () => {
	it('returns 2 for an unknown command', async () => {
		const ctx = testContext();
		expect(await run(ctx, ['nonsense'])).toBe(EXIT.USAGE);
		expect(ctx.io.stderr.join('\n')).toContain('unknown command');
	});

	it('returns 2 for a missing required option', async () => {
		expect(await run(testContext(), ['migrate', 'survey'])).toBe(EXIT.USAGE);
	});

	it('returns 2 for a choice outside the allowed set', async () => {
		expect(await run(testContext(), ['migrate', 'plan', '--to', 'moon'])).toBe(EXIT.USAGE);
	});

	it('returns 2 for a usage error raised inside a command', async () => {
		const ctx = testContext();
		expect(await run(ctx, ['migrate', 'survey', '--host', 'bad host', '--root', '/x'])).toBe(
			EXIT.USAGE
		);
		expect(ctx.io.stderr.join('\n')).toContain('not a hostname or address');
	});

	it('returns 3 for a finding', async () => {
		const ctx = testContext({ files: memoryFiles({ '/settings.php': "'password' => 'pw'" }) });
		expect(await run(ctx, ['secrets', 'scan', '/settings.php'])).toBe(EXIT.FINDING);
		expect(ctx.io.stderr.join('\n')).toContain('1 credential(s) found');
	});

	it('returns 1 for a failure that is not the caller`s fault', async () => {
		const ctx = testContext({
			fetch: fakeFetch(() => {
				throw new Error('ECONNREFUSED');
			})
		});
		expect(await run(ctx, ['health', 'x.dev'])).toBe(EXIT.FAILED);
		expect(ctx.io.stderr.join('\n')).toContain('ECONNREFUSED');
	});

	/**
	 * A stack is for whoever fixes drangler, and a user is not that person.
	 *
	 * Anything that is not a `DranglerError` is a bug here, so it becomes `internal` with the
	 * message and a way to ask for the rest. Printing the stack by default was the default path for
	 * EVERY such exception.
	 */
	it('returns 1 with the message and no stack for an unexpected throw', async () => {
		const bang = () =>
			testContext({
				files: {
					...memoryFiles({}),
					exists: () => {
						throw new TypeError('bang');
					}
				}
			});
		const ctx = bang();
		expect(await run(ctx, ['config', 'check', '/w.jsonc'])).toBe(EXIT.FAILED);
		const said = ctx.io.stderr.join('\n');
		expect(said).toContain('bang');
		expect(said).toContain('re-run with --verbose');
		expect(said).not.toContain('at Object.exists');

		const verbose = bang();
		expect(await run(verbose, ['config', 'check', '/w.jsonc', '--verbose'])).toBe(EXIT.FAILED);
		expect(verbose.io.stderr.join('\n')).toContain('TypeError');
	});

	// a CI step should not have to branch on the exit code before it can parse stdout
	it('prints the error object on stdout under --json, on the failure path', async () => {
		const ctx = testContext({
			files: {
				...memoryFiles({}),
				exists: () => {
					throw new TypeError('bang');
				}
			}
		});
		expect(await run(ctx, ['config', 'check', '/w.jsonc', '--json'])).toBe(EXIT.FAILED);
		expect(ctx.io.json<{ ok: boolean; error: { code: string; retryable: boolean } }>()).toEqual(
			{
				ok: false,
				error: { code: 'internal', message: 'bang', retryable: false, next: null }
			}
		);
	});

	it('prints the next command when the error carries one', async () => {
		const ctx = testContext({ files: memoryFiles({}) });
		expect(await run(ctx, ['site', 'updb', 'https://x.example'])).toBe(EXIT.USAGE);
		expect(ctx.io.stderr.join('\n')).toContain('site claim');
	});

	it('returns 0 on a clean run', async () => {
		const ctx = testContext({
			files: memoryFiles({ '/a/index.php': '<?php' })
		});
		expect(await run(ctx, ['secrets', 'scan', '/a'])).toBe(EXIT.OK);
	});
});

describe('flag wiring', () => {
	// `--site` is the origin now; the Durable Object identity it used to mean is `--site-name`
	it('passes the health flags through to the probe', async () => {
		const fetch = fakeFetch(
			() => new Response('', { status: 200, headers: { 'x-cfw-cache': 'HIT' } })
		);
		const ctx = testContext({ fetch });
		await run(ctx, [
			'health',
			'x.dev',
			'--path',
			'/node/1',
			'--site-name',
			'blog',
			'--skip-edge'
		]);
		expect(fetch.urls[0]).toBe('https://x.dev/serve?path=%2Fnode%2F1&site=blog&edge=0');
	});

	it('defaults --to to workers and honours --json', async () => {
		const ctx = testContext();
		await run(ctx, ['migrate', 'plan', '--json']);
		expect(ctx.io.json<{ direction: string }>().direction).toBe('to-worker');
	});

	it('turns --no-split-rows into splitRows false', async () => {
		const files = memoryFiles({ '/in.sql': 'INSERT INTO `t` VALUES (1),(2);' });
		const ctx = testContext({ files });
		await run(ctx, [
			'migrate',
			'convert',
			'--in',
			'/in.sql',
			'--from',
			'mysql',
			'--to',
			'sqlite',
			'--out',
			'/out.sql',
			'--no-split-rows'
		]);
		expect(files.written.get('/out.sql')?.trim().split('\n')).toHaveLength(1);
	});

	it('runs a survey dry run end to end without a transport', async () => {
		const ctx = testContext();
		expect(
			await run(ctx, [
				'migrate',
				'survey',
				'--host',
				'me@old.example',
				'--root',
				'/var/www/html',
				'--dry-run'
			])
		).toBe(EXIT.OK);
		expect(ctx.io.text()).toContain('drush status --format=json');
	});

	it('runs doctor through the parser', async () => {
		const ctx = testContext({ runner: scriptedRunner({}) });
		expect(await run(ctx, ['doctor'])).toBe(EXIT.FINDING);
		expect(ctx.io.text()).toContain('wrangler');
	});

	it('runs the cf subcommands through the parser', async () => {
		const cf = {
			runner: scriptedRunner({
				'wrangler --version': ok('wrangler 4.20.0'),
				'wrangler whoami': ok(
					'associated with the email me@example.com.\n0123456789abcdef0123456789abcdef'
				)
			}),
			env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct' },
			fetch: fakeFetch(() => new Response(JSON.stringify({ success: true, result: [] })))
		};
		const whoami = testContext(cf);
		expect(await run(whoami, ['cf', 'whoami'])).toBe(EXIT.OK);
		expect(whoami.io.text()).toContain('api-token');

		const workers = testContext(cf);
		expect(await run(workers, ['cf', 'workers'])).toBe(EXIT.OK);
		expect(workers.io.text()).toContain('0 worker(s)');

		const cpu = testContext({
			files: memoryFiles({ '/t.json': '{"executionModel":"durableObject","cpuTime":22}' })
		});
		expect(await run(cpu, ['cf', 'cpu', '/t.json'])).toBe(EXIT.OK);
		expect(cpu.io.text()).toContain('durableObject');
	});

	it('runs config check through the parser', async () => {
		const ctx = testContext({
			files: memoryFiles({
				'/w.jsonc': '{"main":"src/site.ts","vars":{"PW_DIAGNOSTICS":"1"}}'
			})
		});
		expect(await run(ctx, ['config', 'check', '/w.jsonc'])).toBe(EXIT.FINDING);
	});

	it('runs status through the parser, against a deployed site', async () => {
		const ctx = testContext({ fetch: statusFetch() });
		expect(await run(ctx, ['status', 'site.example', '--json'])).toBe(EXIT.OK);
		expect(ctx.io.json<{ accountPlan: string }>().accountPlan).toBe('paid');
	});
});

const statusFetch = (headers: Record<string, string> = {}) =>
	fakeFetch((url) => {
		if (url.includes('/stats')) return new Response('not found', { status: 404 });
		if (url.includes('/firstrun')) {
			return new Response(JSON.stringify({ ok: true, configured: true, firstRunAt: null }));
		}
		return new Response('<html></html>', {
			status: 200,
			headers: {
				'x-cfw-cache': 'MISS',
				'x-cfw-account-plan': 'paid',
				'x-cfw-v': '2',
				...headers
			}
		});
	});

/**
 * The flags every command inherits, declared once on the program.
 *
 * The one breaking change is `--site`: it was the Durable Object identity on `status`, `health` and
 * `migrate export`, and a deployment origin on `migrate plan`. It is always an origin now and the
 * identity is `--site-name`.
 */
describe('global flags', () => {
	const home = { HOME: '/home/me' };

	it('takes --json after a subcommand, from the program', async () => {
		const ctx = testContext({ env: home, fetch: statusFetch() });
		await run(ctx, ['status', 'site.example', '--json']);
		expect(ctx.io.json<{ target: string }>().target).toBe('https://site.example');
	});

	it('takes --json before one too, which a per-command flag could not', async () => {
		const ctx = testContext({ env: home, fetch: statusFetch() });
		await run(ctx, ['--json', 'status', 'site.example']);
		expect(ctx.io.json<{ target: string }>().target).toBe('https://site.example');
	});

	it('refuses --quiet and --verbose together', async () => {
		const ctx = testContext({ env: home, fetch: statusFetch() });
		expect(await run(ctx, ['status', 'site.example', '--quiet', '--verbose'])).toBe(EXIT.USAGE);
		expect(ctx.io.stderr.join('\n')).toContain('opposite things');
	});

	it('traces every request under --verbose', async () => {
		const ctx = testContext({ env: home, fetch: statusFetch() });
		await run(ctx, ['status', 'site.example', '--verbose']);
		expect(ctx.io.stderr.join('\n')).toContain('> GET https://site.example/serve');
	});

	it('refuses a --timeout that is not a positive number', async () => {
		const ctx = testContext({ env: home, fetch: statusFetch() });
		expect(await run(ctx, ['status', 'site.example', '--timeout', 'abc'])).toBe(EXIT.USAGE);
	});

	it('takes the target from --site when the argument is omitted', async () => {
		const fetch = statusFetch();
		const ctx = testContext({ env: home, fetch });
		expect(await run(ctx, ['status', '--site', 'https://site.example', '--json'])).toBe(
			EXIT.OK
		);
		expect(fetch.urls[0]).toContain('https://site.example/serve');
	});

	it('exits 2 on a bare word, naming the flag that takes an identity', async () => {
		const ctx = testContext({ env: home, fetch: statusFetch() });
		expect(await run(ctx, ['status', '--site', 'blog'])).toBe(EXIT.USAGE);
		expect(ctx.io.stderr.join('\n')).toContain('--site-name');
	});

	it('sends --site-name as the Durable Object identity', async () => {
		const fetch = statusFetch();
		const ctx = testContext({ env: home, fetch });
		await run(ctx, ['status', 'site.example', '--site-name', 'blog']);
		expect(fetch.urls[0]).toContain('site=blog');
	});

	it('exits 2 when nothing names a site at all', async () => {
		const ctx = testContext({ env: home, fetch: statusFetch() });
		expect(await run(ctx, ['status'])).toBe(EXIT.USAGE);
		expect(ctx.io.stderr.join('\n')).toContain('drangler.json');
	});

	it('reads the site out of a drangler.json in the working directory', async () => {
		const fetch = statusFetch();
		const ctx = testContext({
			env: home,
			cwd: '/home/me/site',
			files: memoryFiles({
				'/home/me/site/drangler.json': JSON.stringify({
					site: { origin: 'https://fromfile.example', name: 'blog' }
				})
			}),
			fetch
		});
		expect(await run(ctx, ['status', '--json'])).toBe(EXIT.OK);
		expect(fetch.urls[0]).toContain('https://fromfile.example/serve');
		expect(fetch.urls[0]).toContain('site=blog');
	});

	it('lets --config-file replace the search', async () => {
		const fetch = statusFetch();
		const ctx = testContext({
			env: home,
			cwd: '/home/me/site',
			files: memoryFiles({
				'/home/me/site/drangler.json': JSON.stringify({
					site: { origin: 'https://ignored.example' }
				}),
				'/tmp/other.json': JSON.stringify({ site: { origin: 'https://other.example' } })
			}),
			fetch
		});
		await run(ctx, ['status', '--config-file', '/tmp/other.json', '--json']);
		expect(fetch.urls[0]).toContain('https://other.example/serve');
	});

	it('selects a profile block with --profile', async () => {
		const fetch = statusFetch();
		const ctx = testContext({
			env: home,
			cwd: '/home/me/site',
			files: memoryFiles({
				'/home/me/site/drangler.json': JSON.stringify({
					site: { origin: 'https://prod.example' },
					profiles: { staging: { site: { origin: 'https://staging.example' } } }
				})
			}),
			fetch
		});
		await run(ctx, ['status', '--profile', 'staging', '--json']);
		expect(fetch.urls[0]).toContain('https://staging.example/serve');
	});

	it('drives config where through the parser', async () => {
		const ctx = testContext({ env: home, cwd: '/home/me/site', files: memoryFiles({}) });
		expect(await run(ctx, ['config', 'where', '--json'])).toBe(EXIT.OK);
		expect(ctx.io.json<{ profile: string }>().profile).toBe('default');
	});

	it('takes --dry-run from the program on a command that used to declare it', async () => {
		const ctx = testContext({ env: home });
		expect(
			await run(ctx, [
				'migrate',
				'survey',
				'--host',
				'me@old.example',
				'--root',
				'/var/www/html',
				'--dry-run'
			])
		).toBe(EXIT.OK);
		expect(ctx.io.text()).toContain('nothing was executed');
	});

	it('reads --token for migrate export, and --url falls back to --site', async () => {
		let sent: string | null = null;
		const urls: string[] = [];
		const ctx = testContext({
			env: home,
			fetch: (async (url: unknown, init: { headers?: Record<string, string> } = {}) => {
				urls.push(String(url));
				sent = init.headers?.['authorization'] ?? null;
				return new Response(JSON.stringify({ statements: 1, chars: 1, sql: 'SELECT 1;' }));
			}) as never
		});
		await run(ctx, [
			'migrate',
			'export',
			'--site',
			'https://site.example',
			'--token',
			'tok-123'
		]);
		expect(urls[0]).toContain('https://site.example/export');
		expect(sent).toBe('Bearer tok-123');
	});
});

describe('migrate export', () => {
	const body = {
		statements: 3,
		chars: 40,
		tables: { node: 2 },
		structureOnly: ['cache_data', 'watchdog', 'cfw_page'],
		maxStatementChars: 89_364,
		replayable: true,
		sql: 'CREATE TABLE "node" ("nid" INTEGER);'
	};

	it('writes the dump and reports the shape', async () => {
		const files = memoryFiles({});
		const fetch = fakeFetch(() => new Response(JSON.stringify(body)));
		const ctx = testContext({ files, fetch });
		expect(await run(ctx, ['migrate', 'export', '--url', 'x.dev', '--out', '/w.sql'])).toBe(
			EXIT.OK
		);
		expect(fetch.urls[0]).toBe('https://x.dev/export?body=1&site=site');
		expect(files.written.get('/w.sql')).toBe(body.sql);
		expect(ctx.io.text()).toContain('structure only (3)');
	});

	it('prints the structure-only list the envelope reported, not one of its own', async () => {
		const fetch = fakeFetch(() => new Response(JSON.stringify(body)));
		const ctx = testContext({ fetch });
		await run(ctx, ['migrate', 'export', '--url', 'x.dev']);
		expect(ctx.io.text()).toContain('cache_data, watchdog, cfw_page');
		expect(ctx.io.text()).toContain('89,364 of 100,000');
	});

	it('says the list is unknown against a worker that predates the field', async () => {
		const old = { statements: 1, chars: 10, tables: {}, sql: 'SELECT 1;' };
		const ctx = testContext({ fetch: fakeFetch(() => new Response(JSON.stringify(old))) });
		await run(ctx, ['migrate', 'export', '--url', 'x.dev']);
		expect(ctx.io.text()).toContain('predates that field');
		expect(ctx.io.text()).toContain('replayable        not reported');
	});

	it('exits with a finding when the worker says the dump will not replay', async () => {
		const ctx = testContext({
			fetch: fakeFetch(() => new Response(JSON.stringify({ ...body, replayable: false })))
		});
		expect(await run(ctx, ['migrate', 'export', '--url', 'x.dev'])).toBe(EXIT.FINDING);
		expect(ctx.io.stderr.join('\n')).toContain('cannot be replayed');
	});

	it('explains a 409 as the statement ceiling rather than a server error', async () => {
		const ctx = testContext({
			fetch: fakeFetch(() => new Response('cache_container is 960544 chars', { status: 409 }))
		});
		expect(await run(ctx, ['migrate', 'export', '--url', 'x.dev', '--all'])).toBe(EXIT.FAILED);
		expect(ctx.io.stderr.join('\n')).toContain('100,000-character');
		expect(ctx.io.stderr.join('\n')).toContain('cache_container is 960544 chars');
	});

	it('passes --all through', async () => {
		const fetch = fakeFetch(() => new Response(JSON.stringify(body)));
		await run(testContext({ fetch }), ['migrate', 'export', '--url', 'https://x.dev', '--all']);
		expect(fetch.urls[0]).toContain('all=1');
	});

	it('explains a 401 as a missing owner token and names where it comes from', async () => {
		const ctx = testContext({
			fetch: fakeFetch(
				() =>
					new Response('', {
						status: 401,
						headers: { 'www-authenticate': 'Bearer realm="drupflare"' }
					})
			)
		});
		expect(await run(ctx, ['migrate', 'export', '--url', 'x.dev'])).toBe(EXIT.FAILED);
		const err = ctx.io.stderr.join('\n');
		expect(err).toContain('/firstrun');
		expect(err).toContain('ownerToken');
		expect(err).toContain('Bearer realm="drupflare"');
		// never tells the user to reopen every diagnostic route
		expect(err).not.toContain('PW_DIAGNOSTICS');
	});

	it('sends the owner token as a bearer credential', async () => {
		let sent: string | null = null;
		const ctx = testContext({
			fetch: (async (_url: unknown, init: { headers?: Record<string, string> } = {}) => {
				sent = init.headers?.['authorization'] ?? null;
				return new Response(JSON.stringify(body));
			}) as never
		});
		await run(ctx, ['migrate', 'export', '--url', 'x.dev', '--token', 'tok-123']);
		expect(sent).toBe('Bearer tok-123');
	});

	it('reads the owner token from the environment when no flag is given', async () => {
		let sent: string | null = null;
		const ctx = testContext({
			env: { DRUPFLARE_OWNER_TOKEN: 'from-env' },
			fetch: (async (_url: unknown, init: { headers?: Record<string, string> } = {}) => {
				sent = init.headers?.['authorization'] ?? null;
				return new Response(JSON.stringify(body));
			}) as never
		});
		await run(ctx, ['migrate', 'export', '--url', 'x.dev']);
		expect(sent).toBe('Bearer from-env');
	});

	it('says a token was rejected rather than absent when one was supplied', async () => {
		const ctx = testContext({ fetch: fakeFetch(() => new Response('', { status: 401 })) });
		await run(ctx, ['migrate', 'export', '--url', 'x.dev', '--token', 'wrong']);
		expect(ctx.io.stderr.join('\n')).toContain('per SITE');
	});

	it('reads a 404 as a worker too old for the owner tier', async () => {
		const ctx = testContext({ fetch: fakeFetch(() => new Response('', { status: 404 })) });
		expect(await run(ctx, ['migrate', 'export', '--url', 'x.dev'])).toBe(EXIT.FAILED);
		expect(ctx.io.stderr.join('\n')).toContain('too old to have the owner tier');
	});

	it('reports any other failing status', async () => {
		const ctx = testContext({ fetch: fakeFetch(() => new Response('', { status: 500 })) });
		expect(await run(ctx, ['migrate', 'export', '--url', 'x.dev'])).toBe(EXIT.FAILED);
		expect(ctx.io.stderr.join('\n')).toContain('answered 500');
	});

	it('refuses a body with no sql field', async () => {
		const ctx = testContext({ fetch: fakeFetch(() => new Response('{"statements":0}')) });
		expect(await run(ctx, ['migrate', 'export', '--url', 'x.dev'])).toBe(EXIT.FAILED);
		expect(ctx.io.stderr.join('\n')).toContain('?body=1');
	});
});
