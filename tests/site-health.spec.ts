import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readContainerCid } from '../src/commands/doctor';
import type { ProbeResult } from '../src/health/probe';
import { summariseHealth } from '../src/health/repair';
import {
	siteFindings,
	siteNext,
	siteReport,
	siteUnchecked,
	type SiteInputs
} from '../src/health/site';

/**
 * Scoring a deployed site from the envelopes its owner routes return.
 *
 * Each state names the worker code that owns it, and the verdict says whether a CLI can act. A check
 * that did not RUN is reported as such rather than folded into a clean pass, which is the same
 * separation `migrate plan` keeps between a finding and an unmeasured field.
 */
const ORIGIN = 'https://mysite.example';
const NOW = new Date('2026-09-08T05:00:00.000Z').getTime();

function probe(over: Partial<ProbeResult> = {}): ProbeResult {
	return {
		target: ORIGIN,
		requested: `${ORIGIN}/serve`,
		kind: 'worker',
		verdict: 'ok',
		status: 200,
		wallMs: 12,
		tier: 'MISS',
		edgeTier: null,
		generation: 41,
		renderMs: null,
		serveMs: null,
		workerMs: null,
		phpBooted: true,
		queueDepth: 0,
		headerVersion: 2,
		planTier: null,
		accountPlan: 'free',
		degraded: null,
		drupalCache: null,
		drupalDynamicCache: null,
		generator: null,
		diagnostics: 'off',
		cfw: { 'x-cfw-cache': 'MISS' },
		notes: [],
		...over
	};
}

const CLEAN_HEALTH = {
	repair: { rung: 'observe', code: null, strikes: 0, quarantinedAt: null, lastRollbackAt: null },
	quarantined: false,
	rollback: { rollback: false, reason: 'not quarantined; the lower rungs own this' },
	advisories: { state: 'current', insecure: 0, stale: 0, at: 1, detail: '' },
	version: { id: '8c31f0a2', tag: 'v37', timestamp: '2026-09-07T22:10:04Z' },
	lastFindings: [],
	ledger: [],
	ledgerRows: 0
};

function inputs(over: Partial<SiteInputs> = {}): SiteInputs {
	return {
		probe: probe(),
		health: summariseHealth(ORIGIN, CLEAN_HEALTH, NOW),
		updb: { phase: 'complete', cursor: 9, haltReason: null },
		git: { remotes: [] },
		modify: { packages: [] },
		claimed: 'claimed',
		workspace: true,
		container: null,
		...over
	};
}

const ids = (over: Partial<SiteInputs> = {}) => siteFindings(inputs(over)).map((f) => f.id);

describe('a healthy site', () => {
	it('produces no finding and reports the version that answered', () => {
		const report = siteReport(inputs());
		expect(report.findings).toEqual([]);
		expect(report.version).toBe('8c31f0a2 (v37)');
		expect(report.degraded).toBeNull();
		expect(report.next).toEqual([]);
	});

	it('carries the field it read on every finding', () => {
		for (const finding of siteFindings(inputs({ claimed: 'unclaimed' }))) {
			expect(finding.evidence).not.toBe('');
		}
	});
});

describe('one state at a time', () => {
	it('site.quarantined, classified with the worker own word for the route', () => {
		const found = siteFindings(
			inputs({
				health: summariseHealth(
					ORIGIN,
					{
						...CLEAN_HEALTH,
						quarantined: true,
						repair: {
							rung: 'quarantine',
							code: 'bridge.asyncify_called',
							strikes: 3,
							quarantinedAt: NOW - 60_000,
							lastRollbackAt: null
						}
					},
					NOW
				)
			})
		);
		expect(found[0]).toMatchObject({ id: 'site.quarantined', repair: 'stateful' });
		expect(found[0]?.detail).toContain('bridge.asyncify_called');
	});

	/** the object decides with a dwell timer and a restore point it can see; a CLI does not */
	it('site.rollback-pending is report only', () => {
		const found = siteFindings(
			inputs({
				health: summariseHealth(
					ORIGIN,
					{
						...CLEAN_HEALTH,
						quarantined: true,
						rollback: { rollback: true, reason: 'replaying restore point 17' }
					},
					NOW
				)
			})
		);
		expect(found.find((f) => f.id === 'site.rollback-pending')?.repair).toBe('none');
	});

	it('site.updb-halted and site.updb-behind are different states', () => {
		expect(
			ids({ updb: { phase: 'halted', cursor: 4, haltReason: 'update-failed' } })
		).toContain('site.updb-halted');
		const behind = siteFindings(
			inputs({ updb: { phase: 'running', cursor: 4, haltReason: null } })
		);
		expect(behind[0]).toMatchObject({ id: 'site.updb-behind', repair: 'stateful' });
	});

	it('site.replay-stuck from the header the object answers 503 with', () => {
		const found = siteFindings(
			inputs({
				probe: probe({
					status: 503,
					cfw: { 'x-cfw-migrate': '31/62', 'x-cfw-migrate-state': 'running' }
				})
			})
		);
		expect(found[0]).toMatchObject({ id: 'site.replay-stuck', repair: 'stateful' });
		expect(found[0]?.detail).toContain('31/62');
	});

	it('site.fill-stalled costs the meter the drain writes', () => {
		const found = siteFindings(inputs({ probe: probe({ queueDepth: 12 }) }));
		expect(found[0]).toMatchObject({ id: 'site.fill-stalled', repair: 'rebuild' });
	});

	it('site.degraded is a note, because it clears itself at the UTC reset', () => {
		const found = siteFindings(
			inputs({
				probe: probe({
					degraded: { level: 'reduced', driver: 'rows-written', fraction: 0.83 }
				})
			})
		);
		expect(found[0]).toMatchObject({ id: 'site.degraded', severity: 'note', repair: 'none' });
	});

	it('site.preview-pinned names the remote the poller is not touching', () => {
		const found = siteFindings(
			inputs({ git: { remotes: [{ id: 'mantle2', previewOf: 'pr-41' }] } })
		);
		expect(found[0]).toMatchObject({ id: 'site.preview-pinned', repair: 'stateful' });
		expect(found[0]?.detail).toContain('pr-41');
	});

	it('site.revision-half-applied when an active rev mounts no files', () => {
		const found = siteFindings(
			inputs({
				modify: { packages: [{ package: 'mantle2', rev: 'a'.repeat(64), files: 0 }] }
			})
		);
		expect(found[0]).toMatchObject({ id: 'site.revision-half-applied', severity: 'error' });
	});

	it('site.container-cid-stale, which was advertised and never implemented', () => {
		// it appeared only in `siteUnchecked()`, so passing --workspace took it off that list with
		// nothing running in its place. The cid embeds the hash alongside the OS and the services.yml
		// path, so the comparison is a substring rather than equality
		const stale = {
			packHash: 'bb620d1eb8df7bc8',
			rowCid: 'service_container:prod:d87c6ada93448a4f::Linux:a:1:{i:0;s:34:"/drupal/sites/default/services.yml";}'
		};
		expect(ids({ container: stale })).toEqual(['site.container-cid-stale']);

		const agreeing = {
			packHash: 'bb620d1eb8df7bc8',
			rowCid: 'service_container:prod:bb620d1eb8df7bc8::Linux:a:1:{i:0;s:34:"/drupal/sites/default/services.yml";}'
		};
		expect(ids({ container: agreeing })).toEqual([]);
		// and no workspace reports nothing rather than a false stale
		expect(ids({ container: null })).toEqual([]);
	});

	it('site.unclaimed, which is the one anybody can still take', () => {
		expect(ids({ claimed: 'unclaimed' })).toEqual(['site.unclaimed']);
		expect(ids({ claimed: 'unknown' })).toEqual([]);
	});
});

/**
 * A check that did not run and a check that passed are different facts.
 *
 * Collapsing them is what makes a report a guess, which is why `migrate plan` already separates its
 * unknowns from its findings.
 */
describe('what was not checked', () => {
	it('names the workspace the container-cid check needs', () => {
		const rows = siteUnchecked(inputs({ workspace: false }));
		expect(rows.find((r) => r.id === 'site.container-cid-stale')?.needs).toContain(
			'--workspace'
		);
		expect(siteUnchecked(inputs()).map((r) => r.id)).not.toContain('site.container-cid-stale');
	});

	it('names every route that did not answer, rather than passing it', () => {
		const rows = siteUnchecked(
			inputs({ health: null, updb: null, git: null, modify: null })
		).map((r) => r.id);
		expect(rows).toContain('site.quarantined');
		expect(rows).toContain('site.updb-halted');
		expect(rows).toContain('site.revision-half-applied');
	});

	// the cause is a config row in the workspace pack that no owner route reaches
	it('always lists the page store, because a CLI cannot see what causes it', () => {
		expect(siteUnchecked(inputs()).map((r) => r.id)).toContain('site.page-store-empty');
	});
});

describe('what to type next', () => {
	it('is derived from what was found rather than from a fixed list', () => {
		expect(siteNext(ORIGIN, siteFindings(inputs({ claimed: 'unclaimed' })))).toEqual([
			`drangler site claim ${ORIGIN}`
		]);
		expect(siteNext(ORIGIN, siteFindings(inputs({ probe: probe({ queueDepth: 3 }) })))).toEqual(
			[`drangler heal ${ORIGIN} --armfill --yes`]
		);
		expect(siteNext(ORIGIN, [])).toEqual([]);
	});
});

describe('readContainerCid, against a real worker checkout', () => {
	const WORKER = resolve(import.meta.dirname, '..', '..', 'worker');
	const have =
		existsSync(join(WORKER, 'assets/drupal-pf/core.pf.bin')) &&
		existsSync(join(WORKER, 'assets/drupal/site.sqlite'));

	/**
	 * The READER, which the finding test cannot reach.
	 *
	 * `siteFindings` takes `container` as an input, so every assertion above passes on a reader that
	 * returns null for everything. That is the shape this check was already guilty of once: it was
	 * advertised in `siteUnchecked()` and never implemented.
	 */
	it.skipIf(!have)('reads the pack hash and the row cid off disk', () => {
		const read = readContainerCid(WORKER);
		expect(read, 'no reading from a checkout that has both artifacts').not.toBeNull();
		expect(read?.packHash).toMatch(/^[0-9a-f]{16}$/);
		expect(read?.rowCid).toContain('service_container:prod:');
		// this checkout is expected to AGREE, so the finding must not fire on it
		expect(read?.rowCid).toContain(read?.packHash ?? 'no-hash');
		expect(siteFindings(inputs({ container: read })).map((f) => f.id)).toEqual([]);
	});

	it('answers null for a directory that is not a worker checkout', () => {
		expect(readContainerCid(resolve(import.meta.dirname))).toBeNull();
	});
});
