import { resolveAuth } from '../cloudflare/auth';
import type { ResolvedConfig, Setting } from '../config/file';
import type { Context } from '../context';
import { FindingError } from '../errors';
import { emit, kv, table } from '../format';
import { normaliseTarget, probeClaim, probeSite } from '../health/probe';
import { summariseHealth } from '../health/repair';
import { siteReport, type SiteInputs, type SiteReport } from '../health/site';
import { sourceFindings, type SourceFinding } from '../health/source';
import type { CommandRunner } from '../host/exec';
import { runSurvey, type SiteSurvey } from '../migrate/survey';
import { parseTarget } from '../migrate/target';
import { sshTransport } from '../migrate/transport';
import { ownerCall, type OwnerTarget } from '../owner';

export interface ToolCheck {
	name: string;
	/** the command drangler runs that needs it */
	usedBy: string;
	required: boolean;
	present: boolean;
	version: string | null;
	install: string;
}

interface ToolSpec {
	name: string;
	args: string[];
	usedBy: string;
	required: boolean;
	install: string;
}

/**
 * What drangler shells out to, and which command needs each.
 *
 * `ssh` and `wrangler` are required because half the surface is unusable without them. `php` and
 * `drush` are not listed at all: they are needed on the VPS being surveyed, not on this machine.
 *
 * `git` is OPTIONAL and it is back. It was dropped when `status` stopped scanning source checkouts,
 * and `build` and `modify` reach for it again: `build` clones the worker, and `modify release`
 * reads a tag and refuses a dirty tree. Optional rather than required, because a preflight that
 * demands a tool most of the surface never runs is a false failure on a user's machine.
 */
export const TOOLS: readonly ToolSpec[] = [
	{
		name: 'ssh',
		args: ['-V'],
		usedBy: 'migrate survey',
		required: true,
		install: 'openssh-client'
	},
	{
		name: 'git',
		args: ['--version'],
		usedBy: 'build, modify release',
		required: false,
		install: 'your distribution package'
	},
	{
		name: 'wrangler',
		args: ['--version'],
		usedBy: 'cf whoami, cf workers',
		required: true,
		install: 'bun add -g wrangler'
	},
	{
		name: 'bun',
		args: ['--version'],
		usedBy: 'running drangler from source',
		required: false,
		install: 'curl -fsSL https://bun.sh/install | bash'
	},
	{
		name: 'rsync',
		args: ['--version'],
		usedBy: 'the file copy step `migrate plan` prints',
		required: false,
		install: 'your distribution package'
	}
];

/** `ssh -V` writes to stderr, and `git --version` to stdout; both are read. */
export function parseVersion(stdout: string, stderr: string): string | null {
	const text = `${stdout} ${stderr}`;
	return /(\d+\.\d+(?:\.\d+)?[\w.]*)/.exec(text)?.[1] ?? null;
}

export async function checkTools(runner: CommandRunner): Promise<ToolCheck[]> {
	const out: ToolCheck[] = [];
	for (const spec of TOOLS) {
		const result = await runner.run(spec.name, spec.args);
		const present = result.code === 0;
		out.push({
			name: spec.name,
			usedBy: spec.usedBy,
			required: spec.required,
			present,
			version: present ? parseVersion(result.stdout, result.stderr) : null,
			install: spec.install
		});
	}
	return out;
}

export interface DoctorOptions {
	json?: boolean;
	/** the resolved config, so the report says which file supplied each setting */
	config?: ResolvedConfig;
	/** an ssh target to survey and score; without it the local half is all that runs */
	source?: string;
	/** the Drupal root on that host */
	root?: string;
	/** an ssh key, passed to ssh as -i */
	identity?: string;
	/** a site origin to score; without it the local half is all that runs */
	site?: string;
	siteName?: string;
	token?: string;
	timeoutMs?: number;
	/** whether a workspace was given, which decides one `not checked` row */
	workspace?: string;
}

/** one row per setting: what it resolved to and what supplied it */
export function configRows(config: ResolvedConfig): [string, string][] {
	const show = (name: string, setting: Setting): [string, string] => [
		name,
		setting.value === null
			? 'not set'
			: `${setting.value} (${setting.origin}${setting.from === '' ? '' : ` ${setting.from}`})`
	];
	return [
		['profile', config.profile],
		[
			'config files',
			config.sources.length === 0
				? 'none found'
				: config.sources.map((s) => s.path).join(', ')
		],
		show('site', config.site),
		show('site name', config.siteName),
		show('workspace', config.workspace),
		show('account', config.account),
		// the VALUE is never printed; a preflight that echoed a credential would put it in a scrollback
		['owner token', config.token.value === null ? 'not set' : `set (${config.token.from})`]
	];
}

/**
 * Preflight: the tools and the Cloudflare credential, in one pass.
 *
 * Exists because every other command fails in its own way when one of these is missing, and the
 * failure names the symptom rather than the cause -- "ssh exited 127" is a worse first experience
 * than being told ssh is not installed before anything is attempted.
 *
 * **Looks at nothing on disk.** It used to also report a drupflare source workspace, which meant the
 * command someone runs when they are already confused failed on a machine that had never had one.
 * A health check that only passes on a maintainer's laptop is worse than no health check.
 */
export async function runDoctor(ctx: Context, opts: DoctorOptions): Promise<void> {
	const tools = await checkTools(ctx.runner);
	const auth = await resolveAuth(ctx.runner, ctx.env);

	const missing = tools.filter((t) => t.required && !t.present);
	const rows = opts.config === undefined ? [] : configRows(opts.config);
	const source = opts.source === undefined ? null : await scoreSource(ctx, opts);
	const site = opts.site === undefined ? null : await scoreSite(ctx, opts);
	const report = {
		tools,
		auth,
		missing: missing.map((t) => t.name),
		config: Object.fromEntries(rows),
		source,
		site
	};

	emit(ctx.io, opts.json === true, report, () => {
		const lines = [
			...(rows.length === 0 ? [] : [...kv(rows), '']),
			...table(
				['tool', 'found', 'version', 'used by'],
				tools.map((t) => [
					t.name + (t.required ? '' : ' (optional)'),
					t.present ? 'yes' : 'NO',
					t.version ?? '-',
					t.usedBy
				])
			),
			'',
			`cloudflare: ${auth.authenticated ? `${auth.source}${auth.email === null ? '' : ` as ${auth.email}`}` : 'not authenticated'}`
		];
		if (missing.length > 0) {
			lines.push('', 'missing');
			for (const tool of missing) lines.push(`  ${tool.name}: ${tool.install}`);
		}
		if (auth.remedy !== null) lines.push('', `next: ${auth.remedy}`);
		if (source !== null) lines.push('', ...renderSource(source));
		if (site !== null) lines.push('', ...renderSite(site));
		return lines;
	});

	if (missing.length > 0) {
		throw new FindingError('tools', `${missing.length} required tool(s) missing`);
	}
	if (source !== null && source.findings.length > 0) {
		throw new FindingError(
			'source-broken',
			`${source.findings.length} finding(s) on ${source.host}`,
			`drangler doctor --source ${source.host} --root ${source.root} --json`
		);
	}
	if (site !== null && site.findings.length > 0) {
		throw new FindingError(
			'site-broken',
			`${site.findings.length} finding(s) on ${site.site}`,
			site.next[0] ?? null
		);
	}
}

export interface SourceReport {
	host: string;
	root: string;
	findings: SourceFinding[];
	/** the survey the verdict was read from, so `--json` carries its own evidence */
	survey: SiteSurvey;
}

/**
 * Surveys a VPS and scores what came back.
 *
 * The same read-only command plan `migrate survey` issues, because the states worth reporting are
 * all detectable from it; what was missing was a verdict rather than a connection.
 */
async function scoreSource(ctx: Context, opts: DoctorOptions): Promise<SourceReport> {
	const target = parseTarget(opts.source as string, opts.root ?? '/var/www/html', opts.identity);
	const survey = await runSurvey(
		{ transport: sshTransport(ctx.runner, target), now: ctx.now },
		opts.source as string,
		target.root
	);
	return {
		host: opts.source as string,
		root: survey.root,
		findings: sourceFindings(survey),
		survey
	};
}

function renderSource(report: SourceReport): string[] {
	const lines = kv([
		['source', `${report.host}:${report.root}`],
		['php', report.survey.php.version ?? '-'],
		['drupal', report.survey.drupal.version ?? '-'],
		['database', report.survey.database.driver ?? '-'],
		['files', report.survey.files.count === null ? '-' : `${report.survey.files.count} file(s)`]
	]);
	if (report.findings.length === 0) {
		lines.push('', 'nothing wrong with the source that a survey can see');
		return lines;
	}
	lines.push('', 'source findings');
	for (const f of report.findings) {
		lines.push(`  ${f.severity.padEnd(9)}${f.id.padEnd(26)}${f.detail}`);
		lines.push(`  ${' '.repeat(9)}${' '.repeat(26)}evidence: ${f.evidence}`);
	}
	return lines;
}

/** Reads every owner route that reports a state, tolerating the ones a worker does not have. */
async function scoreSite(ctx: Context, opts: DoctorOptions): Promise<SiteReport> {
	const globals = {
		config: opts.config,
		timeoutMs: opts.timeoutMs ?? 15_000
	};
	const origin = normaliseTarget(opts.site as string);
	const siteName = opts.siteName ?? 'site';
	const timeoutMs = globals.timeoutMs;
	const probe = await probeSite(
		{ fetch: ctx.fetch },
		{ target: origin, site: siteName, kind: 'worker', skipEdge: true, timeoutMs }
	);
	const claim = await probeClaim({ fetch: ctx.fetch }, origin, siteName, timeoutMs);

	const token = opts.token ?? null;
	const owner: OwnerTarget | null =
		token === null ? null : { origin, site: siteName, token, timeoutMs };
	const read = async (path: string, params: Record<string, string> = {}) => {
		if (owner === null) return null;
		try {
			const reply = await ownerCall(ctx, owner, path, { params });
			return reply.status >= 400 ? null : reply.body;
		} catch {
			// an owner route that did not answer is a check that did not run, never one that passed
			return null;
		}
	};

	const health = await read('/health');
	const updb = await read('/updb');
	// `/replica` is deliberately NOT read: it is diagnostic-only, a withdrawn lane asks the primary
	// for its own copy, and the same route carries a lane's speculative-batch commit path
	const git = await read('/git');
	const modify = await read('/modify', { action: 'status' });

	return siteReport({
		probe,
		health: health === null ? null : summariseHealth(origin, health, ctx.now().getTime()),
		updb: updb === null ? null : readUpdb(updb),
		git: git === null ? null : { remotes: readRemotes(git) },
		modify: modify === null ? null : { packages: readPackages(modify) },
		claimed: claim.state,
		workspace: opts.workspace !== undefined
	});
}

function readUpdb(body: Record<string, unknown>): SiteInputs['updb'] {
	const status = (body['status'] ?? body) as Record<string, unknown>;
	const run = status['run'] as Record<string, unknown> | null | undefined;
	return {
		phase: run ? String(run['phase']) : null,
		cursor: run ? Number(run['cursorSeq']) : null,
		haltReason: run && typeof run['haltReason'] === 'string' ? run['haltReason'] : null
	};
}

function readRemotes(body: Record<string, unknown>): { id: string; previewOf: string | null }[] {
	const remotes = body['remotes'];
	if (!Array.isArray(remotes)) return [];
	return remotes.map((raw) => {
		const row = (raw ?? {}) as Record<string, unknown>;
		return {
			id: String(row['id'] ?? ''),
			previewOf:
				typeof row['previewOf'] === 'string' && row['previewOf'] !== ''
					? row['previewOf']
					: null
		};
	});
}

function readPackages(
	body: Record<string, unknown>
): { package: string; rev: string | null; files: number }[] {
	const packages = body['packages'];
	if (!Array.isArray(packages)) return [];
	return packages.map((raw) => {
		const row = (raw ?? {}) as Record<string, unknown>;
		return {
			package: String(row['package'] ?? ''),
			rev: typeof row['rev'] === 'string' ? row['rev'] : null,
			files: Number(row['files'] ?? 0)
		};
	});
}

function renderSite(report: SiteReport): string[] {
	const lines = kv([
		['site', report.site],
		['reachable', report.reachable ? 'yes' : 'no'],
		['answered by', report.tier ?? '-'],
		['generation', report.generation === null ? '-' : String(report.generation)],
		['worker version', report.version ?? '-'],
		['degraded', report.degraded ?? 'no']
	]);
	if (report.findings.length > 0) {
		lines.push('', 'findings');
		for (const f of report.findings) {
			lines.push(`  ${f.severity.padEnd(9)}${f.id.padEnd(28)}${f.detail}`);
		}
	}
	if (report.unchecked.length > 0) {
		lines.push('', 'not checked');
		for (const row of report.unchecked) lines.push(`  ${row.id.padEnd(28)}${row.needs}`);
	}
	if (report.next.length > 0) {
		lines.push('', 'next');
		for (const step of report.next) lines.push(`  ${step}`);
	}
	return lines;
}
