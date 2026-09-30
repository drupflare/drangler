import { describe, expect, it } from 'vitest';
import { parseDirection, runPlanCommand } from '../src/commands/migrate';
import { FindingError, UsageError } from '../src/errors';
import { memoryFiles } from '../src/host/files';
import { buildPlan, renderPlan } from '../src/migrate/plan';
import { parseSettings, settingsReport } from '../src/migrate/preview';
import { LIMITS, RULES, rulesFor, type ExportEnvelope } from '../src/migrate/rules';
import {
	allowsDrupal11,
	declaredExtensions,
	scanExtensionCalls,
	type SourceCode
} from '../src/migrate/source-code';
import { emptySurvey, type SiteSurvey } from '../src/migrate/survey';
import {
	assumedTarget,
	FALLBACK_TARGET_PHP,
	probedTarget,
	SHIPPED_DRUPAL,
	statedTarget
} from '../src/migrate/target-runtime';
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

	it('splits the rule set by direction, with a `both` rule counted in each', () => {
		const both = RULES.filter((r) => r.direction === 'both').length;
		expect(rulesFor('to-worker').length + rulesFor('to-vps').length).toBe(RULES.length + both);
		// the source has to be sound whichever way the data is moving
		expect(both).toBeGreaterThan(0);
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

	it('converts PostgreSQL, naming the command', () => {
		const finding = find(
			survey({ database: { driver: 'pgsql', name: null, bytes: null } }),
			'db-driver'
		);
		expect(finding?.severity).toBe('note');
		expect(finding?.detail).toContain('--from pgsql --to sqlite');
	});

	it('blocks a driver it has no converter for', () => {
		const finding = find(
			survey({ database: { driver: 'sqlsrv', name: null, bytes: null } }),
			'db-driver'
		);
		expect(finding?.severity).toBe('blocker');
		expect(finding?.title).toContain('sqlsrv');
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
	it('notes zip, which a stand-in serves, and warns about Phar, which nothing serves', () => {
		const zip = find(survey({ php: { version: null, extensions: ['zip'] } }), 'ext-archive');
		expect(zip?.severity).toBe('note');
		expect(zip?.detail).toContain('ZipArchive');
		const phar = find(
			survey({ php: { version: null, extensions: ['zip', 'Phar'] } }),
			'ext-archive'
		);
		expect(phar?.severity).toBe('warning');
		expect(phar?.title).toContain('Phar');
	});

	it('blocks MongoDB storage, and names the mechanism', () => {
		const finding = find(
			survey({ modules: ['node', 'mongodb', 'mongodb_storage'] }),
			'incompatible-modules'
		);
		expect(finding?.severity).toBe('blocker');
		expect(finding?.detail).toContain('ext-mongodb');
	});

	it('warns rather than blocks for modules the worker covers, saying what changes', () => {
		const plan = buildPlan(
			survey({
				modules: ['node', 'imagemagick', 'imageapi_optimize_binaries', 'automatic_updates']
			}),
			'to-worker'
		);
		expect(plan.findings.find((f) => f.id === 'incompatible-modules')).toBeUndefined();
		const handled = plan.findings.find((f) => f.id === 'handled-modules');
		expect(handled?.severity).toBe('warning');
		expect(handled?.detail).toContain('cfw_images');
		expect(handled?.detail).toContain('exec()');
		expect(handled?.detail).toContain('drangler update');
	});

	it('blocks memcache until it is uninstalled, and says why that is enough', () => {
		for (const m of ['memcache', 'memcache_storage']) {
			const finding = find(survey({ modules: ['node', m] }), 'incompatible-modules');
			expect(finding?.severity).toBe('blocker');
			expect(finding?.detail).toContain('uninstall it before migrating');
		}
	});

	it('treats the MongoDB logger alone as a warning, and MongoDB storage as a blocker', () => {
		const logger = buildPlan(survey({ modules: ['mongodb', 'mongodb_watchdog'] }), 'to-worker');
		expect(logger.findings.find((f) => f.id === 'incompatible-modules')).toBeUndefined();
		expect(logger.findings.find((f) => f.id === 'handled-modules')?.detail).toContain('dblog');
		const storage = buildPlan(
			survey({ modules: ['mongodb', 'mongodb_watchdog', 'mongodb_storage'] }),
			'to-worker'
		);
		expect(storage.findings.find((f) => f.id === 'incompatible-modules')?.severity).toBe(
			'blocker'
		);
	});

	it('warns about a module that needs an unprovisioned service', () => {
		expect(find(survey({ modules: ['search_api_solr'] }), 'service-modules')?.severity).toBe(
			'warning'
		);
	});

	/**
	 * Both are `verified` in `worker/src/ops/module-table.ts` and both were refused here.
	 *
	 * `redis` was refused for "the interpreter has no socket extension"; its socket is answered by
	 * the Zend park. `search_api_solr` was refused for an unprovisioned Solr host, which was never
	 * its blocker -- a transitive `php-64bit` constraint aborted every request before Drupal booted,
	 * and the long64 build satisfies it. A refusal outlives its mechanism silently, so both
	 * directions are asserted.
	 */
	it('does not block redis or search_api_solr, and names why each one now runs', () => {
		const plan = buildPlan(survey({ modules: ['redis', 'search_api_solr'] }), 'to-worker');
		expect(plan.findings.find((f) => f.id === 'incompatible-modules')).toBeUndefined();
		expect(plan.counts.blocker).toBe(0);

		const service = plan.findings.find((f) => f.id === 'service-modules');
		expect(service?.severity).toBe('warning');
		expect(service?.detail).toContain('Zend park');
		expect(service?.detail).toContain('REDIS_URL');
		expect(service?.detail).toContain('php-64bit');
		expect(service?.detail).not.toContain('socket extension');
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
		expect(find(survey({ nodes: 20 }), 'regeneration-ceiling')).toBeUndefined();
		expect(find(survey({ nodes: 2000 }), 'regeneration-ceiling')?.severity).toBe('note');
		expect(find(survey({ nodes: 20000 }), 'regeneration-ceiling')?.severity).toBe('warning');
	});

	/**
	 * The rule used to divide by `rendersPerDayCold: 1_052` and `rendersPerDayWindowed: 7_575`.
	 *
	 * Neither figure was derived anywhere in either repository, and a plan a user acts on is the
	 * last place an invented ceiling belongs. The span comes from two sourced numbers instead: the
	 * free windowed row budget, and the measured 2-to-156 rows a single page fill writes.
	 */
	it('prints a span from sourced figures rather than a single invented ceiling', () => {
		const finding = find(survey({ nodes: 10_000 }), 'regeneration-ceiling');
		expect(finding?.title).toContain('spans 2 to 144 day(s)');
		expect(finding?.detail).toContain('10,869 rows/day');
		expect(finding?.detail).toContain('2 to 156 rows');
		expect(finding?.detail).toContain('free-envelope.ts');
		expect(LIMITS).not.toHaveProperty('rendersPerDayCold');
		expect(LIMITS).not.toHaveProperty('rendersPerDayWindowed');
	});

	it('warns when drush is absent, because the survey is then scoring blanks', () => {
		expect(find(survey(), 'drush-absent')?.severity).toBe('warning');
		expect(find(survey({ drush: '12.5.1' }), 'drush-absent')).toBeUndefined();
	});
});

/**
 * The off-boarding direction, which used to be five fixed paragraphs.
 *
 * Every `to-vps` rule declared `evaluate()` with no parameters and returned a constant, so the whole
 * direction was prose rather than a measurement. Each one reads a real `/export` envelope now, and a
 * rule with no envelope returns null so the criterion reports as unmeasured rather than as a pass.
 */
describe('the off-boarding direction', () => {
	const envelope = (over: Partial<ExportEnvelope> = {}): ExportEnvelope => ({
		status: 200,
		replayable: true,
		maxStatementChars: 4_200,
		tables: { node: 20, cfw_file: 4, cfw_file_chunk: 12 },
		structureOnly: ['cache_page', 'sessions'],
		secrets: false,
		...over
	});

	const withEnvelope = (over: Partial<ExportEnvelope> = {}) =>
		buildPlan(survey(), 'to-vps', assumedTarget(), envelope(over));

	it('measures nothing it was given no envelope for', () => {
		const ids = buildPlan(survey(), 'to-vps').findings.map((f) => f.id);
		// only the rules that depend on nothing remote
		expect(ids).toEqual(['substitutions', 'hash-salt', 'dialect-out']);
	});

	it('reads the credential, the ceiling, the file rows and the bins off the envelope', () => {
		const ids = withEnvelope().findings.map((f) => f.id);
		expect(ids).toContain('export-token');
		expect(ids).toContain('export-replayable');
		expect(ids).toContain('export-structure-only');
		expect(ids).toContain('export-files');
		expect(ids).toContain('export-secrets');
	});

	/**
	 * `/export` moved into `OWNER_ROUTES` and this rule went on saying it 404s.
	 *
	 * `src/commands/migrate.ts` already said the opposite in its own 404 message, so two files here
	 * contradicted each other and the wrong one was what a user read before deciding whether they
	 * could leave at all.
	 */
	it('does not call the owner-gated export a blocker', () => {
		const reachable = withEnvelope().findings.find((f) => f.id === 'export-token');
		expect(reachable?.severity).toBe('note');
		expect(reachable?.detail).toContain('owner tier');
		expect(reachable?.detail).toContain('PW_DIAGNOSTICS');

		// the two real refusals, which the status is what distinguishes
		expect(
			withEnvelope({ status: 401 }).findings.find((f) => f.id === 'export-token')
		).toMatchObject({ severity: 'blocker' });
		expect(
			withEnvelope({ status: 404 }).findings.find((f) => f.id === 'export-token')?.detail
		).toContain('too old');
	});

	/**
	 * The bytes DO leave; what is missing is the tool that writes them back.
	 *
	 * `cfw_file` and `cfw_file_chunk` are not in the worker's `REGENERABLE_TABLES`, so both are
	 * dumped with rows. The old finding said the export carried no managed files at all, which sent
	 * a user to copy a files tree that is already in the dump they are holding.
	 */
	it('names the unpack step rather than claiming the bytes never left', () => {
		const files = withEnvelope().findings.find((f) => f.id === 'export-files');
		expect(files?.severity).toBe('blocker');
		expect(files?.detail).toContain('cfw_file_chunk');
		expect(files?.detail).toContain('migrate files --from-dump');
		expect(files?.detail).not.toContain('dumps the database only');
	});

	it('is a note rather than a blocker on a site with no uploads at all', () => {
		const none = withEnvelope({ tables: { node: 20 } }).findings.find(
			(f) => f.id === 'export-files'
		);
		expect(none?.severity).toBe('note');
	});

	it('blocks a dump the worker itself says cannot be replayed', () => {
		const refused = withEnvelope({
			replayable: false,
			maxStatementChars: 960_544
		}).findings.find((f) => f.id === 'export-replayable');
		expect(refused?.severity).toBe('blocker');
		expect(refused?.detail).toContain('960,544');
	});

	it('names the structure-only tables the envelope reported rather than a list of its own', () => {
		const finding = withEnvelope().findings.find((f) => f.id === 'export-structure-only');
		expect(finding?.detail).toContain('cache_page, sessions');
		expect(finding?.title).toContain('2 table(s)');
	});

	// the safe default is a warning too: the salt a restore needs is the one it withholds
	it('warns either way about the secrets in the dump', () => {
		expect(
			withEnvelope({ secrets: true }).findings.find((f) => f.id === 'export-secrets')
		).toMatchObject({ severity: 'warning' });
		const without = withEnvelope({ secrets: false }).findings.find(
			(f) => f.id === 'export-secrets'
		);
		expect(without?.severity).toBe('warning');
		expect(without?.detail).toContain('hash_salt');
	});

	it('enumerates the substitutions rather than summarising them', () => {
		const finding = withEnvelope().findings.find((f) => f.id === 'substitutions');
		expect(finding?.severity).toBe('blocker');
		expect(finding?.detail).toContain('CfwCacheBackendFactory');
	});
});

/**
 * Every verdict names the field it was read from.
 *
 * A verdict whose evidence a reader cannot follow back to a byte is the class of claim this
 * workspace has recorded being wrong about repeatedly.
 */
describe('evidence', () => {
	it('is carried by every finding either direction produces', () => {
		const plans = [
			buildPlan(survey({ drush: '12.5.1', modules: ['redis'] }), 'to-worker'),
			buildPlan(survey(), 'to-vps', assumedTarget(), {
				status: 200,
				replayable: true,
				tables: { cfw_file: 1, cfw_file_chunk: 2 },
				structureOnly: [],
				secrets: false
			})
		];
		for (const plan of plans) {
			expect(plan.findings.length).toBeGreaterThan(0);
			for (const finding of plan.findings) {
				expect(finding.evidence, finding.id).not.toBe('');
			}
		}
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
		const text = renderPlan(
			buildPlan(survey({ modules: ['mongodb', 'mongodb_storage'] }), 'to-worker')
		).join('\n');
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
			files: memoryFiles({
				'/s.json': JSON.stringify(survey({ modules: ['mongodb', 'mongodb_storage'] }))
			})
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

// #region drupal version and source files

const drupal = (version: string) => ({ version, profile: null, uri: null, root: null });

const sourceOf = (
	files: { path: string; text: string }[],
	over: Partial<SourceCode> = {}
): SourceCode => ({ files, lock: null, settings: null, ...over });

const planWith = (s: SiteSurvey, source: SourceCode) =>
	buildPlan(s, 'to-worker', assumedTarget(), null, source);

describe('drupal-version', () => {
	it('warns on Drupal 10 and names the update chain as the way in', () => {
		const finding = find(survey({ drupal: drupal('10.4.2') }), 'drupal-version');
		expect(finding?.severity).toBe('warning');
		expect(finding?.detail).toContain('drangler site updb');
		expect(finding?.detail).toContain('Drupal 11 release');
	});

	it('blocks Drupal 9, and anything ahead of the worker', () => {
		expect(find(survey({ drupal: drupal('9.5.11') }), 'drupal-version')?.severity).toBe(
			'blocker'
		);
		expect(find(survey({ drupal: drupal('12.0.0') }), 'drupal-version')?.severity).toBe(
			'blocker'
		);
	});

	it('notes a different pin on 11.x and says the constraint is rewritten', () => {
		const finding = find(survey({ drupal: drupal('11.2.0') }), 'drupal-version');
		expect(finding?.severity).toBe('note');
		expect(finding?.detail).toContain(`rewritten to that version`);
		expect(find(survey({ drupal: drupal(SHIPPED_DRUPAL) }), 'drupal-version')).toBeUndefined();
	});

	it('scores nothing for an unread version', () => {
		expect(find(survey(), 'drupal-version')).toBeUndefined();
	});
});

describe('module-core-compat', () => {
	const info = (name: string, body: string) => ({
		path: `modules/contrib/${name}/${name}.info.yml`,
		text: `name: ${name}\ntype: module\n${body}`
	});

	it('reads which requirements admit Drupal 11', () => {
		expect(allowsDrupal11('^10.3 || ^11')).toBe(true);
		expect(allowsDrupal11('^11')).toBe(true);
		expect(allowsDrupal11('>=10.3')).toBe(true);
		expect(allowsDrupal11('^10')).toBe(false);
		expect(allowsDrupal11('~10.3')).toBe(false);
		expect(allowsDrupal11('>=10.3 <11')).toBe(false);
		expect(allowsDrupal11('^9 || ^10')).toBe(false);
	});

	it('names the enabled modules that do not declare ^11, and only those', () => {
		const s = survey({
			drupal: drupal('10.3.1'),
			modules: ['node', 'old_mod', 'ok_mod', 'bare_mod']
		});
		const plan = planWith(
			s,
			sourceOf([
				info('old_mod', 'core_version_requirement: ^10'),
				info('ok_mod', "core_version_requirement: '^10.3 || ^11'"),
				info('bare_mod', 'core: 8.x'),
				info('unused_mod', 'core_version_requirement: ^10')
			])
		);
		const finding = plan.findings.find((f) => f.id === 'module-core-compat');
		expect(finding?.severity).toBe('warning');
		expect(finding?.detail).toContain('old_mod (core_version_requirement ^10)');
		expect(finding?.detail).toContain('bare_mod (no core_version_requirement)');
		expect(finding?.detail).not.toContain('ok_mod');
		expect(finding?.detail).not.toContain('unused_mod');
	});

	it('is silent without a code tree, and for a source already on 11', () => {
		const s = survey({ drupal: drupal('10.3.1'), modules: ['old_mod'] });
		expect(idsOf(s)).not.toContain('module-core-compat');
		const on11 = survey({ drupal: drupal('11.2.0'), modules: ['old_mod'] });
		const files = [info('old_mod', 'core_version_requirement: ^10')];
		expect(planWith(on11, sourceOf(files)).findings.map((f) => f.id)).not.toContain(
			'module-core-compat'
		);
	});
});

describe('declared and called extensions', () => {
	const php = (path: string, text: string) => ({ path, text });
	const composer = (require: Record<string, string>) => ({
		path: 'modules/contrib/farm/composer.json',
		text: JSON.stringify({ name: 'drupal/farm', require })
	});

	it('finds calls by function and class name, with file and line', () => {
		const calls = scanExtensionCalls([
			php(
				'modules/custom/a/a.module',
				[
					'<?php',
					'// bcadd is only a word here',
					'$x = bcadd(1, 2);',
					'$g = new \\GEOSWKTReader();',
					'$d = cal_days_in_month(CAL_GREGORIAN, 2, 2020);',
					'$k = sodium_crypto_secretbox($m, $n, $k);',
					'$h = sodium_crypto_generichash($m);'
				].join('\n')
			)
		]);
		expect(calls['bcmath']).toEqual([
			{ path: 'modules/custom/a/a.module', line: 3, guarded: false }
		]);
		expect(calls['geos']?.[0]?.line).toBe(4);
		expect(calls['calendar']?.[0]?.line).toBe(5);
		expect(calls['sodium']?.map((c) => c.line)).toEqual([6]);
	});

	it('marks a call guarded, and skips definitions and polyfills', () => {
		const calls = scanExtensionCalls([
			php(
				'modules/custom/a/a.module',
				"<?php\nif (function_exists('bcadd')) { $x = bcadd(1, 2); }\n"
			),
			php(
				'modules/custom/b/b.module',
				"<?php\nif (!function_exists('bcsub')) {\nfunction bcsub($a) {}\n}\n"
			),
			php('libraries/polyfill-bcmath/bootstrap.php', '<?php\n$x = bcmul(1, 2);\n')
		]);
		expect(calls['bcmath']).toEqual([
			{ path: 'modules/custom/a/a.module', line: 2, guarded: true }
		]);
	});

	it('reads ext-* from a module composer.json and from the lock', () => {
		const lock = JSON.stringify({
			packages: [{ name: 'farmos/x', require: { 'ext-geos': '*', 'ext-json': '*' } }]
		});
		expect(declaredExtensions([composer({ 'ext-bcmath': '*', php: '>=8' })], lock)).toEqual([
			{ extension: 'bcmath', by: 'drupal/farm' },
			{ extension: 'geos', by: 'farmos/x' }
		]);
	});

	it('notes a declared extension nothing calls', () => {
		const plan = planWith(
			survey(),
			sourceOf([composer({ 'ext-bcmath': '*', 'ext-calendar': '*' })])
		);
		const finding = plan.findings.find((f) => f.id === 'extensions-declared');
		expect(finding?.severity).toBe('note');
		expect(finding?.detail).toContain('ext-bcmath by drupal/farm');
		expect(plan.findings.map((f) => f.id)).not.toContain('extensions-called');
	});

	it('blocks a declared, unguarded call and names the site', () => {
		const plan = planWith(
			survey(),
			sourceOf([
				composer({ 'ext-bcmath': '*' }),
				php('modules/custom/a/a.module', '<?php\n$x = bcadd(1, 2);\n')
			])
		);
		const finding = plan.findings.find((f) => f.id === 'extensions-called');
		expect(finding?.severity).toBe('blocker');
		expect(finding?.detail).toContain('modules/custom/a/a.module:2');
		expect(plan.findings.map((f) => f.id)).not.toContain('extensions-declared');
	});

	it('only warns on an undeclared call or a guarded one', () => {
		const call = php('modules/custom/a/a.module', '<?php\n$x = bcadd(1, 2);\n');
		expect(
			planWith(survey(), sourceOf([call])).findings.find((f) => f.id === 'extensions-called')
				?.severity
		).toBe('warning');
		const guarded = php(
			'modules/custom/a/a.module',
			"<?php\nif (extension_loaded('bcmath')) { $x = bcadd(1, 2); }\n"
		);
		expect(
			planWith(survey(), sourceOf([composer({ 'ext-bcmath': '*' }), guarded])).findings.find(
				(f) => f.id === 'extensions-called'
			)?.severity
		).toBe('warning');
	});

	it('scores nothing without a code tree', () => {
		expect(idsOf(survey())).not.toContain('extensions-called');
		expect(idsOf(survey())).not.toContain('extensions-declared');
	});
});

describe('settings translation', () => {
	const report = (lines: string[]) => settingsReport(parseSettings(lines.join('\n')));

	it('drops memcache settings with a note', () => {
		const settings = report([
			"$settings['memcache']['servers'] = ['127.0.0.1:11211' => 'default'];",
			"$settings['cache']['default'] = 'cache.backend.memcache';"
		]);
		expect(settings.memcache).toEqual(['memcache.servers', 'cache.default']);
		const finding = planWith(survey(), sourceOf([], { settings })).findings.find(
			(f) => f.id === 'settings-memcache'
		);
		expect(finding?.severity).toBe('note');
	});

	it('translates a literal phpredis connection to REDIS_URL without printing it', () => {
		const settings = report([
			"$settings['redis.connection']['interface'] = 'PhpRedis';",
			"$settings['redis.connection']['host'] = 'cache.internal';",
			"$settings['redis.connection']['port'] = 6380;",
			"$settings['redis.connection']['password'] = 'p@ss/w:rd';"
		]);
		expect(settings.redisUrl).toBe('redis://:p%40ss%2Fw%3Ard@cache.internal:6380');
		const plan = planWith(survey(), sourceOf([], { settings }));
		const finding = plan.findings.find((f) => f.id === 'settings-redis');
		expect(finding?.severity).toBe('note');
		expect(JSON.stringify(plan)).not.toContain('p%40ss');
		expect(JSON.stringify(plan)).not.toContain('p@ss');
	});

	it('takes the redis defaults only for the port, and lets settings.local.php override', () => {
		expect(report(["$settings['redis.connection']['host'] = '10.0.0.5';"]).redisUrl).toBe(
			'redis://10.0.0.5:6379'
		);
		expect(
			report([
				"$settings['redis.connection']['host'] = '10.0.0.5';",
				"$settings['redis.connection']['host'] = '10.0.0.9';"
			]).redisUrl
		).toBe('redis://10.0.0.9:6379');
	});

	it('names an expression instead of guessing, and refuses a unix socket', () => {
		const expr = report([
			"$settings['redis.connection']['host'] = getenv('REDIS_HOST');",
			"$settings['redis.connection']['port'] = 6379;"
		]);
		expect(expr.redisUrl).toBeNull();
		expect(expr.redisExpressions).toEqual(['redis.connection.host']);
		const whole = report(["$settings['redis.connection'] = ['host' => 'x'];"]);
		expect(whole.redisExpressions).toEqual(['redis.connection']);
		const socket = report(["$settings['redis.connection']['host'] = '/var/run/redis.sock';"]);
		expect(socket.redisUrl).toBeNull();
		expect(socket.redisNote).toContain('unix socket');
		const finding = planWith(survey(), sourceOf([], { settings: expr })).findings.find(
			(f) => f.id === 'settings-redis'
		);
		expect(finding?.severity).toBe('warning');
	});

	it('reports s3 settings as needing a file store, and translates none of them', () => {
		const settings = report([
			"$settings['s3fs.use_s3_for_public'] = TRUE;",
			"$config['s3fs.settings']['bucket'] = 'assets';",
			"$settings['file_public_path'] = 's3://public';"
		]);
		expect(settings.s3).toEqual([
			's3fs.use_s3_for_public',
			'config:s3fs.settings.bucket',
			'file_public_path'
		]);
		const finding = planWith(survey(), sourceOf([], { settings })).findings.find(
			(f) => f.id === 'settings-s3'
		);
		expect(finding?.severity).toBe('warning');
		expect(finding?.detail).toContain('R2');
	});

	it('finds nothing in a settings file with none of these', () => {
		const settings = report([
			"$settings['hash_salt'] = 'x';",
			"$config['system.site']['name'] = 'a';"
		]);
		expect(settings).toEqual({
			memcache: [],
			redisUrl: null,
			redisNote: null,
			redisExpressions: [],
			s3: []
		});
	});
});

describe('plan --code', () => {
	it('reads modules, the lock and settings from a local tree', async () => {
		const ctx = testContext({
			files: memoryFiles({
				'/s.json': JSON.stringify(
					survey({ drupal: drupal('10.3.1'), modules: ['old_mod'] })
				),
				'/site/modules/contrib/old_mod/old_mod.info.yml':
					'name: Old\ncore_version_requirement: ^10\n',
				'/site/modules/contrib/old_mod/composer.json': JSON.stringify({
					name: 'drupal/old_mod',
					require: { 'ext-calendar': '*' }
				}),
				'/site/sites/default/settings.php':
					"<?php\n$settings['memcache']['servers'] = [];\n$settings['redis.connection']['host'] = 'r';\n"
			})
		});
		await runPlanCommand(ctx, { survey: '/s.json', to: 'workers', code: '/site', json: true });
		const ids = ctx.io.json<{ findings: { id: string }[] }>().findings.map((f) => f.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				'module-core-compat',
				'extensions-declared',
				'settings-memcache',
				'settings-redis'
			])
		);
		expect(ctx.io.text()).not.toContain('redis://');
	});

	it('refuses a directory that does not exist', async () => {
		await expect(
			runPlanCommand(testContext(), { to: 'workers', code: '/none' })
		).rejects.toThrow(UsageError);
	});
});

// #endregion
