import { cloudflareApi, type WorkersPlan } from '../cloudflare/api';
import { requireAccount, resolveAuth } from '../cloudflare/auth';
import {
	checkConfig,
	otherVars,
	parseWranglerConfig,
	readLevers,
	type AccountFacts,
	type LeverReading
} from '../cloudflare/config';
import {
	globalConfigPath,
	PROJECT_CONFIG_NAME,
	type ResolvedConfig,
	type Setting
} from '../config/file';
import type { Context } from '../context';
import { FindingError, UsageError } from '../errors';
import { emit, kv, table } from '../format';
import { normaliseTarget } from '../health/probe';

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

export interface ConfigLeversOptions {
	json?: boolean;
	/** request the origin `FILES_PUBLIC_URL` names and report what it answered */
	check?: boolean;
	timeoutMs?: number;
}

export interface LeverProbe {
	origin: string;
	/** the HTTP status it answered, or null when nothing did */
	status: number | null;
	answered: boolean;
	error: string | null;
}

export interface ConfigLeversReport {
	path: string;
	levers: LeverReading[];
	/** every other `vars` entry, as declared */
	other: { name: string; value: string }[];
	/** null unless `--check` ran */
	filesOrigin: LeverProbe | null;
	notes: string[];
}

/**
 * The optional levers a config declares, and the real state of each.
 *
 * Read-only, and unset is not a finding. Every lever here is off by default and the site is correct
 * without it: `config check` is where a deployment is scored, and a warning for an absent option
 * would turn an opt-in into something a reader has to justify not taking.
 */
export async function runConfigLevers(
	ctx: Context,
	path: string,
	opts: ConfigLeversOptions = {}
): Promise<void> {
	if (!ctx.files.exists(path)) throw new UsageError(`no such file: ${path}`);
	const config = parseWranglerConfig(ctx.files.readText(path));
	const levers = readLevers(config);
	const report: ConfigLeversReport = {
		path,
		levers,
		other: otherVars(config),
		filesOrigin: null,
		notes: []
	};

	const aggregates = levers.find((l) => l.name === 'ASSET_AGGREGATES');
	if (aggregates?.value === '1' && !aggregatesBuilt(ctx, path, config.assets?.directory)) {
		report.notes.push(
			'ASSET_AGGREGATES is on and no agg/manifest.json is beside the assets directory, so no library matches and the substitution changes nothing'
		);
	}

	const filesUrl = levers.find((l) => l.name === 'FILES_PUBLIC_URL')?.value ?? null;
	if (opts.check === true && filesUrl !== null) {
		report.filesOrigin = await probeOrigin(ctx, filesUrl, opts.timeoutMs ?? 15_000);
		if (!report.filesOrigin.answered) {
			report.notes.push(
				'a FILES_PUBLIC_URL that does not answer costs nothing but the option: a public file that has not mirrored keeps its Worker URL either way'
			);
		} else {
			report.notes.push(
				'any status counts as an answer here; an R2 bucket origin has no object at / and a 404 there is normal'
			);
		}
	} else if (opts.check === true) {
		report.notes.push('nothing to check: no FILES_PUBLIC_URL is declared');
	}

	emit(ctx.io, opts.json === true, report, () => {
		const lines = [
			...kv([['config', path]]),
			'',
			...table(
				['lever', 'declared', 'state'],
				report.levers.map((l) => [l.name, l.value ?? 'unset', l.state])
			)
		];
		if (report.filesOrigin !== null) {
			lines.push(
				'',
				...kv([
					['files origin', report.filesOrigin.origin],
					[
						'answered',
						report.filesOrigin.answered
							? `yes, HTTP ${report.filesOrigin.status}`
							: `no: ${report.filesOrigin.error ?? 'unreachable'}`
					]
				])
			);
		}
		if (report.other.length > 0) {
			lines.push(
				'',
				'other vars',
				...report.other.map((v) => `  ${v.name}=${v.value}`),
				'  (declared, not scored here; `drangler config check` scores a deployment)'
			);
		}
		if (report.notes.length > 0) {
			lines.push('', 'notes');
			for (const note of report.notes) lines.push(`  - ${note}`);
		}
		return lines;
	});
}

/** whether `bun run assets:agg` has written the manifest the substitution matches libraries against */
function aggregatesBuilt(ctx: Context, configPath: string, directory: unknown): boolean {
	if (typeof directory !== 'string' || directory === '') return false;
	const root = configPath.includes('/') ? configPath.slice(0, configPath.lastIndexOf('/')) : '.';
	const assets = directory.replace(/^\.\//, '').replace(/\/+$/, '');
	return ctx.files.exists(`${root}/${assets}/agg/manifest.json`);
}

/**
 * Whether the configured origin answers at all.
 *
 * Any status counts. A bucket origin holds no object at `/`, so a 404 there proves DNS, TLS and the
 * custom domain are working, which is the whole question; asserting a 200 would fail every correctly
 * configured bucket.
 */
async function probeOrigin(ctx: Context, origin: string, timeoutMs: number): Promise<LeverProbe> {
	const url = normaliseTarget(origin);
	try {
		const response = await ctx.fetch(url, {
			method: 'GET',
			signal: AbortSignal.timeout(timeoutMs)
		});
		return { origin: url, status: response.status, answered: true, error: null };
	} catch (e) {
		return {
			origin: url,
			status: null,
			answered: false,
			error: e instanceof Error ? e.message : String(e)
		};
	}
}

/** the keys `config where` reports, in the order a reader wants them */
const REPORTED: readonly (keyof Pick<
	ResolvedConfig,
	'site' | 'siteName' | 'workspace' | 'account' | 'token'
>)[] = ['site', 'siteName', 'workspace', 'account', 'token'];

/** a credential is reported as present, never printed */
function shown(key: string, setting: Setting): string {
	if (setting.value === null) return '-';
	return key === 'token' ? 'set' : setting.value;
}

export interface ConfigWhereOptions {
	json?: boolean;
}

/**
 * Which file supplied each value.
 *
 * The flag, the environment variable or the file path that won is printed beside the value, so a
 * setting arriving from a `drangler.json` two directories up is visible rather than deduced. That
 * is the whole of "why is it picking that account".
 *
 * The owner token is reported as `set` and never printed, because it is a credential.
 */
export function runConfigWhere(
	ctx: Context,
	config: ResolvedConfig,
	opts: ConfigWhereOptions = {}
): void {
	const report = {
		profile: config.profile,
		files: config.sources.map((s) => ({ scope: s.scope, path: s.path, profile: s.hasProfile })),
		searched: {
			project: `${PROJECT_CONFIG_NAME} in ${ctx.cwd} or any ancestor`,
			global: globalConfigPath(ctx.env)
		},
		settings: Object.fromEntries(
			REPORTED.map((key) => [
				key,
				{
					value: shown(key, config[key]),
					origin: config[key].origin,
					from: config[key].from
				}
			])
		)
	};

	emit(ctx.io, opts.json === true, report, () => {
		const lines = [
			...kv([['profile', config.profile]]),
			'',
			...table(
				['setting', 'value', 'from'],
				REPORTED.map((key) => [
					key,
					shown(key, config[key]),
					config[key].origin === 'unset' ? 'nothing set it' : config[key].from
				])
			)
		];
		lines.push('', 'files');
		if (config.sources.length === 0) {
			lines.push('  none; searched:');
			lines.push(`    ${report.searched.project}`);
			lines.push(`    ${report.searched.global}`);
		} else {
			for (const source of config.sources) {
				lines.push(
					`  ${source.scope.padEnd(7)} ${source.path}` +
						(source.hasProfile ? ` (has a \`${config.profile}\` profile)` : '')
				);
			}
		}
		return lines;
	});
}
