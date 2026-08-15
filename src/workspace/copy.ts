import { createHash } from 'node:crypto';
import { DranglerError, UsageError } from '../errors';
import type { FileHost } from '../host/files';
import { inWorkspace } from './artifacts';

/** sha256 of a file's bytes, lowercase hex; the identity every decision here is made on */
export function digest(files: FileHost, path: string): string {
	return createHash('sha256').update(files.readBytes(path)).digest('hex');
}

/** what landing one file would do to whatever is already at its destination */
export type CopyVerdict = 'create' | 'identical' | 'overwrite';

export interface CopyEntry {
	from: string;
	to: string;
}

export interface CopyItem extends CopyEntry {
	verdict: CopyVerdict;
	bytes: number;
	sha256: string;
}

export interface CopyPlan {
	items: CopyItem[];
	/** how many destinations would be overwritten, and therefore how many backups are needed */
	backups: number;
}

/**
 * Decides what each copy would do, without writing anything.
 *
 * `identical` is its own verdict rather than a kind of overwrite. Re-running an install must not
 * produce a directory of backups of files that never changed, and a backup set full of noise is one
 * nobody reads when it matters.
 *
 * @throws {UsageError} naming any source that is not there, before any destination is examined.
 */
export function planCopy(files: FileHost, entries: readonly CopyEntry[]): CopyPlan {
	const absent = entries.filter((e) => !files.exists(e.from)).map((e) => e.from);
	if (absent.length > 0) throw new UsageError(`no such file: ${absent.join(', ')}`);

	const items = entries.map((entry) => {
		const sha256 = digest(files, entry.from);
		const verdict: CopyVerdict = !files.exists(entry.to)
			? 'create'
			: digest(files, entry.to) === sha256
				? 'identical'
				: 'overwrite';
		return { ...entry, verdict, bytes: files.size(entry.from), sha256 };
	});
	return { items, backups: items.filter((i) => i.verdict === 'overwrite').length };
}

/** one saved file, enough to put it back without guessing */
export interface BackupRecord {
	/** where it was, so a restore needs no argument but the backup directory */
	path: string;
	/** where it is now */
	backup: string;
	bytes: number;
	sha256: string;
}

export interface BackupManifest {
	version: 1;
	takenAt: string;
	entries: BackupRecord[];
}

/** the file a restore reads; a backup nothing can find is not a backup */
export const BACKUP_MANIFEST = 'backup.json';

/** where a backup set lands, one directory per run, named for when the run happened */
export function backupDir(workspace: string, now: Date): string {
	const stamp = now.toISOString().replace(/[:.]/g, '').replace(/-/g, '');
	return inWorkspace(workspace, `.drangler-backup/${stamp}`);
}

export interface CopyResult {
	backupDir: string | null;
	backedUp: BackupRecord[];
	written: string[];
	unchanged: string[];
}

/**
 * Copies a plan, taking every backup BEFORE the first byte is written.
 *
 * The ordering is the rule, not an implementation detail. Backing up each file just before
 * overwriting it leaves a failure part-way through with half a tree replaced and half of it
 * unbacked, which is strictly worse than either finishing or refusing. So: back everything up,
 * verify each backup by digest against the file it came from, and only then write.
 *
 * Lifted from what `drupflare/worker` does by hand -- `bake-pack.ts` snapshots `site.sqlite` before
 * its first write, `hydrate.ts` verifies every byte against a manifest before it lands, and
 * `backup-cdn.ts` refuses to replace content that differs without an explicit flag. All three are
 * the same rule and none of them was reusable.
 *
 * @throws {DranglerError} before writing anything, when a backup does not read back as what it
 *   copied.
 */
export function applyCopy(
	files: FileHost,
	plan: CopyPlan,
	workspace: string,
	now: Date
): CopyResult {
	const doomed = plan.items.filter((i) => i.verdict === 'overwrite');
	const dir = doomed.length === 0 ? null : backupDir(workspace, now);
	const backedUp: BackupRecord[] = [];

	if (dir !== null) {
		for (const item of doomed) {
			const before = digest(files, item.to);
			const target = `${dir}/${flatten(workspace, item.to)}`;
			files.writeBytes(target, files.readBytes(item.to));
			if (digest(files, target) !== before) {
				throw new DranglerError(
					'backup',
					`the backup of ${item.to} does not read back as what it copied, so nothing was ` +
						'overwritten. Check the filesystem at ' +
						dir
				);
			}
			backedUp.push({
				path: item.to,
				backup: target,
				bytes: files.size(item.to),
				sha256: before
			});
		}
		const manifest: BackupManifest = {
			version: 1,
			takenAt: now.toISOString(),
			entries: backedUp
		};
		files.writeText(`${dir}/${BACKUP_MANIFEST}`, `${JSON.stringify(manifest, null, 2)}\n`);
	}

	const written: string[] = [];
	const unchanged: string[] = [];
	for (const item of plan.items) {
		if (item.verdict === 'identical') {
			unchanged.push(item.to);
			continue;
		}
		files.writeBytes(item.to, files.readBytes(item.from));
		written.push(item.to);
	}
	return { backupDir: dir, backedUp, written, unchanged };
}

/** a workspace-relative path flattened into one filename, so a backup set is one flat directory */
function flatten(workspace: string, path: string): string {
	const root = workspace.replace(/\/+$/, '');
	const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
	return rel.replace(/^\/+/, '').replace(/\//g, '__');
}

/**
 * Puts a backup set back where it came from, verifying every file first.
 *
 * Every digest is checked before the first write, for the same reason the backups are taken before
 * the first write: a restore that fails half way is a third state nobody planned for.
 *
 * @throws {DranglerError} when a backup file is missing or no longer matches its recorded digest.
 */
export function restoreBackup(files: FileHost, dir: string): BackupRecord[] {
	const manifestPath = `${dir.replace(/\/+$/, '')}/${BACKUP_MANIFEST}`;
	if (!files.exists(manifestPath)) {
		throw new UsageError(`no ${BACKUP_MANIFEST} at ${manifestPath}; that is not a backup set`);
	}
	let manifest: BackupManifest;
	try {
		manifest = JSON.parse(files.readText(manifestPath)) as BackupManifest;
	} catch (e) {
		throw new UsageError(
			`${manifestPath} is not a backup manifest: ${e instanceof Error ? e.message : String(e)}`
		);
	}
	const entries = manifest.entries ?? [];

	const problems: string[] = [];
	for (const entry of entries) {
		if (!files.exists(entry.backup)) {
			problems.push(`${entry.backup} is missing`);
			continue;
		}
		const actual = digest(files, entry.backup);
		if (actual !== entry.sha256) {
			problems.push(`${entry.backup} is ${actual}, the manifest says ${entry.sha256}`);
		}
	}
	if (problems.length > 0) {
		throw new DranglerError(
			'restore',
			`the backup set does not match its manifest, so nothing was restored:\n  ${problems.join('\n  ')}`
		);
	}

	for (const entry of entries) files.writeBytes(entry.path, files.readBytes(entry.backup));
	return entries;
}
