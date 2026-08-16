import type { Context } from '../context';
import { DranglerError, FindingError, UsageError } from '../errors';
import { emit, kv, table } from '../format';
import { planBuild, runPlan, type BuildOptions, type BuildReport } from '../workspace/build';
import {
	assertUsable,
	readState,
	resolveWorkspace,
	type WorkspaceOptions
} from '../workspace/layout';
import { resolveSource } from '../workspace/source';
import {
	DEFAULT_CONFIG,
	GATES,
	validateWorkspace,
	type CheckId,
	type ValidationReport
} from '../workspace/validate';

export interface BuildCommandOptions extends WorkspaceOptions, BuildOptions {
	source?: string;
	ref?: string;
	dryRun?: boolean;
	json?: boolean;
}

/**
 * Turns nothing into a deployable `drupflare/worker` tree, and resumes rather than repeating.
 *
 * The steps are a clone, a `bun install` and a `bun run hydrate`, which is what `PUBLISHING.md`
 * documents as the path from `git clone` to `wrangler deploy`. drangler does not reimplement any of
 * it: the checkout is where the pack format, the payload manifest and the asset plan live, and
 * running that repository's own scripts inside a clone of it is what keeps there being one copy.
 */
export async function runBuildCommand(ctx: Context, opts: BuildCommandOptions): Promise<void> {
	const location = resolveWorkspace(ctx, opts);
	const source = resolveSource(ctx.env, opts.source, opts.ref);
	const state = readState(ctx.files, location.path);
	assertUsable(state);

	const steps = planBuild(state, source, opts);
	if (opts.dryRun === true) {
		const report = {
			workspace: location.path,
			origin: location.origin,
			source: { url: source.url, ref: source.ref, local: source.local, from: source.from },
			steps: steps.map((s) => ({
				id: s.id,
				command: s.command.join(' '),
				run: s.run,
				reason: s.reason
			}))
		};
		emit(ctx.io, opts.json === true, report, () => [
			`dry run against ${location.path} (${location.origin}); nothing was executed`,
			'',
			...renderSteps(report.steps)
		]);
		return;
	}

	const report = await runPlan(ctx, steps, location.path, source);
	emit(ctx.io, opts.json === true, report, () => renderBuild(report, location.origin));
}

function renderSteps(steps: BuildReport['steps']): string[] {
	return table(
		['step', 'run', 'reason'],
		steps.map((s) => [s.id, s.run ? 'yes' : 'skip', s.reason])
	).concat(['', ...steps.filter((s) => s.run).map((s) => `  $ ${s.command}`)]);
}

function renderBuild(report: BuildReport, origin: string): string[] {
	const lines = [
		...kv([
			['workspace', `${report.workspace} (${origin})`],
			['source', `${report.source.url} @ ${report.source.ref} (${report.source.from})`]
		]),
		'',
		...table(
			['step', 'ran', 'reason'],
			report.steps.map((s) => [s.id, s.run ? 'yes' : 'skip', s.reason])
		)
	];
	lines.push(
		'',
		report.resumed
			? 'nothing to do; the workspace was already built'
			: 'built. next: drangler validate, then drangler dev'
	);
	return lines;
}

export interface ValidateCommandOptions extends WorkspaceOptions {
	config?: string;
	only?: string;
	json?: boolean;
}

/** the check names `--only` accepts, so a typo is a usage error rather than a silent no-op */
const CHECK_NAMES: readonly CheckId[] = ['workspace', 'artifacts', 'config', 'scrub', 'bundle'];

export function parseChecks(value: string | undefined): readonly CheckId[] | undefined {
	if (value === undefined) return undefined;
	const wanted = value
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s !== '');
	const unknown = wanted.filter((s) => !CHECK_NAMES.includes(s as CheckId));
	if (unknown.length > 0) {
		throw new UsageError(
			`unknown check(s) ${unknown.join(', ')}; expected ${CHECK_NAMES.join(', ')}`
		);
	}
	return wanted as CheckId[];
}

/** Everything that has to hold before `dev` or `deploy` will do anything. */
export async function runValidateCommand(
	ctx: Context,
	opts: ValidateCommandOptions
): Promise<void> {
	const location = resolveWorkspace(ctx, opts);
	const only = parseChecks(opts.only);
	const report = await validateWorkspace(ctx, location.path, {
		...(only === undefined ? {} : { only }),
		...(opts.config === undefined ? {} : { config: opts.config })
	});
	emit(ctx.io, opts.json === true, report, () => renderValidation(report));
	throwOnFindings(report);
}

function renderValidation(report: ValidationReport): string[] {
	const lines = [
		...kv([
			['workspace', report.workspace],
			['config', report.config]
		]),
		'',
		...table(
			['check', 'result', 'what'],
			report.checks.map((c) => [c.id, verdictOf(c.ran, c.ok), c.title])
		)
	];
	for (const check of report.checks) {
		if (check.ran && check.ok) continue;
		lines.push('', `${check.id}: ${check.title}`);
		for (const line of check.detail.split('\n')) lines.push(`  ${line}`);
		if (check.fix !== null) lines.push(`  fix: ${check.fix}`);
	}
	if (report.ok && report.skipped.length === 0) {
		lines.push('', 'every check passed; the workspace is ready to deploy');
	}
	return lines;
}

/** `not run` is its own column value; a check that could not be made must not read as a pass */
function verdictOf(ran: boolean, ok: boolean): string {
	return !ran ? 'not run' : ok ? 'ok' : 'FAIL';
}

function throwOnFindings(report: ValidationReport): void {
	if (report.failed.length > 0) {
		throw new FindingError(
			'validation',
			`${report.failed.length} check(s) failed: ${report.failed.join(', ')}`
		);
	}
	if (report.skipped.length > 0) {
		throw new FindingError(
			'validation-incomplete',
			`${report.skipped.length} check(s) could not run: ${report.skipped.join(', ')}`
		);
	}
}

export interface RunCommandOptions extends WorkspaceOptions {
	config?: string;
	/** build the workspace first when it is not there; on by default */
	build?: boolean;
	/** skip the gate; the flag exists so a user is never stuck behind drangler's own opinion */
	skipValidate?: boolean;
	source?: string;
	ref?: string;
	from?: string;
	/** rebuild the artifacts in the checkout rather than letting hydrate decide */
	fromSource?: boolean;
	/** fail when no payload exists, rather than building from source */
	payloadOnly?: boolean;
	json?: boolean;
}

/**
 * Boots a local Drupal, building the workspace first if there is not one.
 *
 * RESUMABLE THE WAY `wrangler dev` IS. The second run reuses the workspace, because every build step
 * asks the disk whether its output exists rather than asking a lock file whether it ran -- so an
 * interrupted first run resumes at the step that did not finish, and a finished one re-clones and
 * re-downloads nothing.
 */
export async function runDevCommand(
	ctx: Context,
	extra: readonly string[],
	opts: RunCommandOptions
): Promise<void> {
	await runWrangler(ctx, 'dev', extra, opts);
}

/** Deploys the workspace to the caller's own Cloudflare account, through their own wrangler. */
export async function runDeployCommand(
	ctx: Context,
	extra: readonly string[],
	opts: RunCommandOptions
): Promise<void> {
	await runWrangler(ctx, 'deploy', extra, opts);
}

/**
 * The shared path: ensure a workspace, gate it, then hand the terminal to wrangler.
 *
 * The credential is wrangler's own and drangler never reads it. That is why this wraps the binary
 * rather than calling the REST API: a deploy that went through drangler's own HTTP client would need
 * a token with write scope, which is a strictly worse thing to ask a user for than the login they
 * already have.
 */
async function runWrangler(
	ctx: Context,
	verb: 'dev' | 'deploy',
	extra: readonly string[],
	opts: RunCommandOptions
): Promise<void> {
	const location = resolveWorkspace(ctx, opts);
	const source = resolveSource(ctx.env, opts.source, opts.ref);
	const state = readState(ctx.files, location.path);
	assertUsable(state);

	if (opts.build !== false) {
		const steps = planBuild(state, source, {
			...(opts.from === undefined ? {} : { from: opts.from }),
			...(opts.fromSource === true ? { fromSource: true } : {}),
			...(opts.payloadOnly === true ? { payloadOnly: true } : {})
		});
		if (steps.some((s) => s.run)) await runPlan(ctx, steps, location.path, source);
	}

	if (opts.skipValidate !== true) {
		const report = await validateWorkspace(ctx, location.path, {
			only: GATES[verb],
			...(opts.config === undefined ? {} : { config: opts.config })
		});
		if (!report.ok || report.skipped.length > 0) {
			for (const line of renderValidation(report)) ctx.io.err(line);
			throwOnFindings(report);
		}
	}

	const config = opts.config ?? DEFAULT_CONFIG;
	const args = ['wrangler', verb, '-c', config, ...extra];
	ctx.io.out(`${location.path}$ bunx ${args.join(' ')}`);
	const code = await ctx.runner.spawn('bunx', args, { cwd: location.path });
	if (code !== 0) {
		throw new DranglerError('wrangler', `wrangler ${verb} exited ${code}`);
	}
}
