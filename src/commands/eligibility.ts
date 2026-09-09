import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { DranglerError, FindingError, UsageError } from '../errors';
import { emit, kv, table } from '../format';
import { normaliseTarget } from '../health/probe';
import { buildPlan, REQUIRED_FIELDS } from '../migrate/plan';
import type { ExportEnvelope, Finding } from '../migrate/rules';
import { SUBSTITUTIONS } from '../migrate/substitutions';
import type { SiteSurvey } from '../migrate/survey';
import { assumedTarget, statedTarget } from '../migrate/target-runtime';

/**
 * Can this site move, in this direction, today.
 *
 * Split from `migrate plan` because the two answer different questions with one exit code: a plan is
 * an ordered list of work, and eligibility is a verdict. The scoring half is shared; what is new is
 * that a criterion which could not be MEASURED is its own outcome rather than a pass with a caveat.
 */

/** the four answers, and the fourth is why the exit set has four values */
export type EligibilityVerdict = 'GO' | 'GO WITH CHANGES' | 'NO' | 'no verdict';

export interface Criterion {
	id: string;
	/** the survey field, envelope key or header it was read from */
	evidence: string;
	/** null when nothing measured it */
	severity: 'blocker' | 'warning' | 'note' | null;
	detail: string;
}

export interface EligibilityReport {
	direction: 'to-workers' | 'to-vps';
	verdict: EligibilityVerdict;
	criteria: Criterion[];
	/** criteria that reached no measurement at all */
	unmeasured: string[];
	/** the swap list, emitted as data so a script can act on it */
	substitutions: typeof SUBSTITUTIONS | null;
	notes: string[];
}

export interface EligibilityOptions {
	to?: string;
	survey?: string;
	/** the owner token, for the /export envelope */
	token?: string;
	/** turn every unmeasured criterion into a blocker, for a script that must have a verdict */
	assumeWorst?: boolean;
	/** make a GO WITH CHANGES exit 3 where a bare run would have too */
	require?: string;
	targetPhp?: string;
	globals: GlobalOptions;
}

/**
 * Reads the two inputs, scores them, and reaches one of four verdicts.
 *
 * A criterion that could not be measured is `no verdict` and exit `1`, never a `GO` with a caveat.
 * `--assume-worst` turns each one into a blocker and produces a `NO` with a reason, which is what a
 * script that must have an answer asks for.
 */
export async function runEligibility(ctx: Context, opts: EligibilityOptions): Promise<void> {
	const direction = opts.to === 'vps' ? 'to-vps' : 'to-workers';
	const survey = readSurvey(ctx, opts);
	const envelope = direction === 'to-vps' ? await readEnvelope(ctx, opts) : null;
	const target = opts.targetPhp === undefined ? assumedTarget() : statedTarget(opts.targetPhp);

	const plan = buildPlan(
		survey,
		direction === 'to-vps' ? 'to-vps' : 'to-worker',
		target,
		envelope
	);
	const criteria: Criterion[] = plan.findings.map((f: Finding) => ({
		id: f.id,
		evidence: f.evidence,
		severity: f.severity,
		detail: f.detail
	}));

	// a field no rule could read is a criterion that reached no measurement, which is a different
	// outcome from one that was measured and passed
	const unmeasured = unmeasuredCriteria(survey, direction, envelope);
	for (const id of unmeasured) {
		criteria.push({
			id,
			evidence: 'nothing measured it',
			severity: opts.assumeWorst === true ? 'blocker' : null,
			detail:
				opts.assumeWorst === true
					? 'nothing measured this, and --assume-worst scores an unmeasured criterion as a blocker'
					: 'nothing measured this; it is neither a pass nor a failure'
		});
	}

	const report: EligibilityReport = {
		direction,
		verdict: verdictOf(criteria, opts.assumeWorst === true),
		criteria,
		unmeasured: opts.assumeWorst === true ? [] : unmeasured,
		substitutions: direction === 'to-vps' ? SUBSTITUTIONS : null,
		notes: []
	};
	if (direction === 'to-workers') {
		// measured from access logs by `worker/scripts/measure/auth-share.ts`, which a survey does
		// not read. Listed rather than dropped: it decides whether the edge-plan tier ever compiles
		report.notes.push(
			'the authenticated share of traffic is not measurable from a survey, and it is the input to whether the compiled-plan tier ever runs'
		);
	}

	emit(ctx.io, opts.globals.json, report, () => render(report));

	if (report.verdict === 'no verdict') {
		throw new DranglerError(
			'eligibility-unmeasured',
			`${unmeasured.length} criterion/criteria reached no measurement, so there is no verdict`
		);
	}
	if (report.verdict === 'NO') {
		throw new FindingError('eligibility', `${direction}: NO`);
	}
	if (report.verdict === 'GO WITH CHANGES' && opts.require === 'go') {
		throw new FindingError('eligibility', `${direction}: GO WITH CHANGES, and --require go`);
	}
	if (report.verdict === 'GO WITH CHANGES') {
		throw new FindingError('eligibility', `${direction}: GO WITH CHANGES`);
	}
}

/**
 * The four verdicts.
 *
 * `GO WITH CHANGES` and `NO` share exit 3, which is correct under the closed set: both are "the
 * check ran and found something". The distinction lives in the verdict rather than in a fifth exit
 * code that does not exist.
 */
export function verdictOf(
	criteria: readonly Criterion[],
	assumeWorst: boolean
): EligibilityVerdict {
	if (!assumeWorst && criteria.some((c) => c.severity === null)) return 'no verdict';
	if (criteria.some((c) => c.severity === 'blocker')) return 'NO';
	if (criteria.some((c) => c.severity === 'warning')) return 'GO WITH CHANGES';
	return 'GO';
}

function readSurvey(ctx: Context, opts: EligibilityOptions): SiteSurvey {
	if (opts.survey === undefined) {
		throw new UsageError(
			'no survey to score; pass --survey <file> from `migrate survey --out`'
		);
	}
	if (!ctx.files.exists(opts.survey)) throw new UsageError(`no survey at ${opts.survey}`);
	try {
		return JSON.parse(ctx.files.readText(opts.survey)) as SiteSurvey;
	} catch (e) {
		throw new UsageError(
			`${opts.survey} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
		);
	}
}

/**
 * One `/export` request, read for its envelope rather than for its bytes.
 *
 * `?body=1` is deliberately NOT set: the criteria read counts and verdicts, and pulling a whole dump
 * to decide whether a dump is possible would spend the thing being scored.
 */
async function readEnvelope(
	ctx: Context,
	opts: EligibilityOptions
): Promise<ExportEnvelope | null> {
	const origin = opts.globals.config.site.value;
	if (origin === null) return null;
	const url = new URL('/export', normaliseTarget(origin));
	url.searchParams.set('site', opts.globals.config.siteName.value ?? 'site');
	const token = opts.token ?? opts.globals.config.token.value ?? '';
	try {
		const response = await ctx.fetch(url.toString(), {
			headers: token === '' ? {} : { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(opts.globals.timeoutMs)
		});
		if (response.status === 401 || response.status === 404) {
			return { status: response.status };
		}
		const body = (await response.json()) as ExportEnvelope;
		return { ...body, status: response.status, secrets: false };
	} catch {
		// an origin that did not answer measured nothing, which is not the same as a refusal
		return null;
	}
}

/** which criteria this run could not measure at all, by direction */
function unmeasuredCriteria(
	survey: SiteSurvey,
	direction: 'to-workers' | 'to-vps',
	envelope: ExportEnvelope | null
): string[] {
	if (direction === 'to-vps') {
		return envelope === null ? ['the /export envelope'] : [];
	}
	return REQUIRED_FIELDS.filter(([, has]) => !has(survey)).map(([name]) => name);
}

function render(report: EligibilityReport): string[] {
	const lines = kv([
		['direction', report.direction],
		['verdict', report.verdict]
	]);
	lines.push(
		'',
		...table(
			['criterion', 'verdict', 'evidence'],
			report.criteria.map((c) => [c.id, c.severity ?? 'not measured', c.evidence])
		)
	);
	const blockers = report.criteria.filter((c) => c.severity === 'blocker');
	if (blockers.length > 0) {
		lines.push('', 'blockers');
		for (const c of blockers) lines.push(`  ${c.id}: ${c.detail}`);
	}
	if (report.unmeasured.length > 0) {
		lines.push('', 'not measured');
		for (const id of report.unmeasured) lines.push(`  ${id}`);
		lines.push('  --assume-worst scores these as blockers and produces a verdict');
	}
	if (report.substitutions !== null) {
		lines.push(
			'',
			`substitutions (${report.substitutions.length})`,
			...table(
				['what the site runs', 'what a VPS uses'],
				report.substitutions.map((s) => [s.from, s.to])
			)
		);
	}
	if (report.notes.length > 0) {
		lines.push('', 'notes');
		for (const note of report.notes) lines.push(`  - ${note}`);
	}
	return lines;
}
