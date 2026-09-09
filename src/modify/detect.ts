import { UsageError } from '../errors';
import type { FileHost } from '../host/files';

/**
 * What is in this directory, and which package(s) an upload would carry.
 *
 * Detection never guesses silently: every shape names the file it was decided from, and a directory
 * matching none of them is refused with the list of what was looked for.
 *
 * The mount rules and the file filter below are the worker's, in
 * `src/ops/git-sync.ts` and `src/ops/package-install.ts`. They are repeated here rather than
 * invoked because the selection happens on a local disk the site cannot see, and `/modify` takes
 * mounted paths. `tests/modify-detect.spec.ts` reads the sibling's source and fails when the two
 * disagree, which is the same guard `tests/workspace-artifacts.spec.ts` holds over the payload plan.
 */

/** extensions a mounted Drupal tree can use; `KEEP` in the worker's `ops/package-install.ts` */
export const KEEP = [
	/\.php$/,
	/\.inc$/,
	/\.module$/,
	/\.install$/,
	/\.theme$/,
	/\.profile$/,
	/\.engine$/,
	/\.yml$/,
	/\.twig$/,
	/\.js$/,
	/\.css$/
];

/** paths that never belong in a mounted tree even when their extension passes */
export const DROP = [
	/(^|\/)tests?\//i,
	/(^|\/)node_modules\//,
	/(^|\/)vendor\//,
	/(^|\/)\.github\//,
	/(^|\/)\./,
	/(^|\/)coverage\//i
];

/** a file above this cannot be one row, so it is refused rather than silently truncated */
export const RECORD_CAP = 2_199_995;

/** the largest request body the edge forwards; `MAX_BODY_BYTES` defaults to 2 MiB */
export const MAX_BODY_BYTES = 2_097_152;

const INFO = /(?:^|\/)([a-z0-9_]+)\.info\.yml$/;

const PATCH = /\.(patch|diff)$/i;

export type ExtensionType = 'module' | 'theme' | 'profile';

const DEST: Record<ExtensionType, string> = {
	module: 'modules/custom',
	theme: 'themes/custom',
	profile: 'profiles/custom'
};

export type ProjectShape = 'module-project' | 'drupal-tree' | 'bare-module' | 'patch-listing';

export interface DetectedPackage {
	/** the machine name, taken from the info file rather than from the directory */
	name: string;
	type: ExtensionType;
	/** the directory on this disk that holds it */
	dir: string;
	/** the info file the name and the type came from */
	info: string;
	/** where it lands in the Drupal tree */
	mount: string;
	/** every dependency the info file declares, verbatim */
	dependencies: string[];
}

export interface DetectedProject {
	shape: ProjectShape;
	dir: string;
	/** the file the shape was decided from */
	from: string;
	packages: DetectedPackage[];
	/** whether a git checkout surrounds it, which is what `modify release --tag` needs */
	repository: boolean;
}

/** every path under `dir`, relative to it, with the drop list applied to directories as it walks */
export function walkFiles(files: FileHost, dir: string, prefix = ''): string[] {
	let entries;
	try {
		entries = files.readDir(prefix === '' ? dir : `${dir}/${prefix}`);
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries) {
		const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
		if (entry.directory) {
			if (DROP.some((re) => re.test(`${rel}/`))) continue;
			out.push(...walkFiles(files, dir, rel));
			continue;
		}
		out.push(rel);
	}
	return out;
}

function typeOf(source: string): ExtensionType {
	const declared = /^type:\s*(\w+)/m.exec(source)?.[1];
	return declared === 'theme' ? 'theme' : declared === 'profile' ? 'profile' : 'module';
}

/**
 * The dependencies an info file declares, verbatim.
 *
 * Drupal writes them as `project:module`, and the bare form is legacy. Both are carried through
 * unchanged; {@link composerNameOf} is what turns one into a name a registry answers to.
 */
export function readDependencies(source: string): string[] {
	const out: string[] = [];
	let inside = false;
	for (const line of source.split('\n')) {
		if (/^dependencies:\s*$/.test(line)) {
			inside = true;
			continue;
		}
		if (!inside) continue;
		const entry = /^\s+-\s*['"]?([\w:.-]+)['"]?\s*$/.exec(line);
		if (entry !== null) {
			out.push(entry[1] as string);
			continue;
		}
		// a blank line inside a block is still the block; anything else ends it
		if (line.trim() !== '') break;
	}
	return out;
}

/**
 * `drupal:key` and `key:key` both as `drupal/key`, which is what `/installable` takes.
 *
 * The MODULE half is used and the project half is discarded, because the project half does not say
 * what it looks like it says: mantle2 declares its four contrib dependencies as `drupal:json_field`,
 * `drupal:key`, `drupal:smtp` and `drupal:redis`, so reading `drupal` as "this is core" would call
 * four contrib modules core and ask the registry about none of them.
 */
export function composerNameOf(dependency: string): string {
	const module = dependency.includes(':') ? (dependency.split(':').pop() as string) : dependency;
	return `drupal/${module}`;
}

function packageAt(files: FileHost, dir: string, infoRel: string): DetectedPackage | null {
	const name = INFO.exec(infoRel)?.[1];
	if (name === undefined) return null;
	const info = `${dir}/${infoRel}`;
	const source = files.exists(info) ? files.readText(info) : '';
	const type = typeOf(source);
	const root = infoRel.slice(0, Math.max(0, infoRel.length - `${name}.info.yml`.length - 1));
	return {
		name,
		type,
		dir: root === '' ? dir : `${dir}/${root}`,
		info,
		mount: `${DEST[type]}/${name}`,
		dependencies: readDependencies(source)
	};
}

/**
 * Drops a package that lives inside another one.
 *
 * Drupal discovers a submodule as part of its parent's tree, so mounting it again would install the
 * same extension at two paths. Shortest root first, so a parent is always decided before anything
 * nested in it.
 */
function outermost(found: DetectedPackage[]): DetectedPackage[] {
	const sorted = [...found].sort(
		(a, b) => a.dir.length - b.dir.length || (a.name < b.name ? -1 : 1)
	);
	const kept: DetectedPackage[] = [];
	for (const one of sorted) {
		if (kept.some((k) => one.dir === k.dir || one.dir.startsWith(`${k.dir}/`))) continue;
		kept.push(one);
	}
	return kept;
}

const DRUPAL_MARKERS = ['core/lib/Drupal.php', 'web/core/lib/Drupal.php'];

const CUSTOM_DIRS = ['modules/custom', 'themes/custom', 'profiles/custom'];

/**
 * Which of the four shapes this directory is.
 *
 * A patch listing is refused BY NAME rather than treated as an unknown shape. Applying a patch
 * needs the thing it patches, which is core or a contrib module living on the site rather than on
 * this disk, so the answer is to patch the checkout and upload the result.
 */
export function detectProject(files: FileHost, dir: string): DetectedProject {
	const root = dir.replace(/\/+$/, '');
	const repository = files.exists(`${root}/.git`);
	const paths = walkFiles(files, root);

	const marker = DRUPAL_MARKERS.find((path) => files.exists(`${root}/${path}`));
	if (marker !== undefined) {
		const base = marker.startsWith('web/') ? `${root}/web` : root;
		const packages: DetectedPackage[] = [];
		for (const custom of CUSTOM_DIRS) {
			for (const rel of walkFiles(files, `${base}/${custom}`)) {
				const found = packageAt(files, `${base}/${custom}`, rel);
				if (found !== null && INFO.test(rel)) packages.push(found);
			}
		}
		return {
			shape: 'drupal-tree',
			dir: root,
			from: `${root}/${marker}`,
			packages: outermost(packages),
			repository
		};
	}

	const infos = paths.filter((path) => INFO.test(path));
	if (infos.length === 0) {
		if (paths.some((path) => PATCH.test(path))) {
			throw new UsageError(
				`${root} holds patch files and no *.info.yml, and a patch listing is not a module tree. ` +
					'Applying a patch needs the thing it patches, which lives on the site rather than here: ' +
					'patch the checkout and upload the result, or use composer-patches in a Drupal source tree ' +
					'and upload the patched module directory.'
			);
		}
		throw new UsageError(
			`${root} matches no project shape drangler knows. It looked for a *.info.yml, ` +
				`for ${DRUPAL_MARKERS.join(' or ')}, and for a directory of patches.`
		);
	}

	const packages = outermost(
		infos
			.map((rel) => packageAt(files, root, rel))
			.filter((p): p is DetectedPackage => p !== null)
	);
	const topLevel = infos.some((rel) => !rel.includes('/'));
	return {
		// the split is whether a repository surrounds it, because that is what decides whether
		// `modify release --tag` can run at all
		shape: repository || !topLevel ? 'module-project' : 'bare-module',
		dir: root,
		from: packages[0]?.info ?? `${root}/${infos[0] as string}`,
		packages,
		repository
	};
}

/** the package `--package` names, or the only one there is */
export function packageOf(project: DetectedProject, wanted?: string): DetectedPackage {
	if (wanted !== undefined) {
		const hit = project.packages.find((p) => p.name === wanted);
		if (hit === undefined) {
			throw new UsageError(
				`no package named \`${wanted}\` in ${project.dir}; it holds ${
					project.packages.length === 0
						? 'none'
						: project.packages.map((p) => p.name).join(', ')
				}`
			);
		}
		return hit;
	}
	if (project.packages.length === 1) return project.packages[0] as DetectedPackage;
	throw new UsageError(
		project.packages.length === 0
			? `${project.dir} holds no package to work on`
			: `${project.dir} holds ${project.packages.length} packages (${project.packages
					.map((p) => p.name)
					.join(', ')}); name one with --package`
	);
}

export interface PackageFile {
	/** where it lands in the Drupal tree, which is the path `/modify` stores it under */
	path: string;
	/** where it is on this disk */
	local: string;
	source: string;
	bytes: number;
}

export interface PackageSelection {
	files: PackageFile[];
	skipped: { path: string; why: string }[];
	totalBytes: number;
}

/** the same allow-list a git delivery goes through, so an upload and a pull mount the same tree */
export function selectPackageFiles(files: FileHost, pkg: DetectedPackage): PackageSelection {
	const selected: PackageFile[] = [];
	const skipped: { path: string; why: string }[] = [];
	let totalBytes = 0;

	for (const rel of walkFiles(files, pkg.dir).sort()) {
		if (DROP.some((re) => re.test(rel))) {
			skipped.push({ path: rel, why: 'not part of a mountable tree' });
			continue;
		}
		if (!KEEP.some((re) => re.test(rel))) {
			skipped.push({ path: rel, why: 'extension is not executable or readable here' });
			continue;
		}
		const local = `${pkg.dir}/${rel}`;
		const bytes = files.size(local);
		if (bytes > RECORD_CAP) {
			skipped.push({ path: rel, why: `${bytes} bytes exceeds the record cap` });
			continue;
		}
		selected.push({ path: `${pkg.mount}/${rel}`, local, source: files.readText(local), bytes });
		totalBytes += bytes;
	}
	return { files: selected, skipped, totalBytes };
}
