import type { SiteSurvey } from './survey';
import { isOlderThan, type TargetRuntime } from './target-runtime';

export type Direction = 'to-worker' | 'to-vps';

export type Severity = 'blocker' | 'warning' | 'note';

export interface Finding {
	id: string;
	severity: Severity;
	title: string;
	/** the mechanism, and where it is written down; never a bare assertion */
	detail: string;
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
	 */
	evaluate(survey: SiteSurvey, target: TargetRuntime): Finding | null;
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
	/** cold regeneration ceiling, bound by rows written */
	rendersPerDayCold: 1_052,
	/** the same ceiling with a fill window amortising the boot */
	rendersPerDayWindowed: 7_575,
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

/**
 * Modules that cannot work on the worker, with the mechanism for each.
 *
 * A named list rather than a heuristic: every entry is refused for a reason that is a property of the
 * runtime, not of the module's quality, and the message says which. Anything whose failure mode is a
 * guess belongs in `SERVICE_MODULES` at warning severity instead.
 */
export const INCOMPATIBLE_MODULES: Record<string, string> = {
	redis: 'raw TCP; the interpreter has no socket extension and `drupflare/stream-http` bridges https:// streams only',
	memcache:
		'raw TCP; the interpreter has no socket extension and `drupflare/stream-http` bridges https:// streams only',
	memcache_storage:
		'raw TCP; the interpreter has no socket extension and `drupflare/stream-http` bridges https:// streams only',
	mongodb: 'raw TCP, and the driver is a native extension the wasm build does not carry',
	imagemagick: 'shells out to `convert`; the wasm build cannot spawn a process',
	imageapi_optimize_binaries:
		'shells out to image binaries; the wasm build cannot spawn a process'
};

/** Modules that can run but need something the one-click deploy does not provision. */
export const SERVICE_MODULES: Record<string, string> = {
	search_api_solr:
		'reaches Solr over HTTP, which the stream wrapper can do, but no Solr host is provisioned',
	backup_migrate: 'its archive writers want ext-zip or ext-phar, and the wasm build has neither',
	clientside_validation:
		'no runtime obstacle; listed because it pulls a large npm asset set the asset layer must carry'
};

function found(id: string, severity: Severity, title: string, detail: string): Finding {
	return { id, severity, title, detail };
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
					"the worker stores the site in the Durable Object's own SQLite, so no dialect conversion is needed"
				);
			}
			if (CONVERTIBLE_DRIVERS.includes(driver)) {
				return found(
					'db-driver',
					'note',
					`${driver} converts to SQLite`,
					'`drangler migrate convert --from mysql --to sqlite` reads a `drush sql:dump`; the worker has no MySQL'
				);
			}
			return found(
				'db-driver',
				'blocker',
				`no converter for ${driver}`,
				'the worker runs Durable Object SQLite only, and drangler converts the MySQL family alone; dump through an intermediate tool first'
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
				`${ships}, so any code that depends on ${version} behaviour changes underneath it. ${target.note}`
			);
		}
	},
	{
		id: 'ext-archive',
		direction: 'to-worker',
		evaluate(survey) {
			const present = survey.php.extensions.filter((e) => e === 'zip' || e === 'Phar');
			if (present.length === 0) return null;
			return found(
				'ext-archive',
				'warning',
				`the source loads ${present.join(' and ')}`,
				'the wasm interpreter has neither ext-zip nor ext-phar; code that opens an archive must move to a host-side path'
			);
		}
	},
	{
		id: 'incompatible-modules',
		direction: 'to-worker',
		evaluate(survey) {
			const hits = survey.modules.filter((m) => m in INCOMPATIBLE_MODULES);
			if (hits.length === 0) return null;
			return found(
				'incompatible-modules',
				'blocker',
				`${hits.length} enabled module(s) cannot run on the worker`,
				hits.map((m) => `${m}: ${INCOMPATIBLE_MODULES[m]}`).join('; ')
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
				hits.map((m) => `${m}: ${SERVICE_MODULES[m]}`).join('; ')
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
				`${survey.modules.length} enabled modules were listed by name only; the worker cannot spawn a process, and finding the callers needs a grep of the source tree`
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
				`${styles} image styles over ${files.toLocaleString('en-US')} files; Cloudflare Images fails this as a hard cap rather than a bill, and neither the serving nor the regeneration ceiling reports it`
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
				`the Drupal pack is built against a ${LIMITS.assetBytes / 1_048_576} MiB per-asset ceiling, so a files directory this size must be mirrored to R2 rather than shipped in the bundle`
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
				`a restore replays statement text, and a Durable Object refuses one over ${LIMITS.statementChars.toLocaleString('en-US')} characters or a record over ${LIMITS.recordBytes.toLocaleString('en-US')} bytes; check the widest row before converting`
			);
		}
	},
	{
		id: 'regeneration-ceiling',
		direction: 'to-worker',
		evaluate(survey) {
			const nodes = survey.nodes;
			if (nodes === null) return null;
			if (nodes <= LIMITS.rendersPerDayCold) return null;
			const severity: Severity = nodes > LIMITS.rendersPerDayWindowed ? 'warning' : 'note';
			return found(
				'regeneration-ceiling',
				severity,
				`${nodes.toLocaleString('en-US')} nodes against a ${LIMITS.rendersPerDayCold.toLocaleString('en-US')}/day cold regeneration ceiling`,
				`regeneration is bound by rows written, not by CPU: ${LIMITS.rendersPerDayCold.toLocaleString('en-US')} renders/day cold and ${LIMITS.rendersPerDayWindowed.toLocaleString('en-US')} with a fill window, so a full rebuild of every node spans more than one day on the free plan`
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
				'the survey reads the database driver, the module list and the dump through drush; without it every one of those is unknown and the plan is scoring blanks'
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
				'the worker runs a `*/5 * * * *` trigger that drives the fill window; a crontab entry calling drush has no equivalent and its work has to move into hook_cron or a queue'
			);
		}
	},
	{
		id: 'export-gated',
		direction: 'to-vps',
		evaluate() {
			return found(
				'export-gated',
				'blocker',
				'/export is not reachable on a normal deployment',
				'`/export` sits in DIAGNOSTIC_ROUTES in `worker/src/site.ts` and 404s unless `PW_DIAGNOSTICS=1`; the same flag opens `/sql` and `/restore`, so off-boarding currently means opening a remote shell to get the data out'
			);
		}
	},
	{
		id: 'export-structure-only',
		direction: 'to-vps',
		evaluate() {
			return found(
				'export-structure-only',
				'note',
				'the export is not byte-exact by default',
				'some tables come back as schema with no rows; the dump envelope reports exactly which in its `structureOnly` field, and `drangler migrate export` prints that list rather than restating the rule. `?all=1` includes their rows, and the worker then refuses the dump outright when a statement exceeds the 100,000-character Durable Object ceiling'
			);
		}
	},
	{
		id: 'export-files',
		direction: 'to-vps',
		evaluate() {
			return found(
				'export-files',
				'blocker',
				'the export carries no managed files',
				'`/export` dumps the database only; the Drupal tree ships as a per-file pack on the asset layer and user uploads live outside it, so a VPS restore needs the files fetched separately'
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
				"the shipped pack assigns an empty `$settings['hash_salt']` and the object mints one per site, so a VPS settings.php must set its own; one-time login links and form tokens minted by the worker stop validating"
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
				'`drangler migrate convert --from sqlite --to mysql` rewrites it for a MySQL host; a Drupal that stays on SQLite can replay the dump unchanged'
			);
		}
	}
];

/** Rules that apply in one direction, in declaration order. */
export function rulesFor(direction: Direction): Rule[] {
	return RULES.filter((r) => r.direction === direction || r.direction === 'both');
}
