import { dirname, resolve } from 'node:path';
import {
	globalConfigPath,
	PROJECT_CONFIG_NAME,
	readModule,
	type DranglerConfig
} from '../config/file';
import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { DranglerError, FindingError, UsageError } from '../errors';
import { emit, bytes as humanBytes, kv, table } from '../format';
import { probeClaim, probeSite } from '../health/probe';
import { checkPackage, type CheckReport } from '../modify/check';
import {
	detectProject,
	packageOf,
	selectPackageFiles,
	type DetectedPackage,
	type DetectedProject,
	type PackageSelection
} from '../modify/detect';
import {
	applyReply,
	declare,
	manifestRev,
	shortRev,
	uploadPackage,
	type DeclaredFile,
	type UploadResult
} from '../modify/upload';
import { ownerCall, ownerTarget, replyError, type OwnerTarget } from '../owner';

export interface ModifyOptions {
	/** the project directory; defaults to the config's module root, then the working directory */
	dir?: string;
	package?: string;
	globals: GlobalOptions;
}

/** the project, the package and the files, resolved the same way for every subcommand */
interface Resolved {
	project: DetectedProject;
	pkg: DetectedPackage;
	selection: PackageSelection;
}

/**
 * Where the project is.
 *
 * A `--dir` is relative to the working directory and a config `module.root` is relative to the FILE
 * that declared it, which is what lets `drangler.json` say `"root": "."` and still mean the project
 * rather than wherever the shell happens to be.
 */
function projectDir(ctx: Context, opts: ModifyOptions): string {
	if (opts.dir !== undefined && opts.dir !== '') return resolve(ctx.cwd, opts.dir);
	const configured = readModule(opts.globals.config);
	if (configured.root === null || configured.root === '') return ctx.cwd;
	return resolve(configured.from === null ? ctx.cwd : dirname(configured.from), configured.root);
}

function resolveProject(ctx: Context, opts: ModifyOptions): Resolved {
	const project = detectProject(ctx.files, projectDir(ctx, opts));
	const wanted = opts.package ?? readModule(opts.globals.config).package ?? undefined;
	const pkg = packageOf(project, wanted);
	return { project, pkg, selection: selectPackageFiles(ctx.files, pkg) };
}

export interface ModifyInitOptions extends ModifyOptions {
	/** override the detected package name */
	name?: string;
	/** write the link to the global config instead of drangler.json */
	global?: boolean;
}

export interface ModifyInitReport {
	shape: string;
	from: string;
	dir: string;
	package: string;
	mount: string;
	files: number;
	site: string | null;
	reachable: boolean | null;
	claimed: string | null;
	token: boolean;
	wrote: string[];
	next: string[];
}

/**
 * Links a module project to a site, and says where each answer landed.
 *
 * The owner token never goes in `drangler.json`; that file is committed. It lands in the global
 * config through the restricted-write seam, keyed by origin.
 */
export async function runModifyInit(ctx: Context, opts: ModifyInitOptions): Promise<void> {
	const { globals } = opts;
	const project = detectProject(ctx.files, projectDir(ctx, opts));
	const pkg = packageOf(project, opts.name ?? opts.package);
	const selection = selectPackageFiles(ctx.files, pkg);
	const report: ModifyInitReport = {
		shape: project.shape,
		from: project.from,
		dir: project.dir,
		package: pkg.name,
		mount: pkg.mount,
		files: selection.files.length,
		site: globals.config.site.value,
		reachable: null,
		claimed: null,
		token: globals.config.token.value !== null,
		wrote: [],
		next: []
	};

	if (report.site !== null) {
		const siteName = globals.config.siteName.value ?? 'site';
		try {
			const probe = await probeSite(
				{ fetch: ctx.fetch },
				{
					target: report.site,
					site: siteName,
					kind: 'worker',
					skipEdge: true,
					timeoutMs: globals.timeoutMs
				}
			);
			report.reachable = probe.status !== null && probe.verdict !== 'not-drupflare';
		} catch {
			report.reachable = false;
		}
		if (report.reachable === true) {
			report.claimed = (
				await probeClaim({ fetch: ctx.fetch }, report.site, siteName, globals.timeoutMs)
			).state;
		}
	}

	if (opts.global !== true) {
		const path = `${project.dir}/${PROJECT_CONFIG_NAME}`;
		const config: DranglerConfig = {
			...(report.site === null
				? {}
				: {
						site: {
							origin: report.site,
							name: globals.config.siteName.value ?? 'site'
						}
					}),
			module: { root: '.', package: pkg.name }
		};
		ctx.files.writeText(path, `${JSON.stringify(config, null, '\t')}\n`);
		report.wrote.push(path);
	}

	const token = globals.config.token.value;
	if (token !== null && report.site !== null) {
		const path = globalConfigPath(ctx.env);
		let existing: DranglerConfig = {};
		if (ctx.files.exists(path)) {
			try {
				existing = JSON.parse(ctx.files.readText(path)) as DranglerConfig;
			} catch (e) {
				throw new UsageError(
					`${path} is not valid JSON and init will not overwrite it: ${e instanceof Error ? e.message : String(e)}`
				);
			}
		}
		ctx.files.writeSecret(
			path,
			`${JSON.stringify(
				{
					...existing,
					...(opts.global === true && report.site !== null
						? { site: { origin: report.site } }
						: {}),
					sites: {
						...existing.sites,
						[report.site]: { ...existing.sites?.[report.site], ownerToken: token }
					}
				},
				null,
				'\t'
			)}\n`
		);
		report.wrote.push(path);
	}

	if (report.claimed === 'unclaimed') report.next.push(`drangler site claim ${report.site}`);
	else if (report.site === null) report.next.push('drangler modify init --site <origin>');
	else if (!report.token) report.next.push(`drangler site claim ${report.site}`);
	else report.next.push('drangler modify check');

	emit(ctx.io, globals.json, report, () => {
		const lines = kv([
			['detected', `${report.shape} (${report.from})`],
			['package', report.package],
			['mounts to', report.mount],
			['files', String(report.files)],
			[
				'site',
				report.site === null
					? 'not set; pass --site'
					: `${report.site} (${report.reachable === true ? (report.claimed ?? 'reachable') : 'did not answer'})`
			],
			['owner token', report.token ? 'set' : 'not set']
		]);
		lines.push('', 'wrote');
		if (report.wrote.length === 0) lines.push('  nothing');
		for (const path of report.wrote) {
			lines.push(`  ${path}${path.endsWith('config.json') ? ' (mode 0600)' : ''}`);
		}
		lines.push('', 'next');
		for (const step of report.next) lines.push(`  ${step}`);
		return lines;
	});
}

export interface ModifyStatusReport {
	shape: string;
	from: string;
	package: string;
	mount: string;
	local: { rev: string; files: number; bytes: number };
	live: {
		package: string;
		rev: string | null;
		label: string | null;
		files: number;
		bytes: number;
		at: number | null;
		revisions: number;
	} | null;
	clean: boolean;
	notes: string[];
}

/** What is live on the site, against what is on this disk. */
export async function runModifyStatus(ctx: Context, opts: ModifyOptions): Promise<void> {
	const { pkg, project, selection } = resolveProject(ctx, opts);
	const owner = ownerTarget(opts.globals);
	const declared = await declare(selection);
	const reply = await ownerCall(ctx, owner, '/modify', {
		params: { action: 'status', package: pkg.name }
	});
	const packages = Array.isArray(reply.body['packages'])
		? (reply.body['packages'] as Record<string, unknown>[])
		: [];
	const live = packages.find((row) => String(row['package']) === pkg.name) ?? null;

	const report: ModifyStatusReport = {
		shape: project.shape,
		from: project.from,
		package: pkg.name,
		mount: pkg.mount,
		local: {
			rev: await manifestRev(declared),
			files: declared.length,
			bytes: selection.totalBytes
		},
		live:
			live === null
				? null
				: {
						package: String(live['package']),
						rev: typeof live['rev'] === 'string' ? live['rev'] : null,
						label: typeof live['label'] === 'string' ? live['label'] : null,
						files: Number(live['files'] ?? 0),
						bytes: Number(live['bytes'] ?? 0),
						at: live['at'] === null ? null : Number(live['at']),
						revisions: Number(live['revisions'] ?? 0)
					},
		clean: false,
		notes: []
	};
	report.clean = report.live !== null && report.live.rev === report.local.rev;
	if (report.live === null) {
		report.notes.push('this site holds no uploaded revision of this package yet');
	} else if (!report.clean) {
		report.notes.push(
			'the local tree differs from what is live; `drangler modify diff` says how'
		);
	}

	emit(ctx.io, opts.globals.json, report, () => {
		const lines = kv([
			['detected', `${report.shape} (${report.from})`],
			['package', report.package],
			[
				'live',
				report.live === null || report.live.rev === null
					? 'nothing'
					: `${shortRev(report.live.rev)}  ${report.live.label ?? ''}  ${
							report.live.at === null ? '' : new Date(report.live.at).toISOString()
						}`.trim()
			],
			[
				'local',
				`${shortRev(report.local.rev)}  ${report.local.files} files, ${humanBytes(report.local.bytes)}${
					report.clean ? '  (clean)' : ''
				}`
			],
			[
				'history',
				report.live === null
					? '-'
					: `${report.live.revisions} revision(s), ${humanBytes(report.live.bytes)} live`
			]
		]);
		if (report.notes.length > 0) {
			lines.push('', 'notes');
			for (const note of report.notes) lines.push(`  - ${note}`);
		}
		return lines;
	});
}

export interface ModifyDiffOptions extends ModifyOptions {
	/** paths only, without the counts */
	nameOnly?: boolean;
	/** compare against a stored revision instead of what is mounted; a sha, `active` or `previous` */
	against?: string;
}

export type DiffKind = 'added' | 'modified' | 'removed' | 'unchanged';

export interface ModifyDiffReport {
	package: string;
	/** what the local tree was compared against */
	comparedTo: string;
	files: number;
	/** every path that differs, with what would happen to it */
	changes: { path: string; kind: DiffKind }[];
	/** paths whose BYTES the site does not hold, which is what an upload would send */
	outgoing: string[];
	counts: Record<DiffKind, number>;
	rowsWritten: number;
	clean: boolean;
	notes: string[];
}

const NO_COUNTS: Record<DiffKind, number> = { added: 0, modified: 0, removed: 0, unchanged: 0 };

/**
 * Local against live, or against a revision the site has stored.
 *
 * Two comparisons and they answer different questions, so the report names which one it made.
 * Without `--against` the site's `plan` action is the authority: it walks every declared file
 * against the MOUNTED tree, which is what "live" means, and returns the counts and the removed
 * paths. With `--against` the comparison is against that revision's manifest, which is a record of
 * what was committed rather than of what is mounted.
 *
 * `outgoing` is separate from `changes` on purpose. A path can be modified and still need no bytes
 * sent, because the site already holds the blob from an earlier revision.
 */
export async function runModifyDiff(ctx: Context, opts: ModifyDiffOptions): Promise<void> {
	const { pkg, selection } = resolveProject(ctx, opts);
	const owner = ownerTarget(opts.globals);
	const declared = await declare(selection);
	const report: ModifyDiffReport =
		opts.against === undefined
			? await diffAgainstLive(ctx, owner, pkg.name, declared)
			: await diffAgainstRevision(ctx, owner, pkg.name, declared, opts.against);

	// the counts are what the comparison produced; the change list is an attribution of them, and a
	// package with no stored revision has counts and no list at all
	report.clean = report.counts.added + report.counts.modified + report.counts.removed === 0;
	if (!report.clean && report.outgoing.length < report.counts.added + report.counts.modified) {
		report.notes.push(
			'a changed path missing from `to send` is one whose bytes the site already holds from an earlier revision'
		);
	}

	emit(ctx.io, opts.globals.json, report, () => {
		const changed = report.changes.filter((c) => c.kind !== 'unchanged');
		// a package with no stored revision has no per-path list, and the paths whose bytes are
		// going to be sent are the honest answer to "which files" there
		if (opts.nameOnly === true) {
			return changed.length > 0 ? changed.map((c) => c.path) : report.outgoing;
		}
		const lines = kv([
			['package', report.package],
			['compared to', report.comparedTo],
			['files', String(report.files)],
			[
				'counts',
				`${report.counts.added} added, ${report.counts.modified} modified, ${report.counts.removed} removed, ${report.counts.unchanged} unchanged`
			],
			['rows', String(report.rowsWritten)],
			['to send', `${report.outgoing.length} file(s)`]
		]);
		if (changed.length > 0) {
			lines.push('', 'changed');
			for (const change of changed) lines.push(`  ${change.kind.padEnd(10)}${change.path}`);
		} else if (report.clean) {
			lines.push('', 'no difference');
		} else {
			lines.push('', 'to send');
			for (const path of report.outgoing) lines.push(`  ${path}`);
		}
		if (report.notes.length > 0) {
			lines.push('', 'notes');
			for (const note of report.notes) lines.push(`  - ${note}`);
		}
		return lines;
	});

	if (!report.clean) {
		throw new FindingError(
			'modify-diff',
			`${report.package} differs from ${report.comparedTo}`
		);
	}
}

/**
 * The site walks every declared file against the mounted tree; this attributes its counts to paths.
 *
 * Two requests, because they answer two halves. `plan` is the authority on WHAT WOULD CHANGE: it
 * compares against the mounted source, so a file reverted to bytes the site still holds from an
 * earlier revision reads as modified, which is correct and which a blob-holding check here would
 * miss. `manifest` supplies the path set the active revision committed, which is what turns three
 * counts into a list of paths.
 *
 * A package delivered by `/git` or `/install` has no revision at all, so the manifest 404s. The
 * counts are still exact there and the report says the per-path split is unavailable rather than
 * inventing one.
 */
async function diffAgainstLive(
	ctx: Context,
	owner: OwnerTarget,
	pkg: string,
	declared: DeclaredFile[]
): Promise<ModifyDiffReport> {
	const reply = await ownerCall(ctx, owner, '/modify', {
		method: 'POST',
		params: { action: 'plan', package: pkg },
		body: { files: declared }
	});
	if (reply.status >= 400) {
		throw new DranglerError('modify', replyError(reply, 'the site refused the plan'));
	}
	const counts = { ...NO_COUNTS, ...((reply.body['counts'] as Record<DiffKind, number>) ?? {}) };
	const want = new Set(asStringList(reply.body['want']));
	const removed = asStringList(reply.body['removed']);
	const live = await ownerCall(ctx, owner, '/modify', {
		params: { action: 'manifest', package: pkg, rev: 'active' }
	});
	const manifest =
		live.status >= 400
			? null
			: ((live.body['manifest'] as Record<string, string> | undefined) ?? {});

	const changes: ModifyDiffReport['changes'] = [];
	const notes: string[] = [];
	if (manifest === null) {
		notes.push(
			"this package has no stored revision, so the counts are the site's and the per-path split is not available"
		);
	} else {
		for (const file of declared) {
			const before = manifest[file.path];
			changes.push({
				path: file.path,
				kind:
					before === undefined ? 'added' : before === file.hash ? 'unchanged' : 'modified'
			});
		}
		for (const path of removed) changes.push({ path, kind: 'removed' });
	}
	if (removed.length === 200) {
		notes.push('the site caps the removed list at 200 paths, so there may be more');
	}
	return {
		package: pkg,
		comparedTo: 'what is live',
		files: declared.length,
		changes: changes.sort((a, b) => (a.path < b.path ? -1 : 1)),
		outgoing: declared.filter((file) => want.has(file.hash)).map((file) => file.path),
		counts,
		rowsWritten: Number(reply.body['rowsWritten'] ?? 0),
		clean: false,
		notes
	};
}

/** the manifest of one stored revision, which is a record of what was committed */
async function diffAgainstRevision(
	ctx: Context,
	owner: OwnerTarget,
	pkg: string,
	declared: DeclaredFile[],
	rev: string
): Promise<ModifyDiffReport> {
	const reply = await ownerCall(ctx, owner, '/modify', {
		params: { action: 'manifest', package: pkg, rev }
	});
	if (reply.status >= 400) {
		throw new DranglerError('modify', replyError(reply, `no revision \`${rev}\` on this site`));
	}
	const manifest = (reply.body['manifest'] as Record<string, string> | undefined) ?? {};
	const counts = { ...NO_COUNTS };
	const changes: ModifyDiffReport['changes'] = [];
	const seen = new Set<string>();
	for (const file of declared) {
		seen.add(file.path);
		const before = manifest[file.path];
		const kind: DiffKind =
			before === undefined ? 'added' : before === file.hash ? 'unchanged' : 'modified';
		counts[kind]++;
		changes.push({ path: file.path, kind });
	}
	for (const path of Object.keys(manifest)) {
		if (seen.has(path)) continue;
		counts.removed++;
		changes.push({ path, kind: 'removed' });
	}
	const stored = new Set(Object.values(manifest));
	return {
		package: pkg,
		comparedTo: `rev ${shortRev(String(reply.body['rev'] ?? rev))}`,
		files: declared.length,
		changes: changes.sort((a, b) => (a.path < b.path ? -1 : 1)),
		// a hash the revision named is a blob the site holds, so it needs no bytes
		outgoing: declared.filter((file) => !stored.has(file.hash)).map((file) => file.path),
		counts,
		rowsWritten: counts.added + counts.modified + counts.removed,
		clean: false,
		notes: [
			'compared against what that revision COMMITTED, which is not necessarily what is mounted now'
		]
	};
}

function asStringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export interface ModifyCheckOptions extends ModifyOptions {
	php?: string;
	deps?: boolean;
}

/** Everything that can be known before bytes leave this machine. */
export async function runModifyCheck(ctx: Context, opts: ModifyCheckOptions): Promise<void> {
	const report = await gatherCheck(ctx, opts);
	emit(ctx.io, opts.globals.json, report, () => renderCheck(report));
	if (!report.ok) {
		throw new FindingError(
			'modify-check',
			`${report.findings.length} finding(s) on ${report.package}`
		);
	}
}

async function gatherCheck(ctx: Context, opts: ModifyCheckOptions): Promise<CheckReport> {
	const { project, pkg, selection } = resolveProject(ctx, opts);
	return await checkPackage(ctx, project, pkg, selection, {
		...(opts.php === undefined ? {} : { php: opts.php }),
		...(opts.deps === true ? { deps: true, owner: ownerTarget(opts.globals) } : {})
	});
}

function renderCheck(report: CheckReport): string[] {
	const lines = kv([
		['package', report.package],
		['mounts to', report.mount],
		['files', `${report.files} kept, ${report.skipped} skipped`],
		['bytes', `${humanBytes(report.bytes)} in ${report.batches} batch(es)`],
		[
			'lint',
			report.lint.ran
				? `${report.lint.checked - report.lint.failures.length} of ${report.lint.checked} ok (${report.lint.binary})`
				: `skipped: ${report.lint.reason}`
		],
		['paths', report.collisions.length === 0 ? 'no collision inside this project' : 'COLLISION']
	]);
	if (report.dependencies.length > 0) {
		lines.push(
			'',
			'dependencies',
			...table(
				['declared', 'registry', 'version'],
				report.dependencies.map((dep) => [
					dep.declared,
					dep.registry
						? (dep.verdict ?? 'unknown')
						: 'no project; core, or a name nothing publishes',
					dep.version ?? '-'
				])
			)
		);
		const wanted = report.dependencies.filter((d) => d.verdict === 'installable');
		if (wanted.length > 0) {
			lines.push(
				'',
				`${wanted.length} dependenc(ies) can be installed from a registry:`,
				`  drangler modify require ${wanted.map((d) => d.name).join(' ')} --enable`
			);
		}
	}
	if (report.findings.length > 0) {
		lines.push('', 'findings');
		for (const finding of report.findings) lines.push(`  ${finding}`);
	} else {
		lines.push('', 'nothing here stops an upload');
	}
	return lines;
}

export interface ModifyUploadOptions extends ModifyCheckOptions {
	/** the revision label; defaults to the git subject when there is one */
	message?: string;
	/** upload despite a check finding */
	force?: boolean;
}

/**
 * check, plan, blobs, commit.
 *
 * A rolled-back commit exits 1 rather than 3: the kernel refused to boot against the new tree, the
 * site put back what it had, and nothing the caller asked for happened. A `--force`d check finding
 * exits 3, because the upload did land and something was said about it.
 */
export async function runModifyUpload(ctx: Context, opts: ModifyUploadOptions): Promise<void> {
	const { project, pkg, selection } = resolveProject(ctx, opts);
	const owner = ownerTarget(opts.globals);
	const check = await checkPackage(ctx, project, pkg, selection, {
		...(opts.php === undefined ? {} : { php: opts.php }),
		...(opts.deps === true ? { deps: true, owner } : {})
	});
	if (!check.ok && opts.force !== true) {
		emit(ctx.io, opts.globals.json, check, () => renderCheck(check));
		throw new FindingError(
			'modify-check',
			`${check.findings.length} finding(s) on ${check.package}; pass --force to upload anyway`
		);
	}

	const label = opts.message ?? (await gitSubject(ctx, project)) ?? `upload from ${project.dir}`;
	const result = await uploadPackage(ctx, owner, pkg, selection, {
		label,
		origin: project.dir,
		...(opts.globals.dryRun ? { dryRun: true } : {})
	});
	emit(ctx.io, opts.globals.json, { ...result, check }, () => renderUpload(result, label));

	if (result.error !== null) throw new DranglerError('modify', result.error);
	if (!check.ok) {
		throw new FindingError(
			'modify-check',
			`${check.findings.length} finding(s) were overridden by --force`
		);
	}
}

function renderUpload(result: UploadResult, label: string): string[] {
	const lines = kv([
		['package', result.package],
		[
			'plan',
			`${result.files} files, ${result.plan.want.length} not on the site, ${result.plan.have.length} already there`
		],
		['rows', String(result.plan.rowsWritten)],
		[
			'uploading',
			`${result.stored} blob(s), ${humanBytes(result.bytes)}, ${result.batches} batch(es)`
		],
		['label', label],
		['commit', result.rev === null ? 'not committed' : `rev ${shortRev(result.rev)}`],
		[
			'verify',
			result.rolledBack
				? 'the kernel refused to boot; the previous revision is still serving'
				: result.applied
					? 'kernel booted'
					: '-'
		]
	]);
	if (result.error !== null) lines.push('', `error: ${result.error}`);
	if (result.changes.length > 0) {
		lines.push('', 'changed');
		for (const change of result.changes.slice(0, 50)) {
			if (change.kind === 'unchanged') continue;
			lines.push(
				`  ${change.kind.padEnd(9)}${change.path}  +${change.added ?? 0}  -${change.removed ?? 0}`
			);
		}
	}
	if (result.notes.length > 0) {
		lines.push('', 'notes');
		for (const note of result.notes) lines.push(`  - ${note}`);
	}
	return lines;
}

export interface ModifyRevisionsOptions extends ModifyOptions {
	limit?: string | number;
}

/** The stored revisions of one package, newest first. */
export async function runModifyRevisions(
	ctx: Context,
	opts: ModifyRevisionsOptions
): Promise<void> {
	const { pkg } = resolveProject(ctx, opts);
	const owner = ownerTarget(opts.globals);
	const reply = await ownerCall(ctx, owner, '/modify', {
		params: { action: 'revisions', package: pkg.name, limit: opts.limit ?? 20 }
	});
	const revisions = Array.isArray(reply.body['revisions'])
		? (reply.body['revisions'] as Record<string, unknown>[])
		: [];
	const active = typeof reply.body['active'] === 'string' ? reply.body['active'] : null;
	const report = { package: pkg.name, active, revisions };

	emit(ctx.io, opts.globals.json, report, () =>
		revisions.length === 0
			? [`no stored revision of ${pkg.name} on this site`]
			: table(
					['', 'rev', 'when', 'files', 'kind', 'label'],
					revisions.map((row) => [
						row['rev'] === active ? '*' : '',
						shortRev(String(row['rev'])),
						new Date(Number(row['createdAt'] ?? 0)).toISOString(),
						String(row['files'] ?? 0),
						String(row['kind'] ?? ''),
						String(row['label'] ?? '')
					])
				)
	);
}

export interface ModifyActivateOptions extends ModifyOptions {
	/** the previous revision rather than a named one, which is what a rollback means */
	previous?: boolean;
}

/** Makes a stored revision live, with no bytes on the wire. */
export async function runModifyActivate(
	ctx: Context,
	rev: string | undefined,
	opts: ModifyActivateOptions
): Promise<void> {
	const { pkg } = resolveProject(ctx, opts);
	if (!opts.globals.yes) {
		throw new UsageError('this changes what the site serves; pass --yes to say so on purpose');
	}
	const wanted = opts.previous === true ? 'previous' : rev;
	if (wanted === undefined || wanted === '') {
		throw new UsageError('name a revision, or use `drangler modify rollback`');
	}
	const owner = ownerTarget(opts.globals);
	const reply = await ownerCall(ctx, owner, '/modify', {
		method: 'POST',
		params: { action: 'activate', package: pkg.name, rev: wanted }
	});
	const result: UploadResult = {
		package: pkg.name,
		mount: pkg.mount,
		files: 0,
		plan: { have: [], want: [], wantBytes: 0, counts: {}, rowsWritten: 0 },
		batches: 0,
		stored: 0,
		skipped: 0,
		bytes: 0,
		rev: null,
		applied: false,
		rolledBack: false,
		counts: {},
		changes: [],
		error: null,
		notes: []
	};
	applyReply(result, reply);
	emit(ctx.io, opts.globals.json, result, () =>
		kv([
			['package', result.package],
			['active', result.rev === null ? '-' : `rev ${shortRev(result.rev)}`],
			[
				'verify',
				result.rolledBack
					? 'rolled back; nothing changed'
					: result.applied
						? 'kernel booted'
						: '-'
			],
			...(result.error === null ? [] : ([['error', result.error]] as [string, string][]))
		])
	);
	if (result.error !== null) throw new DranglerError('modify', result.error);
}

/** Sugar over `activate previous`, and the one people type. */
export async function runModifyRollback(ctx: Context, opts: ModifyOptions): Promise<void> {
	await runModifyActivate(ctx, undefined, { ...opts, previous: true });
}

/** Deletes a stored revision and the blobs no surviving manifest still names. */
export async function runModifyDrop(ctx: Context, rev: string, opts: ModifyOptions): Promise<void> {
	const { pkg } = resolveProject(ctx, opts);
	if (!opts.globals.yes) {
		throw new UsageError('dropping a revision cannot be undone; pass --yes');
	}
	const owner = ownerTarget(opts.globals);
	const reply = await ownerCall(ctx, owner, '/modify', {
		method: 'POST',
		params: { action: 'drop', package: pkg.name, rev }
	});
	const report = {
		package: pkg.name,
		rev,
		dropped: reply.body['dropped'] === true,
		blobsFreed: Number(reply.body['blobsFreed'] ?? 0),
		reason: typeof reply.body['reason'] === 'string' ? reply.body['reason'] : null
	};
	emit(ctx.io, opts.globals.json, report, () =>
		kv([
			['package', report.package],
			['rev', shortRev(report.rev)],
			['dropped', report.dropped ? 'yes' : `no: ${report.reason ?? 'the site refused'}`],
			['blobs freed', String(report.blobsFreed)]
		])
	);
	if (!report.dropped) {
		throw new DranglerError('modify', report.reason ?? 'the site refused the drop');
	}
}

export interface ModifyRequireOptions {
	version?: string;
	registry?: string;
	/** also enable each package after it installs */
	enable?: boolean;
	force?: boolean;
	globals: GlobalOptions;
}

/**
 * `/installable`, then `/install`, then optionally `/enable`.
 *
 * Not an upload path: a package with a registry entry belongs to the registry, and delivering it
 * from a laptop would put a second copy of it on the site with no version behind it.
 */
export async function runModifyRequire(
	ctx: Context,
	names: readonly string[],
	opts: ModifyRequireOptions
): Promise<void> {
	if (names.length === 0) throw new UsageError('name at least one package to require');
	const owner = ownerTarget(opts.globals);
	const results: {
		name: string;
		verdict: string | null;
		version: string | null;
		installed: boolean;
		enabled: boolean | null;
		error: string | null;
	}[] = [];

	for (const name of names) {
		const row = {
			name,
			verdict: null as string | null,
			version: null as string | null,
			installed: false,
			enabled: null as boolean | null,
			error: null as string | null
		};
		results.push(row);

		const check = await ownerCall(ctx, owner, '/installable', { params: { module: name } });
		row.verdict = typeof check.body['verdict'] === 'string' ? check.body['verdict'] : null;
		row.version = typeof check.body['version'] === 'string' ? check.body['version'] : null;
		if (row.verdict !== 'installable' && opts.force !== true) {
			row.error = `${row.verdict ?? 'unknown'}; pass --force to install anyway`;
			continue;
		}
		if (opts.globals.dryRun) continue;

		const installed = await ownerCall(ctx, owner, '/install', {
			method: 'POST',
			params: {
				module: name,
				...(opts.version === undefined ? {} : { version: opts.version }),
				...(opts.registry === undefined ? {} : { registry: opts.registry }),
				...(opts.force === true ? { force: '1' } : {})
			}
		});
		row.installed = installed.body['ok'] !== false && installed.status < 400;
		if (!row.installed) {
			row.error = replyError(installed, 'the site refused the install');
			continue;
		}
		if (opts.enable === true) {
			const enabled = await enableModule(ctx, owner, moduleNameOf(name));
			row.enabled = enabled.ok;
			if (!enabled.ok) row.error = enabled.error;
		}
	}

	emit(ctx.io, opts.globals.json, { packages: results }, () =>
		table(
			['package', 'verdict', 'version', 'installed', 'enabled', 'error'],
			results.map((row) => [
				row.name,
				row.verdict ?? '-',
				row.version ?? '-',
				row.installed ? 'yes' : 'no',
				row.enabled === null ? '-' : row.enabled ? 'yes' : 'no',
				row.error ?? ''
			])
		)
	);
	const failed = results.filter((row) => row.error !== null);
	if (failed.length > 0) {
		throw new DranglerError('modify', `${failed.length} package(s) did not land`);
	}
}

/** `drupal/json_field` names the module `json_field`; the registry name is not the machine name */
export function moduleNameOf(name: string): string {
	return name.includes('/') ? (name.split('/').pop() as string) : name;
}

async function enableModule(
	ctx: Context,
	owner: OwnerTarget,
	module: string
): Promise<{ ok: boolean; error: string | null }> {
	const reply = await ownerCall(ctx, owner, '/enable', {
		method: 'POST',
		params: { module }
	});
	const ok = reply.status < 400 && reply.body['ok'] !== false;
	return { ok, error: ok ? null : replyError(reply, 'the site refused the enable') };
}

/** Turns modules on, after `/install` or `modify upload` has landed their files. */
export async function runModifyEnable(
	ctx: Context,
	names: readonly string[],
	opts: { globals: GlobalOptions }
): Promise<void> {
	if (names.length === 0) throw new UsageError('name at least one module to enable');
	const owner = ownerTarget(opts.globals);
	const results: { module: string; enabled: boolean; error: string | null }[] = [];
	for (const name of names) {
		const module = moduleNameOf(name);
		if (opts.globals.dryRun) {
			results.push({ module, enabled: false, error: null });
			continue;
		}
		const outcome = await enableModule(ctx, owner, module);
		results.push({ module, enabled: outcome.ok, error: outcome.error });
	}
	emit(ctx.io, opts.globals.json, { modules: results }, () =>
		table(
			['module', 'enabled', 'error'],
			results.map((row) => [row.module, row.enabled ? 'yes' : 'no', row.error ?? ''])
		)
	);
	const failed = results.filter((row) => row.error !== null);
	if (failed.length > 0) {
		throw new DranglerError('modify', `${failed.length} module(s) did not enable`);
	}
}

export interface ModifyReleaseOptions extends ModifyUploadOptions {
	tag?: string;
}

/**
 * Uploads from a tagged commit rather than from the working tree.
 *
 * Refuses a dirty tree, and refuses a tag that is not what is checked out. Checking the tag out
 * here would need a second working tree and a way to remove it, and drangler has no delete seam by
 * design; naming the checkout the caller has to make is the smaller thing.
 *
 * The only `modify` subcommand that needs git.
 */
export async function runModifyRelease(ctx: Context, opts: ModifyReleaseOptions): Promise<void> {
	const tag = opts.tag;
	if (tag === undefined || tag === '')
		throw new UsageError('--tag names the tag to release from');
	const project = detectProject(ctx.files, projectDir(ctx, opts));
	if (!project.repository) {
		throw new UsageError(`${project.dir} is not a git checkout, so there is no tag to release`);
	}

	const dirty = await ctx.runner.run('git', ['status', '--porcelain'], { cwd: project.dir });
	if (dirty.code !== 0) {
		throw new DranglerError('git', `git status in ${project.dir} exited ${dirty.code}`);
	}
	if (dirty.stdout.trim() !== '') {
		throw new UsageError(
			`${project.dir} has uncommitted changes, and a release names a commit; commit or stash them first`
		);
	}

	const tagged = await ctx.runner.run('git', ['rev-parse', `${tag}^{commit}`], {
		cwd: project.dir
	});
	if (tagged.code !== 0) {
		throw new UsageError(`no tag \`${tag}\` in ${project.dir}`);
	}
	const head = await ctx.runner.run('git', ['rev-parse', 'HEAD'], { cwd: project.dir });
	if (head.stdout.trim() !== tagged.stdout.trim()) {
		throw new UsageError(
			`${tag} is ${tagged.stdout.trim().slice(0, 8)} and HEAD is ${head.stdout.trim().slice(0, 8)}; ` +
				`run \`git checkout ${tag}\` so the tree on disk is the tree being released`
		);
	}

	const { pkg, selection } = resolveProject(ctx, opts);
	const owner = ownerTarget(opts.globals);
	const result = await uploadPackage(ctx, owner, pkg, selection, {
		label: opts.message ?? tag,
		origin: tagged.stdout.trim(),
		...(opts.globals.dryRun ? { dryRun: true } : {})
	});
	emit(ctx.io, opts.globals.json, { tag, sha: tagged.stdout.trim(), ...result }, () => [
		...kv([['tag', `${tag} (${tagged.stdout.trim().slice(0, 8)})`]]),
		...renderUpload(result, opts.message ?? tag)
	]);
	if (result.error !== null) throw new DranglerError('modify', result.error);
}

/** the subject of the commit on disk, when there is one; the default revision label */
async function gitSubject(ctx: Context, project: DetectedProject): Promise<string | null> {
	if (!project.repository) return null;
	const result = await ctx.runner.run('git', ['log', '-1', '--format=%s'], { cwd: project.dir });
	const subject = result.stdout.trim();
	return result.code === 0 && subject !== '' ? subject : null;
}
