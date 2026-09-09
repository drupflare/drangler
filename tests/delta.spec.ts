import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCutoverCommand, runDeltaCommand } from '../src/commands/migrate';
import { UsageError } from '../src/errors';
import { memoryFiles } from '../src/host/files';
import {
	assertCrossable,
	AUTHORITATIVE_TABLES,
	deltaPlan,
	deltaTables,
	EXCLUDED_FROM_DELTA,
	reseedStatement
} from '../src/migrate/delta';
import { testContext, testGlobals } from './helpers';

/**
 * The second dump's table set.
 *
 * There is no global LSN in Drupal and no binlog on a shared host, so the delta cannot be computed
 * from a marker: it is the `AUTHORITATIVE` set minus the tables that must never cross, and the
 * read-only window is what makes the writes it misses an empty set.
 */
describe('deltaTables', () => {
	/** rows minted on the source are signed against a different hash_salt on the target */
	it('never carries sessions, whatever else is discovered', () => {
		expect(deltaTables()).not.toContain('sessions');
		expect(deltaTables(['sessions', 'node__field_x'])).not.toContain('sessions');
		expect(AUTHORITATIVE_TABLES).toContain('sessions');
		expect(EXCLUDED_FROM_DELTA['sessions']).toContain('hash_salt');
	});

	it('drops every table the inventory says must not cross, each with a reason', () => {
		for (const [table, why] of Object.entries(EXCLUDED_FROM_DELTA)) {
			expect(deltaTables(), table).not.toContain(table);
			expect(why, table).not.toBe('');
		}
	});

	it('carries the entity and configuration tables', () => {
		const tables = deltaTables();
		for (const table of ['config', 'node', 'node_field_data', 'file_managed', 'users']) {
			expect(tables).toContain(table);
		}
	});

	/** a contrib module adds node__field_x and node_revision__field_x; enumerating that is a list nobody prunes */
	it('reaches contrib entity storage through the patterns rather than a list', () => {
		const tables = deltaTables([
			'node__field_streak',
			'node_revision__field_streak',
			'media_field_revision',
			'cache_render'
		]);
		expect(tables).toContain('node__field_streak');
		expect(tables).toContain('node_revision__field_streak');
		expect(tables).toContain('media_field_revision');
		// a cache table matches no pattern and is not authoritative
		expect(tables).not.toContain('cache_render');
	});

	it('is sorted, so two runs produce the same dump command', () => {
		expect(deltaTables()).toEqual([...deltaTables()].sort());
	});
});

/**
 * The one arithmetic step, and the one that fails silently when it is skipped.
 *
 * Copying `sequences` without re-seeding it makes the first new node on the target collide with a
 * row the delta brought over, and nothing errors until the two meet.
 */
describe('the sequences re-seed', () => {
	it('carries sequences AND re-seeds it', () => {
		expect(deltaTables()).toContain('sequences');
		expect(reseedStatement()).toMatch(/UPDATE sequences SET value/);
		expect(reseedStatement()).toContain('MAX(nid)');
	});

	it('is a statement rather than a copied row, because the value has to be computed', () => {
		expect(deltaPlan().reseed).toBe(reseedStatement());
		expect(deltaPlan().steps.some((s) => s.detail.includes(reseedStatement()))).toBe(true);
	});
});

describe('the ordered steps', () => {
	/** a file with no row is dead weight; a row whose bytes have not arrived is a broken image */
	it('puts the second rsync before the database dump', () => {
		const steps = deltaPlan().steps;
		const files = steps.findIndex((s) => s.title.includes('rsync'));
		const dump = steps.findIndex((s) => s.title.includes('dump the delta'));
		expect(files).toBeGreaterThan(-1);
		expect(files).toBeLessThan(dump);
	});

	it('starts with maintenance mode and never takes the source out of it', () => {
		const steps = deltaPlan().steps;
		expect(steps[0]?.command).toContain('maintenance_mode 1');
		expect(steps.some((s) => s.detail.includes('rollback target'))).toBe(true);
		expect(steps.some((s) => (s.command ?? '').includes('maintenance_mode 0'))).toBe(false);
	});

	it('names the tables in the dump command it prints', () => {
		const dump = deltaPlan().steps.find((s) => s.title.includes('dump the delta'));
		expect(dump?.command).toContain('--tables-list=');
		expect(dump?.command).toContain('node_field_data');
	});
});

describe('assertCrossable', () => {
	it('refuses a table the inventory says must not cross', () => {
		expect(() => assertCrossable('sessions')).toThrow(UsageError);
		expect(() => assertCrossable('node')).not.toThrow();
	});
});

describe('the commands', () => {
	const ctxFor = () => testContext({ files: memoryFiles({}) });

	it('prints the set, what was left behind, and the re-seed', () => {
		const ctx = ctxFor();
		runDeltaCommand(ctx, { globals: testGlobals({}, ctx) });
		const said = ctx.io.text();
		expect(said).toContain('left behind on purpose');
		expect(said).toContain('sessions:');
		expect(said).toContain('UPDATE sequences');
	});

	// a checklist that reports its own items done is a checklist nobody reads
	it('the cutover checklist ticks nothing and reaches no verdict', () => {
		const ctx = ctxFor();
		runCutoverCommand(ctx, { checklist: true, globals: testGlobals({}, ctx) });
		const said = ctx.io.text();
		expect(said).toContain('[ ]');
		expect(said).not.toContain('[x]');
		expect(said).toContain('what no mechanism catches');
		expect(said).toContain('a checklist that ticks itself');
	});

	it('names the three things nothing catches, under --json too', () => {
		const ctx = ctxFor();
		runCutoverCommand(ctx, { globals: testGlobals({ json: true }, ctx) });
		const report = ctx.io.json<{ unsafe: { id: string }[]; verdict: null }>();
		expect(report.unsafe.map((u) => u.id)).toEqual([
			'writes-after-the-last-read',
			'a-visitor-mid-form',
			'cron-part-way'
		]);
		expect(report.verdict).toBeNull();
	});
});

/**
 * The classification, against the sibling rather than against this copy.
 *
 * A table that becomes authoritative upstream and is missing here is a row that silently stops
 * crossing. Skips without the sibling and FAILS under `REQUIRE_SIBLINGS=1`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const INVENTORY = resolve(HERE, '..', '..', 'worker', 'src', 'ops', 'state-inventory.ts');
const source = existsSync(INVENTORY) ? readFileSync(INVENTORY, 'utf8') : null;
if (source === null && process.env.REQUIRE_SIBLINGS) {
	throw new Error(
		`no worker checkout at ${INVENTORY}, and REQUIRE_SIBLINGS says this lane has one.`
	);
}

describe.skipIf(source === null)('the set tracks the worker inventory', () => {
	function declared(): string[] {
		const text = source as string;
		const start = text.indexOf('const AUTHORITATIVE_TABLES');
		const block = text.slice(start, text.indexOf(']);', start));
		return [...block.matchAll(/^\t'([a-z0-9_]+)'/gm)].map((m) => m[1] as string);
	}

	it('names no table the inventory does not call authoritative', () => {
		const upstream = new Set(declared());
		for (const table of AUTHORITATIVE_TABLES) {
			expect(
				upstream,
				`${table} is in the delta set and not AUTHORITATIVE upstream`
			).toContain(table);
		}
	});

	// the cfw_* tables are drupflare's own and are dropped by the VPS side rather than crossed
	it('carries every upstream table that is not a cfw_ one', () => {
		const here = new Set(AUTHORITATIVE_TABLES);
		for (const table of declared()) {
			if (table.startsWith('cfw_')) continue;
			expect(
				here,
				`${table} is AUTHORITATIVE upstream and missing from the delta set`
			).toContain(table);
		}
	});
});
