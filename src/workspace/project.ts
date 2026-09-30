import { UsageError } from '../errors';
import type { FileHost } from '../host/files';
import {
	DROP,
	KEEP,
	MAX_BODY_BYTES,
	RECORD_CAP,
	detectProject,
	selectPackageFiles,
	walkFiles,
	type DetectedPackage,
	type PackageFile,
	type PackageSelection
} from '../modify/detect';
import type { AutoloadDeclaration } from '../modify/upload';

/**
 * What a composer project has to send to a drupflare site, worked out from its lock.
 *
 * The site holds a pack (Drupal core and the packages of the worker's own `composer.lock`), so the
 * delivery set is the lock's packages minus what the pack already has: composer's answer for THIS
 * project, computed natively where composer can run, then diffed against the shipped lock.
 */

/** packages the pack patches for the interpreter, so a delivered copy would undo the patch */
export const PACK_OWNED: Record<string, string> = {
	'guzzlehttp/guzzle': 'the pack rewrites Utils::chooseHandler() for the interpreter'
};

/** core files the pack rewrites (`scripts/patch-drupal.mjs` in the worker), never overlaid whole */
export const WORKER_PATCHED_CORE = [
	'core/lib/Drupal/Core/Render/Renderer.php',
	'core/lib/Drupal/Core/Session/AccessPolicyProcessor.php',
	'core/lib/Drupal/Core/Field/Plugin/Field/FieldType/EntityReferenceItemBase.php',
	'core/modules/language/src/ConfigurableLanguageManager.php',
	'core/modules/big_pipe/src/Render/BigPipe.php',
	'core/includes/batch.inc'
];

/** text a vendor package may need beyond the PHP allow-list; a blob is UTF-8 text */
export const VENDOR_KEEP = [...KEEP, /\.(json|txt|ini|xml|dist|html?|xlf|csv|svg)$/];

/** one group of revisions is kept under this much declared JSON, well inside the body limit */
export const GROUP_BUDGET_BYTES = Math.floor(MAX_BODY_BYTES * 0.7);

export interface LockPackage {
	name: string;
	version: string;
	type: string;
	autoload: Record<string, unknown>;
}

export interface Lock {
	packages: LockPackage[];
	extra: Record<string, unknown>;
}

export function parseLock(text: string, label = 'composer.lock'): Lock {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new UsageError(`${label} is not JSON`);
	}
	const raw = (parsed as { packages?: unknown } | null)?.packages;
	if (!Array.isArray(raw)) throw new UsageError(`${label} has no packages array`);
	const packages: LockPackage[] = [];
	for (const entry of raw) {
		const e = entry as Record<string, unknown>;
		if (typeof e['name'] !== 'string' || typeof e['version'] !== 'string') continue;
		packages.push({
			name: e['name'],
			version: e['version'],
			type: typeof e['type'] === 'string' ? e['type'] : 'library',
			autoload:
				e['autoload'] !== null && typeof e['autoload'] === 'object'
					? (e['autoload'] as Record<string, unknown>)
					: {}
		});
	}
	const extra = (parsed as { extra?: unknown }).extra;
	return {
		packages,
		extra: extra !== null && typeof extra === 'object' ? (extra as Record<string, unknown>) : {}
	};
}

/** name to version, which is the whole of what the delivery diff needs from the shipped lock */
export function versionsOf(lock: Lock): Record<string, string> {
	return Object.fromEntries(lock.packages.map((p) => [p.name, p.version]));
}

const bare = (version: string): string => version.replace(/^v/i, '');

/**
 * Every package the project patches, from each place a patch plugin records one.
 *
 * composer-patches 2 writes `patches.lock.json`, 1.x reads `composer.patches.json` and the
 * `extra.patches` of `composer.json`, and either may leave `patches_applied` in the lock's extra.
 * A package named by any of them is delivered even at the version the pack holds.
 */
export function patchedPackages(files: FileHost, dir: string, lock: Lock): Set<string> {
	const out = new Set<string>();
	const read = (name: string): Record<string, unknown> | null => {
		const path = `${dir}/${name}`;
		if (!files.exists(path)) return null;
		try {
			return JSON.parse(files.readText(path)) as Record<string, unknown>;
		} catch {
			return null;
		}
	};
	const take = (value: unknown): void => {
		if (value === null || typeof value !== 'object') return;
		for (const [name, patches] of Object.entries(value)) {
			const count = Array.isArray(patches)
				? patches.length
				: patches !== null && typeof patches === 'object'
					? Object.keys(patches).length
					: 0;
			if (count > 0) out.add(name);
		}
	};
	take(read('patches.lock.json')?.['patches']);
	take(read('composer.patches.json')?.['patches']);
	const manifest = read('composer.json');
	take((manifest?.['extra'] as { patches?: unknown } | undefined)?.patches);
	take(lock.extra['patches_applied']);
	take(lock.extra['patches']);
	return out;
}

/** where a locked package lands in the Drupal tree, or null when it is not delivered as files */
export function mountOf(name: string, type: string): string | null {
	const short = name.split('/')[1] ?? name;
	switch (type) {
		case 'drupal-module':
		case 'drupal-custom-module':
			return `modules/contrib/${short}`;
		case 'drupal-theme':
		case 'drupal-custom-theme':
			return `themes/contrib/${short}`;
		case 'drupal-profile':
		case 'drupal-custom-profile':
			return `profiles/contrib/${short}`;
		case 'drupal-library':
		case 'npm-asset':
		case 'bower-asset':
			return `libraries/${short}`;
		case 'composer-plugin':
		case 'metapackage':
		case 'drupal-drush':
		case 'drupal-recipe':
		case 'drupal-core':
		case 'project':
			return null;
		default:
			return `vendor/${name}`;
	}
}

export type DeliveryReason = 'missing' | 'version' | 'patched';

export interface DeliveryItem {
	name: string;
	version: string;
	type: string;
	mount: string;
	reason: DeliveryReason;
	/** the version the pack holds, when it holds one */
	shipped: string | null;
	autoload: Record<string, unknown>;
}

export type CoreVerdict =
	| { state: 'absent' }
	| { state: 'same'; version: string }
	| { state: 'patched'; version: string }
	| { state: 'drift'; project: string; shipped: string }
	| { state: 'mismatch'; project: string; shipped: string | null };

export interface DeliveryPlan {
	items: DeliveryItem[];
	skipped: { name: string; why: string }[];
	core: CoreVerdict;
}

/**
 * Which locked packages the site lacks, holds at another version, or holds unpatched.
 *
 * A package the pack holds at a NEWER version stays the pack's: shadowing it with older files
 * downgrades part of the framework. One the project locks newer is delivered only while the
 * project's core is on the pack's minor: a different minor means a different framework, and shadowing files of the pack's
 * `symfony/*` with a copy built for another Drupal is worse than the pack's own version.
 */
export function computeDelivery(
	lock: Lock,
	shipped: Record<string, string>,
	patched: ReadonlySet<string>
): DeliveryPlan {
	const items: DeliveryItem[] = [];
	const skipped: DeliveryPlan['skipped'] = [];
	const projectCore = lock.packages.find((p) => p.name === 'drupal/core')?.version ?? null;
	const shippedCore = shipped['drupal/core'] ?? null;
	const minor = (v: string): string => bare(v).split('.').slice(0, 2).join('.');
	const core: CoreVerdict =
		projectCore === null
			? { state: 'absent' }
			: shippedCore !== null && bare(projectCore) === bare(shippedCore)
				? patched.has('drupal/core')
					? { state: 'patched', version: projectCore }
					: { state: 'same', version: projectCore }
				: shippedCore !== null && minor(projectCore) === minor(shippedCore)
					? { state: 'drift', project: projectCore, shipped: shippedCore }
					: { state: 'mismatch', project: projectCore, shipped: shippedCore };

	for (const pkg of lock.packages) {
		if (pkg.name === 'drupal/core' || pkg.name.startsWith('drupal/core-')) continue;
		const mount = mountOf(pkg.name, pkg.type);
		if (mount === null) {
			skipped.push({ name: pkg.name, why: `a ${pkg.type} carries no files the site mounts` });
			continue;
		}
		const pack = shipped[pkg.name] ?? null;
		const owned = PACK_OWNED[pkg.name];
		if (owned !== undefined && pack !== null) {
			skipped.push({ name: pkg.name, why: owned });
			continue;
		}
		const same = pack !== null && bare(pack) === bare(pkg.version);
		if (same && !patched.has(pkg.name)) continue;
		if (pack !== null && !same && newerThan(pack, pkg.version)) {
			skipped.push({
				name: pkg.name,
				why: `the pack holds ${pack}, which is newer than the ${pkg.version} this project locks, so the pack's version stands`
			});
			continue;
		}
		if (pack !== null && !same && core.state === 'mismatch') {
			skipped.push({
				name: pkg.name,
				why: `the pack holds ${pack} and this project's core is not the pack's, so the pack's version stands`
			});
			continue;
		}
		items.push({
			name: pkg.name,
			version: pkg.version,
			type: pkg.type,
			mount,
			reason: pack === null ? 'missing' : same ? 'patched' : 'version',
			shipped: pack,
			autoload: pkg.autoload
		});
	}
	items.sort((a, b) => a.mount.localeCompare(b.mount));
	return { items, skipped, core };
}

/** whether `a` orders above `b` by their numeric parts; false when either is not a plain version */
export function newerThan(a: string, b: string): boolean {
	const parts = (v: string): number[] | null => {
		const m = /^(\d+(?:\.\d+)*)(?:[-+.].*)?$/.exec(bare(v));
		return m === null ? null : m[1]!.split('.').map(Number);
	};
	const x = parts(a);
	const y = parts(b);
	if (x === null || y === null) return false;
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	return false;
}

/** the directory composer installed a package into, from `vendor/composer/installed.json` */
export function installPaths(files: FileHost, dir: string): Map<string, string> {
	const out = new Map<string, string>();
	const path = `${dir}/vendor/composer/installed.json`;
	if (!files.exists(path)) return out;
	try {
		const parsed = JSON.parse(files.readText(path)) as {
			packages?: { name?: string; 'install-path'?: string }[];
		};
		for (const p of parsed.packages ?? []) {
			if (typeof p.name !== 'string' || typeof p['install-path'] !== 'string') continue;
			out.set(p.name, normalise(`${dir}/vendor/composer/${p['install-path']}`));
		}
	} catch {
		// an unreadable file is the same as none, and the caller falls back to vendor/<name>
	}
	return out;
}

/** collapses `..` and `.` so `vendor/composer/../foo/bar` reads as `vendor/foo/bar` */
export function normalise(path: string): string {
	const out: string[] = [];
	for (const part of path.split('/')) {
		if (part === '..') out.pop();
		else if (part !== '.' && part !== '') out.push(part);
	}
	return `${path.startsWith('/') ? '/' : ''}${out.join('/')}`;
}

/** the name a `/modify` package is known by: drupal extensions by machine name, the rest vendor__name */
export function modifyNameOf(name: string, mount: string): string {
	const [vendor, short] = name.split('/') as [string, string];
	return /^(modules|themes|profiles)\//.test(mount) ? short : `${vendor}__${short}`;
}

/** one revision the build uploads: a set of packages whose files fit one manifest */
export interface UploadGroup {
	name: string;
	selection: PackageSelection;
	autoload: AutoloadDeclaration[];
	members: string[];
}

interface Member {
	label: string;
	selection: PackageSelection;
	autoload: AutoloadDeclaration | null;
}

const declaredBytes = (selection: PackageSelection): number =>
	selection.files.reduce((sum, f) => sum + f.path.length + 64 + 40, 0);

/**
 * Packs members into revisions no bigger than the budget, never splitting a package across two.
 *
 * One revision per package would boot the kernel once per package, and a project has a hundred.
 * A group is a revision, so a rebuild replaces the group wholesale and a package dropped from the
 * lock leaves with it. A package alone over the budget is reported rather than truncated.
 */
export function groupMembers(
	base: string,
	members: readonly Member[],
	budget = GROUP_BUDGET_BYTES
): { groups: UploadGroup[]; oversized: { name: string; bytes: number }[] } {
	const groups: UploadGroup[] = [];
	const oversized: { name: string; bytes: number }[] = [];
	let current: UploadGroup | null = null;
	let size = 0;
	for (const member of members) {
		const bytes = declaredBytes(member.selection);
		if (bytes > budget) {
			oversized.push({ name: member.label, bytes });
			continue;
		}
		if (current === null || size + bytes > budget) {
			current = {
				name: groups.length === 0 ? base : `${base}_${groups.length + 1}`,
				selection: { files: [], skipped: [], totalBytes: 0 },
				autoload: [],
				members: []
			};
			groups.push(current);
			size = 0;
		}
		current.selection.files.push(...member.selection.files);
		current.selection.skipped.push(...member.selection.skipped);
		current.selection.totalBytes += member.selection.totalBytes;
		if (member.autoload !== null) current.autoload.push(member.autoload);
		current.members.push(member.label);
		size += bytes;
	}
	return { groups, oversized };
}

/** a package's files, read from where composer put them, under the mount the site expects */
export function selectDelivered(
	files: FileHost,
	dir: string,
	item: DeliveryItem,
	paths: ReadonlyMap<string, string>
): { selection: PackageSelection; autoload: AutoloadDeclaration | null; dir: string } {
	const at = paths.get(item.name) ?? `${dir}/vendor/${item.name}`;
	const pkg: DetectedPackage = {
		name: item.name,
		type: 'module',
		dir: at,
		info: '',
		mount: item.mount,
		dependencies: []
	};
	const selection = files.exists(at)
		? selectPackageFiles(files, pkg, VENDOR_KEEP)
		: { files: [], skipped: [], totalBytes: 0 };
	const isCode = item.mount.startsWith('vendor/') || item.mount.startsWith('libraries/');
	return {
		selection,
		dir: at,
		autoload: isCode
			? {
					name: item.name,
					version: item.version,
					mount: item.mount,
					autoload: item.autoload
				}
			: null
	};
}

/**
 * The files of the project's own code: custom modules, themes and profiles, plus whatever sits in
 * the docroot's `libraries/` that composer did not put there.
 */
export function selectCustom(
	files: FileHost,
	dir: string,
	delivered: ReadonlySet<string>
): Member[] {
	const members: Member[] = [];
	let project;
	try {
		project = detectProject(files, dir);
	} catch {
		return members;
	}
	for (const pkg of project.packages) {
		members.push({
			label: pkg.mount,
			selection: selectPackageFiles(files, pkg),
			autoload: null
		});
	}
	const docroot = ['web', 'docroot', 'html']
		.map((d) => `${dir}/${d}`)
		.find((d) => files.exists(`${d}/core/lib/Drupal.php`));
	if (docroot !== undefined && files.exists(`${docroot}/libraries`)) {
		for (const entry of files.readDir(`${docroot}/libraries`)) {
			const at = normalise(`${docroot}/libraries/${entry.name}`);
			if (!entry.directory || delivered.has(at)) continue;
			const pkg: DetectedPackage = {
				name: entry.name,
				type: 'module',
				dir: at,
				info: '',
				mount: `libraries/${entry.name}`,
				dependencies: []
			};
			members.push({
				label: pkg.mount,
				selection: selectPackageFiles(files, pkg, VENDOR_KEEP),
				autoload: null
			});
		}
	}
	return members;
}

export interface CoreOverlay {
	selection: PackageSelection;
	/** paths only the pristine core has; a revision cannot remove a packed file */
	removed: string[];
	/** changed paths the pack rewrites itself, left out so the interpreter patch survives */
	refused: string[];
}

/** what patching changed in core: the files of `patched` that differ from `pristine`, under `core/` */
export function diffCore(files: FileHost, patched: string, pristine: string): CoreOverlay {
	const changed: PackageFile[] = [];
	const refused: string[] = [];
	const after = walkFiles(files, patched).sort();
	const before = new Set(walkFiles(files, pristine));
	let totalBytes = 0;
	for (const rel of after) {
		if (DROP.some((re) => re.test(rel)) || !KEEP.some((re) => re.test(rel))) continue;
		before.delete(rel);
		const local = `${patched}/${rel}`;
		const bytes = files.size(local);
		if (bytes > RECORD_CAP) continue;
		const other = `${pristine}/${rel}`;
		if (files.exists(other) && sameBytes(files.readBytes(local), files.readBytes(other)))
			continue;
		const path = `core/${rel}`;
		if (WORKER_PATCHED_CORE.includes(path)) {
			refused.push(path);
			continue;
		}
		changed.push({ path, local, source: files.readText(local), bytes });
		totalBytes += bytes;
	}
	const removed = [...before]
		.filter((rel) => !DROP.some((re) => re.test(rel)) && KEEP.some((re) => re.test(rel)))
		.map((rel) => `core/${rel}`)
		.sort();
	return { selection: { files: changed, skipped: [], totalBytes }, removed, refused };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
