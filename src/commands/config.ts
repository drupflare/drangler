import { cloudflareApi, type WorkersPlan } from '../cloudflare/api';
import { requireAccount, resolveAuth } from '../cloudflare/auth';
import { checkConfig, parseWranglerConfig, type AccountFacts } from '../cloudflare/config';
import type { Context } from '../context';
import { FindingError, UsageError } from '../errors';
import { emit, kv } from '../format';

export interface ConfigCheckOptions {
	json?: boolean;
	/** compare the `PLAN` var against the account's real entitlement */
	account?: string;
	plan?: string;
}

/**
 * Resolves what the account is actually entitled to, without making it a requirement.
 *
 * Three ways in, in order: an explicit `--plan`, a live lookup when a Cloudflare token is present,
 * and otherwise nothing at all. "Nothing at all" leaves the plan rule unevaluated rather than
 * defaulted, so a config check run without credentials never reports that `PLAN` is right.
 */
export async function resolvePlanFacts(
	ctx: Context,
	opts: ConfigCheckOptions
): Promise<{ facts: AccountFacts; source: string }> {
	if (opts.plan !== undefined) {
		const plan = opts.plan.toLowerCase();
		if (plan !== 'free' && plan !== 'paid' && plan !== 'unknown') {
			throw new UsageError(`--plan must be free, paid or unknown, not \`${opts.plan}\``);
		}
		return { facts: { workersPlan: plan as WorkersPlan }, source: '--plan' };
	}
	const token = ctx.env.CLOUDFLARE_API_TOKEN ?? ctx.env.CF_API_TOKEN ?? '';
	if (token === '') {
		return {
			facts: {},
			source: 'not checked (no CLOUDFLARE_API_TOKEN; pass --plan to check offline)'
		};
	}
	const auth = await resolveAuth(ctx.runner, ctx.env);
	const account = requireAccount(auth, opts.account ?? null);
	const reading = await cloudflareApi(ctx.fetch, token).workersPlan(account);
	return {
		facts: { workersPlan: reading.plan },
		source:
			reading.evidence.length === 0
				? `account ${account}, no Workers rate plan in the subscription list`
				: `account ${account}: ${reading.evidence.join(', ')}`
	};
}

/** Reads a wrangler config and scores it against the deployments this project has shipped wrong. */
export async function runConfigCheck(
	ctx: Context,
	path: string,
	opts: ConfigCheckOptions
): Promise<void> {
	if (!ctx.files.exists(path)) throw new UsageError(`no such file: ${path}`);
	const text = ctx.files.readText(path);
	const config = parseWranglerConfig(text);
	const { facts, source } = await resolvePlanFacts(ctx, opts);
	const findings = checkConfig(config, facts);
	const counts = {
		blocker: findings.filter((f) => f.severity === 'blocker').length,
		warning: findings.filter((f) => f.severity === 'warning').length,
		note: findings.filter((f) => f.severity === 'note').length
	};

	emit(
		ctx.io,
		opts.json === true,
		{
			path,
			name: config.name ?? null,
			plan: facts.workersPlan ?? null,
			planSource: source,
			counts,
			findings
		},
		() => {
			const lines = kv([
				['config', path],
				['worker', typeof config.name === 'string' ? config.name : '(unnamed)'],
				['account plan', facts.workersPlan ?? 'not checked'],
				['read from', source],
				['blockers', String(counts.blocker)],
				['warnings', String(counts.warning)],
				['notes', String(counts.note)]
			]);
			for (const severity of ['blocker', 'warning', 'note'] as const) {
				const hits = findings.filter((f) => f.severity === severity);
				if (hits.length === 0) continue;
				lines.push('', `${severity}s`);
				for (const finding of hits) {
					lines.push(`  ${finding.id}: ${finding.title}`);
					lines.push(`    ${finding.detail}`);
				}
			}
			return lines;
		}
	);

	if (counts.blocker > 0) {
		throw new FindingError('config', `${counts.blocker} blocker(s) in ${path}`);
	}
}
