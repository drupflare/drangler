import type { CommandResult } from '../host/exec';
import type { Transport } from './transport';

/** One read-only command the survey issues, and what a non-zero exit from it means. */
export interface SurveyStep {
	id: string;
	command: string;
	/** a required step that fails aborts nothing, but its absence is reported as an error */
	required: boolean;
	description: string;
}

export interface SiteSurvey {
	source: 'vps';
	host: string;
	root: string;
	capturedAt: string | null;
	php: { version: string | null; extensions: string[] };
	drush: string | null;
	drupal: { version: string | null; profile: string | null; uri: string | null };
	database: { driver: string | null; name: string | null; bytes: number | null };
	files: { kb: number | null; count: number | null };
	modules: string[];
	nodes: number | null;
	imageStyles: number | null;
	errors: { id: string; detail: string }[];
}

/**
 * Every command the survey will run, in order.
 *
 * READ-ONLY BY CONSTRUCTION. Nothing here writes a file, changes a config or takes a lock, so a
 * survey against a production VPS is safe to run during traffic; that is the property that makes
 * `--dry-run` printing this list a useful review rather than theatre.
 *
 * The `drush sql:query` steps are MySQL-shaped and are all optional, because a site on PostgreSQL or
 * SQLite should still produce a survey rather than an error report.
 */
export function surveyPlan(root: string): SurveyStep[] {
	const cd = `cd ${root} &&`;
	return [
		{ id: 'php-version', command: 'php -v', required: true, description: 'PHP version' },
		{ id: 'php-modules', command: 'php -m', required: true, description: 'loaded extensions' },
		{
			id: 'drush-version',
			command: `${cd} drush --version`,
			required: false,
			description: 'drush presence'
		},
		{
			id: 'drush-status',
			command: `${cd} drush status --format=json`,
			required: true,
			description: 'Drupal version, database driver, site URI'
		},
		{
			id: 'modules',
			command: `${cd} drush pm:list --status=enabled --type=module --format=json`,
			required: true,
			description: 'enabled modules'
		},
		{
			id: 'files-kb',
			command: `du -sk ${root}/sites/default/files`,
			required: false,
			description: 'public files size'
		},
		{
			id: 'files-count',
			command: `find ${root}/sites/default/files -type f | wc -l`,
			required: false,
			description: 'public file count'
		},
		{
			id: 'db-bytes',
			command:
				`${cd} drush sql:query ` +
				'"SELECT SUM(data_length + index_length) FROM information_schema.tables ' +
				'WHERE table_schema = DATABASE()"',
			required: false,
			description: 'database size (MySQL only)'
		},
		{
			id: 'nodes',
			command: `${cd} drush sql:query "SELECT COUNT(*) FROM node"`,
			required: false,
			description: 'node count'
		},
		{
			id: 'image-styles',
			command:
				`${cd} drush sql:query ` +
				`"SELECT COUNT(*) FROM config WHERE name LIKE 'image.style.%'"`,
			required: false,
			description: 'image style count'
		}
	];
}

/** `PHP 8.3.6 (cli) (built: ...)` to `8.3.6`. */
export function parsePhpVersion(stdout: string): string | null {
	const match = /^PHP\s+(\d+\.\d+\.\d+[^\s]*)/m.exec(stdout);
	return match?.[1] ?? null;
}

/**
 * The `[PHP Modules]` section of `php -m`, without the Zend one.
 *
 * Both sections are flat lists of bare names, so a parser that ignored the headers would report
 * `Zend OPcache` as a loadable extension and a rule keyed on extension names would then be wrong.
 */
export function parsePhpModules(stdout: string): string[] {
	const out: string[] = [];
	let inPhp = false;
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (/^\[.*\]$/.test(trimmed)) {
			inPhp = trimmed.toLowerCase() === '[php modules]';
			continue;
		}
		if (inPhp && trimmed !== '') out.push(trimmed);
	}
	return out;
}

interface DrushStatus {
	[key: string]: unknown;
}

/** Reads a key under either the hyphenated or the camel form drush has used across major versions. */
function statusField(status: DrushStatus, ...names: string[]): string | null {
	for (const name of names) {
		const value = status[name];
		if (typeof value === 'string' && value !== '') return value;
	}
	return null;
}

export interface DrushStatusFields {
	drupalVersion: string | null;
	dbDriver: string | null;
	dbName: string | null;
	uri: string | null;
	profile: string | null;
}

/** Parses `drush status --format=json`, tolerating both key spellings and a non-JSON body. */
export function parseDrushStatus(stdout: string): DrushStatusFields | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const status = parsed as DrushStatus;
	return {
		drupalVersion: statusField(status, 'drupal-version', 'drupalVersion'),
		dbDriver: statusField(status, 'db-driver', 'dbDriver'),
		dbName: statusField(status, 'db-name', 'dbName'),
		uri: statusField(status, 'uri'),
		profile: statusField(status, 'install-profile', 'installProfile')
	};
}

/** Enabled module machine names from `drush pm:list --format=json`, sorted. */
export function parseModuleList(stdout: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (parsed === null || typeof parsed !== 'object') return [];
	if (Array.isArray(parsed)) {
		return parsed.filter((v): v is string => typeof v === 'string').sort();
	}
	return Object.keys(parsed as Record<string, unknown>).sort();
}

/**
 * The last standalone integer in a body of output.
 *
 * `drush sql:query` prints a column header on some drivers and not others, and `du` prefixes the
 * path; taking the last integer-only token is the one rule that reads all of them without a
 * per-driver branch.
 */
export function parseCount(stdout: string): number | null {
	let found: number | null = null;
	for (const line of stdout.split('\n')) {
		const match = /^(\d+)(\s|$)/.exec(line.trim());
		if (match?.[1] !== undefined) found = Number(match[1]);
	}
	return found;
}

/** `123456\t/var/www/html/sites/default/files` to `123456`, in kilobytes. */
export function parseDuKb(stdout: string): number | null {
	const match = /^(\d+)\s/m.exec(stdout.trim());
	return match?.[1] === undefined ? null : Number(match[1]);
}

/** An empty survey, so a caller that only has partial output still has a well-typed record. */
export function emptySurvey(host: string, root: string): SiteSurvey {
	return {
		source: 'vps',
		host,
		root,
		capturedAt: null,
		php: { version: null, extensions: [] },
		drush: null,
		drupal: { version: null, profile: null, uri: null },
		database: { driver: null, name: null, bytes: null },
		files: { kb: null, count: null },
		modules: [],
		nodes: null,
		imageStyles: null,
		errors: []
	};
}

export interface SurveyDeps {
	transport: Transport;
	now?: () => Date;
}

/**
 * Runs the whole plan and folds the output into a survey.
 *
 * A failing step is recorded and the run continues. A partial survey is the normal case -- a host
 * without drush still answers `php -v` -- and the rules layer is written to treat an unknown as
 * unknown rather than as a pass.
 */
export async function runSurvey(deps: SurveyDeps, host: string, root: string): Promise<SiteSurvey> {
	const survey = emptySurvey(host, root);
	survey.capturedAt = (deps.now ?? (() => new Date()))().toISOString();

	for (const step of surveyPlan(root)) {
		let result: CommandResult;
		try {
			result = await deps.transport.exec(step.command);
		} catch (e) {
			survey.errors.push({ id: step.id, detail: e instanceof Error ? e.message : String(e) });
			continue;
		}
		if (result.code !== 0) {
			if (step.required) {
				survey.errors.push({
					id: step.id,
					detail: `exit ${result.code}: ${result.stderr.trim().split('\n')[0] ?? 'no detail'}`
				});
			}
			continue;
		}
		applyStep(survey, step.id, result.stdout);
	}
	return survey;
}

/** Folds one step's stdout into the survey. Split out so a spec can drive a single parser path. */
export function applyStep(survey: SiteSurvey, id: string, stdout: string): void {
	switch (id) {
		case 'php-version':
			survey.php.version = parsePhpVersion(stdout);
			return;
		case 'php-modules':
			survey.php.extensions = parsePhpModules(stdout);
			return;
		case 'drush-version':
			survey.drush = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
			return;
		case 'drush-status': {
			const status = parseDrushStatus(stdout);
			if (status === null) return;
			survey.drupal.version = status.drupalVersion;
			survey.drupal.profile = status.profile;
			survey.drupal.uri = status.uri;
			survey.database.driver = status.dbDriver;
			survey.database.name = status.dbName;
			return;
		}
		case 'modules':
			survey.modules = parseModuleList(stdout);
			return;
		case 'files-kb':
			survey.files.kb = parseDuKb(stdout);
			return;
		case 'files-count':
			survey.files.count = parseCount(stdout);
			return;
		case 'db-bytes':
			survey.database.bytes = parseCount(stdout);
			return;
		case 'nodes':
			survey.nodes = parseCount(stdout);
			return;
		case 'image-styles':
			survey.imageStyles = parseCount(stdout);
			return;
		default:
			return;
	}
}
