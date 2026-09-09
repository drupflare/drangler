import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { DranglerError, FindingError, UsageError } from '../errors';
import { emit, bytes as humanBytes, kv, table } from '../format';
import {
	DEFAULT_CHECKPOINT,
	digestOf,
	emptyCheckpoint,
	notePhase,
	readCheckpoint,
	writeCheckpoint
} from '../migrate/checkpoint';
import { convertDump, DO_STATEMENT_CHARS, type Dialect } from '../migrate/convert';
import { deltaPlan } from '../migrate/delta';
import { recoverFiles, writeRecovered } from '../migrate/files';
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
import { inWorkspace } from '../workspace/artifacts';
import {
	applyCopy,
	planCopy,
	restoreBackup,
	type CopyEntry,
	type CopyPlan
} from '../workspace/copy';
import { assertUsable, readState, resolveWorkspace, WORKER_PACKAGE } from '../workspace/layout';

export interface SurveyOptions {
	/** re-run only the steps that have neither a value nor a recorded error */
	resume?: boolean;
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

	// a resume reads the survey it is continuing, so the steps that already answered are skipped
	const before =
		opts.resume === true && opts.out !== undefined && ctx.files.exists(opts.out)
			? (JSON.parse(ctx.files.readText(opts.out)) as SiteSurvey)
			: null;
	const survey = await runSurvey({ transport, now: ctx.now }, opts.host, target.root, before);
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
	/** the deployed worker origin; resolved from `--site` or the config when the flag is absent */
	url?: string;
	site?: string;
	out?: string;
	all?: boolean;
	json?: boolean;
	/** the per-site owner token `/firstrun` returns once as `ownerToken` */
	token?: string;
	/** pull the dump in chunks through `?cursor=`, so a dropped connection loses one chunk */
	chunked?: boolean;
	/** continue from the cursor a previous run recorded */
	resume?: boolean;
	/** where that cursor is recorded; defaults to `.drangler/migration.json` */
	checkpoint?: string;
	/** characters per chunk, passed through as `?chunkChars=` */
	chunkChars?: string | number;
}

/** one chunk of a cursored dump, and the cursor that follows it */
interface ExportChunk extends ExportBody {
	ok?: boolean;
	done?: boolean;
	/** opaque; it goes back to the route verbatim */
	nextCursor?: string | null;
	cursor?: unknown;
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
	if (opts.url === undefined || opts.url.trim() === '') {
		throw new UsageError(
			'no site to export from; pass --url, --site, or put a site in a drangler.json'
		);
	}
	const url = new URL('/export', opts.url.startsWith('http') ? opts.url : `https://${opts.url}`);
	url.searchParams.set('body', '1');
	url.searchParams.set('site', opts.site ?? 'site');
	if (opts.all === true) url.searchParams.set('all', '1');

	const token = opts.token ?? ctx.env.DRUPFLARE_OWNER_TOKEN ?? '';
	if (opts.chunked === true || opts.resume === true) {
		await exportChunked(ctx, opts, url, token);
		return;
	}
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

/** where a migrated site database lands in a workspace, which is what `bun run assets:sql` reads */
export const SITE_DB_PATH = 'assets/drupal/site.sqlite';

export interface InstallOptions {
	workspace?: string;
	/** a SQLite database file, not a SQL dump; `migrate convert` produces the dump that builds one */
	db?: string;
	/** repeated `<from>=<workspace-relative to>` pairs */
	asset?: string[];
	/** run `bun run assets:sql` afterwards, which is what makes a landed database ship */
	repack?: boolean;
	/** report the backup set an earlier run took rather than refusing over it */
	resume?: boolean;
	/** where the migration checkpoint lives */
	checkpoint?: string;
	globals: GlobalOptions;
}

/** `<from>=<to>`, where `to` is workspace-relative and may not climb out of the workspace */
export function parseAssetPair(pair: string, workspace: string): CopyEntry {
	const at = pair.indexOf('=');
	if (at <= 0 || at === pair.length - 1) {
		throw new UsageError(`--asset wants \`<from>=<to>\`, not \`${pair}\``);
	}
	const from = pair.slice(0, at);
	const to = pair.slice(at + 1);
	if (to.startsWith('/') || to.split('/').includes('..')) {
		throw new UsageError(
			`--asset destination \`${to}\` must be a path inside the workspace; drangler will not ` +
				'write outside it'
		);
	}
	return { from, to: inWorkspace(workspace, to) };
}

/**
 * Lands migrated bytes in a workspace, backing up anything it would overwrite.
 *
 * The last mile of an on-boarding migration, and until now it was the one step the user did by hand:
 * `migrate convert` wrote a dump and then stopped. Everything here goes through one primitive that
 * takes every backup first, verifies each one by digest, and only then writes -- so a failure part
 * way leaves either the original tree or a complete backup of it, never half of each.
 *
 * **A database is not the same thing as a dump.** `--db` takes a SQLite FILE; a converted dump
 * becomes one with `sqlite3 site.sqlite < dump.sql`, and that step is printed rather than run,
 * because replaying somebody's dump is a decision with a different blast radius from copying a file.
 */
export async function runInstallCommand(ctx: Context, opts: InstallOptions): Promise<void> {
	const location = resolveWorkspace(ctx, opts, opts.globals.config);
	const state = readState(ctx.files, location.path);
	assertUsable(state);
	if (!state.checkout) {
		throw new UsageError(
			`${location.path} is not a ${WORKER_PACKAGE} checkout; run drangler build first`
		);
	}

	const entries: CopyEntry[] = [
		...(opts.db === undefined
			? []
			: [{ from: opts.db, to: inWorkspace(location.path, SITE_DB_PATH) }]),
		...(opts.asset ?? []).map((pair) => parseAssetPair(pair, location.path))
	];
	if (entries.length === 0) {
		throw new UsageError('nothing to install; pass --db and/or --asset <from>=<to>');
	}

	const plan = planCopy(ctx.files, entries);
	if (opts.globals.dryRun) {
		emit(ctx.io, opts.globals.json, { workspace: location.path, plan, applied: null }, () =>
			renderInstall(location.path, plan, null)
		);
		return;
	}

	// A SECOND BACKUP OVER THE FIRST IS THE ONE THAT LOSES THE ORIGINAL. A re-run after a partial
	// install would copy what the first run already wrote, so the set that could put the site back
	// is the one from the first run and nothing else
	const checkpointPath = opts.checkpoint ?? DEFAULT_CHECKPOINT;
	const existing =
		readCheckpoint(ctx.files, checkpointPath)?.phases['install']?.backupDir ?? null;
	if (existing !== null && ctx.files.exists(existing)) {
		if (opts.resume !== true) {
			throw new UsageError(
				`${existing} already holds a backup set from an earlier install; a second one would copy what that run wrote and lose the originals`,
				`drangler migrate install --resume, or drangler migrate restore --backup ${existing}`
			);
		}
		ctx.io.err(`resuming; the backup set from the first run is at ${existing}`);
	}

	const result = applyCopy(ctx.files, plan, location.path, ctx.now());
	if (result.backupDir !== null) {
		const base =
			readCheckpoint(ctx.files, checkpointPath) ??
			emptyCheckpoint('', 'to-worker', ctx.now().toISOString());
		writeCheckpoint(
			ctx.files,
			checkpointPath,
			notePhase(base, 'install', {
				state: 'done',
				backupDir: existing ?? result.backupDir
			})
		);
	}
	// not conditioned on --db: an --asset can land a database too, and a silently ignored flag is worse
	if (opts.repack === true) {
		ctx.io.out(`${location.path}$ bun run assets:sql`);
		const code = await ctx.runner.spawn('bun', ['run', 'assets:sql'], {
			cwd: location.path,
			timeoutMs: 30 * 60_000
		});
		if (code !== 0) {
			throw new DranglerError(
				'repack',
				`bun run assets:sql exited ${code}; the database is installed and the chunks the ` +
					`worker replays are stale. The backup is at ${result.backupDir ?? '(none taken)'}`
			);
		}
	}

	emit(ctx.io, opts.globals.json, { workspace: location.path, plan, applied: result }, () =>
		renderInstall(location.path, plan, result)
	);
}

function renderInstall(
	workspace: string,
	plan: CopyPlan,
	applied: ReturnType<typeof applyCopy> | null
): string[] {
	const lines = [
		...kv([
			['workspace', workspace],
			['files', String(plan.items.length)],
			['backups needed', String(plan.backups)]
		]),
		'',
		...table(
			['action', 'size', 'destination'],
			plan.items.map((i) => [i.verdict, humanBytes(i.bytes), i.to])
		)
	];
	if (applied === null) {
		lines.push('', 'dry run; nothing was written');
		return lines;
	}
	lines.push(
		'',
		applied.backupDir === null
			? 'nothing was overwritten, so no backup was taken'
			: `${applied.backedUp.length} file(s) backed up to ${applied.backupDir}`
	);
	if (applied.backupDir !== null) {
		lines.push(`  put them back with: drangler migrate restore --backup ${applied.backupDir}`);
	}
	const db = plan.items.find((i) => i.to.endsWith(SITE_DB_PATH));
	if (db !== undefined && db.verdict !== 'identical') {
		lines.push(
			'',
			'the database is in place and the chunks the worker replays are not; regenerate them:',
			`  cd ${workspace} && bun run assets:sql`
		);
	}
	return lines;
}

export interface RestoreOptions {
	backup: string;
	json?: boolean;
}

/**
 * Puts a backup set back.
 *
 * A backup nothing can restore is a filing cabinet, so this is not optional scope. Every recorded
 * digest is verified before the first write, for the same reason the backups are taken before the
 * first write.
 */
export async function runRestoreCommand(ctx: Context, opts: RestoreOptions): Promise<void> {
	const entries = restoreBackup(ctx.files, opts.backup);
	emit(ctx.io, opts.json === true, { backup: opts.backup, restored: entries }, () => [
		...table(
			['size', 'restored to'],
			entries.map((e) => [humanBytes(e.bytes), e.path])
		),
		'',
		`${entries.length} file(s) restored from ${opts.backup}`
	]);
}

/**
 * Pulls the dump one chunk at a time, so a dropped connection loses a chunk rather than the dump.
 *
 * The mechanism is the worker's and it was already there: `/export?cursor=` walks a `DumpCursor` and
 * the route answers 409 on a shape mismatch, because "two different dumps are being spliced"
 * produces a file that looks whole and is not. A single unbounded `?body=1` held the whole thing in
 * memory and had no way back from a failure part-way.
 *
 * The terminating observation is THE CURSOR ADVANCING, not a chunk count. A chunk that comes back
 * with the cursor it was given will come back that way every time, so it is `export-stalled` rather
 * than a loop that spends its bound.
 */
async function exportChunked(
	ctx: Context,
	opts: ExportOptions,
	url: URL,
	token: string
): Promise<void> {
	const path = opts.checkpoint ?? DEFAULT_CHECKPOINT;
	const checkpoint = opts.resume === true ? readCheckpoint(ctx.files, path) : null;
	if (opts.resume === true && checkpoint === null) {
		throw new UsageError(`no checkpoint at ${path}, so there is nothing to resume`);
	}
	let cursor = (opts.resume === true ? checkpoint?.phases['export']?.cursor : null) ?? 'start';
	const parts: string[] = [];
	let chunks = 0;
	let statements = 0;
	let last: ExportChunk = {};

	for (;;) {
		const chunkUrl = new URL(url.toString());
		chunkUrl.searchParams.set('cursor', cursor);
		if (opts.chunkChars !== undefined) {
			chunkUrl.searchParams.set('chunkChars', String(opts.chunkChars));
		}
		const response = await ctx.fetch(chunkUrl.toString(), {
			headers: token === '' ? {} : { authorization: `Bearer ${token}` }
		});
		// the route's own refusal: the options behind this cursor are not the options it was
		// created under, and continuing would splice two dumps
		if (response.status === 409) {
			throw new DranglerError(
				'export-torn',
				`${url.origin}/export refused to continue this cursor: ${(await response.text()).trim().slice(0, 300)}`,
				{ next: 'drangler migrate export --chunked, from the start' }
			);
		}
		if (!response.ok && response.status !== 200) {
			throw new DranglerError(
				'export-failed',
				`${url.origin}/export answered ${response.status} on chunk ${chunks + 1}`
			);
		}
		const chunk = (await response.json()) as ExportChunk;
		if (typeof chunk.sql !== 'string') {
			throw new DranglerError('export-failed', 'a chunk carried no `sql`; ask for ?body=1');
		}
		parts.push(chunk.sql);
		statements += chunk.statements ?? 0;
		chunks++;
		last = chunk;

		if (chunk.done === true || chunk.nextCursor === null || chunk.nextCursor === undefined) {
			break;
		}
		if (chunk.nextCursor === cursor) {
			await recordCursor(ctx, path, opts, cursor);
			throw new DranglerError(
				'export-stalled',
				`chunk ${chunks} came back with the cursor it was given, so the dump is not advancing`
			);
		}
		cursor = chunk.nextCursor;
		ctx.io.err(`chunk ${chunks}, ${statements} statement(s)`);
		await recordCursor(ctx, path, opts, cursor);
	}

	const sql = parts.join('');
	if (opts.out !== undefined) ctx.files.writeText(opts.out, sql);
	await recordCursor(ctx, path, opts, null);

	emit(
		ctx.io,
		opts.json === true,
		{
			chunks,
			statements,
			chars: sql.length,
			tables: last.tables ?? null,
			structureOnly: last.structureOnly ?? null,
			replayable: last.replayable ?? null,
			resumed: opts.resume === true,
			out: opts.out ?? null
		},
		() =>
			kv([
				['chunks', String(chunks)],
				['statements', String(statements)],
				['characters', String(sql.length)],
				['resumed', opts.resume === true ? 'yes' : 'no'],
				['written to', opts.out ?? '(not written; pass --out)']
			])
	);
}

/** keeps the cursor where a resume will find it; a null cursor marks the phase done */
async function recordCursor(
	ctx: Context,
	path: string,
	opts: ExportOptions,
	cursor: string | null
): Promise<void> {
	const existing = readCheckpoint(ctx.files, path);
	const base = existing ?? emptyCheckpoint('', 'to-vps', ctx.now().toISOString());
	writeCheckpoint(
		ctx.files,
		path,
		notePhase(base, 'export', {
			state: cursor === null ? 'done' : 'partial',
			artifact: opts.out ?? null,
			cursor,
			...(cursor === null && opts.out !== undefined
				? { sha256: await digestOf(ctx.files, opts.out) }
				: {})
		})
	);
}

export interface DeltaOptions {
	/** a survey, so contrib entity tables reach the set through the patterns */
	survey?: string;
	globals: GlobalOptions;
}

/**
 * The second dump's table set, and the one arithmetic step in the whole procedure.
 *
 * Prints; it runs nothing. The delta reaches the site through a deploy, exactly as the first pass
 * does, because the alternative is a route that applies arbitrary SQL to a live object and that is
 * `/restore` with a smaller blast radius and the same shape.
 */
export function runDeltaCommand(ctx: Context, opts: DeltaOptions): void {
	const discovered =
		opts.survey === undefined || !ctx.files.exists(opts.survey)
			? []
			: tablesFromSurvey(ctx, opts.survey);
	const plan = deltaPlan(discovered);
	emit(ctx.io, opts.globals.json, plan, () => [
		...kv([
			['tables', String(plan.tables.length)],
			['excluded', String(plan.excluded.length)],
			['re-seed', plan.reseed]
		]),
		'',
		'tables',
		`  ${plan.tables.join(', ')}`,
		'',
		'left behind on purpose',
		...plan.excluded.map((e) => `  ${e.table}: ${e.why}`),
		'',
		'steps',
		...plan.steps.flatMap((step) => [
			`  ${step.n}. ${step.title}`,
			...(step.command === null ? [] : [`     $ ${step.command}`]),
			`     ${step.detail}`
		])
	]);
}

/** the entity tables a survey happened to record, so contrib storage reaches the pattern set */
function tablesFromSurvey(ctx: Context, path: string): string[] {
	try {
		const survey = JSON.parse(ctx.files.readText(path)) as { tables?: string[] };
		return Array.isArray(survey.tables) ? survey.tables : [];
	} catch {
		return [];
	}
}

export interface CutoverOptions {
	checklist?: boolean;
	globals: GlobalOptions;
}

/**
 * The steps a human confirms, and the three things no mechanism catches.
 *
 * **It never ticks itself.** A checklist that reports its own items done is a checklist nobody
 * reads, and every item below is something only the person doing the cutover can observe.
 */
export function runCutoverCommand(ctx: Context, opts: CutoverOptions): void {
	const plan = deltaPlan();
	const unsafe = [
		{
			id: 'writes-after-the-last-read',
			detail: 'writes the source accepted between the last dump read and maintenance mode. There is no mechanism that catches them; the window exists to make the set empty'
		},
		{
			id: 'a-visitor-mid-form',
			detail: "their form_build_id was minted against the source's hash_salt and the target mints its own, so the POST fails. Maintenance mode makes that a maintenance page rather than a silent token rejection, which is why the window starts with it"
		},
		{
			id: 'cron-part-way',
			detail: 'a queue item claimed and not released is claimed on the source forever and absent from the target'
		}
	];
	const report = { steps: plan.steps, unsafe, verdict: null };
	emit(ctx.io, opts.globals.json, report, () => [
		'cutover checklist -- nothing here is ticked by drangler',
		'',
		...plan.steps.flatMap((step) => [
			`  [ ] ${step.n}. ${step.title}`,
			...(step.command === null ? [] : [`         $ ${step.command}`]),
			`         ${step.detail}`
		]),
		'',
		'what no mechanism catches',
		...unsafe.flatMap((row) => [`  ${row.id}`, `    ${row.detail}`]),
		'',
		'there is no done verdict for any of these; a checklist that ticks itself is one nobody reads'
	]);
}

export interface FilesOptions {
	/** the dump to read `cfw_file_chunk` rows out of */
	fromDump?: string;
	/** where the tree lands */
	out?: string;
	globals: GlobalOptions;
}

/**
 * Writes the managed files in a dump back onto a filesystem.
 *
 * The step `export-files` names as missing. The bytes leave in `cfw_file_chunk` and nothing turned
 * them back into a tree, so a user who acted on the old warning arrived at a VPS with every upload
 * gone.
 */
export function runFilesCommand(ctx: Context, opts: FilesOptions): void {
	if (opts.fromDump === undefined) {
		throw new UsageError(
			'pass --from-dump <file>, a dump written by `drangler migrate export`'
		);
	}
	if (!ctx.files.exists(opts.fromDump)) throw new UsageError(`no dump at ${opts.fromDump}`);
	const report = recoverFiles(ctx.files.readText(opts.fromDump));

	const written =
		opts.out === undefined || opts.globals.dryRun
			? { written: [], bytes: 0 }
			: writeRecovered(ctx.files, opts.out, report);

	emit(
		ctx.io,
		opts.globals.json,
		{
			files: report.files.map((f) => ({ uri: f.uri, path: f.path, bytes: f.bytes.length })),
			incomplete: report.incomplete,
			totalBytes: report.totalBytes,
			written: written.written,
			out: opts.out ?? null
		},
		() => {
			const lines = kv([
				['files', String(report.files.length)],
				['bytes', String(report.totalBytes)],
				['written', opts.out === undefined ? '(not written; pass --out)' : opts.out]
			]);
			if (report.incomplete.length > 0) {
				lines.push('', 'incomplete');
				for (const row of report.incomplete) {
					lines.push(
						`  ${row.uri}: ${row.have} of ${row.expected} chunk(s); this dump is truncated`
					);
				}
			}
			return lines;
		}
	);

	if (report.incomplete.length > 0) {
		throw new FindingError(
			'files-incomplete',
			`${report.incomplete.length} file(s) have missing chunks, so this dump is truncated`
		);
	}
}
