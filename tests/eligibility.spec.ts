import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runEligibility, verdictOf, type EligibilityReport } from '../src/commands/eligibility';
import { DranglerError, EXIT, FindingError, UsageError } from '../src/errors';
import type { FetchLike } from '../src/health/probe';
import { memoryFiles } from '../src/host/files';
import { substitutionClasses, SUBSTITUTIONS } from '../src/migrate/substitutions';
import { emptySurvey, type SiteSurvey } from '../src/migrate/survey';
import { FALLBACK_TARGET_PHP } from '../src/migrate/target-runtime';
import { run } from '../src/run';
import { testContext, testGlobals, type TestContext } from './helpers';

const ORIGIN = 'https://mysite.example';
const SURVEY = '/work/survey.json';

/** everything a to-worker plan needs measured, so an unmeasured field is the only unknown */
function measured(over: Partial<SiteSurvey> = {}): SiteSurvey {
	return {
		...emptySurvey('me@old.example', '/var/www/html'),
		// the same version the destination runs, so nothing warns about being behind it
		php: { version: FALLBACK_TARGET_PHP, extensions: ['curl', 'pdo_mysql'] },
		drush: '12.5.1',
		drupal: { version: '10.3.1', profile: 'standard', uri: null, root: '/var/www/html' },
		database: { driver: 'sqlite', name: 'drupal', bytes: 1_048_576 },
		files: { kb: 100, count: 4 },
		dbAlive: true,
		fileRows: 4,
		modules: ['node'],
		nodes: 10,
		imageStyles: 2,
		...over
	};
}

function ctxFor(survey: SiteSurvey, fetch?: FetchLike): TestContext {
	return testContext({
		files: memoryFiles({ [SURVEY]: JSON.stringify(survey) }),
		cwd: '/work',
		...(fetch === undefined ? {} : { fetch })
	});
}

const globalsFor = (ctx: TestContext, over = {}) =>
	testGlobals({ json: true, ...over }, ctx, { site: ORIGIN, token: 'tok' });

/**
 * The four verdicts, and the fourth is why the exit set has four values.
 *
 * A criterion that could not be MEASURED is exit 1, never a `GO` with a caveat. `GO WITH CHANGES`
 * and `NO` share exit 3, which is correct under the closed set: both are "the check ran and found
 * something", and the distinction lives in the verdict rather than in a fifth code.
 */
describe('the verdict set', () => {
	const note = { id: 'a', evidence: 'x', severity: 'note' as const, detail: '' };
	const warn = { ...note, id: 'b', severity: 'warning' as const };
	const block = { ...note, id: 'c', severity: 'blocker' as const };
	const unmeasured = { ...note, id: 'd', severity: null };

	it('reaches GO only when everything was measured and nothing found', () => {
		expect(verdictOf([note], false)).toBe('GO');
		expect(verdictOf([], false)).toBe('GO');
	});

	it('reaches GO WITH CHANGES on a warning and NO on a blocker', () => {
		expect(verdictOf([note, warn], false)).toBe('GO WITH CHANGES');
		expect(verdictOf([warn, block], false)).toBe('NO');
	});

	it('reaches no verdict when a criterion measured nothing', () => {
		expect(verdictOf([note, unmeasured], false)).toBe('no verdict');
		// and --assume-worst turns each one into a blocker, which is a verdict with a reason
		expect(verdictOf([note, { ...unmeasured, severity: 'blocker' }], true)).toBe('NO');
	});
});

describe('to workers', () => {
	it('exits 0 on a survey that measured everything and found nothing', async () => {
		const ctx = ctxFor(measured());
		await runEligibility(ctx, { survey: SURVEY, globals: globalsFor(ctx) });
		const report = ctx.io.json<EligibilityReport>();
		expect(report.verdict).toBe('GO');
		expect(report.unmeasured).toEqual([]);
	});

	it('exits 3 with GO WITH CHANGES when a criterion is a warning', async () => {
		const ctx = ctxFor(measured({ php: { version: '8.1.2', extensions: ['zip'] } }));
		await expect(
			runEligibility(ctx, { survey: SURVEY, globals: globalsFor(ctx) })
		).rejects.toBeInstanceOf(FindingError);
		expect(ctx.io.json<EligibilityReport>().verdict).toBe('GO WITH CHANGES');
	});

	it('exits 3 with NO when a criterion is a blocker', async () => {
		const ctx = ctxFor(measured({ modules: ['memcache'] }));
		await expect(
			runEligibility(ctx, { survey: SURVEY, globals: globalsFor(ctx) })
		).rejects.toBeInstanceOf(FindingError);
		expect(ctx.io.json<EligibilityReport>().verdict).toBe('NO');
	});

	/** the check could not run, which is a different fact from the check finding something */
	it('exits 1 with no verdict when a criterion measured nothing', async () => {
		const ctx = ctxFor(measured({ nodes: null }));
		const failure = (await runEligibility(ctx, {
			survey: SURVEY,
			globals: globalsFor(ctx)
		}).then(
			() => null,
			(e: unknown) => e as DranglerError
		)) as DranglerError;
		expect(failure.code).toBe('eligibility-unmeasured');
		expect(failure.exitCode).toBe(EXIT.FAILED);
		expect(ctx.io.json<EligibilityReport>().unmeasured).toContain('nodes');
	});

	it('--assume-worst turns an unmeasured criterion into a blocker with a reason', async () => {
		const ctx = ctxFor(measured({ nodes: null }));
		await expect(
			runEligibility(ctx, { survey: SURVEY, assumeWorst: true, globals: globalsFor(ctx) })
		).rejects.toBeInstanceOf(FindingError);
		const report = ctx.io.json<EligibilityReport>();
		expect(report.verdict).toBe('NO');
		expect(report.criteria.find((c) => c.id === 'nodes')?.detail).toContain('--assume-worst');
	});

	// it decides whether the compiled-plan tier ever runs, so it is listed rather than dropped
	it('says the authenticated share is not measurable from a survey', async () => {
		const ctx = ctxFor(measured());
		await runEligibility(ctx, { survey: SURVEY, globals: globalsFor(ctx) });
		expect(ctx.io.json<EligibilityReport>().notes.join(' ')).toContain('authenticated share');
	});
});

describe('to a VPS', () => {
	const envelope = (over: Record<string, unknown> = {}) =>
		(async () =>
			new Response(
				JSON.stringify({
					replayable: true,
					maxStatementChars: 4_200,
					tables: { node: 20 },
					structureOnly: ['cache_page'],
					...over
				}),
				{ headers: { 'content-type': 'application/json' } }
			)) as unknown as FetchLike;

	/** the direction had no measurement at all: five rules returning five constants */
	it('changes its findings when the envelope changes', async () => {
		const clean = ctxFor(measured(), envelope());
		await expect(
			runEligibility(clean, { to: 'vps', survey: SURVEY, globals: globalsFor(clean) })
		).rejects.toBeInstanceOf(FindingError);
		const first = clean.io.json<EligibilityReport>();

		const withFiles = ctxFor(measured(), envelope({ tables: { cfw_file_chunk: 40 } }));
		await expect(
			runEligibility(withFiles, { to: 'vps', survey: SURVEY, globals: globalsFor(withFiles) })
		).rejects.toBeInstanceOf(FindingError);
		const second = withFiles.io.json<EligibilityReport>();

		const files = (r: EligibilityReport) => r.criteria.find((c) => c.id === 'export-files');
		expect(files(first)?.severity).toBe('note');
		expect(files(second)?.severity).toBe('blocker');
		expect(files(second)?.detail).toContain('40');
	});

	it('reaches no verdict when the export could not be read at all', async () => {
		const ctx = ctxFor(measured(), (async () => {
			throw new Error('ENOTFOUND');
		}) as unknown as FetchLike);
		await expect(
			runEligibility(ctx, { to: 'vps', survey: SURVEY, globals: globalsFor(ctx) })
		).rejects.toThrow(/no measurement/);
		expect(ctx.io.json<EligibilityReport>().unmeasured).toEqual(['the /export envelope']);
	});

	it('emits the substitution table as data', async () => {
		const ctx = ctxFor(measured(), envelope());
		await expect(
			runEligibility(ctx, { to: 'vps', survey: SURVEY, globals: globalsFor(ctx) })
		).rejects.toBeInstanceOf(FindingError);
		const report = ctx.io.json<EligibilityReport>();
		expect(report.substitutions).toHaveLength(SUBSTITUTIONS.length);
		expect(report.substitutions?.[0]).toMatchObject({ kind: 'service' });
	});

	it('carries no substitution table in the other direction', async () => {
		const ctx = ctxFor(measured());
		await runEligibility(ctx, { survey: SURVEY, globals: globalsFor(ctx) });
		expect(ctx.io.json<EligibilityReport>().substitutions).toBeNull();
	});
});

describe('the flags', () => {
	it('refuses a run with no survey to score', async () => {
		const ctx = ctxFor(measured());
		await expect(runEligibility(ctx, { globals: globalsFor(ctx) })).rejects.toBeInstanceOf(
			UsageError
		);
	});

	// --require go makes a GO WITH CHANGES fail a gate that a bare run would also have exited 3 on
	it('--require go exits 3 on GO WITH CHANGES and says so', async () => {
		const ctx = ctxFor(measured({ php: { version: '8.1.2', extensions: [] } }));
		await expect(
			runEligibility(ctx, { survey: SURVEY, require: 'go', globals: globalsFor(ctx) })
		).rejects.toThrow(/--require go/);
	});

	it('is reachable from the parser', async () => {
		const ctx = ctxFor(measured());
		expect(await run(ctx, ['migrate', 'eligibility', '--survey', SURVEY])).toBe(EXIT.OK);
		expect(ctx.io.text()).toContain('verdict');
	});

	it('scores a survey with a stated target version', async () => {
		const ctx = ctxFor(measured({ php: { version: '8.1.2', extensions: [] } }));
		expect(
			await run(ctx, ['migrate', 'eligibility', '--survey', SURVEY, '--target-php', '8.1.2'])
		).toBe(EXIT.OK);
	});
});

/**
 * The substitution list, against the module rather than against itself.
 *
 * A user changes every entry by hand, so a class named here that the module does not define would
 * send somebody looking for a service that is not there. Skips without the sibling and FAILS under
 * `REQUIRE_SIBLINGS=1`, the same asymmetry `tests/target-runtime.spec.ts` uses.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_SRC = resolve(HERE, '..', '..', 'drupflare', 'src');
const present = existsSync(MODULE_SRC);
if (!present && process.env.REQUIRE_SIBLINGS) {
	throw new Error(`no drupflare module checkout at ${MODULE_SRC}, and REQUIRE_SIBLINGS is set.`);
}

function phpFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...phpFiles(path));
		else if (entry.name.endsWith('.php')) out.push(path);
	}
	return out;
}

describe.skipIf(!present)('the substitutions track the module', () => {
	it('names only classes the module actually defines', () => {
		const sources = phpFiles(MODULE_SRC).map((p) => readFileSync(p, 'utf8'));
		for (const full of substitutionClasses()) {
			const short = full.split('\\').pop() as string;
			expect(
				sources.some((s) => new RegExp(`(class|interface)\\s+${short}\\b`).test(s)),
				`${full} is in SUBSTITUTIONS and no class in ${MODULE_SRC} declares ${short}`
			).toBe(true);
		}
	});
});
