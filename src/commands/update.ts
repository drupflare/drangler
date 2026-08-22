import { cloudflareApi } from '../cloudflare/api';
import { requireAccount, requireToken, resolveAuth } from '../cloudflare/auth';
import type { Context } from '../context';
import { DranglerError, UsageError } from '../errors';
import { emit, kv, table } from '../format';
import { planBuild, runPlan, type BuildReport } from '../workspace/build';
import {
	assertUsable,
	readState,
	resolveWorkspace,
	type WorkspaceOptions
} from '../workspace/layout';
import { resolveSource } from '../workspace/source';
import {
	movedRef,
	resolveUpdateTarget,
	updateSummary,
	type UpdateOutcome
} from '../workspace/update';
import { DEFAULT_CONFIG, GATES, validateWorkspace } from '../workspace/validate';

export interface UpdateCommandOptions extends WorkspaceOptions {
	/** the drupflare version to move to: a tag, a branch or a sha */
	to?: string;
	source?: string;
	config?: string;
	account?: string;
	/** skip the gate before a deploy; the flag exists so nobody is stuck behind drangler's opinion */
	skipValidate?: boolean;
	dryRun?: boolean;
	json?: boolean;
}

/**
 * Moves a checkout to another drupflare version, and optionally the Worker running it.
 *
 * Reuses `planBuild()` rather than carrying a second copy of the clone/install/hydrate ladder, and
 * reuses its `refresh` step, which already refuses a dirty tree and fast-forwards rather than
 * resetting. What this adds is the part a build cannot do: noticing that the checkout MOVED, and
 * forcing `install` and `hydrate` when it did.
 */
export async function runUpdateCommand(
	ctx: Context,
	worker: string | undefined,
	opts: UpdateCommandOptions
): Promise<void> {
	const location = resolveWorkspace(ctx, opts);
	const state = readState(ctx.files, location.path);
	assertUsable(state);
	const target = resolveUpdateTarget(state, worker);
	const source = resolveSource(ctx.env, opts.source, opts.to);

	if (!state.repository) {
		throw new UsageError(
			`${location.path} has no .git, so there is no version to move. It was hydrated from a ` +
				'payload rather than cloned; rebuild it with `drangler build` to get a checkout that ' +
				'can be updated.'
		);
	}

	// checked BEFORE the checkout is touched: refusing after a fast-forward would leave the tree on
	// a version whose deploy never happened
	if (target.mode === 'deployed') await assertDeployed(ctx, target.worker as string, opts);

	const before = await headSha(ctx, location.path);

	if (opts.dryRun === true) {
		emit(
			ctx.io,
			opts.json === true,
			{
				mode: target.mode,
				worker: target.worker,
				workspace: location.path,
				ref: source.ref,
				at: before,
				because: target.because
			},
			() => [
				`dry run; nothing was executed`,
				'',
				...kv([
					['mode', `${target.mode} (${target.because})`],
					['workspace', location.path],
					['at', before],
					['moving to', `${source.url} @ ${source.ref}`],
					...(target.worker === null
						? []
						: [['then deploying', target.worker] as [string, string]])
				])
			]
		);
		return;
	}

	const refresh = await runPlan(
		ctx,
		planBuild(state, source, { refresh: true }).filter(
			(s) => s.id === 'clone' || s.id === 'refresh'
		),
		location.path,
		source
	);

	const after = await headSha(ctx, location.path);
	const moved = movedRef(before, after);

	// FORCED WHEN THE REF MOVED, and this is the reason `update` is not just `build --refresh`.
	// `planBuild()` skips both when their output exists, and after a version change that output
	// belongs to the version being left behind
	const rebuilt = moved
		? await runPlan(
				ctx,
				planBuild(readState(ctx.files, location.path), source, { force: true }).filter(
					(s) => s.id === 'install' || s.id === 'hydrate'
				),
				location.path,
				source
			)
		: null;

	let deployed = false;
	if (target.mode === 'deployed') {
		if (opts.skipValidate !== true) await gate(ctx, location.path, opts);
		await deploy(ctx, location.path, target.worker as string, opts);
		deployed = true;
	}

	const outcome: UpdateOutcome = {
		mode: target.mode,
		worker: target.worker,
		workspace: location.path,
		ref: source.ref,
		from: before,
		to: after,
		moved,
		deployed
	};
	emit(ctx.io, opts.json === true, { ...outcome, steps: stepsOf(refresh, rebuilt) }, () => [
		...kv([
			['mode', `${target.mode} (${target.because})`],
			['workspace', location.path],
			['ref', source.ref],
			['from', outcome.from],
			['to', outcome.to]
		]),
		'',
		...table(
			['step', 'ran', 'reason'],
			stepsOf(refresh, rebuilt).map((s) => [s.id, s.run ? 'yes' : 'skip', s.reason])
		),
		'',
		updateSummary(outcome)
	]);
}

function stepsOf(refresh: BuildReport, rebuilt: BuildReport | null): BuildReport['steps'] {
	return [
		...refresh.steps,
		...(rebuilt?.steps ?? [
			{
				id: 'install' as const,
				command: 'bun install',
				run: false,
				reason: 'the checkout did not move, so its artifacts are current'
			}
		])
	];
}

/** the commit the checkout is on; the reading that makes "already current" a measurement */
async function headSha(ctx: Context, workspace: string): Promise<string> {
	const head = await ctx.runner.run('git', ['-C', workspace, 'rev-parse', 'HEAD']);
	if (head.code !== 0) {
		throw new DranglerError(
			'update',
			`git rev-parse failed in ${workspace}: ${head.stderr.trim() || `exit ${head.code}`}`
		);
	}
	return head.stdout.trim();
}

/**
 * Refuses to "update" a Worker that is not there.
 *
 * `update` moves an existing deployment; creating one is `deploy`. Without this the typo case
 * uploads a second Worker under the misspelled name and reports success.
 */
async function assertDeployed(
	ctx: Context,
	worker: string,
	opts: UpdateCommandOptions
): Promise<void> {
	const auth = await resolveAuth(ctx.runner, ctx.env);
	const account = requireAccount(auth, opts.account ?? null);
	const scripts = await cloudflareApi(ctx.fetch, requireToken(ctx.env)).listWorkers(account);
	if (scripts.some((s) => s.id === worker)) return;
	throw new UsageError(
		`no worker named \`${worker}\` on account ${account}, so there is nothing to update. ` +
			'`drangler cf workers` lists them; `drangler deploy` creates one.'
	);
}

async function gate(ctx: Context, workspace: string, opts: UpdateCommandOptions): Promise<void> {
	const report = await validateWorkspace(ctx, workspace, {
		only: GATES.deploy,
		...(opts.config === undefined ? {} : { config: opts.config })
	});
	if (report.ok && report.skipped.length === 0) return;
	for (const check of report.checks) {
		if (check.ran && check.ok) continue;
		ctx.io.err(`${check.id}: ${check.title}`);
	}
	throw new DranglerError(
		'validation',
		`the updated workspace does not pass the deploy gate; it was NOT deployed to ${
			opts.config ?? DEFAULT_CONFIG
		}`
	);
}

/** the deploy itself, through the caller's own wrangler, the same as `drangler deploy` */
async function deploy(
	ctx: Context,
	workspace: string,
	worker: string,
	opts: UpdateCommandOptions
): Promise<void> {
	const args = ['wrangler', 'deploy', '-c', opts.config ?? DEFAULT_CONFIG, '--name', worker];
	ctx.io.err(`${workspace}$ bunx ${args.join(' ')}`);
	const code = await ctx.runner.spawn('bunx', args, { cwd: workspace });
	if (code !== 0) throw new DranglerError('wrangler', `wrangler deploy exited ${code}`);
}
