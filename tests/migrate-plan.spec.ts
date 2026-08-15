import { describe, expect, it } from 'vitest';
import { parseDirection, runPlanCommand } from '../src/commands/migrate';
import { FindingError, UsageError } from '../src/errors';
import { memoryFiles } from '../src/host/files';
import { buildPlan, renderPlan } from '../src/migrate/plan';
import { RULES, rulesFor } from '../src/migrate/rules';
import { emptySurvey, type SiteSurvey } from '../src/migrate/survey';
import { FALLBACK_TARGET_PHP, probedTarget, statedTarget } from '../src/migrate/target-runtime';
import { testContext } from './helpers';

function survey(over: Partial<SiteSurvey> = {}): SiteSurvey {
	return { ...emptySurvey('me@old.example', '/var/www/html'), ...over };
}

const idsOf = (s: SiteSurvey, to: 'to-worker' | 'to-vps' = 'to-worker') =>
	buildPlan(s, to).findings.map((f) => f.id);

const find = (s: SiteSurvey, id: string, to: 'to-worker' | 'to-vps' = 'to-worker') =>
	buildPlan(s, to).findings.find((f) => f.id === id);

describe('rule coverage', () => {
	it('every rule has a unique id and a direction', () => {
		const ids = RULES.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(RULES.every((r) => ['to-worker', 'to-vps', 'both'].includes(r.direction))).toBe(
			true
		);
	});

	it('splits the rule set by direction', () => {
		expect(rulesFor('to-worker').length + rulesFor('to-vps').length).toBe(RULES.length);
	});

	it('scores only what an empty survey genuinely establishes', () => {
		expect(idsOf(survey())).toEqual(['drush-absent', 'cron']);
	});
});

describe('db-driver', () => {
	it('treats MySQL as convertible', () => {
		const finding = find(
			survey({ database: { driver: 'mysql', name: 'd', bytes: null } }),
			'db-driver'
		);
		expect(finding?.severity).toBe('note');
		expect(finding?.detail).toContain('migrate convert');
	});

	it('treats SQLite as needing no conversion', () => {
		expect(
			find(survey({ database: { driver: 'sqlite', name: null, bytes: null } }), 'db-driver')
				?.severity
		).toBe('note');
	});

	it('blocks a driver it has no converter for', () => {
		const finding = find(
			survey({ database: { driver: 'pgsql', name: null, bytes: null } }),
			'db-driver'
		);
		expect(finding?.severity).toBe('blocker');
		expect(finding?.title).toContain('pgsql');
	});
});

describe('php-version', () => {
	it('warns below the target, naming the version and its provenance', () => {
		const finding = find(survey({ php: { version: '8.1.0', extensions: [] } }), 'php-version');
		expect(finding?.detail).toContain(FALLBACK_TARGET_PHP);
		// the figure is never presented as a measurement when it was not one
		expect(finding?.detail).toContain('assumed');
	});

	/**
	 * The regression. The rule hardcoded `minor >= 3` while the worker shipped 8.5, so a source on
	 * 8.4 was passed silently -- the display string and the comparison were two separate assertions
	 * of the same fact and both were stale.
	 */
	it('warns on 8.4 against a worker on 8.5', () => {
		expect(
			find(survey({ php: { version: '8.4.0', extensions: [] } }), 'php-version')
		).toBeDefined();
	});

	it('says nothing at or above the target', () => {
		expect(
			find(survey({ php: { version: '8.5.2', extensions: [] } }), 'php-version')
		).toBeUndefined();
		expect(
			find(survey({ php: { version: '9.0.0', extensions: [] } }), 'php-version')
		).toBeUndefined();
	});

	it('compares against a stated target rather than the fallback', () => {
		const plan = buildPlan(
			survey({ php: { version: '8.4.0', extensions: [] } }),
			'to-worker',
			statedTarget('8.4')
		);
		expect(plan.findings.find((f) => f.id === 'php-version')).toBeUndefined();
		expect(plan.target).toMatchObject({ php: '8.4', source: 'stated' });
	});

	it('reports a probed target as a measurement and prints it on the plan', () => {
		const plan = buildPlan(
			survey({ php: { version: '8.1.0', extensions: [] } }),
			'to-worker',
			probedTarget('8.5.2', 'https://x.dev')
		);
		expect(plan.findings.find((f) => f.id === 'php-version')?.detail).toContain(
			'the worker runs PHP 8.5.2'
		);
		expect(renderPlan(plan).join('\n')).toContain('Target: PHP 8.5.2 (probed)');
	});
});

describe('extensions and modules', () => {
	it('warns when the source loads an archive extension', () => {
		expect(
			find(survey({ php: { version: null, extensions: ['zip'] } }), 'ext-archive')?.title
		).toContain('zip');
	});

	it('blocks a module the runtime cannot host, and names the mechanism', () => {
		const finding = find(
			survey({ modules: ['node', 'redis', 'imagemagick'] }),
			'incompatible-modules'
		);
		expect(finding?.severity).toBe('blocker');
		expect(finding?.detail).toContain('socket extension');
		expect(finding?.detail).toContain('spawn a process');
	});

	it('warns about a module that needs an unprovisioned service', () => {
		expect(find(survey({ modules: ['search_api_solr'] }), 'service-modules')?.severity).toBe(
			'warning'
		);
	});

	it('says outright that a shell-out cannot be detected remotely', () => {
		expect(find(survey({ modules: ['node'] }), 'shellout-undetectable')?.severity).toBe('note');
	});
});

describe('platform ceilings', () => {
	it('warns when the image styles times the file count exceeds the monthly cap', () => {
		const finding = find(
			survey({ imageStyles: 10, files: { kb: null, count: 2000 } }),
			'image-transforms'
		);
		expect(finding?.severity).toBe('warning');
		expect(finding?.title).toContain('20,000');
	});

	it('says nothing when the worst case fits the cap', () => {
		expect(
			find(survey({ imageStyles: 2, files: { kb: null, count: 100 } }), 'image-transforms')
		).toBeUndefined();
	});

	it('warns when the files directory exceeds the per-asset ceiling', () => {
		expect(find(survey({ files: { kb: 40960, count: null } }), 'files-payload')?.severity).toBe(
			'warning'
		);
		expect(find(survey({ files: { kb: 1024, count: null } }), 'files-payload')).toBeUndefined();
	});

	it('warns on a database large enough to meet the statement ceiling', () => {
		const finding = find(
			survey({ database: { driver: null, name: null, bytes: 200 * 1024 * 1024 } }),
			'database-size'
		);
		expect(finding?.detail).toContain('100,000');
	});

	it('scales the regeneration finding with the node count', () => {
		expect(find(survey({ nodes: 500 }), 'regeneration-ceiling')).toBeUndefined();
		expect(find(survey({ nodes: 2000 }), 'regeneration-ceiling')?.severity).toBe('note');
		expect(find(survey({ nodes: 20000 }), 'regeneration-ceiling')?.severity).toBe('warning');
	});

	it('warns when drush is absent, because the survey is then scoring blanks', () => {
		expect(find(survey(), 'drush-absent')?.severity).toBe('warning');
		expect(find(survey({ drush: '12.5.1' }), 'drush-absent')).toBeUndefined();
	});
});

describe('the off-boarding direction', () => {
	it('names the gate, the files gap and the structure-only bins', () => {
		const plan = buildPlan(survey(), 'to-vps');
		expect(plan.findings.map((f) => f.id)).toEqual([
			'export-gated',
			'export-structure-only',
			'export-files',
			'hash-salt',
			'dialect-out'
		]);
		expect(plan.counts.blocker).toBe(2);
	});

	it('points at the envelope field rather than restating which tables are structure-only', () => {
		const detail = find(survey(), 'export-structure-only', 'to-vps')?.detail ?? '';
		expect(detail).toContain('structureOnly');
		// the list itself is the worker's to own; naming the tables here is what goes stale
		expect(detail).not.toMatch(/watchdog|cachetags|cfw_page/);
	});
});

describe('buildPlan', () => {
	it('reports what the survey did not measure rather than passing it', () => {
		expect(buildPlan(survey(), 'to-worker').unknowns).toEqual([
			'php.version',
			'drupal.version',
			'database.driver',
			'database.bytes',
			'files.kb',
			'files.count',
			'modules',
			'nodes',
			'imageStyles'
		]);
	});

	it('drops a field from the unknowns once it is measured', () => {
		expect(buildPlan(survey({ nodes: 3 }), 'to-worker').unknowns).not.toContain('nodes');
	});

	it('orders six steps per direction and names the direction', () => {
		expect(buildPlan(survey(), 'to-worker').steps).toHaveLength(6);
		expect(buildPlan(survey(), 'to-vps').steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it('puts the source host into the commands it prints', () => {
		expect(buildPlan(survey(), 'to-worker').steps[0]?.command).toContain('me@old.example');
	});
});

describe('renderPlan', () => {
	it('groups by severity and lists the steps', () => {
		const text = renderPlan(buildPlan(survey({ modules: ['redis'] }), 'to-worker')).join('\n');
		expect(text).toContain('VPS to Worker');
		expect(text).toContain('BLOCKERS (1)');
		expect(text).toContain('NOT MEASURED');
		expect(text).toContain('STEPS');
	});

	it('omits a severity with no findings', () => {
		expect(renderPlan(buildPlan(survey(), 'to-vps')).join('\n')).not.toContain('WARNINGS');
	});
});

describe('parseDirection', () => {
	it('accepts the spellings the CLI and the rules use', () => {
		expect(parseDirection('workers')).toBe('to-worker');
		expect(parseDirection('worker')).toBe('to-worker');
		expect(parseDirection('vps')).toBe('to-vps');
		expect(parseDirection('to-vps')).toBe('to-vps');
	});

	it('refuses anything else', () => {
		expect(() => parseDirection('cloud')).toThrow(UsageError);
	});
});

describe('plan command', () => {
	it('plans from a written survey', async () => {
		const ctx = testContext({
			files: memoryFiles({ '/s.json': JSON.stringify(survey({ nodes: 10 })) })
		});
		await runPlanCommand(ctx, { survey: '/s.json', to: 'workers' });
		expect(ctx.io.text()).toContain('me@old.example');
	});

	it('plans with no survey at all, reporting everything as unmeasured', async () => {
		const ctx = testContext();
		await runPlanCommand(ctx, { to: 'workers', json: true });
		expect(ctx.io.json<{ unknowns: string[] }>().unknowns).toHaveLength(9);
	});

	it('exits with a finding when a blocker is present', async () => {
		const ctx = testContext({
			files: memoryFiles({ '/s.json': JSON.stringify(survey({ modules: ['redis'] })) })
		});
		await expect(runPlanCommand(ctx, { survey: '/s.json', to: 'workers' })).rejects.toThrow(
			FindingError
		);
	});

	it('refuses a survey path that does not exist', async () => {
		await expect(
			runPlanCommand(testContext(), { survey: '/none', to: 'workers' })
		).rejects.toThrow(UsageError);
	});
});
