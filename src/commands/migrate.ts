import type { Context } from '../context';
import { DranglerError, FindingError, UsageError } from '../errors';
import { emit, kv } from '../format';
import { convertDump, DO_STATEMENT_CHARS, type Dialect } from '../migrate/convert';
import { buildPlan, renderPlan } from '../migrate/plan';
import type { Direction } from '../migrate/rules';
import { emptySurvey, runSurvey, surveyPlan, type SiteSurvey } from '../migrate/survey';
import { destination, parseTarget, type SshTarget } from '../migrate/target';
import {
	assumedTarget,
	probeTargetPhp,
	statedTarget,
	type TargetRuntime
} from '../migrate/target-runtime';
import {
	refusingTransport,
	replayTransport,
	sshTransport,
	type Transcript,
	type Transport
} from '../migrate/transport';

export interface SurveyOptions {
	host: string;
	root: string;
	identity?: string;
	dryRun?: boolean;
	replay?: string;
	out?: string;
	json?: boolean;
}

/**
 * Surveys a VPS Drupal over SSH.
 *
 * `--dry-run` prints the command plan and connects to nothing, which is the reviewable form: every
 * command is read-only, and a user handing over SSH access to a production host is entitled to read
 * the list before it runs.
 */
export async function runSurveyCommand(ctx: Context, opts: SurveyOptions): Promise<void> {
	const target = parseTarget(opts.host, opts.root, opts.identity);
	const transport = selectTransport(ctx, opts, target);

	if (opts.dryRun === true) {
		const steps = surveyPlan(target.root);
		emit(ctx.io, opts.json === true, { target, steps }, () => [
			`dry run against ${opts.host}; nothing was executed`,
			'',
			...steps.flatMap((step) => [
				`${step.id}${step.required ? '' : ' (optional)'}: ${step.description}`,
				`  $ ${step.command}`
			])
		]);
		return;
	}

	const survey = await runSurvey({ transport, now: ctx.now }, opts.host, target.root);
	if (opts.out !== undefined)
		ctx.files.writeText(opts.out, `${JSON.stringify(survey, null, 2)}\n`);

	emit(ctx.io, opts.json === true, survey, () => renderSurvey(survey, opts.out));
}

/**
 * Picks the transport before anything decides whether to use it.
 *
 * A dry run gets one that refuses every command rather than no transport at all, so a later change
 * that adds an exec to the dry-run path fails loudly instead of quietly opening a connection the user
 * asked not to make.
 */
export function selectTransport(
	ctx: Context,
	opts: Pick<SurveyOptions, 'dryRun' | 'replay'>,
	target: SshTarget
): Transport {
	if (opts.dryRun === true) return refusingTransport(destination(target));
	if (opts.replay !== undefined) {
		return replayTransport(readTranscript(ctx, opts.replay), opts.replay);
	}
	return sshTransport(ctx.runner, target);
}

function readTranscript(ctx: Context, path: string): Transcript {
	if (!ctx.files.exists(path)) throw new UsageError(`no transcript at ${path}`);
	try {
		return JSON.parse(ctx.files.readText(path)) as Transcript;
	} catch (e) {
		throw new UsageError(`${path} is not a transcript: ${e instanceof Error ? e.message : e}`);
	}
}

function renderSurvey(survey: SiteSurvey, out?: string): string[] {
	const lines = kv([
		['host', survey.host],
		['root', survey.root],
		['php', survey.php.version ?? 'unknown'],
		[
			'extensions',
			survey.php.extensions.length === 0 ? 'unknown' : String(survey.php.extensions.length)
		],
		['drush', survey.drush ?? 'absent'],
		['drupal', survey.drupal.version ?? 'unknown'],
		['profile', survey.drupal.profile ?? 'unknown'],
		['database', `${survey.database.driver ?? 'unknown'} ${survey.database.name ?? ''}`.trim()],
		['db bytes', survey.database.bytes === null ? 'unknown' : String(survey.database.bytes)],
		['files kb', survey.files.kb === null ? 'unknown' : String(survey.files.kb)],
		['files', survey.files.count === null ? 'unknown' : String(survey.files.count)],
		['modules', String(survey.modules.length)],
		['nodes', survey.nodes === null ? 'unknown' : String(survey.nodes)],
		['image styles', survey.imageStyles === null ? 'unknown' : String(survey.imageStyles)]
	]);
	if (survey.errors.length > 0) {
		lines.push('', 'errors');
		for (const error of survey.errors) lines.push(`  ${error.id}: ${error.detail}`);
	}
	if (out !== undefined) lines.push('', `written to ${out}`);
	return lines;
}

export interface PlanOptions {
	survey?: string;
	to: string;
	/** state the destination's PHP version instead of assuming it */
	targetPhp?: string;
	/** a deployment to read the PHP version from; only works where /php is reachable */
	site?: string;
	json?: boolean;
}

/** `workers` and `vps` on the command line; the rule set names the directions the other way round. */
export function parseDirection(to: string): Direction {
	if (to === 'workers' || to === 'worker' || to === 'to-worker') return 'to-worker';
	if (to === 'vps' || to === 'to-vps') return 'to-vps';
	throw new UsageError(`--to must be \`workers\` or \`vps\`, not \`${to}\``);
}

/**
 * Scores a survey and prints the ordered plan.
 *
 * Exits 3 when a blocker is present, so a pipeline can gate on it without parsing the report; exit 1
 * would mean the check itself failed, which is a different thing to act on.
 */
export async function runPlanCommand(ctx: Context, opts: PlanOptions): Promise<void> {
	const direction = parseDirection(opts.to);
	const survey =
		opts.survey === undefined
			? emptySurvey('<host>', '<drupal-root>')
			: (JSON.parse(readOrFail(ctx, opts.survey)) as SiteSurvey);
	const plan = buildPlan(survey, direction, await resolveTarget(ctx, opts));

	emit(ctx.io, opts.json === true, plan, () => renderPlan(plan));

	if (plan.counts.blocker > 0) {
		throw new FindingError(
			'blockers',
			`${plan.counts.blocker} blocker(s) in the ${direction} plan`
		);
	}
}

/**
 * What the destination runs: stated, then probed, then the labelled fallback.
 *
 * A probe that fails is NOT an error. `/php` is diagnostic-gated, so being unable to read it is the
 * normal case on a correctly configured deployment; the plan falls back and says so rather than
 * refusing to run.
 */
export async function resolveTarget(ctx: Context, opts: PlanOptions): Promise<TargetRuntime> {
	if (opts.targetPhp !== undefined) return statedTarget(opts.targetPhp);
	if (opts.site !== undefined) {
		const probed = await probeTargetPhp(ctx.fetch, opts.site);
		if (probed !== null) return probed;
		return assumedTarget();
	}
	return assumedTarget();
}

function readOrFail(ctx: Context, path: string): string {
	if (!ctx.files.exists(path)) throw new UsageError(`no such file: ${path}`);
	return ctx.files.readText(path);
}

export interface ExportOptions {
	url: string;
	site?: string;
	out?: string;
	all?: boolean;
	json?: boolean;
	/** the per-site owner token `/firstrun` returns once as `ownerToken` */
	token?: string;
}

interface ExportBody {
	statements?: number;
	chars?: number;
	tables?: Record<string, number>;
	sql?: string;
	/** the table names the worker resolved as structure-only, so drangler reads them rather than restating the rule */
	structureOnly?: string[];
	/** the widest statement in the dump, against the 100,000-character Durable Object ceiling */
	maxStatementChars?: number;
	/** the worker's own verdict on whether this dump can be replayed back into an object */
	replayable?: boolean;
}

/**
 * Pulls a deployed site's database out through `/export`.
 *
 * The off-boarding half, and it no longer costs a diagnostic deploy. `/export` sits on the OWNER
 * tier: a per-site bearer token, minted by `/firstrun` and returned once as `ownerToken`. An
 * unauthenticated request answers **401 with a `WWW-Authenticate: Bearer` challenge**, which is a
 * different fact from a missing route and is reported as one -- a user whose token is merely absent
 * should not be told to redeploy the site with every diagnostic route open.
 *
 * `/restore` and `/sql` are unchanged and still diagnostic-only, which is why there is no import
 * counterpart to this command.
 */
export async function runExportCommand(ctx: Context, opts: ExportOptions): Promise<void> {
	const url = new URL('/export', opts.url.startsWith('http') ? opts.url : `https://${opts.url}`);
	url.searchParams.set('body', '1');
	url.searchParams.set('site', opts.site ?? 'site');
	if (opts.all === true) url.searchParams.set('all', '1');

	const token = opts.token ?? ctx.env.DRUPFLARE_OWNER_TOKEN ?? '';
	const response = await ctx.fetch(url.toString(), {
		headers: token === '' ? {} : { authorization: `Bearer ${token}` }
	});

	if (response.status === 401) {
		const challenge = response.headers.get('www-authenticate') ?? '';
		throw new DranglerError(
			'export-unauthorized',
			token === ''
				? `${url.origin}/export needs the site owner token${challenge === '' ? '' : ` (${challenge})`}. It is minted per site and returned once by /firstrun as \`ownerToken\`; pass it with --token or set DRUPFLARE_OWNER_TOKEN`
				: `${url.origin}/export rejected the owner token supplied. It is per SITE, so check --site matches the site the token was minted for`
		);
	}
	if (response.status === 404) {
		throw new DranglerError(
			'export-missing',
			`${url.origin}/export answered 404. The route is not diagnostic-gated any more, so this is a worker too old to have the owner tier rather than one with diagnostics closed`
		);
	}
	// the worker refuses a dump it knows will not replay rather than handing over one that looks fine
	if (response.status === 409) {
		const detail = await response.text();
		throw new DranglerError(
			'export-unreplayable',
			`${url.origin}/export refused: a statement exceeds the ${DO_STATEMENT_CHARS.toLocaleString('en-US')}-character Durable Object ceiling, so the dump could not be replayed back. ${detail.trim().slice(0, 300)}`
		);
	}
	if (!response.ok) {
		throw new DranglerError(
			'export-failed',
			`${url.origin}/export answered ${response.status}`
		);
	}
	const body = (await response.json()) as ExportBody;
	if (typeof body.sql !== 'string') {
		throw new DranglerError(
			'export-failed',
			'/export returned no `sql` field; ask for ?body=1'
		);
	}
	if (opts.out !== undefined) ctx.files.writeText(opts.out, body.sql);

	const tables = Object.entries(body.tables ?? {});
	emit(
		ctx.io,
		opts.json === true,
		{
			statements: body.statements,
			chars: body.chars,
			tables: body.tables,
			structureOnly: body.structureOnly ?? null,
			maxStatementChars: body.maxStatementChars ?? null,
			replayable: body.replayable ?? null,
			out: opts.out ?? null
		},
		() => {
			const lines = kv([
				['statements', String(body.statements ?? 0)],
				['characters', String(body.chars ?? body.sql?.length ?? 0)],
				['tables', String(tables.length)],
				['rows', String(tables.reduce((sum, [, n]) => sum + n, 0))],
				[
					'widest statement',
					body.maxStatementChars === undefined
						? 'not reported'
						: `${body.maxStatementChars.toLocaleString('en-US')} of ${DO_STATEMENT_CHARS.toLocaleString('en-US')}`
				],
				[
					'replayable',
					body.replayable === undefined ? 'not reported' : body.replayable ? 'yes' : 'NO'
				],
				['written to', opts.out ?? '(not written; pass --out)']
			]);
			// read off the envelope rather than restated here; the worker owns which tables these are
			if (body.structureOnly !== undefined) {
				lines.push('', `structure only (${body.structureOnly.length})`);
				lines.push(`  ${body.structureOnly.join(', ')}`);
				lines.push(
					'  these carry schema and no rows; they regenerate on the restored site'
				);
			} else {
				lines.push(
					'',
					'the envelope did not report `structureOnly`, so which tables came back empty is unknown;',
					'this worker predates that field'
				);
			}
			return lines;
		}
	);

	if (body.replayable === false) {
		throw new FindingError(
			'unreplayable',
			'the worker reports this dump cannot be replayed back into a Durable Object'
		);
	}
}

export interface ConvertCommandOptions {
	in: string;
	out?: string;
	from: string;
	to: string;
	skipUnsupported?: boolean;
	splitRows?: boolean;
	maxStatementChars?: number;
	json?: boolean;
}

function parseDialect(value: string): Dialect {
	if (value === 'mysql' || value === 'mariadb') return 'mysql';
	if (value === 'sqlite') return 'sqlite';
	throw new UsageError(`unknown dialect \`${value}\`; expected mysql or sqlite`);
}

/** Converts a dump between the dialects the two hosting shapes use. */
export async function runConvertCommand(ctx: Context, opts: ConvertCommandOptions): Promise<void> {
	const from = parseDialect(opts.from);
	const to = parseDialect(opts.to);
	const input = readOrFail(ctx, opts.in);
	const result = convertDump(input, {
		from,
		to,
		...(opts.splitRows === undefined ? {} : { splitRows: opts.splitRows }),
		...(opts.skipUnsupported === undefined ? {} : { skipUnsupported: opts.skipUnsupported }),
		...(opts.maxStatementChars === undefined
			? {}
			: { maxStatementChars: opts.maxStatementChars })
	});

	if (opts.out !== undefined) ctx.files.writeText(opts.out, result.sql);

	const { sql: _sql, ...summary } = result;
	emit(ctx.io, opts.json === true, { ...summary, out: opts.out ?? null }, () => {
		const lines = kv([
			['from', from],
			['to', to],
			['statements', String(result.statements)],
			['tables', String(result.tables.length)],
			['indexes', String(result.indexes)],
			['rows', String(result.rows)],
			['skipped', String(result.skipped.length)],
			[
				'widest statement',
				`${result.maxStatementChars.toLocaleString('en-US')}` +
					(to === 'sqlite' ? ` of ${DO_STATEMENT_CHARS.toLocaleString('en-US')}` : '')
			],
			['written to', opts.out ?? '(not written; pass --out)']
		]);
		if (result.overLimit.length > 0) {
			lines.push('', 'rows too wide for the target');
			for (const hit of result.overLimit) {
				lines.push(
					`  ${hit.table}: ${hit.rows} row(s), widest ${hit.widest.toLocaleString('en-US')} characters`
				);
			}
			lines.push('  their schema is still emitted; only the rows were dropped');
		}
		if (result.lossy.length > 0) {
			lines.push('', 'lossy');
			for (const note of result.lossy) lines.push(`  - ${note}`);
		}
		if (result.skipped.length > 0) {
			lines.push('', 'skipped');
			for (const skip of result.skipped) lines.push(`  - ${skip.reason}: ${skip.preview}`);
		}
		return lines;
	});

	if (result.skipped.length > 0) {
		throw new FindingError(
			'skipped',
			`${result.skipped.length} statement(s) were not converted`
		);
	}
}
