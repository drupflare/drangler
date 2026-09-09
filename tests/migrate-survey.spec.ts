import { describe, expect, it } from 'vitest';
import { runSurveyCommand, selectTransport } from '../src/commands/migrate';
import { TransportError, UsageError } from '../src/errors';
import { memoryFiles } from '../src/host/files';
import {
	applyStep,
	emptySurvey,
	parseCount,
	parseDrushStatus,
	parseDuKb,
	parseModuleList,
	parsePhpModules,
	parsePhpVersion,
	runSurvey,
	settledSteps,
	surveyPlan
} from '../src/migrate/survey';
import { parseTarget } from '../src/migrate/target';
import {
	replayTransport,
	SSH_ATTEMPTS,
	sshTransport,
	type Transcript
} from '../src/migrate/transport';
import { fail, ok, testContext } from './helpers';

const PLAN = surveyPlan('/var/www/html');
const step = (id: string) => PLAN.find((s) => s.id === id)?.command as string;

const transcript = (): Transcript => ({
	[step('php-version')]: ok('PHP 8.2.15 (cli) (built: Jan 1 2026)\nCopyright (c) The PHP Group'),
	[step('php-modules')]: ok(
		'[PHP Modules]\ncurl\nzip\npdo_mysql\n\n[Zend Modules]\nZend OPcache'
	),
	[step('drush-version')]: ok('Drush Commandline Tool 12.5.1'),
	[step('drush-status')]: ok(
		JSON.stringify({
			'drupal-version': '10.3.1',
			'db-driver': 'mysql',
			'db-name': 'drupal',
			uri: 'https://old.example',
			'install-profile': 'standard'
		})
	),
	[step('modules')]: ok(JSON.stringify({ node: {}, views: {}, redis: {} })),
	[step('files-kb')]: ok('40960\t/var/www/html/sites/default/files'),
	[step('files-count')]: ok('    1200\n'),
	[step('db-bytes')]: ok('SUM(data_length + index_length)\n104857600'),
	[step('db-alive')]: ok('1\n1'),
	[step('file-rows')]: ok('COUNT(*)\n1200'),
	[step('nodes')]: ok('COUNT(*)\n2000'),
	[step('image-styles')]: ok('COUNT(*)\n6')
});

describe('surveyPlan', () => {
	it('is read-only: nothing writes, deletes or changes state', () => {
		for (const s of PLAN) {
			expect(s.command).not.toMatch(
				/\b(rm|mv|chmod|chown|drop|delete|truncate|sql:dump|>)\b/i
			);
		}
	});

	it('runs every command from the given root', () => {
		expect(surveyPlan('/srv/d').every((s) => !s.command.includes('/var/www'))).toBe(true);
		expect(step('files-kb')).toContain('/var/www/html/sites/default/files');
	});
});

describe('parsers', () => {
	it('reads the PHP version off `php -v`', () => {
		expect(parsePhpVersion('PHP 8.3.6 (cli) (built: x)')).toBe('8.3.6');
		expect(parsePhpVersion('not php')).toBeNull();
	});

	it('reads only the PHP Modules section of `php -m`', () => {
		expect(parsePhpModules('[PHP Modules]\ncurl\nzip\n\n[Zend Modules]\nZend OPcache')).toEqual(
			['curl', 'zip']
		);
	});

	it('reads drush status under either key spelling', () => {
		expect(parseDrushStatus('{"drupal-version":"11.0.0","db-driver":"mysql"}')).toMatchObject({
			drupalVersion: '11.0.0',
			dbDriver: 'mysql'
		});
		expect(parseDrushStatus('{"drupalVersion":"11.0.0"}')?.drupalVersion).toBe('11.0.0');
	});

	it('returns null for output that is not a JSON object', () => {
		expect(parseDrushStatus('command not found')).toBeNull();
		expect(parseDrushStatus('[1,2]')).toBeNull();
	});

	it('reads a module list from an object or an array', () => {
		expect(parseModuleList('{"views":{},"node":{}}')).toEqual(['node', 'views']);
		expect(parseModuleList('["b","a"]')).toEqual(['a', 'b']);
		expect(parseModuleList('nope')).toEqual([]);
		expect(parseModuleList('null')).toEqual([]);
	});

	it('takes the last integer, so a column header does not become the answer', () => {
		expect(parseCount('COUNT(*)\n42')).toBe(42);
		expect(parseCount('   7  \n')).toBe(7);
		expect(parseCount('nothing here')).toBeNull();
	});

	it('reads du kilobytes off the first field', () => {
		expect(parseDuKb('40960\t/var/www/html/sites/default/files')).toBe(40960);
		expect(parseDuKb('du: cannot access')).toBeNull();
	});
});

describe('applyStep', () => {
	it('ignores an id it does not know', () => {
		const survey = emptySurvey('h', '/r');
		applyStep(survey, 'nonsense', 'anything');
		expect(survey).toEqual(emptySurvey('h', '/r'));
	});

	it('leaves the survey alone when drush status is unparseable', () => {
		const survey = emptySurvey('h', '/r');
		applyStep(survey, 'drush-status', 'bash: drush: not found');
		expect(survey.drupal.version).toBeNull();
	});
});

describe('runSurvey', () => {
	it('folds a whole transcript into a survey', async () => {
		const survey = await runSurvey(
			{
				transport: replayTransport(transcript()),
				now: () => new Date('2026-08-14T00:00:00Z')
			},
			'me@old.example',
			'/var/www/html'
		);
		expect(survey).toMatchObject({
			capturedAt: '2026-08-14T00:00:00.000Z',
			drush: '12.5.1',
			nodes: 2000,
			imageStyles: 6,
			modules: ['node', 'redis', 'views']
		});
		expect(survey.php).toEqual({ version: '8.2.15', extensions: ['curl', 'zip', 'pdo_mysql'] });
		expect(survey.database).toEqual({ driver: 'mysql', name: 'drupal', bytes: 104857600 });
		expect(survey.files).toEqual({ kb: 40960, count: 1200 });
		// the two controls: the database answered, and the file count has something to mean
		expect(survey.dbAlive).toBe(true);
		expect(survey.fileRows).toBe(1200);
		expect(survey.errors).toEqual([]);
	});

	it('records a failing required step and continues', async () => {
		const partial = transcript();
		partial[step('drush-status')] = fail(127, 'drush: command not found');
		const survey = await runSurvey(
			{ transport: replayTransport(partial) },
			'me@old.example',
			'/var/www/html'
		);
		expect(survey.errors).toEqual([
			{ id: 'drush-status', detail: 'exit 127: drush: command not found' }
		]);
		expect(survey.php.version).toBe('8.2.15');
	});

	it('stays quiet about a failing optional step', async () => {
		const partial = transcript();
		partial[step('db-bytes')] = fail(1, 'ERROR 1146');
		const survey = await runSurvey(
			{ transport: replayTransport(partial) },
			'h',
			'/var/www/html'
		);
		expect(survey.errors).toEqual([]);
		expect(survey.database.bytes).toBeNull();
	});

	it('records a transport refusal as an error per step', async () => {
		const survey = await runSurvey({ transport: replayTransport({}) }, 'h', '/var/www/html');
		expect(survey.errors).toHaveLength(PLAN.length);
		expect(survey.errors[0]?.detail).toContain('no entry for');
	});
});

describe('selectTransport', () => {
	it('gives a dry run a transport that refuses everything', async () => {
		const transport = selectTransport(testContext(), { dryRun: true }, parseTarget('h', '/x'));
		await expect(transport.exec('php -v')).rejects.toThrow(/dry run/);
	});

	it('gives a replay run the transcript', async () => {
		const ctx = testContext({
			files: memoryFiles({ '/t.json': JSON.stringify({ 'php -v': ok('PHP 8.3.0') }) })
		});
		const transport = selectTransport(ctx, { replay: '/t.json' }, parseTarget('h', '/x'));
		expect((await transport.exec('php -v')).stdout).toBe('PHP 8.3.0');
	});

	it('refuses a missing or malformed transcript', () => {
		const ctx = testContext({ files: memoryFiles({ '/bad.json': '{' }) });
		expect(() => selectTransport(ctx, { replay: '/none' }, parseTarget('h', '/x'))).toThrow(
			UsageError
		);
		expect(() => selectTransport(ctx, { replay: '/bad.json' }, parseTarget('h', '/x'))).toThrow(
			/not a transcript/
		);
	});
});

describe('survey command', () => {
	it('prints the command plan and connects to nothing on a dry run', async () => {
		const ctx = testContext();
		await runSurveyCommand(ctx, {
			host: 'me@old.example',
			root: '/var/www/html',
			dryRun: true
		});
		const text = ctx.io.text();
		expect(text).toContain('nothing was executed');
		expect(text).toContain('$ php -v');
		expect(ctx.runner).toBeDefined();
	});

	it('writes the survey when asked, and reports where', async () => {
		const files = memoryFiles({ '/t.json': JSON.stringify(transcript()) });
		const ctx = testContext({ files });
		await runSurveyCommand(ctx, {
			host: 'me@old.example',
			root: '/var/www/html',
			replay: '/t.json',
			out: '/survey.json'
		});
		expect(JSON.parse(files.written.get('/survey.json') as string).drupal.version).toBe(
			'10.3.1'
		);
		expect(ctx.io.text()).toContain('written to /survey.json');
	});

	it('renders the errors it collected', async () => {
		const ctx = testContext({ files: memoryFiles({ '/t.json': '{}' }) });
		await runSurveyCommand(ctx, {
			host: 'me@old.example',
			root: '/var/www/html',
			replay: '/t.json'
		});
		expect(ctx.io.text()).toContain('errors');
	});
});

/**
 * `--resume` re-runs only the steps with neither a value nor a recorded error.
 *
 * A step that failed the same way twice will fail the same way a third time, so re-running it is
 * what turns a resume into a restart. The settled set is read off the SURVEY rather than off a
 * separate list, so a field that stops being filled cannot leave the two disagreeing.
 */
describe('runSurvey --resume', () => {
	it('skips every step that already produced a value', async () => {
		const first = await runSurvey(
			{ transport: replayTransport(transcript()), now: () => new Date(0) },
			'me@old.example',
			'/var/www/html'
		);

		// a transcript with only ONE entry: anything the resume re-ran would throw
		const only: Transcript = { [step('nodes')]: ok('COUNT(*)\n2000') };
		const resumed = await runSurvey(
			{ transport: replayTransport(only), now: () => new Date(0) },
			'me@old.example',
			'/var/www/html',
			first
		);
		expect(resumed.errors).toEqual([]);
		expect(resumed.php.version).toBe('8.2.15');
		expect(resumed.nodes).toBe(2000);
	});

	/**
	 * An OPTIONAL step that ran and failed leaves neither, and is the case a resume exists for.
	 *
	 * A required step's failure is recorded in `errors[]` and is therefore settled: it answered, and
	 * the answer was an error.
	 */
	it('re-runs a step that has neither a value nor an error', async () => {
		const partial = transcript();
		partial[step('nodes')] = fail(1, 'Lost connection to MySQL server');
		const first = await runSurvey(
			{ transport: replayTransport(partial), now: () => new Date(0) },
			'me@old.example',
			'/var/www/html'
		);
		expect(first.nodes).toBeNull();
		expect(first.errors).toEqual([]);

		const resumed = await runSurvey(
			{ transport: replayTransport(transcript()), now: () => new Date(0) },
			'me@old.example',
			'/var/www/html',
			first
		);
		expect(resumed.nodes).toBe(2000);
	});

	// a step recorded as failing is settled: it answered, and the answer was an error
	it('does not re-run a step whose failure was recorded', () => {
		const survey = emptySurvey('me@old.example', '/var/www/html');
		survey.errors.push({ id: 'drush-status', detail: 'exit 127' });
		expect(settledSteps(survey).has('drush-status')).toBe(true);
		expect(settledSteps(survey).has('nodes')).toBe(false);
	});
});

/**
 * The ssh retry, which terminates on an OBSERVATION rather than on the bound.
 *
 * ssh exits 255 for everything from a refused connection to a dropped session, and the remote
 * command never ran, so a retry cannot double anything. Any other exit code means the command ran
 * and its result is the answer, whatever the answer was.
 */
describe('the ssh retry', () => {
	const target = parseTarget('me@old.example', '/var/www/html');

	it('retries a transport failure up to the bound and then raises one error', async () => {
		let attempts = 0;
		const refusing = {
			run: async () => {
				attempts++;
				return { code: 255, stdout: '', stderr: 'Connection refused' };
			},
			spawn: async () => 0
		};
		await expect(sshTransport(refusing, target).exec('php -v')).rejects.toThrow(TransportError);
		expect(attempts).toBe(SSH_ATTEMPTS);
	});

	it('stops the moment the step produced output, whatever the exit code was', async () => {
		let attempts = 0;
		const flaky = {
			run: async () => {
				attempts++;
				return attempts === 1
					? { code: 255, stdout: '', stderr: 'kex_exchange_identification' }
					: { code: 0, stdout: 'PHP 8.2.15', stderr: '' };
			},
			spawn: async () => 0
		};
		const result = await sshTransport(flaky, target).exec('php -v');
		expect(result.stdout).toBe('PHP 8.2.15');
		expect(attempts).toBe(2);
	});

	// a non-zero exit that is not 255 is the command's own answer and must not be retried
	it('does not retry a command that ran and failed', async () => {
		let attempts = 0;
		const runner = {
			run: async () => {
				attempts++;
				return { code: 127, stdout: '', stderr: 'drush: command not found' };
			},
			spawn: async () => 0
		};
		const result = await sshTransport(runner, target).exec('drush status');
		expect(result.code).toBe(127);
		expect(attempts).toBe(1);
	});
});
