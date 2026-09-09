import type { SiteSurvey } from '../migrate/survey';

/**
 * Scoring a VPS source from the survey that was already taken.
 *
 * Every state below is detectable from commands `surveyPlan()` issues; what was missing is a
 * VERDICT on them. `runSurvey()` records a failed required step in `survey.errors[]` and continues,
 * which is right, and nothing downstream turned that into a refusal: a source whose `php -v` exited
 * non-zero and a source that simply has no node count produced the same shape of report, and both
 * reached `GO`.
 *
 * **None of these is auto-repairable.** drangler is read-only against a VPS by construction, and
 * `tests/migrate-survey.spec.ts` asserts no survey step matches a mutating verb. Repairing somebody
 * else's production Drupal over ssh is a different product.
 */

export type SourceSeverity = 'blocker' | 'warning';

export interface SourceFinding {
	id: string;
	severity: SourceSeverity;
	title: string;
	detail: string;
	/** the survey field or step the verdict was read from */
	evidence: string;
}

/** whether a step failed outright, which is a different fact from a field being absent */
function failed(survey: SiteSurvey, id: string): string | null {
	return survey.errors.find((e) => e.id === id)?.detail ?? null;
}

function finding(
	id: string,
	severity: SourceSeverity,
	title: string,
	detail: string,
	evidence: string
): SourceFinding {
	return { id, severity, title, detail, evidence };
}

/**
 * Every `source.*` state this survey shows, worst first.
 *
 * Ordered by how far up the stack the fault is, because a dead PHP explains every blank below it
 * and reporting seven findings for one cause is how a report stops being read.
 */
export function sourceFindings(survey: SiteSurvey): SourceFinding[] {
	const found: SourceFinding[] = [];

	const php = failed(survey, 'php-version');
	if (php !== null || (survey.php.version === null && failed(survey, 'php-modules') !== null)) {
		found.push(
			finding(
				'source.php-dead',
				'blocker',
				'php did not run on the source',
				`\`php -v\` did not answer${php === null ? '' : `: ${php}`}. Nothing below this was measured, because every other step runs through the same interpreter`,
				'survey.errors[php-version]'
			)
		);
		return found;
	}

	// EVERY CHECK BELOW READS A FIELD DRUSH FILLS, so without drush they are all blank for one
	// reason and reporting four blockers for it would be reporting the same fact four times. An
	// absent field and a step that ran and produced nothing are different facts
	if (survey.drush === null) {
		found.push(
			finding(
				'source.drush-absent',
				'warning',
				'drush is not on the source',
				'the module list, the database driver and the row counts all come back through drush, so every one of them is blank rather than measured. Install it in the site root with `composer require drush/drush`',
				'survey.drush'
			)
		);
		return found;
	}

	if (survey.drupal.version === null) {
		found.push(
			finding(
				'source.bootstrap-fail',
				'blocker',
				'Drupal did not bootstrap',
				'`drush status` returned without a `drupal-version`, so the site did not reach a bootable state. A truncated `settings.php` and an unreadable database both look like this from here',
				'survey.drupal.version'
			)
		);
	}

	if (survey.database.driver === null || survey.dbAlive === false) {
		found.push(
			finding(
				'source.db-unreadable',
				'blocker',
				'the database did not answer',
				survey.database.driver === null
					? '`drush status` reported no `db-driver`, so nothing here has connected to the database'
					: `the driver is \`${survey.database.driver}\` and \`SELECT 1\` did not come back, so the credentials or the host in \`settings.php\` are wrong`,
				survey.database.driver === null ? 'survey.database.driver' : 'survey.dbAlive'
			)
		);
	}

	if (survey.files.kb === null && failed(survey, 'files-kb') !== null) {
		found.push(
			finding(
				'source.files-missing',
				'blocker',
				'the public files directory is not there',
				'`du` on `sites/default/files` did not answer, so either the path is wrong or the volume that holds it is not mounted. Every upload on the site is inside it',
				'survey.errors[files-kb]'
			)
		);
	} else if (survey.files.count === 0 && (survey.fileRows ?? 0) > 0) {
		found.push(
			finding(
				'source.files-unreadable',
				'blocker',
				'the files directory is empty and the database says it should not be',
				`\`file_managed\` holds ${survey.fileRows} row(s) and the tree holds no files at all, which is a mount that is not there rather than a site with no uploads`,
				'survey.files.count against survey.fileRows'
			)
		);
	}

	// checked last because it explains nothing above it: a survey against the wrong root measures a
	// different site, and every field in it is about that other site rather than being absent
	const reported = survey.drupal.root;
	if (reported !== null && reported !== '' && reported !== survey.root) {
		found.push(
			finding(
				'source.root-wrong',
				'blocker',
				'drush reports a different Drupal root',
				`--root is \`${survey.root}\` and drush bootstrapped \`${reported}\`, so this survey measured a different site`,
				'survey.root against survey.drupal.root'
			)
		);
	}

	return found;
}

/** whether a source is fit to migrate at all; any blocker means no */
export function sourceBlocked(findings: readonly SourceFinding[]): boolean {
	return findings.some((f) => f.severity === 'blocker');
}
