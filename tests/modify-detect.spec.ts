import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors';
import { memoryFiles } from '../src/host/files';
import {
	composerNameOf,
	detectProject,
	DROP,
	KEEP,
	packageOf,
	readDependencies,
	RECORD_CAP,
	selectPackageFiles,
	walkFiles
} from '../src/modify/detect';

const DIR = '/work/mantle2';

/**
 * mantle2's real layout, cut down to what detection and selection look at.
 *
 * The dependency block is verbatim from `mantle2.info.yml`, including the part that matters: four
 * CONTRIB dependencies declared under the `drupal:` project prefix.
 */
const MANTLE2_INFO = [
	'name: mantle2',
	'type: module',
	'description: Core Mantle2 Implementation',
	'core_version_requirement: ^11',
	'',
	'dependencies:',
	'  - drupal:node',
	'  - drupal:user',
	'  - drupal:comment',
	'  - drupal:json_field',
	'  - drupal:key',
	'  - drupal:field',
	'  - drupal:options',
	'  - drupal:datetime',
	'  - drupal:smtp',
	'  - drupal:redis',
	''
].join('\n');

function mantle2(over: Record<string, string> = {}): Record<string, string> {
	return {
		[`${DIR}/.git/HEAD`]: 'ref: refs/heads/master',
		[`${DIR}/mantle2.info.yml`]: MANTLE2_INFO,
		[`${DIR}/mantle2.module`]: '<?php\n',
		[`${DIR}/mantle2.install`]: '<?php\n',
		[`${DIR}/mantle2.services.yml`]: 'services: {}\n',
		[`${DIR}/mantle2.routing.yml`]: '{}\n',
		[`${DIR}/src/Service/StreakService.php`]: '<?php\nclass StreakService {}\n',
		[`${DIR}/composer.json`]: '{"name":"earth-app/mantle2"}',
		[`${DIR}/README.md`]: '# mantle2',
		[`${DIR}/package.json`]: '{}',
		// the three DROP directories a checkout really has, and a `.` path
		[`${DIR}/tests/src/Kernel/StreakTest.php`]: '<?php\n',
		[`${DIR}/vendor/autoload.php`]: '<?php\n',
		[`${DIR}/node_modules/left-pad/index.js`]: 'module.exports = 1;',
		[`${DIR}/.editorconfig`]: 'root = true',
		...over
	};
}

describe('detectProject', () => {
	it('reads a module project from its info file, not from its directory', () => {
		const project = detectProject(memoryFiles(mantle2()), DIR);
		expect(project).toMatchObject({ shape: 'module-project', repository: true });
		expect(project.from).toBe(`${DIR}/mantle2.info.yml`);
		expect(project.packages).toHaveLength(1);
		expect(project.packages[0]).toMatchObject({
			name: 'mantle2',
			type: 'module',
			mount: 'modules/custom/mantle2'
		});
	});

	// the split is whether a repository surrounds it, because that decides whether `release` can run
	it('calls a loose directory a bare module and says it has no repository', () => {
		const files = mantle2();
		delete files[`${DIR}/.git/HEAD`];
		const project = detectProject(memoryFiles(files), DIR);
		expect(project).toMatchObject({ shape: 'bare-module', repository: false });
	});

	it('mounts a theme under themes/custom and a profile under profiles/custom', () => {
		const theme = detectProject(
			memoryFiles({
				'/work/olivero/olivero.info.yml': 'name: Olivero\ntype: theme\n',
				'/work/olivero/olivero.theme': '<?php\n'
			}),
			'/work/olivero'
		);
		expect(theme.packages[0]).toMatchObject({
			type: 'theme',
			mount: 'themes/custom/olivero'
		});

		const profile = detectProject(
			memoryFiles({
				'/work/demo/demo.info.yml': 'name: Demo\ntype: profile\n',
				'/work/demo/demo.profile': '<?php\n'
			}),
			'/work/demo'
		);
		expect(profile.packages[0]?.mount).toBe('profiles/custom/demo');
	});

	/** Drupal discovers a submodule as part of its parent, so mounting it again installs it twice */
	it('drops a submodule that lives inside another package', () => {
		const project = detectProject(
			memoryFiles(
				mantle2({
					[`${DIR}/modules/mantle2_extra/mantle2_extra.info.yml`]:
						'name: Extra\ntype: module\n'
				})
			),
			DIR
		);
		expect(project.packages.map((p) => p.name)).toEqual(['mantle2']);
	});

	it('finds every custom package in a Drupal source tree, and names the marker it used', () => {
		const project = detectProject(
			memoryFiles({
				'/work/site/web/core/lib/Drupal.php': '<?php\n',
				'/work/site/web/modules/custom/one/one.info.yml': 'name: One\ntype: module\n',
				'/work/site/web/modules/custom/one/one.module': '<?php\n',
				'/work/site/web/themes/custom/skin/skin.info.yml': 'name: Skin\ntype: theme\n',
				// contrib is NOT uploaded; it belongs to the registry
				'/work/site/web/modules/contrib/token/token.info.yml': 'name: Token\n'
			}),
			'/work/site'
		);
		expect(project.shape).toBe('drupal-tree');
		expect(project.from).toBe('/work/site/web/core/lib/Drupal.php');
		expect(project.packages.map((p) => p.name).sort()).toEqual(['one', 'skin']);
	});

	/**
	 * A patch listing is refused BY NAME rather than as an unknown shape.
	 *
	 * Applying a patch needs the thing it patches, which lives on the site rather than on this disk,
	 * so the refusal names the two answers that do work.
	 */
	it('refuses a directory of patches and points at the two real answers', () => {
		const files = memoryFiles({
			'/work/patches/2919984-fix-views.patch': 'diff --git a b',
			'/work/patches/other.diff': 'diff --git a b'
		});
		expect(() => detectProject(files, '/work/patches')).toThrow(UsageError);
		expect(() => detectProject(files, '/work/patches')).toThrow(/patch the checkout/);
	});

	it('names what it looked for when a directory is no shape at all', () => {
		const files = memoryFiles({ '/work/empty/notes.txt': 'hello' });
		expect(() => detectProject(files, '/work/empty')).toThrow(/core\/lib\/Drupal\.php/);
	});
});

describe('packageOf', () => {
	const two = memoryFiles({
		'/work/tree/core/lib/Drupal.php': '<?php\n',
		'/work/tree/modules/custom/one/one.info.yml': 'name: One\n',
		'/work/tree/modules/custom/two/two.info.yml': 'name: Two\n'
	});

	it('takes the only package there is', () => {
		expect(packageOf(detectProject(memoryFiles(mantle2()), DIR)).name).toBe('mantle2');
	});

	it('names every candidate when there is more than one and no --package', () => {
		const project = detectProject(two, '/work/tree');
		expect(() => packageOf(project)).toThrow(/one, two/);
		expect(packageOf(project, 'two').name).toBe('two');
	});

	it('refuses a package the project does not hold', () => {
		expect(() => packageOf(detectProject(two, '/work/tree'), 'three')).toThrow(/three/);
	});
});

describe('selectPackageFiles', () => {
	it('keeps what a mounted tree can use and mounts it under the package', () => {
		const files = memoryFiles(mantle2());
		const project = detectProject(files, DIR);
		const selection = selectPackageFiles(files, packageOf(project));
		expect(selection.files.map((f) => f.path)).toEqual([
			'modules/custom/mantle2/mantle2.info.yml',
			'modules/custom/mantle2/mantle2.install',
			'modules/custom/mantle2/mantle2.module',
			'modules/custom/mantle2/mantle2.routing.yml',
			'modules/custom/mantle2/mantle2.services.yml',
			'modules/custom/mantle2/src/Service/StreakService.php'
		]);
	});

	it('skips tests, vendor, node_modules, dotfiles and unreadable extensions', () => {
		const files = memoryFiles(mantle2());
		const selection = selectPackageFiles(files, packageOf(detectProject(files, DIR)));
		const kept = selection.files.map((f) => f.path).join(' ');
		for (const absent of ['tests/', 'vendor/', 'node_modules/', '.editorconfig', 'README.md']) {
			expect(kept).not.toContain(absent);
		}
		// package.json passes no KEEP pattern, and composer.json is a `.json` too
		expect(kept).not.toContain('package.json');
		expect(selection.skipped.length).toBeGreaterThan(0);
	});

	it('refuses a file no single row can hold, with the byte count', () => {
		const files = memoryFiles(mantle2({ [`${DIR}/src/Huge.php`]: 'x'.repeat(10) }));
		const oversized = {
			...files,
			size: (path: string) => (path.endsWith('Huge.php') ? RECORD_CAP + 1 : files.size(path))
		};
		const selection = selectPackageFiles(oversized, packageOf(detectProject(files, DIR)));
		expect(selection.files.some((f) => f.path.endsWith('Huge.php'))).toBe(false);
		expect(selection.skipped.find((s) => s.path.endsWith('Huge.php'))?.why).toContain(
			'record cap'
		);
	});

	it('walks nothing for a directory that is not there', () => {
		expect(walkFiles(memoryFiles({}), '/nowhere')).toEqual([]);
	});
});

describe('dependencies', () => {
	it('reads the block an info file declares, and stops at the next key', () => {
		expect(readDependencies(MANTLE2_INFO)).toEqual([
			'drupal:node',
			'drupal:user',
			'drupal:comment',
			'drupal:json_field',
			'drupal:key',
			'drupal:field',
			'drupal:options',
			'drupal:datetime',
			'drupal:smtp',
			'drupal:redis'
		]);
		expect(readDependencies('name: x\ntype: module\n')).toEqual([]);
	});

	/**
	 * The MODULE half is what names the project, and mantle2 is why.
	 *
	 * It declares four contrib dependencies under the `drupal:` prefix, so reading the project half
	 * as "this is core" would call `json_field`, `key`, `smtp` and `redis` core and never ask the
	 * registry about any of them.
	 */
	it('maps a dependency onto the name /installable takes', () => {
		expect(composerNameOf('drupal:json_field')).toBe('drupal/json_field');
		expect(composerNameOf('key:key')).toBe('drupal/key');
		expect(composerNameOf('node')).toBe('drupal/node');
	});
});

/**
 * The drift check, against the sibling rather than against drangler's own copy.
 *
 * The mount filter is the worker's, in `src/ops/package-install.ts`. It is repeated here because the
 * selection happens on a local disk the site cannot see, so this reads the sibling's source and
 * fails when the two disagree. Skips when the sibling is absent and FAILS under `REQUIRE_SIBLINGS=1`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALL = resolve(HERE, '..', '..', 'worker', 'src', 'ops', 'package-install.ts');
const installSource = existsSync(INSTALL) ? readFileSync(INSTALL, 'utf8') : null;
if (installSource === null && process.env.REQUIRE_SIBLINGS) {
	throw new Error(
		`no worker checkout at ${INSTALL}, and REQUIRE_SIBLINGS says this lane has one.`
	);
}

describe.skipIf(installSource === null)('the mount filter tracks the worker', () => {
	const patterns = (name: string): string[] => {
		const source = installSource as string;
		const start = source.indexOf(`export const ${name} = [`);
		const block = source.slice(start, source.indexOf('] as const', start));
		return [...block.matchAll(/^\t(\/.+\/i?),?$/gm)].map((m) => m[1] as string);
	};

	it('keeps the same extensions', () => {
		expect(patterns('KEEP')).toEqual(KEEP.map((re) => re.toString()));
	});

	it('drops the same paths', () => {
		expect(patterns('DROP')).toEqual(DROP.map((re) => re.toString()));
	});

	it('agrees on the record cap', () => {
		const declared = /RECORD_CAP\s*=\s*([\d_]+)/.exec(installSource as string)?.[1];
		expect(Number((declared ?? '').replace(/_/g, ''))).toBe(RECORD_CAP);
	});
});
