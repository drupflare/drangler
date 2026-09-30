import { isAbsolute, resolve } from 'node:path';
import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { DranglerError, UsageError } from '../errors';
import { emit, bytes as humanBytes, kv, table } from '../format';
import { uploadPackage, type UploadResult } from '../modify/upload';
import { ownerTarget, type OwnerTarget } from '../owner';
import { isWorkerCheckout, resolveWorkspace } from '../workspace/layout';
import {
	computeDelivery,
	diffCore,
	groupMembers,
	installPaths,
	normalise,
	parseLock,
	patchedPackages,
	selectCustom,
	selectDelivered,
	versionsOf,
	type CoreOverlay,
	type DeliveryPlan,
	type UploadGroup
} from '../workspace/project';
import { resolveSource } from '../workspace/source';

export interface ProjectBuildOptions {
	project: string;
	/** a `composer.lock` to score against instead of the worker checkout's or the published one */
	shippedLock?: string;
	ref?: string;
	workspace?: string;
	/** `docker` runs composer in the composer:2 image, `host` runs the composer on PATH */
	composer?: 'docker' | 'host';
	image?: string;
	/** skip the composer step and read the project as it stands */
	install?: boolean;
	/** `false` leaves patched core files out */
	core?: boolean;
	globals: GlobalOptions;
}

const COMPOSER_ARGS = [
	'--no-interaction',
	'--no-progress',
	'--no-scripts',
	'--ignore-platform-reqs',
	'--prefer-dist'
];

export interface ProjectBuildReport {
	project: string;
	shipped: { from: string; core: string | null };
	composer: string | null;
	core: DeliveryPlan['core'] & {
		overlay?: { files: number; removed: string[]; refused: string[] };
	};
	delivery: {
		name: string;
		version: string;
		mount: string;
		reason: string;
		shipped: string | null;
		files: number | null;
	}[];
	skipped: DeliveryPlan['skipped'];
	oversized: { name: string; bytes: number }[];
	uploads: (Pick<UploadResult, 'package' | 'files' | 'stored' | 'rev' | 'applied' | 'error'> & {
		members: number;
	})[];
	notes: string[];
}

/**
 * Builds a composer project natively and sends the site what its pack lacks.
 *
 * composer runs where composer can (a `composer:2` container by default), with the project's own
 * plugins, so patches apply and private repositories authenticate from the project's `auth.json` or
 * `COMPOSER_AUTH`. The lock that comes out is diffed against the shipped one; what the pack lacks,
 * holds at another version, or holds unpatched goes up as `modify` revisions, vendor packages with
 * the autoload composer would have written. `--dry-run` reads the lock as it stands and prints the
 * set, touching neither composer nor the site.
 */
export async function runProjectBuild(ctx: Context, opts: ProjectBuildOptions): Promise<void> {
	const dir = normalise(isAbsolute(opts.project) ? opts.project : resolve(ctx.cwd, opts.project));
	if (!ctx.files.exists(`${dir}/composer.json`)) {
		throw new UsageError(`${dir} has no composer.json, so there is nothing to build`);
	}
	const dry = opts.globals.dryRun;
	const notes: string[] = [];
	const shipped = await loadShipped(ctx, opts);

	let composer: string | null = null;
	if (opts.install !== false && !dry) {
		composer = await composerStep(ctx, dir, opts, ['install', ...COMPOSER_ARGS]);
	} else {
		notes.push(
			dry
				? 'dry run: composer was not run, the lock is read as it stands'
				: 'composer was skipped; the project is read as it stands'
		);
	}
	const lockPath = `${dir}/composer.lock`;
	if (!ctx.files.exists(lockPath)) {
		throw new UsageError(
			`${dir} has no composer.lock; run composer install there or drop --no-install`
		);
	}
	const lock = parseLock(ctx.files.readText(lockPath), lockPath);
	const plan = computeDelivery(lock, shipped.versions, patchedPackages(ctx.files, dir, lock));
	const paths = installPaths(ctx.files, dir);

	const members = plan.items.map((item) => ({
		item,
		...selectDelivered(ctx.files, dir, item, paths)
	}));
	const contrib = members.filter((m) => /^(modules|themes|profiles)\//.test(m.item.mount));
	const code = members.filter((m) => !/^(modules|themes|profiles)\//.test(m.item.mount));
	const delivered = new Set(members.map((m) => m.dir));
	const oversized: ProjectBuildReport['oversized'] = [];
	const groups: UploadGroup[] = [];
	const add = (base: string, list: Parameters<typeof groupMembers>[1]): void => {
		const made = groupMembers(base, list);
		groups.push(...made.groups);
		oversized.push(...made.oversized);
	};

	let overlay: CoreOverlay | null = null;
	if (plan.core.state === 'patched' && opts.core !== false) {
		if (dry) {
			notes.push('core is patched; its overlay is worked out after composer runs');
		} else {
			overlay = await coreOverlay(ctx, dir, opts, plan.core.version, paths);
			add('project_core', [
				{ label: 'drupal/core', selection: overlay.selection, autoload: null }
			]);
		}
	}
	add(
		'project_vendor',
		code.map((m) => ({ label: m.item.name, selection: m.selection, autoload: m.autoload }))
	);
	add(
		'project_contrib',
		contrib.map((m) => ({ label: m.item.name, selection: m.selection, autoload: null }))
	);
	add('project_custom', selectCustom(ctx.files, dir, delivered));

	const report: ProjectBuildReport = {
		project: dir,
		shipped: { from: shipped.from, core: shipped.versions['drupal/core'] ?? null },
		composer,
		core: {
			...plan.core,
			...(overlay === null
				? {}
				: {
						overlay: {
							files: overlay.selection.files.length,
							removed: overlay.removed,
							refused: overlay.refused
						}
					})
		},
		delivery: members.map((m) => ({
			name: m.item.name,
			version: m.item.version,
			mount: m.item.mount,
			reason: m.item.reason,
			shipped: m.item.shipped,
			files: ctx.files.exists(m.dir) ? m.selection.files.length : null
		})),
		skipped: plan.skipped,
		oversized,
		uploads: [],
		notes
	};
	notes.push(...coreNotes(plan.core, overlay, opts));
	for (const item of report.delivery) {
		if (item.reason === 'version') {
			notes.push(
				`${item.name}: the pack holds ${item.shipped}; files only that version has stay mounted beside ${item.version}`
			);
		}
	}

	if (!dry) {
		const owner = ownerTarget(opts.globals);
		for (const group of groups) {
			if (group.selection.files.length === 0) continue;
			const result = await sendGroup(ctx, owner, group, dir);
			report.uploads.push({
				package: result.package,
				members: group.members.length,
				files: result.files,
				stored: result.stored,
				rev: result.rev,
				applied: result.applied,
				error: result.error
			});
			if (result.error !== null) {
				emit(ctx.io, opts.globals.json, report, () => render(report, dry));
				throw new DranglerError('project-upload', `${group.name}: ${result.error}`);
			}
		}
	}
	emit(ctx.io, opts.globals.json, report, () => render(report, dry));
}

/** the shipped lock: the flag, then the worker checkout at hand, then the published one */
async function loadShipped(
	ctx: Context,
	opts: ProjectBuildOptions
): Promise<{ versions: Record<string, string>; from: string }> {
	let file = opts.shippedLock;
	if (file !== undefined) file = isAbsolute(file) ? file : resolve(ctx.cwd, file);
	if (file === undefined) {
		const workspace = resolveWorkspace(ctx, { workspace: opts.workspace }, opts.globals.config);
		if (isWorkerCheckout(ctx.files, workspace.path)) file = `${workspace.path}/composer.lock`;
	}
	if (file !== undefined) {
		if (!ctx.files.exists(file)) throw new UsageError(`${file} does not exist`);
		return { versions: versionsOf(parseLock(ctx.files.readText(file), file)), from: file };
	}
	const source = resolveSource(ctx.env, undefined, opts.ref);
	const url = `https://raw.githubusercontent.com/drupflare/worker/${source.ref}/composer.lock`;
	const res = await ctx.fetch(url, { signal: AbortSignal.timeout(opts.globals.timeoutMs) });
	if (!res.ok) {
		throw new DranglerError(
			'project-shipped',
			`could not read the shipped lock from ${url} (${res.status}); pass --shipped-lock <composer.lock of the worker>`
		);
	}
	return { versions: versionsOf(parseLock(await res.text(), url)), from: url };
}

/** the argv composer runs under, and what it is called for the report */
function composerCommand(
	ctx: Context,
	dir: string,
	opts: ProjectBuildOptions,
	args: readonly string[]
): { file: string; args: string[]; label: string } {
	if (opts.composer === 'host') {
		return { file: 'composer', args: [...args], label: `composer ${args.join(' ')}` };
	}
	const extra = (ctx.env.DRANGLER_DOCKER_ARGS ?? '--memory 4g').split(/\s+/).filter(Boolean);
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	const argv = [
		'run',
		'--rm',
		...(uid === undefined || gid === undefined ? [] : ['--user', `${uid}:${gid}`]),
		...extra,
		'-e',
		'COMPOSER_AUTH',
		'-e',
		'COMPOSER_HOME=/tmp/composer',
		'-e',
		'COMPOSER_CACHE_DIR=/tmp/composer/cache',
		'-v',
		`${dir}:/app`,
		'-w',
		'/app',
		opts.image ?? 'composer:2',
		...args
	];
	return { file: 'docker', args: argv, label: `docker ${argv.join(' ')}` };
}

async function composerStep(
	ctx: Context,
	dir: string,
	opts: ProjectBuildOptions,
	args: readonly string[]
): Promise<string> {
	const command = composerCommand(ctx, dir, opts, args);
	ctx.io.err(`composer: ${command.label}`);
	const options = { cwd: dir, timeoutMs: 60 * 60_000 };
	// composer prints to stdout, and `--json` promises stdout carries one object
	let code: number;
	if (opts.globals.json) {
		const result = await ctx.runner.run(command.file, command.args, options);
		if (result.stdout !== '') ctx.io.err(result.stdout);
		if (result.stderr !== '') ctx.io.err(result.stderr);
		code = result.code;
	} else {
		code = await ctx.runner.spawn(command.file, command.args, options);
	}
	if (code !== 0) {
		throw new DranglerError(
			'project-composer',
			`composer exited ${code}: \`${command.label}\``,
			{
				retryable: true
			}
		);
	}
	return command.label;
}

/**
 * Patched core against a pristine copy of the same version, so the overlay is exactly what the
 * patches changed. The pristine copy is a one-package composer project with plugins off, kept in
 * `.drangler/pristine` beside the project.
 */
async function coreOverlay(
	ctx: Context,
	dir: string,
	opts: ProjectBuildOptions,
	version: string,
	paths: ReadonlyMap<string, string>
): Promise<CoreOverlay> {
	const pristine = `${dir}/.drangler/pristine`;
	ctx.files.writeText(
		`${pristine}/composer.json`,
		JSON.stringify(
			{
				name: 'drangler/pristine',
				require: { 'drupal/core': version.replace(/^v/i, '') },
				config: { 'allow-plugins': false }
			},
			null,
			'\t'
		)
	);
	await composerStep(ctx, pristine, opts, [
		'update',
		'--no-dependencies',
		'--no-plugins',
		...COMPOSER_ARGS
	]);
	const patched = paths.get('drupal/core') ?? `${dir}/vendor/drupal/core`;
	return diffCore(ctx.files, patched, `${pristine}/vendor/drupal/core`);
}

function coreNotes(
	core: DeliveryPlan['core'],
	overlay: CoreOverlay | null,
	opts: ProjectBuildOptions
): string[] {
	if (core.state === 'drift') {
		return [
			`core: the project locks ${core.project} and the pack ships ${core.shipped}; a core patch is not overlaid, because it was written against other source`
		];
	}
	if (core.state === 'mismatch') {
		return [
			`core: the project locks ${core.project} and the pack ships ${core.shipped ?? 'no core'}; ` +
				'nothing of core is delivered and packages the pack holds keep the pack version'
		];
	}
	if (core.state !== 'patched') return [];
	if (opts.core === false) return ['core is patched and --no-core left the patches out'];
	if (overlay === null) return [];
	const out = [
		`core: ${overlay.selection.files.length} patched file(s) go up as an overlay; a site pays one container rebuild for a changed core yml`
	];
	if (overlay.removed.length > 0) {
		out.push(
			`core: ${overlay.removed.length} file(s) a patch deletes stay in the pack, because a revision cannot remove a packed file`
		);
	}
	if (overlay.refused.length > 0) {
		out.push(
			`core: ${overlay.refused.join(', ')} left out, because the pack rewrites them for the interpreter`
		);
	}
	return out;
}

async function sendGroup(
	ctx: Context,
	owner: OwnerTarget,
	group: UploadGroup,
	dir: string
): Promise<UploadResult> {
	ctx.io.err(
		`${group.name}: ${group.members.length} package(s), ${group.selection.files.length} file(s)`
	);
	return await uploadPackage(
		ctx,
		owner,
		{ name: group.name, type: 'module', dir, info: '', mount: '', dependencies: [] },
		group.selection,
		{
			label: `build --project (${group.members.length} package(s))`,
			origin: dir,
			autoload: group.autoload
		}
	);
}

function render(report: ProjectBuildReport, dry: boolean): string[] {
	const lines = kv([
		['project', report.project],
		[
			'shipped lock',
			`${report.shipped.from}${report.shipped.core === null ? '' : ` (core ${report.shipped.core})`}`
		],
		['core', describeCore(report.core)],
		['delivered', String(report.delivery.length)],
		['skipped', String(report.skipped.length)]
	]);
	if (report.delivery.length > 0) {
		lines.push(
			'',
			...table(
				['package', 'version', 'why', 'mount', 'files'],
				report.delivery.map((d) => [
					d.name,
					d.version,
					d.reason === 'version' ? `pack has ${d.shipped}` : d.reason,
					d.mount,
					d.files === null ? '-' : String(d.files)
				])
			)
		);
	}
	if (report.skipped.length > 0) {
		lines.push('', 'skipped');
		for (const s of report.skipped) lines.push(`  ${s.name}: ${s.why}`);
	}
	if (report.oversized.length > 0) {
		lines.push('', 'too large for one revision, not sent');
		for (const o of report.oversized)
			lines.push(`  ${o.name}: ${humanBytes(o.bytes)} of declared paths`);
	}
	if (report.uploads.length > 0) {
		lines.push(
			'',
			...table(
				['revision', 'packages', 'files', 'blobs sent', 'commit'],
				report.uploads.map((u) => [
					u.package,
					String(u.members),
					String(u.files),
					String(u.stored),
					u.rev === null ? 'not committed' : u.rev.slice(0, 8)
				])
			)
		);
	}
	if (report.notes.length > 0) {
		lines.push('', 'notes');
		for (const n of report.notes) lines.push(`  - ${n}`);
	}
	if (dry) lines.push('', 'dry run; nothing was executed or sent');
	return lines;
}

function describeCore(core: ProjectBuildReport['core']): string {
	switch (core.state) {
		case 'absent':
			return 'not in the lock';
		case 'same':
			return `${core.version}, the pack's`;
		case 'patched':
			return core.overlay === undefined
				? `${core.version}, patched`
				: `${core.version}, patched: ${core.overlay.files} file(s) overlaid`;
		case 'drift':
			return `${core.project}; the pack ships ${core.shipped}`;
		case 'mismatch':
			return `${core.project}; the pack ships ${core.shipped ?? 'none'}`;
	}
}
