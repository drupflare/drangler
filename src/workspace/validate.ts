import { checkConfig, parseWranglerConfig } from '../cloudflare/config';
import type { Context } from '../context';
import { HYDRATE_COMMAND, inWorkspace, missingArtifacts } from './artifacts';
import { ceilingVerdict, FREE_CEILING, parseWranglerGzipBytes } from './bundle';
import { isWorkerCheckout, readState, WORKER_PACKAGE } from './layout';

export type CheckId = 'workspace' | 'artifacts' | 'config' | 'scrub' | 'bundle';

export interface ValidationCheck {
	id: CheckId;
	/**
	 * Whether the check could be made at all.
	 *
	 * A check that could not run is reported as `ran: false` and never as a pass. That distinction is
	 * the whole reason this is a record rather than a boolean: "the pack scrubber is not installed"
	 * and "the pack carries no secret" are different facts and only one of them is safe to deploy on.
	 */
	ran: boolean;
	ok: boolean;
	title: string;
	detail: string;
	/** the exact command that fixes it, or null when there is nothing to run */
	fix: string | null;
}

/**
 * Which checks each command insists on before it will do its work.
 *
 * `dev` and `deploy` differ on two, and the difference is what each one actually risks.
 * `wrangler dev` bundles locally and never uploads, so the 3 MiB ceiling does not apply to it and a
 * seeded credential in the pack is not published by it. `wrangler deploy` does both.
 */
export const GATES: Record<'dev' | 'deploy', readonly CheckId[]> = {
	dev: ['workspace', 'artifacts', 'config'],
	deploy: ['workspace', 'artifacts', 'config', 'scrub', 'bundle']
};

/** every check, in the order a report reads best */
export const ALL_CHECKS: readonly CheckId[] = [
	'workspace',
	'artifacts',
	'config',
	'scrub',
	'bundle'
];

export interface ValidateOptions {
	/** run only these; defaults to every check */
	only?: readonly CheckId[];
	/** the wrangler config to score and to price, relative to the workspace */
	config?: string;
}

export interface ValidationReport {
	workspace: string;
	config: string;
	checks: ValidationCheck[];
	/** checks that ran and failed */
	failed: CheckId[];
	/** checks that could not be made, which is not the same as passing */
	skipped: CheckId[];
	ok: boolean;
}

export const DEFAULT_CONFIG = 'wrangler.jsonc';

/**
 * Everything that has to hold before a workspace can be run or deployed.
 *
 * The set is deliberately small and every member is a failure `drupflare/worker` has actually
 * shipped: a checkout with no generated tree, a config whose interpreter alias resolves to the
 * fallback binary at 710,410 bytes over the ceiling, and a per-file pack still carrying the
 * `hash_salt` that Workers assets serve publicly.
 */
export async function validateWorkspace(
	ctx: Context,
	workspace: string,
	opts: ValidateOptions = {}
): Promise<ValidationReport> {
	const only = new Set(opts.only ?? ALL_CHECKS);
	const config = opts.config ?? DEFAULT_CONFIG;
	const checks: ValidationCheck[] = [];

	for (const id of ALL_CHECKS) {
		if (!only.has(id)) continue;
		checks.push(await runCheck(ctx, workspace, config, id));
	}

	const failed = checks.filter((c) => c.ran && !c.ok).map((c) => c.id);
	const skipped = checks.filter((c) => !c.ran).map((c) => c.id);
	return { workspace, config, checks, failed, skipped, ok: failed.length === 0 };
}

async function runCheck(
	ctx: Context,
	workspace: string,
	config: string,
	id: CheckId
): Promise<ValidationCheck> {
	switch (id) {
		case 'workspace':
			return checkWorkspace(ctx, workspace);
		case 'artifacts':
			return checkArtifacts(ctx, workspace);
		case 'config':
			return checkWranglerConfig(ctx, workspace, config);
		case 'scrub':
			return await checkScrub(ctx, workspace);
		case 'bundle':
			return await checkBundle(ctx, workspace, config);
	}
}

function checkWorkspace(ctx: Context, workspace: string): ValidationCheck {
	const state = readState(ctx.files, workspace);
	const ok = isWorkerCheckout(ctx.files, workspace);
	return {
		id: 'workspace',
		ran: true,
		ok,
		title: ok ? `${WORKER_PACKAGE} checkout` : `not a ${WORKER_PACKAGE} checkout`,
		detail: ok
			? `${workspace}${state.repository ? '' : ' (no .git, so --refresh has nothing to fetch)'}`
			: state.occupied
				? `${workspace} holds files and its package.json does not name ${WORKER_PACKAGE}`
				: `${workspace} does not exist`,
		fix: ok ? null : `drangler build --workspace ${workspace}`
	};
}

function checkArtifacts(ctx: Context, workspace: string): ValidationCheck {
	if (!isWorkerCheckout(ctx.files, workspace)) {
		return {
			id: 'artifacts',
			ran: false,
			ok: false,
			title: 'generated artifacts not checked',
			detail: 'there is no checkout to look in',
			fix: `drangler build --workspace ${workspace}`
		};
	}
	const missing = missingArtifacts(ctx.files, workspace);
	return {
		id: 'artifacts',
		ran: true,
		ok: missing.length === 0,
		title:
			missing.length === 0
				? 'every generated artifact is on disk'
				: `${missing.length} generated artifact(s) missing`,
		detail:
			missing.length === 0
				? 'assets/ and .interp/ are complete, so wrangler has everything it bundles'
				: missing.map((m) => `${m.path} <- ${m.produces}`).join('\n'),
		fix: missing.length === 0 ? null : `cd ${workspace} && ${HYDRATE_COMMAND}`
	};
}

function checkWranglerConfig(ctx: Context, workspace: string, config: string): ValidationCheck {
	const path = inWorkspace(workspace, config);
	if (!ctx.files.exists(path)) {
		return {
			id: 'config',
			ran: false,
			ok: false,
			title: 'wrangler config not checked',
			detail: `no ${config} at ${path}`,
			fix: `drangler build --workspace ${workspace}`
		};
	}
	let findings;
	try {
		findings = checkConfig(parseWranglerConfig(ctx.files.readText(path)));
	} catch (e) {
		return {
			id: 'config',
			ran: false,
			ok: false,
			title: 'wrangler config not checked',
			detail: `${path} did not parse: ${e instanceof Error ? e.message : String(e)}`,
			fix: null
		};
	}
	const blockers = findings.filter((f) => f.severity === 'blocker');
	const warnings = findings.filter((f) => f.severity === 'warning');
	return {
		id: 'config',
		ran: true,
		ok: blockers.length === 0,
		title:
			blockers.length === 0
				? `${config} has no blockers${warnings.length === 0 ? '' : `, ${warnings.length} warning(s)`}`
				: `${config} has ${blockers.length} blocker(s)`,
		detail:
			blockers.length === 0
				? warnings.map((f) => `warning: ${f.title}`).join('\n') ||
					'scored against the deployments this project has shipped wrong'
				: blockers.map((f) => `${f.title}: ${f.detail}`).join('\n'),
		fix: blockers.length === 0 ? null : `drangler config check ${path}`
	};
}

/**
 * Runs the worker's own pack scrubber rather than reading the pack here.
 *
 * The per-file pack format has one implementation and it is in `drupflare/worker`; a second reader
 * in drangler is exactly the drift the workspace has already spent a session deleting. Invoking the
 * checkout's script is what the clone buys.
 *
 * Exit 2 means the script found no pack to look at, which is a check that could NOT be made.
 */
async function checkScrub(ctx: Context, workspace: string): Promise<ValidationCheck> {
	const result = await ctx.runner.run('bun', ['run', 'assets:scrub:check'], {
		cwd: workspace,
		timeoutMs: 5 * 60_000
	});
	if (result.code === 0) {
		return {
			id: 'scrub',
			ran: true,
			ok: true,
			title: 'the per-file pack carries no seeded secret',
			detail: 'bun run assets:scrub:check found nothing to rewrite',
			fix: null
		};
	}
	if (result.code === 1) {
		return {
			id: 'scrub',
			ran: true,
			ok: false,
			title: 'the per-file pack still ships a secret',
			detail:
				'Workers assets are served publicly, so every site deployed from this pack would ' +
				`share it:\n${(result.stdout || result.stderr).trim()}`,
			fix: `cd ${workspace} && bun run assets:scrub`
		};
	}
	return {
		id: 'scrub',
		ran: false,
		ok: false,
		title: 'the pack scrubber could not run',
		detail: `bun run assets:scrub:check exited ${result.code}: ${(result.stderr || result.stdout).trim()}`,
		fix: `cd ${workspace} && ${HYDRATE_COMMAND}`
	};
}

/**
 * Prices the bundle by dry-running the real config, which needs no Cloudflare credential.
 *
 * The figure is wrangler's own printed one. A local gzip over the outdir moves with concatenation
 * order and zlib version, and `drupflare/worker` measured that instrument disagreeing with the meter
 * that binds by tens of kilobytes in both directions.
 *
 * The outdir is not cleared first, and it does not need to be: this reads what wrangler PRINTS,
 * which is computed from what it bundled rather than from what the directory holds. The instrument
 * that had to clear it was the local one.
 */
async function checkBundle(
	ctx: Context,
	workspace: string,
	config: string
): Promise<ValidationCheck> {
	const outdir = inWorkspace(workspace, 'dist/dry-run');
	const result = await ctx.runner.run(
		'bunx',
		['wrangler', 'deploy', '-c', config, '--dry-run', '--outdir', outdir],
		{ cwd: workspace, timeoutMs: 15 * 60_000 }
	);
	const bytes = parseWranglerGzipBytes(`${result.stdout}\n${result.stderr}`);
	if (bytes === undefined) {
		return {
			id: 'bundle',
			ran: false,
			ok: false,
			title: 'the bundle could not be priced',
			detail:
				`wrangler deploy --dry-run exited ${result.code} and printed no gzip figure:\n` +
				`${(result.stderr || result.stdout).trim().slice(0, 600)}`,
			fix: `cd ${workspace} && bunx wrangler deploy -c ${config} --dry-run`
		};
	}
	const verdict = ceilingVerdict(bytes);
	return {
		id: 'bundle',
		ran: true,
		ok: verdict.fitsFree,
		title: verdict.fitsFree
			? `bundle fits the free ceiling, ${verdict.freeHeadroom.toLocaleString('en-US')} bytes under`
			: `bundle is ${(-verdict.freeHeadroom).toLocaleString('en-US')} bytes OVER the free ceiling`,
		detail:
			`${bytes.toLocaleString('en-US')} gzipped bytes against ` +
			`${FREE_CEILING.toLocaleString('en-US')}, as printed by wrangler` +
			(verdict.fitsFree ? '' : verdict.fitsPaid ? '; it fits the paid ceiling' : ''),
		fix: verdict.fitsFree ? null : `drangler config check ${inWorkspace(workspace, config)}`
	};
}
