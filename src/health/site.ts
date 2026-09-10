import type { ProbeResult } from './probe';
import { readRepairState, type RepairReport } from './repair';

/**
 * Scoring a deployed drupflare site from the envelopes its owner routes return.
 *
 * Every state names the worker code that owns it, and the verdict says whether a CLI can do
 * anything about it, in the three words `worker/docs/configuration.md` classifies the repair
 * surface with.
 *
 * **A withdrawn replica lane is not scored here.** `/replica` is diagnostic-only and stays that way:
 * a lane that withdrew asks the primary for a fresh copy itself and the primary queues it, so there
 * is nothing to drive, and the same route carries a lane's speculative-batch commit path, which
 * belongs to the pool rather than to whoever holds the owner token. Three of them are report-only and each has a mechanism rather than a
 * preference: a rollback is a decision the object makes with a dwell timer and a restore point it
 * can see; an empty page store is caused by a config row in the workspace pack that no owner route
 * reaches; and a degraded site clears itself at the UTC reset.
 *
 * A check that did not RUN is not a check that passed. Everything here reports `checked: false` with
 * a reason rather than folding an unreachable route into a clean verdict.
 */

export type SiteSeverity = 'error' | 'warning' | 'note';

export interface SiteFinding {
	id: string;
	severity: SiteSeverity;
	detail: string;
	/** the envelope field or the header the verdict was read from */
	evidence: string;
	/**
	 * Whether an owner route can act on it, in the worker's own three words.
	 *
	 * `worker/docs/configuration.md` classifies the repair surface as `safe`, `rebuild` and
	 * `stateful`; `none` is a state no owner route reaches at all.
	 */
	repair: 'none' | 'safe' | 'rebuild' | 'stateful';
}

/** a check that could not be made, with what it would need */
export interface SiteUnchecked {
	id: string;
	needs: string;
}

export interface SiteReport {
	site: string;
	reachable: boolean;
	tier: string | null;
	generation: number | null;
	version: string | null;
	degraded: string | null;
	findings: SiteFinding[];
	unchecked: SiteUnchecked[];
	next: string[];
}

/** everything the scorer reads, so a spec supplies four envelopes and no network */
export interface SiteInputs {
	probe: ProbeResult;
	/** `GET /health`, or null when it could not be read */
	health: RepairReport | null;
	/** `GET /updb`, or null */
	updb: { phase: string | null; cursor: number | null; haltReason: string | null } | null;
	/** `GET /git`, or null */
	git: { remotes: { id: string; previewOf: string | null }[] } | null;
	/** `GET /modify?action=status`, or null */
	modify: { packages: { package: string; rev: string | null; files: number }[] } | null;
	/** whether anybody has claimed the site */
	claimed: 'claimed' | 'unclaimed' | 'unknown';
	/** whether a workspace was given, which is what the container-cid check needs */
	workspace: boolean;
	/**
	 * The pack's `VERSIONS_HASH` and the cid on the workspace's `cache_container` row.
	 *
	 * Null when no workspace was given or either artifact was unreadable. THE CHECK THIS FEEDS WAS
	 * ADVERTISED AND NEVER WRITTEN: `site.container-cid-stale` appeared only in `siteUnchecked()`, so
	 * passing `--workspace` took it off that list without anything running in its place.
	 */
	container: { packHash: string; rowCid: string } | null;
}

function finding(
	id: string,
	severity: SiteSeverity,
	detail: string,
	evidence: string,
	repair: SiteFinding['repair'] = 'none'
): SiteFinding {
	return { id, severity, detail, evidence, repair };
}

/** phases in which the update chain does no more work */
const TERMINAL_UPDB = ['complete', 'halted', 'rolled_back', 'abandoned'];

/**
 * Every `site.*` state these envelopes show.
 *
 * The order is what a reader acts on first: a quarantined site is refusing writes, a halted update
 * chain is holding a schema half-applied, and a note about the page store is neither.
 */
export function siteFindings(input: SiteInputs): SiteFinding[] {
	const found: SiteFinding[] = [];
	const health = input.health;

	if (health !== null && health.quarantined) {
		found.push(
			finding(
				'site.quarantined',
				'error',
				`${health.code ?? 'an unnamed failure'}, ${health.strikes} strike(s); writes and the fill lane are stopped and the site still serves`,
				'/health .quarantined',
				'stateful'
			)
		);
	}
	if (health !== null && health.rollback.rollback) {
		found.push(
			finding(
				'site.rollback-pending',
				'error',
				`the object will roll back on its next alarm: ${health.rollback.reason}`,
				'/health .rollback'
			)
		);
	}
	if (health !== null && health.advisories?.state === 'insecure') {
		found.push(
			finding(
				'site.advisories',
				'warning',
				`${health.advisories.insecure} project(s) carry a security advisory: ${health.advisories.detail}`,
				'/health .advisories'
			)
		);
	}

	const updb = input.updb;
	if (updb?.phase === 'halted') {
		found.push(
			finding(
				'site.updb-halted',
				'error',
				`the update chain halted at ${updb.haltReason ?? 'an unnamed unit'}; it holds until an operator clears it, and no route reaches the rollback`,
				'/updb .run.phase'
			)
		);
	} else if (updb?.phase !== null && updb !== null && !TERMINAL_UPDB.includes(updb.phase ?? '')) {
		found.push(
			finding(
				'site.updb-behind',
				'warning',
				`the update chain is ${updb.phase} at cursor ${updb.cursor ?? '?'}; a beat can execute a hook_update_N`,
				'/updb .run.phase',
				'stateful'
			)
		);
	}

	const migrate = input.probe.cfw['x-cfw-migrate'];
	if (migrate !== undefined) {
		found.push(
			finding(
				'site.replay-stuck',
				'warning',
				`replaying the packed database, chunk ${migrate} (${input.probe.cfw['x-cfw-migrate-state'] ?? 'unknown'}); a fresh site does this once`,
				'x-cfw-migrate',
				'stateful'
			)
		);
	}

	const queue = input.probe.queueDepth;
	if (queue !== null && queue > 0) {
		found.push(
			finding(
				'site.fill-stalled',
				'warning',
				`${queue} page(s) queued for a fill; re-arming spends the rows the drain writes`,
				'x-cfw-queue-depth',
				'rebuild'
			)
		);
	}

	if (input.probe.degraded !== null) {
		found.push(
			finding(
				'site.degraded',
				'note',
				`shedding load at the ${input.probe.degraded.level} level, driven by ${input.probe.degraded.driver}; cron, the queue and image regeneration are off until the UTC reset`,
				'x-cfw-degrade'
			)
		);
	}

	const pinned = (input.git?.remotes ?? []).filter((r) => r.previewOf !== null);
	for (const remote of pinned) {
		found.push(
			finding(
				'site.preview-pinned',
				'warning',
				`\`${remote.id}\` is pinned to preview ${remote.previewOf}, so the poller and the webhook are not replacing its tree`,
				'/git .previewOf',
				'stateful'
			)
		);
	}

	const empty = (input.modify?.packages ?? []).filter((p) => p.rev !== null && p.files === 0);
	for (const pkg of empty) {
		found.push(
			finding(
				'site.revision-half-applied',
				'error',
				`\`${pkg.package}\` names an active revision with no files mounted, so its blobs are incomplete`,
				'/modify?action=status',
				'stateful'
			)
		);
	}

	if (input.claimed === 'unclaimed') {
		found.push(
			finding(
				'site.unclaimed',
				'error',
				'nobody has claimed this site: uid 1 has no usable password and whoever reaches the URL first can set one',
				'/firstrun .configured'
			)
		);
	}

	// the cid embeds the hash, so `includes` is the comparison; the row also carries the OS and the
	// services.yml path, which is why this is not an equality test
	if (input.container !== null && !input.container.rowCid.includes(input.container.packHash)) {
		found.push(
			finding(
				'site.container-cid-stale',
				'warning',
				`the packed container row is keyed to a different dependency set than the pack (pack ${input.container.packHash}), so every first kernel boot rebuilds a 482 KB container`,
				'workspace: assets/drupal-pf against cache_container.cid',
				'rebuild'
			)
		);
	}

	return found;
}

/**
 * The checks that did not run, and what each one needs.
 *
 * Its own block for the reason `migrate plan` already separates `unknowns`: a check that did not run
 * and a check that passed are different facts, and collapsing them is what makes a report a guess.
 */
export function siteUnchecked(input: SiteInputs): SiteUnchecked[] {
	const out: SiteUnchecked[] = [];
	if (!input.workspace) {
		out.push({
			id: 'site.container-cid-stale',
			needs: '--workspace; the check compares the pack VERSIONS_HASH against its cache_container row'
		});
	}
	if (input.health === null)
		out.push({ id: 'site.quarantined', needs: '/health did not answer' });
	if (input.updb === null) out.push({ id: 'site.updb-halted', needs: '/updb did not answer' });
	if (input.git === null) out.push({ id: 'site.preview-pinned', needs: '/git did not answer' });
	if (input.modify === null) {
		out.push({
			id: 'site.revision-half-applied',
			needs: '/modify did not answer; this worker may predate the route'
		});
	}
	// N requests to one stable path, and the cause is a config row in the workspace pack that no
	// owner route can reach; a CLI offering to fix it would be offering to fix a file it cannot see
	out.push({
		id: 'site.page-store-empty',
		needs: 'repeated requests to one path; the fix is in the workspace pack rather than on the site'
	});
	return out;
}

/** the commands worth typing next, derived from what was found rather than from a fixed list */
export function siteNext(site: string, findings: readonly SiteFinding[]): string[] {
	const next: string[] = [];
	const has = (id: string) => findings.some((f) => f.id === id);
	if (has('site.unclaimed')) next.push(`drangler site claim ${site}`);
	if (has('site.quarantined')) next.push(`drangler heal ${site} --release --yes`);
	if (has('site.replay-stuck')) next.push(`drangler heal ${site} --replay --yes`);
	if (has('site.updb-behind')) next.push(`drangler site updb ${site} --step`);
	if (has('site.fill-stalled')) next.push(`drangler heal ${site} --armfill --yes`);
	if (has('site.preview-pinned')) next.push(`drangler heal ${site} --unpin <remote> --yes`);
	return next;
}

/** builds the whole report, so `doctor --site` renders and the scorer stays pure */
export function siteReport(input: SiteInputs): SiteReport {
	const findings = siteFindings(input);
	return {
		site: input.probe.target,
		reachable: input.probe.status !== null,
		tier: input.probe.tier,
		generation: input.probe.generation,
		version:
			input.health?.version === null || input.health?.version === undefined
				? null
				: `${input.health.version.id}${input.health.version.tag === null ? '' : ` (${input.health.version.tag})`}`,
		degraded:
			input.probe.degraded === null
				? null
				: `${input.probe.degraded.level} (${input.probe.degraded.driver} at ${input.probe.degraded.fraction ?? '?'} of 1.00)`,
		findings,
		unchecked: siteUnchecked(input),
		next: siteNext(input.probe.target, findings)
	};
}

/** the `/health` envelope, parsed the same way `heal` parses it */
export { readRepairState };
