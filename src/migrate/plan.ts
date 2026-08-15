import { rulesFor, type Direction, type Finding, type Severity } from './rules';
import type { SiteSurvey } from './survey';
import { assumedTarget, type TargetRuntime } from './target-runtime';

export interface PlanStep {
	n: number;
	title: string;
	/** the exact command, when there is one drangler or another tool can run */
	command: string | null;
	detail: string;
}

export interface MigrationPlan {
	direction: Direction;
	source: string;
	root: string;
	findings: Finding[];
	counts: Record<Severity, number>;
	/** what the destination is taken to run, and whether that was measured */
	target: TargetRuntime;
	/** survey fields a rule wanted and did not get; an unknown is never scored as a pass */
	unknowns: string[];
	steps: PlanStep[];
}

/**
 * Survey fields whose absence changes the verdict, and the rule that goes unscored without each.
 *
 * Reported rather than defaulted. A plan built from a survey with no database driver has not decided
 * that the driver is fine; it has not looked, and saying so is the difference between a plan and a
 * guess.
 */
const REQUIRED_FIELDS: readonly (readonly [string, (s: SiteSurvey) => boolean])[] = [
	['php.version', (s) => s.php.version !== null],
	['drupal.version', (s) => s.drupal.version !== null],
	['database.driver', (s) => s.database.driver !== null],
	['database.bytes', (s) => s.database.bytes !== null],
	['files.kb', (s) => s.files.kb !== null],
	['files.count', (s) => s.files.count !== null],
	['modules', (s) => s.modules.length > 0],
	['nodes', (s) => s.nodes !== null],
	['imageStyles', (s) => s.imageStyles !== null]
];

const TO_WORKER_STEPS = (survey: SiteSurvey): PlanStep[] => [
	{
		n: 1,
		title: 'Dump the Source Database',
		command: `ssh ${survey.host} 'cd ${survey.root} && drush sql:dump --result-file=/tmp/site.sql --gzip'`,
		detail: 'a plain mysqldump; drangler reads the uncompressed form'
	},
	{
		n: 2,
		title: 'Scan the Dump for Credentials',
		command: 'drangler secrets scan /tmp/site.sql sites/default/settings.php',
		detail: 'a dump carries user password hashes and settings.php carries the database password; both would otherwise travel into an asset that Workers serves publicly'
	},
	{
		n: 3,
		title: 'Convert the Dump to SQLite',
		command:
			'drangler migrate convert --from mysql --to sqlite --in /tmp/site.sql --out site.sqlite.sql',
		detail: 'refuses on any construct it will not guess at, rather than emitting SQL that replays wrong'
	},
	{
		n: 4,
		title: 'Copy the Managed Files',
		command: `rsync -a ${survey.host}:${survey.root}/sites/default/files/ ./files/`,
		detail: 'user uploads are not in the database and are not in the Drupal pack'
	},
	{
		n: 5,
		title: 'Build the Site Assets',
		command: null,
		detail: 'in `drupflare/worker`: the packs are generated there and `assets/drupal/site.sqlite` is hand-trimmed, so the converted rows are inserted into it surgically and `bun run assets:sql` is re-run'
	},
	{
		n: 6,
		title: 'Deploy and Verify',
		command: 'drangler health <worker-url> --skip-edge',
		detail: 'reads the x-cfw-* headers on /serve and reports which tier answered and whether the interpreter is booted'
	}
];

const TO_VPS_STEPS = (survey: SiteSurvey): PlanStep[] => [
	{
		n: 1,
		title: 'Open the Diagnostic Routes',
		command: 'bunx wrangler deploy --var PW_DIAGNOSTICS:1',
		detail: 'run in `drupflare/worker`, and revert immediately: the same flag exposes /sql, /restore and /export to anyone'
	},
	{
		n: 2,
		title: 'Export the Database',
		command: 'drangler migrate export --url <worker-url> --out worker.sql',
		detail: 'GET /export?body=1, which is dumpDatabase() in worker/src/db/export-sql.ts'
	},
	{
		n: 3,
		title: 'Convert the Dump to MySQL',
		command: 'drangler migrate convert --from sqlite --to mysql --in worker.sql --out vps.sql',
		detail: 'skip this step for a VPS Drupal that will stay on SQLite'
	},
	{
		n: 4,
		title: 'Restore onto the Host',
		command: `ssh ${survey.host} 'cd ${survey.root} && drush sql:cli < vps.sql'`,
		detail: 'the cache bins arrive as structure only, so the first request rebuilds them'
	},
	{
		n: 5,
		title: 'Set a Local hash_salt',
		command: null,
		detail: 'the exported settings assign an empty salt; a VPS needs its own, and the worker-minted one is not portable'
	},
	{
		n: 6,
		title: 'Verify the Restored Site',
		command: `drangler health ${survey.drupal.uri ?? '<site-url>'} --kind vps`,
		detail: 'reads x-generator and the Drupal cache headers rather than the worker ones'
	}
];

/**
 * Scores a survey against the rules for one direction and orders the work.
 *
 * Pure: same survey, same plan, every time. The whole point of separating this from `runSurvey()` is
 * that a captured survey can be re-planned offline as the rule set grows.
 */
export function buildPlan(
	survey: SiteSurvey,
	direction: Direction,
	target: TargetRuntime = assumedTarget()
): MigrationPlan {
	const findings: Finding[] = [];
	for (const rule of rulesFor(direction)) {
		const finding = rule.evaluate(survey, target);
		if (finding !== null) findings.push(finding);
	}
	const counts: Record<Severity, number> = { blocker: 0, warning: 0, note: 0 };
	for (const finding of findings) counts[finding.severity]++;

	return {
		direction,
		source: survey.host,
		root: survey.root,
		findings,
		counts,
		target,
		unknowns: REQUIRED_FIELDS.filter(([, has]) => !has(survey)).map(([name]) => name),
		steps: direction === 'to-worker' ? TO_WORKER_STEPS(survey) : TO_VPS_STEPS(survey)
	};
}

/** Renders a plan as text, blockers first. */
export function renderPlan(plan: MigrationPlan): string[] {
	const lines: string[] = [];
	const heading = plan.direction === 'to-worker' ? 'VPS to Worker' : 'Worker to VPS';
	lines.push(`Migration plan: ${heading}`);
	lines.push(`Source: ${plan.source}${plan.root === '/' ? '' : ` (${plan.root})`}`);
	// printed on every plan, because a verdict about PHP compatibility is only as good as this
	lines.push(`Target: PHP ${plan.target.php} (${plan.target.source})`);
	lines.push('');

	for (const severity of ['blocker', 'warning', 'note'] as const) {
		const hits = plan.findings.filter((f) => f.severity === severity);
		if (hits.length === 0) continue;
		lines.push(`${severity.toUpperCase()}S (${hits.length})`);
		for (const finding of hits) {
			lines.push(`  ${finding.id}: ${finding.title}`);
			lines.push(`    ${finding.detail}`);
		}
		lines.push('');
	}

	if (plan.unknowns.length > 0) {
		lines.push(`NOT MEASURED (${plan.unknowns.length})`);
		lines.push(`  ${plan.unknowns.join(', ')}`);
		lines.push('  these were absent from the survey, so no rule scored them');
		lines.push('');
	}

	lines.push('STEPS');
	for (const step of plan.steps) {
		lines.push(`  ${step.n}. ${step.title}`);
		if (step.command !== null) lines.push(`     $ ${step.command}`);
		lines.push(`     ${step.detail}`);
	}
	return lines;
}
