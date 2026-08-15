import { parseWranglerConfig, type WranglerConfig } from '../cloudflare/config';
import type { Context } from '../context';
import { FindingError } from '../errors';
import { emit, kv } from '../format';
import { probeSite } from '../health/probe';

export interface StatusOptions {
	path?: string;
	site?: string;
	timeoutMs?: number;
	/** a wrangler config to read the deploy's own identity from, when the user has one */
	config?: string;
	json?: boolean;
}

export interface SiteStatus {
	target: string;
	reachable: boolean;
	/** the tier that answered, which says how much of the stack the request actually touched */
	tier: string | null;
	generation: number | null;
	plan: string | null;
	headerVersion: number | null;
	phpBooted: boolean | null;
	/** whether the diagnostic routes are open, which they should not be on a deployed site */
	diagnostics: 'off' | 'gated' | 'open';
	/** read from a local wrangler config when one was given or found; absent otherwise */
	config: {
		path: string;
		name: string | null;
		main: string | null;
		compatibilityDate: string | null;
	} | null;
	notes: string[];
}

/** the config a user deployed from, if they kept the checkout; absent is the normal case */
function readConfig(ctx: Context, explicit?: string): SiteStatus['config'] {
	const candidates = explicit
		? [explicit]
		: [`${ctx.cwd}/wrangler.jsonc`, `${ctx.cwd}/wrangler.json`];
	for (const path of candidates) {
		if (!ctx.files.exists(path)) continue;
		try {
			const parsed: WranglerConfig = parseWranglerConfig(ctx.files.readText(path));
			return {
				path,
				name: typeof parsed.name === 'string' ? parsed.name : null,
				main: typeof parsed.main === 'string' ? parsed.main : null,
				compatibilityDate:
					typeof parsed.compatibility_date === 'string' ? parsed.compatibility_date : null
			};
		} catch {
			// an unreadable config is "no config": `config check` is the command that judges one
			return null;
		}
	}
	return null;
}

/**
 * What am I running?
 *
 * The first question a site owner asks, and it is about their DEPLOYED site rather than about any
 * checkout. Everything below one `/serve` request is public: the object reports its plan, its
 * generation, the header contract version and whether an interpreter is booted on the same response
 * a visitor gets, so this needs no credential and no diagnostic route.
 *
 * Distinct from `health`, which asks "is it up and which tier answered" and is the thing to put in a
 * monitor. This asks "what is deployed here", which is the thing to read before changing anything.
 *
 * A local wrangler config is reported when one happens to be in the working directory -- a user who
 * deployed from the template may have kept the checkout -- and its absence is not a failure. That is
 * the only local file this command looks at.
 */
export async function runStatus(ctx: Context, target: string, opts: StatusOptions): Promise<void> {
	const result = await probeSite(
		{ fetch: ctx.fetch },
		{
			target,
			path: opts.path ?? '/',
			site: opts.site ?? 'site',
			kind: 'worker',
			// the object sets `x-cfw-plan` on a MISS, and a cache tier answers without it, so the
			// edge is bypassed to give the identity fields a chance to be populated
			skipEdge: true,
			diagnostics: true,
			...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs })
		}
	);

	const status: SiteStatus = {
		target: result.target,
		reachable: result.status !== null,
		tier: result.tier,
		generation: result.generation,
		plan: result.plan,
		headerVersion: result.headerVersion,
		phpBooted: result.phpBooted,
		diagnostics: result.diagnostics,
		config: readConfig(ctx, opts.config),
		notes: [...result.notes]
	};

	if (status.diagnostics === 'open') {
		status.notes.push(
			'the diagnostic routes answer on this deployment; /sql and /restore are reachable and should be closed'
		);
	}
	if (status.plan === null && status.tier !== null) {
		status.notes.push(
			`answered from the ${status.tier} tier, which does not carry x-cfw-plan; the plan is unknown rather than free`
		);
	}

	emit(ctx.io, opts.json === true, status, () => {
		const rows: [string, string][] = [
			['site', status.target],
			['reachable', status.reachable ? 'yes' : 'no'],
			['answered by', status.tier ?? '-'],
			['generation', status.generation === null ? '-' : String(status.generation)],
			['plan', status.plan ?? 'unknown'],
			[
				'header contract',
				status.headerVersion === null ? 'unversioned' : `v${status.headerVersion}`
			],
			['interpreter', status.phpBooted === null ? '-' : status.phpBooted ? 'booted' : 'cold'],
			['diagnostics', status.diagnostics]
		];
		if (status.config !== null) {
			rows.push(
				['config', status.config.path],
				['worker name', status.config.name ?? '-'],
				['compatibility date', status.config.compatibilityDate ?? '-']
			);
		}
		const lines = kv(rows);
		if (status.notes.length > 0) {
			lines.push('', 'notes');
			for (const note of status.notes) lines.push(`  - ${note}`);
		}
		return lines;
	});

	if (!status.reachable) {
		throw new FindingError('unreachable', `${status.target} did not answer`);
	}
	if (status.diagnostics === 'open') {
		throw new FindingError(
			'diagnostics-open',
			`${status.target} exposes its diagnostic routes`
		);
	}
}
