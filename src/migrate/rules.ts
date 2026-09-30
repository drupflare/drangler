import { sourceFindings } from '../health/source';
import { DO_STATEMENT_CHARS } from './convert';
import {
	declaredExtensions,
	EXTENSION_CALLS,
	modulesWithout11,
	scanExtensionCalls,
	type SourceCode
} from './source-code';
import { SUBSTITUTIONS } from './substitutions';
import type { SiteSurvey } from './survey';
import { isOlderThan, SHIPPED_DRUPAL, versionParts, type TargetRuntime } from './target-runtime';

export type Direction = 'to-worker' | 'to-vps';

export type Severity = 'blocker' | 'warning' | 'note';

export interface Finding {
	id: string;
	severity: Severity;
	title: string;
	/** the mechanism, and where it is written down; never a bare assertion */
	detail: string;
	/**
	 * The survey field, envelope key or header this verdict was read from.
	 *
	 * A verdict whose evidence a reader cannot follow back to a byte is the class of claim this
	 * workspace has recorded being wrong about repeatedly, so every rule names its field and
	 * `tests/migrate-plan.spec.ts` fails on one that does not.
	 */
	evidence: string;
}

/**
 * What a real `/export` reply says about the site being left.
 *
 * Every `to-vps` rule used to declare `evaluate()` with no parameters and return a constant, so the
 * off-boarding direction was five fixed paragraphs rather than a measurement. Null means the
 * envelope was not read, which is an UNMEASURED criterion rather than a pass.
 */
export interface ExportEnvelope {
	/** the status `/export` answered, which is the reachability criterion on its own */
	status: number;
	replayable?: boolean;
	maxStatementChars?: number;
	/** table name to row count */
	tables?: Record<string, number>;
	/** the tables the worker resolved as carrying schema and no rows */
	structureOnly?: string[];
	/** whether `?secrets=1` was asked for, which decides what the dump is safe to store */
	secrets?: boolean;
}

export interface Rule {
	id: string;
	direction: Direction | 'both';
	/**
	 * null when the rule does not apply to this survey.
	 *
	 * `target` is what the DESTINATION runs, with its provenance. Passed in rather than read from a
	 * constant so a rule cannot assert a version as fact, and so the same figure drives both the
	 * comparison and the message a user reads.
	 *
	 * `envelope` is what a real `/export` said. A `to-vps` rule that ignores it is scoring a
	 * paragraph rather than a site.
	 *
	 * `source` is the source's own files when a tree was streamed or named. A rule that needs it
	 * returns null without one, so the plan reports nothing about code nobody read.
	 */
	evaluate(
		survey: SiteSurvey,
		target: TargetRuntime,
		envelope?: ExportEnvelope | null,
		source?: SourceCode | null
	): Finding | null;
}

/**
 * The limits for the migration rules.
 *
 * Kept as one table so a rule cannot invent a ceiling, and so a figure that moves is corrected in one
 * place instead of in every message that mentions it.
 */
export const LIMITS = {
	/** Worker requests per day on the free plan; every visit costs one, cached or not */
	visitsPerDay: 100_000,
	/**
	 * Rows written per day on the free plan, inside a fill window.
	 *
	 * This is the meter regeneration is bound by, and it replaces a `rendersPerDayCold: 1_052` and a
	 * `rendersPerDayWindowed: 7_575` that nothing here or in `drupflare/worker` derived. Score a real
	 * workload with `bun scripts/measure/free-envelope.ts` in that repository; the figure is its
	 * windowed row budget.
	 */
	rowsPerDayWindowed: 10_869,
	/**
	 * The same budget on the alarm chain, which is the tighter of the two by 3.9x.
	 *
	 * Same source. A regeneration driven only by the cron alarm is scored against this rather than
	 * against the windowed figure.
	 */
	rowsPerDayAlarmChain: 2_777,
	/** rows one page fill writes with the bins already warm; the low end of a measured range */
	rowsPerFillWarm: 2,
	/**
	 * The high end of that range, with nothing warm.
	 *
	 * `tests/integration/rows-per-fill-audit.spec.ts` in `drupflare/worker` pins each class between
	 * the two. There is no flat figure to quote, so a span is what a plan can honestly print.
	 */
	rowsPerFillCold: 156,
	/** unique Cloudflare Images transformations per MONTH on free; fails as a cap, not a bill */
	imageTransformsPerMonth: 5_000,
	/** one Durable Object SQLite record */
	recordBytes: 2_199_995,
	/** statement text a Durable Object will accept */
	statementChars: 100_000,
	/** bound parameters per statement */
	boundParams: 100,
	/** per-asset ceiling the Drupal pack is built against */
	assetBytes: 25 * 1024 * 1024
} as const;

/** MySQL family, which the bundled converter reads. */
const CONVERTIBLE_DRIVERS = ['mysql', 'mysqli', 'mariadb', 'pdo_mysql'];

/** PostgreSQL, which the bundled converter reads into SQLite from a plain-format pg_dump. */
const POSTGRES_DRIVERS = ['pgsql', 'postgres', 'postgresql', 'pdo_pgsql'];

/**
 * Modules that cannot work on the worker, with the mechanism for each.
 *
 * A named list rather than a heuristic: every entry is refused for a reason that is a property of the
 * runtime, not of the module's quality, and the message says which. Anything whose failure mode is a
 * guess belongs in `SERVICE_MODULES` at warning severity instead.
 */
export const INCOMPATIBLE_MODULES: Record<string, string> = {
	memcache:
		'wants ext-memcached or ext-memcache, which the wasm build does not carry; uninstall it before migrating, since the worker chooses its own cache backends',
	memcache_storage:
		'wants ext-memcached or ext-memcache, which the wasm build does not carry; uninstall it before migrating, since the worker chooses its own cache backends',
	mongodb:
		'stores entities or key-value data in MongoDB through ext-mongodb, which the wasm build does not carry'
};

/**
 * Modules that migrate with a warning, because the worker covers what they do another way.
 *
 * Each entry says what changes on the worker, so the warning is something an operator can act on.
 */
export const HANDLED_MODULES: Record<string, string> = {
	imagemagick:
		'the site is moved to the cfw_images toolkit on its first reconcile, because `convert` cannot run here; image styles are applied at delivery',
	imageapi_optimize_binaries:
		'its processors call exec(), which answers as a failed command and records a degradation, so images are stored unoptimised',
	automatic_updates:
		'it rewrites the codebase with composer, which the worker cannot run; updates arrive through `drangler update` and reconciliation, so disable it before migrating',
	project_browser:
		'it installs modules with composer, which the worker cannot run; modules arrive through `/install` and `drangler modify`, so disable it before migrating'
};

/** the MongoDB submodules that need nothing beyond logging, which dblog replaces */
const MONGODB_LOGGING_ONLY = ['mongodb', 'mongodb_watchdog'];

/**
 * Modules that can run but need something the one-click deploy does not provision.
 *
 * `redis` and `search_api_solr` were both refused here as runtime impossibilities and both are
 * `verified` in `worker/src/ops/module-table.ts`. A refusal keyed on a mechanism the runtime has
 * since acquired still reads to a user as a platform limit, so each entry now says what the site
 * has to supply instead.
 */
export const SERVICE_MODULES: Record<string, string> = {
	redis: 'its blocking socket is answered by the Zend park -- the trapped call freezes the PHP continuation, the host performs the read in JavaScript and resumes it -- so what is missing is a reachable Redis and a `REDIS_URL`, which also arms the trap. The Durable Object own SQLite is the faster cache backend, because a parked get is a network round trip where SQLite is a local read',
	search_api_solr:
		'installs on the long64 build, which satisfies the transitive `php-64bit` constraint that used to abort every request before Drupal booted; a Solr SERVER is still an outbound dependency and no host is provisioned',
	backup_migrate: 'its archive writers want ext-zip or ext-phar, and the wasm build has neither',
	clientside_validation:
		'no runtime obstacle; listed because it pulls a large npm asset set the asset layer must carry'
};

function found(
	id: string,
	severity: Severity,
	title: string,
	detail: string,
	evidence: string
): Finding {
	return { id, severity, title, detail, evidence };
}

/**
 * The rules, in report order.
 *
 * Every rule returns null when the survey does not carry the field it scores, so an unknown is
 * reported as unknown by `plan()` rather than silently passing. A rule that treated a missing value
 * as a pass would make a partial survey look like a clean bill of health.
 */
export const RULES: readonly Rule[] = [
	{
		id: 'db-driver',
		direction: 'to-worker',
		evaluate(survey) {
			const driver = survey.database.driver?.toLowerCase() ?? null;
			if (driver === null) return null;
			if (driver === 'sqlite') {
				return found(
					'db-driver',
					'note',
					'SQLite source database',
					"the worker stores the site in the Durable Object's own SQLite, so no dialect conversion is needed",
					'survey.database.driver'
				);
			}
			if (CONVERTIBLE_DRIVERS.includes(driver)) {
				return found(
					'db-driver',
					'note',
					`${driver} converts to SQLite`,
					'`drangler migrate convert --from mysql --to sqlite` reads a `drush sql:dump`; the worker has no MySQL',
					'survey.database.driver'
				);
			}
			if (POSTGRES_DRIVERS.includes(driver)) {
				return found(
					'db-driver',
					'note',
					`${driver} converts to SQLite`,
					'`drangler migrate convert --from pgsql --to sqlite` reads a plain-format `pg_dump`; the worker has no PostgreSQL',
					'survey.database.driver'
				);
			}
			return found(
				'db-driver',
				'blocker',
				`no converter for ${driver}`,
				'the worker runs Durable Object SQLite only, and drangler converts the MySQL family and PostgreSQL; dump through an intermediate tool first',
				'survey.database.driver'
			);
		}
	},
	{
		id: 'php-version',
		direction: 'to-worker',
		evaluate(survey, target) {
			const version = survey.php.version;
			if (version === null) return null;
			// compared against the SAME figure the message prints. These used to be two separate
			// hardcoded assertions of the same fact, and only the comparison changed the verdict
			if (!isOlderThan(version, target.php)) return null;
			const ships =
				target.source === 'probed'
					? `the worker runs PHP ${target.php}`
					: `the worker is taken to run PHP ${target.php} (${target.source})`;
			return found(
				'php-version',
				'warning',
				`the source runs PHP ${version}`,
				`${ships}, so any code that depends on ${version} behaviour changes underneath it. ${target.note}`,
				'survey.php.version against the target runtime'
			);
		}
	},
	{
		id: 'drupal-version',
		direction: 'to-worker',
		evaluate(survey) {
			const version = survey.drupal.version;
			if (version === null) return null;
			const { major } = versionParts(version);
			const evidence = 'survey.drupal.version against SHIPPED_DRUPAL';
			if (major === 11) {
				if (version === SHIPPED_DRUPAL) return null;
				return found(
					'drupal-version',
					'note',
					`the source is pinned to Drupal ${version}`,
					`the worker ships Drupal ${SHIPPED_DRUPAL}; the drupal/core constraint is rewritten to that version and reported`,
					evidence
				);
			}
			if (major === 10) {
				return found(
					'drupal-version',
					'warning',
					`the source runs Drupal ${version}`,
					`the worker runs Drupal ${SHIPPED_DRUPAL}, so this is a major upgrade on the way in. Its update chain runs the schema updates: \`drangler site updb\` drives it, and \`preview\` runs it after a migrated claim. Every enabled contrib module needs a Drupal 11 release; \`--code\` and \`preview\` name the ones that do not declare one`,
					evidence
				);
			}
			return found(
				'drupal-version',
				'blocker',
				`the source runs Drupal ${version}`,
				major > 11
					? `the worker ships Drupal ${SHIPPED_DRUPAL} and a site cannot move to an older major`
					: `Drupal ${major} is more than one major behind the ${SHIPPED_DRUPAL} the worker ships; upgrade the source to Drupal 10 first, then migrate`,
				evidence
			);
		}
	},
	{
		id: 'module-core-compat',
		direction: 'to-worker',
		evaluate(survey, _target, _envelope, source) {
			if (source === null || source === undefined) return null;
			if (versionParts(survey.drupal.version ?? '0').major !== 10) return null;
			const hits = modulesWithout11(survey.modules, source.files);
			if (hits.length === 0) return null;
			return found(
				'module-core-compat',
				'warning',
				`${hits.length} enabled module(s) do not declare Drupal 11 support`,
				`${hits.map((m) => `${m.name} (${m.requirement === null ? 'no core_version_requirement' : `core_version_requirement ${m.requirement}`})`).join('; ')}. Each needs a release with \`^11\` in its .info.yml before the worker can enable it`,
				'core_version_requirement in the code tree against survey.modules'
			);
		}
	},
	{
		id: 'ext-archive',
		direction: 'to-worker',
		evaluate(survey) {
			const present = survey.php.extensions.filter((e) => e === 'zip' || e === 'Phar');
			if (present.length === 0) return null;
			if (!present.includes('Phar')) {
				return found(
					'ext-archive',
					'note',
					'the source loads zip',
					'`ZipArchive` is served by a stand-in the driver installs, which reads and writes archives; ext-zip itself is not in the build',
					'survey.php.extensions'
				);
			}
			return found(
				'ext-archive',
				'warning',
				`the source loads ${present.join(' and ')}`,
				'the wasm interpreter has no ext-phar, so code that opens a Phar must move to a host-side path; `ZipArchive` is served by a stand-in',
				'survey.php.extensions'
			);
		}
	},
	{
		id: 'extensions-called',
		direction: 'to-worker',
		evaluate(_survey, _target, _envelope, source) {
			if (source === null || source === undefined) return null;
			const declared = declaredExtensions(source.files, source.lock);
			const calls = scanExtensionCalls(source.files);
			const lines: string[] = [];
			let severity: Severity = 'warning';
			for (const [ext, sites] of Object.entries(calls)) {
				const hard =
					declared.some((d) => d.extension === ext) && sites.some((s) => !s.guarded);
				if (hard) severity = 'blocker';
				const shown = sites
					.slice(0, 5)
					.map((s) => `${s.path}:${s.line}${s.guarded ? ' (guarded)' : ''}`);
				const more = sites.length > 5 ? ` and ${sites.length - 5} more` : '';
				const build =
					EXTENSION_CALLS[ext]!.build === 'partial'
						? 'the build has stand-ins for part of it'
						: 'the wasm build does not carry it';
				lines.push(`ext-${ext}, ${build}: ${shown.join(', ')}${more}`);
			}
			if (lines.length === 0) return null;
			return found(
				'extensions-called',
				severity,
				`${lines.length} extension(s) are called that the worker does not carry`,
				`${lines.join('; ')}. A call that is declared in composer and not guarded blocks; an undeclared or guarded one warns, since the code may have a fallback`,
				'call sites in the code tree, matched by function and class name'
			);
		}
	},
	{
		id: 'extensions-declared',
		direction: 'to-worker',
		evaluate(_survey, _target, _envelope, source) {
			if (source === null || source === undefined) return null;
			const calls = scanExtensionCalls(source.files);
			const idle = declaredExtensions(source.files, source.lock).filter(
				(d) => calls[d.extension] === undefined
			);
			if (idle.length === 0) return null;
			return found(
				'extensions-declared',
				'note',
				`${idle.length} extension requirement(s) are declared and never called`,
				`${idle.map((d) => `ext-${d.extension} by ${d.by}`).join('; ')}. No call site was found in the code tree, so the requirement alone does not stop the move; a call made through a variable or an alias would not be seen`,
				'composer ext-* requirements against call sites in the code tree'
			);
		}
	},
	{
		id: 'settings-memcache',
		direction: 'to-worker',
		evaluate(_survey, _target, _envelope, source) {
			const names = source?.settings?.memcache ?? [];
			if (names.length === 0) return null;
			return found(
				'settings-memcache',
				'note',
				'memcache backends in settings.php are dropped',
				`${names.join(', ')}: the worker chooses its own cache backends, so these are not carried`,
				'the settings.php assignments'
			);
		}
	},
	{
		id: 'settings-redis',
		direction: 'to-worker',
		evaluate(_survey, _target, _envelope, source) {
			const settings = source?.settings;
			if (settings === null || settings === undefined || settings.redisNote === null)
				return null;
			return found(
				'settings-redis',
				settings.redisUrl === null ? 'warning' : 'note',
				settings.redisUrl === null
					? 'redis.connection is not carried'
					: 'redis.connection becomes REDIS_URL',
				`${settings.redisNote}. The value is written to the workspace .dev.vars and, on deploy, through \`wrangler secret bulk\`; it is not printed`,
				"the $settings['redis.connection'] assignments"
			);
		}
	},
	{
		id: 'settings-s3',
		direction: 'to-worker',
		evaluate(_survey, _target, _envelope, source) {
			const names = source?.settings?.s3 ?? [];
			if (names.length === 0) return null;
			return found(
				'settings-s3',
				'warning',
				'the source stores files in S3',
				`${names.join(', ')}: an s3:// scheme is not translated. Files move into the drupflare file store or an R2 binding, and the module's settings are set by hand`,
				'the settings.php assignments'
			);
		}
	},
	{
		id: 'incompatible-modules',
		direction: 'to-worker',
		evaluate(survey) {
			const mongo = survey.modules.filter((m) => m === 'mongodb' || m.startsWith('mongodb_'));
			// the logger alone needs MongoDB for logs only, which dblog replaces
			const loggingOnly = mongo.every((m) => MONGODB_LOGGING_ONLY.includes(m));
			const hits = survey.modules.filter(
				(m) => m in INCOMPATIBLE_MODULES && !(m === 'mongodb' && loggingOnly)
			);
			if (hits.length === 0) return null;
			return found(
				'incompatible-modules',
				'blocker',
				`${hits.length} enabled module(s) cannot run on the worker`,
				hits.map((m) => `${m}: ${INCOMPATIBLE_MODULES[m]}`).join('; '),
				'survey.modules against INCOMPATIBLE_MODULES'
			);
		}
	},
	{
		id: 'handled-modules',
		direction: 'to-worker',
		evaluate(survey) {
			const mongo = survey.modules.filter((m) => m === 'mongodb' || m.startsWith('mongodb_'));
			const loggingOnly =
				mongo.includes('mongodb_watchdog') &&
				mongo.every((m) => MONGODB_LOGGING_ONLY.includes(m));
			const hits = survey.modules.filter((m) => m in HANDLED_MODULES);
			const details = hits.map((m) => `${m}: ${HANDLED_MODULES[m]}`);
			if (loggingOnly) {
				details.push(
					'mongodb_watchdog: it logs into MongoDB, which the worker cannot reach; disable it and mongodb before migrating, and dblog or the host logger takes over'
				);
			}
			if (details.length === 0) return null;
			return found(
				'handled-modules',
				'warning',
				`${details.length} enabled module(s) migrate, and the worker covers what they do another way`,
				details.join('; '),
				'survey.modules against HANDLED_MODULES'
			);
		}
	},
	{
		id: 'service-modules',
		direction: 'to-worker',
		evaluate(survey) {
			const hits = survey.modules.filter((m) => m in SERVICE_MODULES);
			if (hits.length === 0) return null;
			return found(
				'service-modules',
				'warning',
				`${hits.length} enabled module(s) need something the deploy does not provision`,
				hits.map((m) => `${m}: ${SERVICE_MODULES[m]}`).join('; '),
				'survey.modules against SERVICE_MODULES'
			);
		}
	},
	{
		id: 'shellout-undetectable',
		direction: 'to-worker',
		evaluate(survey) {
			if (survey.modules.length === 0) return null;
			return found(
				'shellout-undetectable',
				'note',
				'a module calling exec() cannot be detected from a survey',
				`${survey.modules.length} enabled modules were listed by name only; the worker cannot spawn a process, and finding the callers needs a grep of the source tree`,
				'nothing; a survey cannot see an exec() call'
			);
		}
	},
	{
		id: 'image-transforms',
		direction: 'to-worker',
		evaluate(survey) {
			const styles = survey.imageStyles;
			const files = survey.files.count;
			if (styles === null || files === null) return null;
			const worst = styles * files;
			if (worst <= LIMITS.imageTransformsPerMonth) return null;
			return found(
				'image-transforms',
				'warning',
				`up to ${worst.toLocaleString('en-US')} image transformations against a ${LIMITS.imageTransformsPerMonth.toLocaleString('en-US')}/month cap`,
				`${styles} image styles over ${files.toLocaleString('en-US')} files; Cloudflare Images fails this as a hard cap rather than a bill, and neither the serving nor the regeneration ceiling reports it`,
				'survey.imageStyles times survey.files.count'
			);
		}
	},
	{
		id: 'files-payload',
		direction: 'to-worker',
		evaluate(survey) {
			const kb = survey.files.kb;
			if (kb === null) return null;
			if (kb * 1024 <= LIMITS.assetBytes) return null;
			return found(
				'files-payload',
				'warning',
				`public files are ${Math.round((kb * 1024) / 1_048_576)} MiB`,
				`the Drupal pack is built against a ${LIMITS.assetBytes / 1_048_576} MiB per-asset ceiling, so a files directory this size must be mirrored to R2 rather than shipped in the bundle`,
				'survey.files.kb and survey.files.count'
			);
		}
	},
	{
		id: 'database-size',
		direction: 'to-worker',
		evaluate(survey) {
			const bytes = survey.database.bytes;
			if (bytes === null) return null;
			if (bytes < 64 * 1024 * 1024) return null;
			return found(
				'database-size',
				'warning',
				`the source database is ${Math.round(bytes / 1_048_576)} MiB`,
				`a restore replays statement text, and a Durable Object refuses one over ${LIMITS.statementChars.toLocaleString('en-US')} characters or a record over ${LIMITS.recordBytes.toLocaleString('en-US')} bytes; check the widest row before converting`,
				'survey.database.bytes'
			);
		}
	},
	{
		/**
		 * How long a full rebuild takes, printed as a SPAN.
		 *
		 * A rebuild is bound by rows written and one fill writes anywhere from
		 * {@link LIMITS.rowsPerFillWarm} to {@link LIMITS.rowsPerFillCold} rows depending on what is
		 * already warm, so there is no single renders-per-day figure to quote. The two constants this
		 * used to divide by had no derivation anywhere, which is how a plan a user acts on came to
		 * carry an invented ceiling.
		 */
		id: 'regeneration-ceiling',
		direction: 'to-worker',
		evaluate(survey) {
			const nodes = survey.nodes;
			if (nodes === null) return null;
			const best = Math.ceil((nodes * LIMITS.rowsPerFillWarm) / LIMITS.rowsPerDayWindowed);
			const worst = Math.ceil((nodes * LIMITS.rowsPerFillCold) / LIMITS.rowsPerDayWindowed);
			if (worst <= 1) return null;
			const severity: Severity = best > 1 ? 'warning' : 'note';
			return found(
				'regeneration-ceiling',
				severity,
				`rebuilding ${nodes.toLocaleString('en-US')} nodes spans ${best} to ${worst} day(s) on the free plan`,
				`regeneration is bound by rows written rather than by CPU: ${LIMITS.rowsPerDayWindowed.toLocaleString('en-US')} rows/day inside a fill window, and one page fill writes ${LIMITS.rowsPerFillWarm} to ${LIMITS.rowsPerFillCold} rows depending on what is already warm. Score the real workload with \`bun scripts/measure/free-envelope.ts\` in drupflare/worker; a rebuild driven only by the cron alarm is against ${LIMITS.rowsPerDayAlarmChain.toLocaleString('en-US')} rows/day instead`,
				'survey.nodes against LIMITS.rowsPerDayWindowed'
			);
		}
	},
	{
		/**
		 * A survey error is a verdict, and it was not one.
		 *
		 * `runSurvey()` records a failed required step and continues, which is right. Nothing
		 * downstream turned that into a refusal: a source whose `php -v` exited non-zero and one
		 * that simply has no node count produced the same report, and both reached a pass.
		 */
		id: 'source-health',
		direction: 'both',
		evaluate(survey) {
			const findings = sourceFindings(survey);
			const blockers = findings.filter((f) => f.severity === 'blocker');
			if (blockers.length === 0) return null;
			return found(
				'source-health',
				'blocker',
				`${blockers.length} thing(s) are wrong with the source itself`,
				`${blockers.map((f) => `${f.id}: ${f.detail}`).join('; ')}. Nothing measured from this survey is trustworthy until they are fixed; \`drangler doctor --source\` reports the same set with its evidence`,
				'sourceFindings(survey)'
			);
		}
	},
	{
		id: 'drush-absent',
		direction: 'to-worker',
		evaluate(survey) {
			if (survey.drush !== null) return null;
			return found(
				'drush-absent',
				'warning',
				'no drush on the source host',
				'the survey reads the database driver, the module list and the dump through drush; without it every one of those is unknown and the plan is scoring blanks',
				'survey.drush'
			);
		}
	},
	{
		id: 'cron',
		direction: 'to-worker',
		evaluate() {
			return found(
				'cron',
				'note',
				'system cron becomes a Cron Trigger',
				'the worker runs a `*/5 * * * *` trigger that drives the fill window; a crontab entry calling drush has no equivalent and its work has to move into hook_cron or a queue',
				'nothing; the trigger is a property of the destination'
			);
		}
	},
	{
		id: 'export-token',
		direction: 'to-vps',
		evaluate(_survey, _target, envelope) {
			if (envelope === undefined || envelope === null) return null;
			if (envelope.status === 401) {
				return found(
					'export-token',
					'blocker',
					'/export refused the credential it was given',
					'`/export` is in `OWNER_ROUTES` and answers 401 with a `WWW-Authenticate: Bearer` challenge when the token is absent or belongs to another site. The token is minted once by `drangler site claim`, and it is per SITE',
					'the /export status'
				);
			}
			if (envelope.status === 404) {
				return found(
					'export-token',
					'blocker',
					'/export is not on this worker',
					'the route answered 404 with a credential attached, which is a worker too old to have the owner tier rather than one with diagnostics closed. `drangler update <worker>` moves it forward',
					'the /export status'
				);
			}
			return found(
				'export-token',
				'note',
				'the export is reachable with the owner token',
				`\`/export\` answered ${envelope.status} on the owner tier, so leaving needs no \`PW_DIAGNOSTICS=1\` and does not expose \`/sql\` and \`/restore\` alongside it`,
				'the /export status'
			);
		}
	},
	{
		id: 'export-replayable',
		direction: 'to-vps',
		evaluate(_survey, _target, envelope) {
			if (envelope?.replayable === undefined) return null;
			if (envelope.replayable) {
				return found(
					'export-replayable',
					'note',
					'the dump can be replayed back',
					`the widest statement is ${(envelope.maxStatementChars ?? 0).toLocaleString('en-US')} characters against the ${DO_STATEMENT_CHARS.toLocaleString('en-US')} a Durable Object accepts, so this dump can go back into a worker as well as onto a VPS`,
					'the /export envelope replayable field'
				);
			}
			return found(
				'export-replayable',
				'blocker',
				'the worker refuses this dump as unreplayable',
				`the widest statement is ${(envelope.maxStatementChars ?? 0).toLocaleString('en-US')} characters against a ${DO_STATEMENT_CHARS.toLocaleString('en-US')} ceiling. A restore point nobody can replay reads as a backup and is not one; drop \`--all\`, or narrow it with a limit`,
				'the /export envelope replayable field'
			);
		}
	},
	{
		id: 'export-structure-only',
		direction: 'to-vps',
		evaluate(_survey, _target, envelope) {
			if (envelope?.structureOnly === undefined) return null;
			return found(
				'export-structure-only',
				'note',
				`${envelope.structureOnly.length} table(s) come back as schema with no rows`,
				`the worker resolved these as regenerable and named them itself: ${envelope.structureOnly.join(', ')}. \`--all\` includes their rows, and the worker then refuses the dump outright when a statement exceeds the Durable Object ceiling`,
				'the /export envelope structureOnly field'
			);
		}
	},
	{
		id: 'export-files',
		direction: 'to-vps',
		evaluate(_survey, _target, envelope) {
			if (envelope?.tables === undefined) return null;
			const chunks = envelope.tables['cfw_file_chunk'] ?? 0;
			const files = envelope.tables['cfw_file'] ?? 0;
			if (chunks === 0 && files === 0) {
				return found(
					'export-files',
					'note',
					'this site holds no managed files',
					'`cfw_file` and `cfw_file_chunk` are both empty in the dump, so there are no uploads to write back to a filesystem',
					'the /export envelope tables map'
				);
			}
			return found(
				'export-files',
				'blocker',
				'the file bytes are in the dump and nothing writes them back yet',
				`\`cfw_file\` holds ${files} row(s) and \`cfw_file_chunk\` holds ${chunks}, so the bytes ARE leaving. What does not exist is anything that turns those chunk rows back into a \`sites/default/files/\` tree: run \`drangler migrate files --from-dump\` against the dump before serving the restored site`,
				'the /export envelope tables map'
			);
		}
	},
	{
		id: 'export-secrets',
		direction: 'to-vps',
		evaluate(_survey, _target, envelope) {
			if (envelope === undefined || envelope === null) return null;
			return envelope.secrets === true
				? found(
						'export-secrets',
						'warning',
						'this dump carries the site credentials',
						'`?secrets=1` includes the owner token, the Cloudflare OAuth tokens and the hash salt. A restore needs the salt and nothing else does, so this file may not be stored anywhere a backup normally goes; `drangler secrets scan` finds all four',
						'the ?secrets=1 parameter on the export'
					)
				: found(
						'export-secrets',
						'warning',
						'this dump withholds the hash salt a restore needs',
						'without `?secrets=1` the dump carries no `hash_salt`, so the restored site mints its own and every one-time login link and form token minted by the worker stops validating. That is the safe default and it is a step, not an absence',
						'the ?secrets=1 parameter on the export'
					);
		}
	},
	{
		id: 'substitutions',
		direction: 'to-vps',
		evaluate() {
			return found(
				'substitutions',
				'blocker',
				`${SUBSTITUTIONS.length} services and settings have to be swapped back by hand`,
				`the site runs on drupflare's own cache, lock, logger, mail, image toolkit and database driver, and every one of them is a class a VPS does not have. \`drangler migrate eligibility --to vps --json\` emits the whole table as \`substitutions\`; the first is \`${SUBSTITUTIONS[0]?.from}\` becoming \`${SUBSTITUTIONS[0]?.to}\``,
				'drupflare/drupflare service classes and the shipped settings.php'
			);
		}
	},
	{
		id: 'hash-salt',
		direction: 'to-vps',
		evaluate() {
			return found(
				'hash-salt',
				'note',
				'the restored site needs its own hash_salt',
				"the shipped pack assigns an empty `$settings['hash_salt']` and the object mints one per site, so a VPS settings.php must set its own; one-time login links and form tokens minted by the worker stop validating",
				'the shipped settings.php hash_salt'
			);
		}
	},
	{
		id: 'dialect-out',
		direction: 'to-vps',
		evaluate() {
			return found(
				'dialect-out',
				'note',
				'the dump is SQLite',
				'`drangler migrate convert --from sqlite --to mysql` rewrites it for a MySQL host; a Drupal that stays on SQLite can replay the dump unchanged',
				'the dump the /export envelope describes'
			);
		}
	}
];

/** Findings that read the source's own files, which preview can only score once they are streamed. */
export const SOURCE_FINDING_IDS: readonly string[] = [
	'module-core-compat',
	'extensions-called',
	'extensions-declared',
	'settings-memcache',
	'settings-redis',
	'settings-s3'
];

/** Rules that apply in one direction, in declaration order. */
export function rulesFor(direction: Direction): Rule[] {
	return RULES.filter((r) => r.direction === direction || r.direction === 'both');
}
