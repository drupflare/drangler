import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/errors';
import type { FetchLike } from '../src/health/probe';
import { scriptedRunner, type CommandResult, type ScriptedRunner } from '../src/host/exec';
import { memoryFiles, type MemoryFiles } from '../src/host/files';
import { run } from '../src/run';
import {
	WORKER_PATCHED_CORE,
	computeDelivery,
	diffCore,
	groupMembers,
	installPaths,
	modifyNameOf,
	mountOf,
	newerThan,
	normalise,
	parseLock,
	patchedPackages,
	versionsOf
} from '../src/workspace/project';
import { ok, testContext, type TestContext } from './helpers';

const P = '/p';
const SHIPPED = '/shipped/composer.lock';
const ORIGIN = 'https://mysite.example';

const lockOf = (packages: object[], extra: object = {}) =>
	JSON.stringify({ packages, 'packages-dev': [], extra });

const SHIPPED_LOCK = lockOf([
	{ name: 'drupal/core', version: '11.4.7', type: 'drupal-core' },
	{ name: 'drupal/admin_toolbar', version: '3.6.3', type: 'drupal-module' },
	{ name: 'symfony/console', version: 'v7.4.19', type: 'library' },
	{ name: 'symfony/yaml', version: 'v7.4.18', type: 'library' },
	{ name: 'guzzlehttp/guzzle', version: '7.15.5', type: 'library' }
]);

const PROJECT_LOCK = lockOf([
	{ name: 'drupal/core', version: '11.4.7', type: 'drupal-core' },
	{ name: 'drupal/core-recommended', version: '11.4.7', type: 'metapackage' },
	{ name: 'drupal/token', version: '1.15.0', type: 'drupal-module' },
	{ name: 'drupal/admin_toolbar', version: '3.6.3', type: 'drupal-module' },
	{
		name: 'acme/widget',
		version: '1.4.0',
		type: 'library',
		autoload: { 'psr-4': { 'Acme\\Widget\\': 'src/' } }
	},
	{ name: 'symfony/console', version: 'v7.4.21', type: 'library' },
	{ name: 'symfony/yaml', version: 'v7.4.10', type: 'library' },
	{ name: 'guzzlehttp/guzzle', version: '7.9.0', type: 'library' },
	{ name: 'cweagans/composer-patches', version: '2.0.0', type: 'composer-plugin' }
]);

const INSTALLED = JSON.stringify({
	packages: [
		{ name: 'acme/widget', 'install-path': '../acme/widget' },
		{ name: 'symfony/console', 'install-path': '../symfony/console' },
		{ name: 'drupal/token', 'install-path': '../../web/modules/contrib/token' },
		{ name: 'drupal/core', 'install-path': '../../web/core' }
	]
});

function project(over: Record<string, string> = {}): Record<string, string> {
	return {
		[`${P}/composer.json`]: '{"name":"acme/site"}',
		[`${P}/composer.lock`]: PROJECT_LOCK,
		[`${P}/vendor/composer/installed.json`]: INSTALLED,
		[`${P}/vendor/acme/widget/src/Widget.php`]:
			'<?php\nnamespace Acme\\Widget;\nclass Widget {}\n',
		[`${P}/vendor/acme/widget/LICENSE`]: 'MIT',
		[`${P}/vendor/symfony/console/Command.php`]: '<?php\nclass Command {}\n',
		[`${P}/web/modules/contrib/token/token.info.yml`]: 'name: Token\ntype: module\n',
		[`${P}/web/modules/contrib/token/token.module`]: '<?php\n',
		[`${P}/web/modules/custom/mine/mine.info.yml`]: 'name: Mine\ntype: module\n',
		[`${P}/web/modules/custom/mine/mine.module`]: '<?php\n// mine\n',
		[`${P}/web/core/lib/Drupal.php`]: '<?php\nclass Drupal {}\n',
		[SHIPPED]: SHIPPED_LOCK,
		...over
	};
}

describe('reading a lock and scoring it against the shipped one', () => {
	const lock = parseLock(PROJECT_LOCK);
	const shipped = versionsOf(parseLock(SHIPPED_LOCK));

	it('delivers what the pack lacks and what it holds at another version', () => {
		const plan = computeDelivery(lock, shipped, new Set());
		expect(plan.items.map((i) => [i.name, i.reason, i.mount])).toEqual([
			['drupal/token', 'missing', 'modules/contrib/token'],
			['acme/widget', 'missing', 'vendor/acme/widget'],
			['symfony/console', 'version', 'vendor/symfony/console']
		]);
		expect(plan.core).toEqual({ state: 'same', version: '11.4.7' });
	});

	it('leaves out what the pack holds at the same version, plugins, and pack-patched packages', () => {
		const plan = computeDelivery(lock, shipped, new Set());
		const names = plan.items.map((i) => i.name);
		expect(names).not.toContain('drupal/admin_toolbar');
		expect(names).not.toContain('drupal/core-recommended');
		expect(names).not.toContain('guzzlehttp/guzzle');
		expect(plan.skipped.map((s) => s.name).sort()).toEqual([
			'cweagans/composer-patches',
			'guzzlehttp/guzzle',
			'symfony/yaml'
		]);
		expect(plan.skipped.find((s) => s.name === 'symfony/yaml')?.why).toContain('newer');
	});

	it('delivers a package at the pack version when the project patches it', () => {
		const plan = computeDelivery(lock, shipped, new Set(['drupal/admin_toolbar']));
		expect(plan.items.find((i) => i.name === 'drupal/admin_toolbar')?.reason).toBe('patched');
	});

	it('keeps the pack version of a shared package when the project core is not the pack core', () => {
		const other = parseLock(
			lockOf([
				{ name: 'drupal/core', version: '10.4.0', type: 'drupal-core' },
				{ name: 'symfony/console', version: 'v6.4.1', type: 'library' },
				{ name: 'acme/widget', version: '1.4.0', type: 'library' }
			])
		);
		const plan = computeDelivery(other, shipped, new Set());
		expect(plan.core).toEqual({ state: 'mismatch', project: '10.4.0', shipped: '11.4.7' });
		expect(plan.items.map((i) => i.name)).toEqual(['acme/widget']);
		expect(plan.skipped[0]?.name).toBe('symfony/console');
	});

	it('still delivers a shared package at another version across a core patch release', () => {
		const drift = parseLock(
			lockOf([
				{ name: 'drupal/core', version: '11.4.5', type: 'drupal-core' },
				{ name: 'symfony/console', version: 'v7.4.21', type: 'library' }
			])
		);
		const plan = computeDelivery(drift, shipped, new Set(['drupal/core']));
		expect(plan.core).toEqual({ state: 'drift', project: '11.4.5', shipped: '11.4.7' });
		expect(plan.items.map((i) => i.name)).toEqual(['symfony/console']);
	});

	it('marks core patched when a patch file names it', () => {
		const plan = computeDelivery(lock, shipped, new Set(['drupal/core']));
		expect(plan.core).toEqual({ state: 'patched', version: '11.4.7' });
	});

	it('refuses a lock that is not JSON or carries no packages', () => {
		expect(() => parseLock('nope')).toThrow('not JSON');
		expect(() => parseLock('{}')).toThrow('no packages');
	});
});

describe('ordering versions', () => {
	it('orders by numeric parts and refuses to order what is not a plain version', () => {
		expect(newerThan('v7.4.19', 'v7.4.17')).toBe(true);
		expect(newerThan('7.4', '7.4.0')).toBe(false);
		expect(newerThan('3.7.3', '3.10.0')).toBe(false);
		expect(newerThan('dev-main', '1.0.0')).toBe(false);
	});
});

describe('which packages a project patches', () => {
	const lock = parseLock(PROJECT_LOCK);

	it('reads composer-patches 2, 1.x and the applied record in the lock', () => {
		const files = memoryFiles({
			[`${P}/patches.lock.json`]: JSON.stringify({
				patches: { 'drupal/core': [{ url: 'a' }] }
			}),
			[`${P}/composer.patches.json`]: JSON.stringify({
				patches: { 'drupal/token': { d: 'u' } }
			}),
			[`${P}/composer.json`]: JSON.stringify({
				extra: { patches: { 'acme/widget': { d: 'u' } } }
			})
		});
		const applied = parseLock(
			lockOf([], { patches_applied: { 'symfony/console': { d: 'u' } } })
		);
		expect([...patchedPackages(files, P, lock)].sort()).toEqual([
			'acme/widget',
			'drupal/core',
			'drupal/token'
		]);
		expect([...patchedPackages(memoryFiles({}), P, applied)]).toEqual(['symfony/console']);
	});

	it('ignores an empty patch list and unreadable files', () => {
		const files = memoryFiles({
			[`${P}/patches.lock.json`]: '{bad',
			[`${P}/composer.json`]: JSON.stringify({ extra: { patches: { 'a/b': {} } } })
		});
		expect(patchedPackages(files, P, lock).size).toBe(0);
	});
});

describe('where a package lands', () => {
	it('mounts by composer type the way the worker installs one', () => {
		expect(mountOf('drupal/token', 'drupal-module')).toBe('modules/contrib/token');
		expect(mountOf('drupal/claro_x', 'drupal-theme')).toBe('themes/contrib/claro_x');
		expect(mountOf('drupal/standard_x', 'drupal-profile')).toBe('profiles/contrib/standard_x');
		expect(mountOf('npm-asset/chart.js', 'npm-asset')).toBe('libraries/chart.js');
		expect(mountOf('acme/widget', 'library')).toBe('vendor/acme/widget');
		expect(mountOf('cweagans/composer-patches', 'composer-plugin')).toBeNull();
	});

	it('names a revision by machine name for extensions and vendor__name for the rest', () => {
		expect(modifyNameOf('drupal/token', 'modules/contrib/token')).toBe('token');
		expect(modifyNameOf('acme/widget', 'vendor/acme/widget')).toBe('acme__widget');
	});

	it('reads install paths and collapses the relative segments', () => {
		const files = memoryFiles(project());
		const paths = installPaths(files, P);
		expect(paths.get('acme/widget')).toBe('/p/vendor/acme/widget');
		expect(paths.get('drupal/token')).toBe('/p/web/modules/contrib/token');
		expect(installPaths(memoryFiles({}), P).size).toBe(0);
		expect(normalise('/a/b/../c/./d')).toBe('/a/c/d');
	});
});

describe('grouping packages into revisions', () => {
	const member = (label: string, paths: string[]) => ({
		label,
		autoload: null,
		selection: {
			files: paths.map((path) => ({ path, local: path, source: 'x', bytes: 1 })),
			skipped: [],
			totalBytes: paths.length
		}
	});

	it('keeps a package whole and starts another revision when the budget is spent', () => {
		const a = member('a/a', ['vendor/a/a/1.php', 'vendor/a/a/2.php']);
		const b = member('b/b', ['vendor/b/b/1.php']);
		const { groups, oversized } = groupMembers('project_vendor', [a, b], 300);
		expect(groups.map((g) => [g.name, g.members])).toEqual([
			['project_vendor', ['a/a']],
			['project_vendor_2', ['b/b']]
		]);
		expect(oversized).toEqual([]);
	});

	it('reports a package too big for any revision instead of cutting it', () => {
		const huge = member(
			'big/big',
			Array.from({ length: 50 }, (_, i) => `vendor/big/big/${i}.php`)
		);
		const { groups, oversized } = groupMembers('project_vendor', [huge], 300);
		expect(groups).toEqual([]);
		expect(oversized[0]?.name).toBe('big/big');
	});
});

describe('what patching changed in core', () => {
	const PATCHED = '/p/web/core';
	const PRISTINE = '/p/.drangler/pristine/vendor/drupal/core';

	it('is the files that differ, with core/ in front, and never the pack-rewritten ones', () => {
		const files = memoryFiles({
			[`${PATCHED}/lib/Same.php`]: '<?php // same\n',
			[`${PRISTINE}/lib/Same.php`]: '<?php // same\n',
			[`${PATCHED}/lib/Changed.php`]: '<?php // patched\n',
			[`${PRISTINE}/lib/Changed.php`]: '<?php // pristine\n',
			[`${PATCHED}/lib/New.php`]: '<?php // new\n',
			[`${PRISTINE}/lib/Gone.php`]: '<?php // gone\n',
			[`${PATCHED}/lib/Drupal/Core/Render/Renderer.php`]: '<?php // patched\n',
			[`${PRISTINE}/lib/Drupal/Core/Render/Renderer.php`]: '<?php // pristine\n',
			[`${PATCHED}/tests/Ignored.php`]: '<?php // tests\n'
		});
		const overlay = diffCore(files, PATCHED, PRISTINE);
		expect(overlay.selection.files.map((f) => f.path).sort()).toEqual([
			'core/lib/Changed.php',
			'core/lib/New.php'
		]);
		expect(overlay.removed).toEqual(['core/lib/Gone.php']);
		expect(overlay.refused).toEqual(['core/lib/Drupal/Core/Render/Renderer.php']);
	});
});

/**
 * The worker's own list of core files it rewrites, read out of its patch script.
 *
 * Skips without the sibling and fails under `REQUIRE_SIBLINGS=1`, the shape the other
 * sibling-reading specs use.
 */
describe('the pack-rewritten core list', () => {
	const script = resolve(
		dirname(fileURLToPath(import.meta.url)),
		'../../worker/scripts/patch-drupal.mjs'
	);
	const present = existsSync(script);
	if (!present && process.env.REQUIRE_SIBLINGS) {
		throw new Error(`no worker checkout at ${script}, and REQUIRE_SIBLINGS is set.`);
	}

	it.skipIf(!present)('names every core file scripts/patch-drupal.mjs rewrites', () => {
		const source = readFileSync(script, 'utf8');
		const rewritten = [...source.matchAll(/'(core\/[A-Za-z0-9_/.-]+)'/g)].map((m) => m[1]!);
		expect(rewritten.length).toBeGreaterThan(0);
		for (const path of rewritten) expect(WORKER_PATCHED_CORE).toContain(path);
	});
});

interface Site {
	fetch: FetchLike;
	calls: { action: string; pkg: string; body: any }[];
}

function fakeSite(): Site {
	const calls: Site['calls'] = [];
	const held = new Set<string>();
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});
	const fetch = (async (input: unknown, init: RequestInit = {}) => {
		const url = new URL(String(input));
		const action = url.searchParams.get('action') ?? '';
		const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		calls.push({ action, pkg: url.searchParams.get('package') ?? '', body });
		if (url.pathname !== '/modify') return json({ ok: false }, 404);
		if (action === 'plan') {
			const declared = body.files as { hash: string }[];
			return json({
				ok: true,
				have: declared.filter((f) => held.has(f.hash)).map((f) => f.hash),
				want: declared.filter((f) => !held.has(f.hash)).map((f) => f.hash),
				wantBytes: 0,
				counts: {},
				rowsWritten: 0
			});
		}
		if (action === 'blobs') {
			for (const b of body.blobs as { hash: string }[]) held.add(b.hash);
			return json({ ok: true, stored: body.blobs.length, skipped: 0, bytes: 0 });
		}
		if (action === 'commit') {
			return json({ ok: true, rev: 'r'.repeat(64), applied: true, rolledBack: false });
		}
		return json({ ok: false }, 400);
	}) as unknown as FetchLike;
	return { fetch, calls };
}

const COMPOSER_INSTALL =
	'composer install --no-interaction --no-progress --no-scripts --ignore-platform-reqs --prefer-dist';
const COMPOSER_PRISTINE =
	'composer update --no-dependencies --no-plugins --no-interaction --no-progress --no-scripts --ignore-platform-reqs --prefer-dist';

function ctxFor(
	seed: Record<string, string>,
	script: Record<string, CommandResult | ((args: readonly string[]) => CommandResult)> = {},
	site: Site = fakeSite()
): TestContext & { runner: ScriptedRunner; files: MemoryFiles; site: Site } {
	const files = memoryFiles(seed);
	const runner = scriptedRunner({ [COMPOSER_INSTALL]: ok(''), ...script });
	return Object.assign(testContext({ files, runner, fetch: site.fetch }), { site }) as never;
}

const args = (extra: string[] = []) => [
	'build',
	'--project',
	P,
	'--shipped-lock',
	SHIPPED,
	'--composer',
	'host',
	'--site',
	ORIGIN,
	'--token',
	'tok',
	...extra
];

describe('drangler build --project', () => {
	it('--dry-run prints the delivery set and touches neither composer nor the site', async () => {
		const ctx = ctxFor(project());
		expect(await run(ctx, args(['--dry-run', '--json']))).toBe(EXIT.OK);
		const report = ctx.io.json<{ delivery: { name: string }[] }>();
		expect(report.delivery.map((d: { name: string }) => d.name)).toEqual([
			'drupal/token',
			'acme/widget',
			'symfony/console'
		]);
		expect(ctx.runner.calls).toEqual([]);
		expect(ctx.site.calls).toEqual([]);
	});

	it('runs composer, then uploads vendor, contrib and custom code as separate revisions', async () => {
		const ctx = ctxFor(project());
		expect(await run(ctx, args())).toBe(EXIT.OK);
		expect(ctx.runner.calls[0]).toMatchObject({
			file: 'composer',
			args: COMPOSER_INSTALL.split(' ').slice(1)
		});

		const commits = ctx.site.calls.filter((c) => c.action === 'commit');
		expect(commits.map((c) => c.pkg)).toEqual([
			'project_vendor',
			'project_contrib',
			'project_custom'
		]);

		const vendor = commits[0]!.body;
		expect(vendor.files.map((f: { path: string }) => f.path).sort()).toEqual([
			'vendor/acme/widget/src/Widget.php',
			'vendor/symfony/console/Command.php'
		]);
		// composer's autoload rides the commit, which is what lets the site register it
		expect(vendor.autoload).toEqual([
			{
				name: 'acme/widget',
				version: '1.4.0',
				mount: 'vendor/acme/widget',
				autoload: { 'psr-4': { 'Acme\\Widget\\': 'src/' } }
			},
			{
				name: 'symfony/console',
				version: 'v7.4.21',
				mount: 'vendor/symfony/console',
				autoload: {}
			}
		]);
		expect(commits[1]!.body.files.map((f: { path: string }) => f.path).sort()).toEqual([
			'modules/contrib/token/token.info.yml',
			'modules/contrib/token/token.module'
		]);
		expect(commits[1]!.body.autoload).toBeUndefined();
		expect(commits[2]!.body.files.map((f: { path: string }) => f.path).sort()).toEqual([
			'modules/custom/mine/mine.info.yml',
			'modules/custom/mine/mine.module'
		]);
	});

	it('sends the second run nothing the site already holds', async () => {
		const site = fakeSite();
		const first = ctxFor(project(), {}, site);
		await run(first, args());
		const blobsBefore = site.calls.filter((c) => c.action === 'blobs').length;
		const second = ctxFor(project(), {}, site);
		await run(second, args());
		expect(site.calls.filter((c) => c.action === 'blobs').length).toBe(blobsBefore);
	});

	it('builds a pristine core beside the project and uploads only what a patch changed', async () => {
		const seed = project({
			[`${P}/patches.lock.json`]: JSON.stringify({
				patches: { 'drupal/core': [{ url: 'a' }] }
			}),
			[`${P}/web/core/lib/Patched.php`]: '<?php // patched\n',
			[`${P}/web/core/lib/Untouched.php`]: '<?php // same\n'
		});
		const ctx = ctxFor(seed, {
			[COMPOSER_PRISTINE]: () => {
				ctx.files.writeText(
					`${P}/.drangler/pristine/vendor/drupal/core/lib/Patched.php`,
					'<?php // pristine\n'
				);
				ctx.files.writeText(
					`${P}/.drangler/pristine/vendor/drupal/core/lib/Untouched.php`,
					'<?php // same\n'
				);
				ctx.files.writeText(
					`${P}/.drangler/pristine/vendor/drupal/core/lib/Drupal.php`,
					'<?php\nclass Drupal {}\n'
				);
				return ok('');
			}
		});
		expect(await run(ctx, args())).toBe(EXIT.OK);
		const commits = ctx.site.calls.filter((c) => c.action === 'commit');
		expect(commits[0]!.pkg).toBe('project_core');
		expect(commits[0]!.body.files.map((f: { path: string }) => f.path)).toEqual([
			'core/lib/Patched.php'
		]);
		const pristine = ctx.runner.calls.find((c) => c.args[0] === 'update');
		expect(pristine?.cwd).toBe(`${P}/.drangler/pristine`);
	});

	it('leaves core alone with --no-core', async () => {
		const ctx = ctxFor(
			project({
				[`${P}/patches.lock.json`]: JSON.stringify({
					patches: { 'drupal/core': [{ url: 'a' }] }
				})
			})
		);
		expect(await run(ctx, args(['--no-core']))).toBe(EXIT.OK);
		expect(ctx.site.calls.some((c) => c.pkg === 'project_core')).toBe(false);
		expect(ctx.runner.calls.some((c) => c.args[0] === 'update')).toBe(false);
	});

	it('runs composer in the composer image by default, capped, with the project mounted', async () => {
		const ctx = ctxFor(project());
		ctx.env.DRANGLER_DOCKER_ARGS = '--memory 4g --cpus 4';
		const seen: { file: string; args: readonly string[] }[] = [];
		ctx.runner = {
			...ctx.runner,
			spawn: async (file, argv) => {
				seen.push({ file, args: argv });
				return 0;
			}
		};
		const argv = args().filter(
			(a, i, all) => a !== '--composer' && all[i - 1] !== '--composer'
		);
		expect(await run(ctx, argv)).toBe(EXIT.OK);
		expect(seen[0]?.file).toBe('docker');
		expect(seen[0]?.args.slice(0, 2)).toEqual(['run', '--rm']);
		expect(seen[0]?.args).toEqual(
			expect.arrayContaining([
				'--memory',
				'4g',
				'--cpus',
				'4',
				'-v',
				`${P}:/app`,
				'-w',
				'/app'
			])
		);
		expect(seen[0]?.args.slice(-6)).toEqual([
			'install',
			'--no-interaction',
			'--no-progress',
			'--no-scripts',
			'--ignore-platform-reqs',
			'--prefer-dist'
		]);
		expect(seen[0]?.args.at(-7)).toBe('composer:2');
	});

	it('keeps composer output off stdout under --json', async () => {
		const ctx = ctxFor(project(), {
			[COMPOSER_INSTALL]: ok('Scaffolding files for drupal/core:')
		});
		expect(await run(ctx, args(['--json']))).toBe(EXIT.OK);
		expect(ctx.io.json<{ project: string }>().project).toBe(P);
		expect(ctx.runner.calls[0]?.mode).toBe('run');
		expect(ctx.io.stderr.join('\n')).toContain('Scaffolding files');
	});

	it('stops with the composer exit code when composer fails', async () => {
		const ctx = ctxFor(project(), {
			[COMPOSER_INSTALL]: { code: 2, stdout: '', stderr: 'boom' }
		});
		expect(await run(ctx, args())).toBe(EXIT.FAILED);
		expect(ctx.site.calls).toEqual([]);
	});

	it('takes the shipped lock from the published worker when nothing local names one', async () => {
		const urls: string[] = [];
		const site = fakeSite();
		const inner = site.fetch;
		const ctx = ctxFor(
			project(),
			{},
			{
				calls: site.calls,
				fetch: (async (input: unknown, init?: RequestInit) => {
					urls.push(String(input));
					if (String(input).includes('raw.githubusercontent.com')) {
						return new Response(SHIPPED_LOCK);
					}
					return (inner as any)(input, init);
				}) as unknown as FetchLike
			}
		);
		const argv = args(['--dry-run']).filter(
			(a, i, all) => !(a === '--shipped-lock' || all[i - 1] === '--shipped-lock')
		);
		expect(await run(ctx, argv)).toBe(EXIT.OK);
		expect(urls[0]).toBe(
			'https://raw.githubusercontent.com/drupflare/worker/master/composer.lock'
		);
	});

	it('refuses a directory with no composer.json and a --composer it does not know', async () => {
		expect(await run(ctxFor({}), args(['--dry-run']))).toBe(EXIT.USAGE);
		expect(await run(ctxFor(project()), args(['--composer', 'bogus']))).toBe(EXIT.USAGE);
	});
});
