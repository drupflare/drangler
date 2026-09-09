import { describe, expect, it } from 'vitest';
import { sourceBlocked, sourceFindings } from '../src/health/source';
import { emptySurvey, type SiteSurvey } from '../src/migrate/survey';

/**
 * A survey error is a VERDICT, and it was not one.
 *
 * `runSurvey()` records a failed required step and continues, which is right. Nothing downstream
 * turned that into a refusal: a source whose `php -v` exited non-zero and one that simply has no
 * node count produced the same shape of report, and both reached a pass.
 */
function healthy(over: Partial<SiteSurvey> = {}): SiteSurvey {
	return {
		...emptySurvey('me@old.example', '/var/www/html'),
		php: { version: '8.2.15', extensions: ['curl'] },
		drush: '12.5.1',
		drupal: {
			version: '10.3.1',
			profile: 'standard',
			uri: 'https://old.example',
			root: '/var/www/html'
		},
		database: { driver: 'mysql', name: 'drupal', bytes: 1 },
		files: { kb: 40960, count: 1200 },
		dbAlive: true,
		fileRows: 1200,
		...over
	};
}

const ids = (survey: SiteSurvey) => sourceFindings(survey).map((f) => f.id);

describe('a healthy source', () => {
	it('produces no finding at all', () => {
		expect(sourceFindings(healthy())).toEqual([]);
		expect(sourceBlocked(sourceFindings(healthy()))).toBe(false);
	});

	it('carries the field it read on every finding it does produce', () => {
		for (const finding of sourceFindings(healthy({ drush: null }))) {
			expect(finding.evidence).not.toBe('');
		}
	});
});

describe('one state at a time', () => {
	it('source.php-dead stops there, because nothing below it was measured', () => {
		const survey = healthy({
			php: { version: null, extensions: [] },
			errors: [{ id: 'php-version', detail: 'exit 127: php: command not found' }]
		});
		expect(ids(survey)).toEqual(['source.php-dead']);
		expect(sourceBlocked(sourceFindings(survey))).toBe(true);
	});

	/**
	 * Without drush every field below it is blank for ONE reason.
	 *
	 * Reporting a bootstrap failure and an unreadable database on top of it would be reporting the
	 * same fact three times, and a report that does that is one nobody reads.
	 */
	it('source.drush-absent stops there too, and is a warning rather than a blocker', () => {
		const survey = healthy({
			drush: null,
			drupal: { version: null, profile: null, uri: null, root: null },
			database: { driver: null, name: null, bytes: null }
		});
		expect(ids(survey)).toEqual(['source.drush-absent']);
		expect(sourceBlocked(sourceFindings(survey))).toBe(false);
	});

	it('source.bootstrap-fail when drush ran and reported no version', () => {
		const survey = healthy({
			drupal: { version: null, profile: null, uri: null, root: null }
		});
		expect(ids(survey)).toContain('source.bootstrap-fail');
	});

	it('source.db-unreadable for no driver, and for a driver whose SELECT 1 died', () => {
		expect(ids(healthy({ database: { driver: null, name: null, bytes: null } }))).toContain(
			'source.db-unreadable'
		);

		const refused = sourceFindings(healthy({ dbAlive: false }));
		expect(refused.map((f) => f.id)).toEqual(['source.db-unreadable']);
		// the two look identical in the report unless the detail says which one it was
		expect(refused[0]?.detail).toContain('SELECT 1');
		expect(refused[0]?.evidence).toBe('survey.dbAlive');
	});

	it('source.files-missing when du itself did not answer', () => {
		const survey = healthy({
			files: { kb: null, count: null },
			errors: [{ id: 'files-kb', detail: 'exit 1: No such file or directory' }]
		});
		expect(ids(survey)).toContain('source.files-missing');
	});

	/** zero files and zero rows is a site with no uploads; zero and 4,000 is a missing volume */
	it('source.files-unreadable only when the database says there should be files', () => {
		expect(ids(healthy({ files: { kb: 4, count: 0 }, fileRows: 0 }))).toEqual([]);
		expect(ids(healthy({ files: { kb: 4, count: 0 }, fileRows: 4000 }))).toEqual([
			'source.files-unreadable'
		]);
	});

	it('source.root-wrong when drush bootstrapped somewhere else', () => {
		const survey = healthy({
			drupal: {
				version: '10.3.1',
				profile: 'standard',
				uri: null,
				root: '/var/www/other'
			}
		});
		expect(ids(survey)).toEqual(['source.root-wrong']);
		expect(sourceFindings(survey)[0]?.detail).toContain('/var/www/other');
	});
});
