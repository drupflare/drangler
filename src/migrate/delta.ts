import { UsageError } from '../errors';

/**
 * The second dump: which tables cross in a cutover, and the one arithmetic step in the procedure.
 *
 * **There is no global LSN in Drupal and no binlog on a shared host**, so the delta cannot be
 * computed from a marker. It is the tables classified `AUTHORITATIVE` in the worker's
 * `src/ops/state-inventory.ts`, minus the ones that must never cross, and the window is what makes
 * the set of writes it misses empty.
 *
 * `tests/delta.spec.ts` reads that sibling's source and fails when a table appears there and not
 * here, which is the `REQUIRE_SIBLINGS` shape `tests/target-runtime.spec.ts` uses.
 */

/** the entity and configuration tables one execution authority owns; `AUTHORITATIVE` upstream */
export const AUTHORITATIVE_TABLES: readonly string[] = [
	'config',
	'sessions',
	'users',
	'users_data',
	'users_field_data',
	'user__roles',
	'node',
	'node_field_data',
	'node_field_revision',
	'node_revision',
	'node__body',
	'node_access',
	'taxonomy_term_data',
	'taxonomy_term_field_data',
	'path_alias',
	'file_managed',
	'menu_link_content',
	'menu_link_content_data',
	'media',
	'media_field_data',
	'block_content',
	'block_content_field_data',
	'semaphore',
	'flood',
	'queue',
	'file_usage',
	'inline_block_usage',
	'taxonomy_index',
	'batch',
	'sequences'
];

/**
 * Tables that are authoritative and must NOT cross, each for its own reason.
 *
 * `sessions` is the documented cost of the whole procedure: rows minted on the source are signed
 * against a different `hash_salt`, so on the target they neither work nor fail visibly and a visitor
 * sees an intermittent logged-out state. Everyone logs in again.
 */
export const EXCLUDED_FROM_DELTA: Record<string, string> = {
	sessions:
		'signed against the source hash_salt, so on the target they neither work nor fail visibly; everyone logs in again',
	semaphore: 'a lock held on the source means nothing on the target',
	flood: 'a rate-limit counter regenerates, and carrying one bans somebody for the old window',
	queue: 'a claimed item is claimed on the source forever and absent from the target either way',
	batch: 'a half-finished batch cannot be resumed on a different site',
	watchdog: 'a log is not state'
};

/** the pattern set that makes an entity storage table authoritative without enumerating it */
export const AUTHORITATIVE_PATTERNS: readonly RegExp[] = [
	/^[a-z0-9_]+__[a-z0-9_]+$/,
	/_revision$/,
	/_revision__[a-z0-9_]+$/,
	/_field_revision$/
];

export interface DeltaPlan {
	/** the tables the second dump carries, sorted */
	tables: string[];
	/** what was dropped, and why */
	excluded: { table: string; why: string }[];
	/** the statement that re-seeds the id generator, which is the step that fails silently */
	reseed: string;
	/** the ordered steps, files before database */
	steps: { n: number; title: string; command: string | null; detail: string }[];
}

/**
 * Which tables the delta dump carries.
 *
 * `discovered` is the table list from the source, so a site with contrib entity storage gets its
 * `node__field_x` tables through the patterns rather than through a list nobody prunes. Passing none
 * gives the base set.
 */
export function deltaTables(discovered: readonly string[] = []): string[] {
	const wanted = new Set(AUTHORITATIVE_TABLES);
	for (const table of discovered) {
		if (AUTHORITATIVE_PATTERNS.some((p) => p.test(table))) wanted.add(table);
	}
	for (const table of Object.keys(EXCLUDED_FROM_DELTA)) wanted.delete(table);
	return [...wanted].sort();
}

/**
 * The `sequences` re-seed.
 *
 * `sequences` is copied AND THEN re-seeded above the highest id in the copied set. This is the one
 * arithmetic step in the whole procedure and the one that fails silently if it is skipped: the first
 * new node on the target collides with a row the delta pass brought over, and nothing errors until
 * the two meet.
 *
 * It is a separate statement rather than a copied row, for the same reason the worker's export reads
 * integers through `hex()`: a value that has to be COMPUTED from what landed cannot be a value that
 * was carried.
 */
export function reseedStatement(table = 'sequences'): string {
	return `UPDATE ${table} SET value = (SELECT COALESCE(MAX(nid), 0) FROM node) + 1 WHERE value < (SELECT COALESCE(MAX(nid), 0) FROM node) + 1;`;
}

/**
 * The ordered cutover steps.
 *
 * **Files before the database, both passes.** A file with no row is dead weight; a row whose bytes
 * have not arrived is a broken image on a page a visitor is looking at.
 *
 * The source is NOT taken out of maintenance mode at the end. It stays there as the rollback target,
 * which is the only rollback this procedure has.
 */
export function deltaPlan(discovered: readonly string[] = []): DeltaPlan {
	const tables = deltaTables(discovered);
	return {
		tables,
		excluded: Object.entries(EXCLUDED_FROM_DELTA).map(([table, why]) => ({ table, why })),
		reseed: reseedStatement(),
		steps: [
			{
				n: 1,
				title: 'put the source in maintenance mode and stop its crontab',
				command: 'drush state:set system.maintenance_mode 1',
				detail: 'every write the source accepts after the last dump read is lost, and the window exists to make that set empty. Cron keeps draining queues and indexing search until it is stopped, and each of those is a write'
			},
			{
				n: 2,
				title: 'rsync the files directory, second pass, BEFORE the database',
				command: null,
				detail: 'a file with no row is dead weight and a row with no file is a broken image, so the bytes go first'
			},
			{
				n: 3,
				title: 'dump the delta table set',
				command: `drush sql:dump --tables-list=${tables.join(',')}`,
				detail: `${tables.length} table(s); ${Object.keys(EXCLUDED_FROM_DELTA).length} authoritative table(s) are deliberately left behind`
			},
			{
				n: 4,
				title: 'convert, install and deploy',
				command:
					'drangler migrate convert --from mysql --to sqlite && drangler migrate install --db ... --repack && drangler deploy',
				detail: 'the delta lands in the workspace pack and reaches the site through a deploy. There is no route that applies SQL to a live object, and there is not going to be one'
			},
			{
				n: 5,
				title: 're-seed the id generator',
				command: null,
				detail: `append this to the converted delta before installing it: ${reseedStatement()}`
			},
			{
				n: 6,
				title: 'wait for the pack replay',
				command: 'drangler site upgrade --no-deploy',
				detail: 'the object answers 503 with x-cfw-migrate until its cursor is done'
			},
			{
				n: 7,
				title: 'flip DNS',
				command: null,
				detail: 'the source stays in maintenance mode afterwards, as the rollback target. It is not taken out'
			}
		]
	};
}

/** refuses a table somebody asked to add that the inventory says must not cross */
export function assertCrossable(table: string): void {
	const why = EXCLUDED_FROM_DELTA[table];
	if (why !== undefined) {
		throw new UsageError(`${table} must not cross in a delta: ${why}`);
	}
}
