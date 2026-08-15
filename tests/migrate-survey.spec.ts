import { describe, expect, it } from 'vitest';
import { runSurveyCommand, selectTransport } from '../src/commands/migrate';
import { UsageError } from '../src/errors';
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
	surveyPlan
} from '../src/migrate/survey';
import { parseTarget } from '../src/migrate/target';
import { replayTransport, type Transcript } from '../src/migrate/transport';
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
