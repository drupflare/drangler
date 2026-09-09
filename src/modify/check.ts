import type { Context } from '../context';
import { ownerCall, type OwnerTarget } from '../owner';
import {
	composerNameOf,
	MAX_BODY_BYTES,
	RECORD_CAP,
	type DetectedPackage,
	type DetectedProject,
	type PackageFile,
	type PackageSelection
} from './detect';
import { planBatches, type BlobEntry } from './upload';

/** extensions `php -l` can say anything about; a `.yml` or a `.twig` is not one of them */
const LINTABLE = /\.(php|module|inc|install|theme|profile|engine)$/;

export interface LintResult {
	ran: boolean;
	/** the binary that ran, or the reason none did */
	binary: string | null;
	reason: string | null;
	checked: number;
	failures: { path: string; message: string }[];
}

export interface DependencyVerdict {
	/** the info file's own string, such as `drupal:node` */
	declared: string;
	/** the composer name it was looked up under */
	name: string;
	verdict: string | null;
	version: string | null;
	note: string | null;
	/** `not-found` means no registry project, which is what a core module looks like from here */
	registry: boolean;
}

export interface CheckReport {
	package: string;
	mount: string;
	files: number;
	skipped: number;
	bytes: number;
	batches: number;
	lint: LintResult;
	/** files no request body can carry, and files no single row can hold */
	oversized: { path: string; bytes: number; why: string }[];
	collisions: { path: string; packages: string[] }[];
	dependencies: DependencyVerdict[];
	findings: string[];
	ok: boolean;
}

export interface CheckOptions {
	/** a local PHP binary; without one the lint is skipped with a named reason */
	php?: string;
	/** resolve every declared dependency against `/installable` */
	deps?: boolean;
	/** an owner target, when `--deps` is asked for */
	owner?: OwnerTarget;
}

/**
 * Everything that can be known before bytes leave this machine.
 *
 * Every kept file parses, no file exceeds a row or a request body, no two packages here want the
 * same mount, and with `--deps` every declared dependency resolves.
 *
 * **A collision with a package on the SITE is not checked here, and the reason is the route.**
 * `/modify?action=status` reports package names and `plan` reports the file-level diff for the one
 * package it was asked about; neither returns another package's paths, so the only place that
 * knows is `commit`, which refuses with a 409 naming both. What is checked here is the collision
 * this machine can see: two packages in one project wanting one mount.
 */
export async function checkPackage(
	ctx: Context,
	project: DetectedProject,
	pkg: DetectedPackage,
	selection: PackageSelection,
	opts: CheckOptions = {}
): Promise<CheckReport> {
	const blobs: BlobEntry[] = await Promise.all(
		selection.files.map(async (file) => ({
			hash: await hashSource(file.source),
			source: file.source
		}))
	);
	const report: CheckReport = {
		package: pkg.name,
		mount: pkg.mount,
		files: selection.files.length,
		skipped: selection.skipped.length,
		bytes: selection.totalBytes,
		batches: planBatches(blobs).length,
		lint: await lintFiles(ctx, selection.files, opts.php),
		oversized: oversizedFiles(selection.files),
		collisions: mountCollisions(project),
		dependencies: [],
		findings: [],
		ok: true
	};

	if (opts.deps === true && opts.owner !== undefined) {
		report.dependencies = await resolveDependencies(ctx, opts.owner, pkg);
	}

	if (report.files === 0) {
		report.findings.push(
			'no file in this package passes the mount filter, so there is nothing to upload'
		);
	}
	for (const failure of report.lint.failures) {
		report.findings.push(`${failure.path}: ${failure.message}`);
	}
	for (const big of report.oversized) {
		report.findings.push(`${big.path}: ${big.why}`);
	}
	for (const clash of report.collisions) {
		report.findings.push(`${clash.path} is claimed by ${clash.packages.join(' and ')}`);
	}
	for (const dep of report.dependencies) {
		if (!dep.registry || dep.verdict === 'installable') continue;
		report.findings.push(
			`${dep.declared} resolves to ${dep.verdict ?? 'nothing'}${dep.note === null ? '' : `: ${dep.note}`}`
		);
	}
	report.ok = report.findings.length === 0;
	return report;
}

/** sha256 of the UTF-8 bytes, which is what the site re-computes before it stores a blob */
export async function hashSource(source: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function lintFiles(
	ctx: Context,
	files: readonly PackageFile[],
	php?: string
): Promise<LintResult> {
	if (php === undefined) {
		return {
			ran: false,
			binary: null,
			reason: 'no --php given, so nothing parsed the PHP on this machine',
			checked: 0,
			failures: []
		};
	}
	const version = await ctx.runner.run(php, ['--version']);
	if (version.code !== 0) {
		return {
			ran: false,
			binary: php,
			reason: `\`${php} --version\` exited ${version.code}`,
			checked: 0,
			failures: []
		};
	}
	const failures: { path: string; message: string }[] = [];
	const lintable = files.filter((file) => LINTABLE.test(file.path));
	for (const file of lintable) {
		const result = await ctx.runner.run(php, ['-l', file.local]);
		if (result.code === 0) continue;
		const message = `${result.stdout}\n${result.stderr}`
			.split('\n')
			.map((line) => line.trim())
			.find((line) => line !== '');
		failures.push({ path: file.path, message: message ?? `php -l exited ${result.code}` });
	}
	return {
		ran: true,
		binary: `${php} ${/(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1] ?? 'unknown version'}`,
		reason: null,
		checked: lintable.length,
		failures
	};
}

function oversizedFiles(files: readonly PackageFile[]): CheckReport['oversized'] {
	const out: CheckReport['oversized'] = [];
	for (const file of files) {
		if (file.bytes > RECORD_CAP) {
			out.push({
				path: file.path,
				bytes: file.bytes,
				why: `over the ${RECORD_CAP} byte record cap`
			});
		} else if (file.bytes > MAX_BODY_BYTES) {
			// selectPackageFiles keeps anything under RECORD_CAP, and RECORD_CAP is larger than the
			// body limit, so a file can pass one and still have no request that carries it
			out.push({
				path: file.path,
				bytes: file.bytes,
				why: `over the ${MAX_BODY_BYTES} byte request body limit, and a blob cannot be split`
			});
		}
	}
	return out;
}

function mountCollisions(project: DetectedProject): CheckReport['collisions'] {
	const byMount = new Map<string, string[]>();
	for (const pkg of project.packages) {
		byMount.set(pkg.mount, [...(byMount.get(pkg.mount) ?? []), pkg.name]);
	}
	return [...byMount]
		.filter(([, names]) => names.length > 1)
		.map(([path, packages]) => ({ path, packages }));
}

/**
 * Every declared dependency, against `/installable`.
 *
 * Every one is asked about, including the ones that look like core. The project half of a
 * `project:module` dependency is not a reliable core marker -- mantle2 writes its four contrib
 * dependencies as `drupal:json_field`, `drupal:key`, `drupal:smtp` and `drupal:redis` -- so the
 * registry answers instead of a prefix. A core module has no project of its own on drupal.org, so
 * `not-found` is what core looks like from here and is reported as such rather than as a failure.
 *
 * This says whether a dependency CAN be installed. Whether it IS installed is a different question,
 * and no route lists a site's enabled modules, so claiming the second would claim more than was
 * measured.
 */
async function resolveDependencies(
	ctx: Context,
	owner: OwnerTarget,
	pkg: DetectedPackage
): Promise<DependencyVerdict[]> {
	const out: DependencyVerdict[] = [];
	for (const declared of pkg.dependencies) {
		const name = composerNameOf(declared);
		const reply = await ownerCall(ctx, owner, '/installable', { params: { module: name } });
		const verdict = typeof reply.body['verdict'] === 'string' ? reply.body['verdict'] : null;
		out.push({
			declared,
			name,
			verdict,
			version: typeof reply.body['version'] === 'string' ? reply.body['version'] : null,
			note: typeof reply.body['note'] === 'string' ? reply.body['note'] : null,
			registry: verdict !== null && verdict !== 'not-found'
		});
	}
	return out;
}
