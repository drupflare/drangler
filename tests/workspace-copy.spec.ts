import { describe, expect, it } from 'vitest';
import { DranglerError, UsageError } from '../src/errors';
import { memoryFiles, type FileHost } from '../src/host/files';
import {
	applyCopy,
	BACKUP_MANIFEST,
	backupDir,
	digest,
	planCopy,
	restoreBackup,
	type BackupManifest
} from '../src/workspace/copy';
import { WORKSPACE } from './helpers';

const NOW = new Date('2026-08-15T03:15:00.000Z');
const DB = `${WORKSPACE}/assets/drupal/site.sqlite`;
const STAMP = `${WORKSPACE}/.drangler-backup/20260815T031500000Z`;

const tree = (over: Record<string, string> = {}) =>
	memoryFiles({ '/in/site.sqlite': 'NEW DATABASE', ...over });

describe('backupDir', () => {
	it('names one directory per run, from the clock the caller injected', () => {
		expect(backupDir(WORKSPACE, NOW)).toBe(STAMP);
	});

	it('produces a stamp with no character a filesystem argues about', () => {
		expect(backupDir(WORKSPACE, NOW).split('/').pop()).not.toMatch(/[:.]/);
	});
});

describe('planCopy', () => {
	it('calls an absent destination a create', () => {
		const plan = planCopy(tree(), [{ from: '/in/site.sqlite', to: DB }]);
		expect(plan.items[0]).toMatchObject({ verdict: 'create', bytes: 12 });
		expect(plan.backups).toBe(0);
	});

	it('calls a differing destination an overwrite, and counts a backup for it', () => {
		const plan = planCopy(tree({ [DB]: 'OLD DATABASE' }), [
			{ from: '/in/site.sqlite', to: DB }
		]);
		expect(plan.items[0]?.verdict).toBe('overwrite');
		expect(plan.backups).toBe(1);
	});

	it('calls a byte-identical destination identical, so a re-run backs up nothing', () => {
		const plan = planCopy(tree({ [DB]: 'NEW DATABASE' }), [
			{ from: '/in/site.sqlite', to: DB }
		]);
		expect(plan.items[0]?.verdict).toBe('identical');
		expect(plan.backups).toBe(0);
	});

	it('compares by digest, not by size; two files of one length are not one file', () => {
		const files = tree({ [DB]: 'OLD DATABASE' });
		expect(files.size(DB)).toBe(files.size('/in/site.sqlite'));
		expect(planCopy(files, [{ from: '/in/site.sqlite', to: DB }]).items[0]?.verdict).toBe(
			'overwrite'
		);
	});

	it('names every absent source before it looks at a single destination', () => {
		expect(() =>
			planCopy(tree(), [
				{ from: '/in/site.sqlite', to: DB },
				{ from: '/in/gone.sqlite', to: `${WORKSPACE}/x` }
			])
		).toThrow(UsageError);
	});

	it('records the source digest, which is what a later verification compares against', () => {
		const files = tree();
		expect(planCopy(files, [{ from: '/in/site.sqlite', to: DB }]).items[0]?.sha256).toBe(
			digest(files, '/in/site.sqlite')
		);
	});
});

describe('applyCopy', () => {
	it('takes no backup when nothing is overwritten', () => {
		const files = tree();
		const result = applyCopy(
			files,
			planCopy(files, [{ from: '/in/site.sqlite', to: DB }]),
			WORKSPACE,
			NOW
		);
		expect(result).toMatchObject({ backupDir: null, backedUp: [], written: [DB] });
		expect(files.readText(DB)).toBe('NEW DATABASE');
	});

	it('backs the old bytes up before writing, and the backup is readable', () => {
		const files = tree({ [DB]: 'OLD DATABASE' });
		const result = applyCopy(
			files,
			planCopy(files, [{ from: '/in/site.sqlite', to: DB }]),
			WORKSPACE,
			NOW
		);

		expect(result.backupDir).toBe(STAMP);
		expect(result.backedUp).toHaveLength(1);
		expect(files.readText(result.backedUp[0]!.backup)).toBe('OLD DATABASE');
		expect(files.readText(DB)).toBe('NEW DATABASE');
	});

	it('flattens the backup name, so one directory holds a whole set unambiguously', () => {
		const files = tree({ [DB]: 'OLD DATABASE' });
		const result = applyCopy(
			files,
			planCopy(files, [{ from: '/in/site.sqlite', to: DB }]),
			WORKSPACE,
			NOW
		);
		expect(result.backedUp[0]?.backup).toBe(`${STAMP}/assets__drupal__site.sqlite`);
	});

	it('writes a manifest a restore can read without being told anything else', () => {
		const files = tree({ [DB]: 'OLD DATABASE' });
		applyCopy(files, planCopy(files, [{ from: '/in/site.sqlite', to: DB }]), WORKSPACE, NOW);

		const manifest = JSON.parse(
			files.readText(`${STAMP}/${BACKUP_MANIFEST}`)
		) as BackupManifest;
		expect(manifest).toMatchObject({ version: 1, takenAt: NOW.toISOString() });
		expect(manifest.entries[0]).toMatchObject({ path: DB, bytes: 12 });
	});

	it('takes EVERY backup before the FIRST write, so a mid-run failure leaves a complete set', () => {
		const files = tree({
			'/in/two.json': 'NEW TWO',
			[DB]: 'OLD DATABASE',
			[`${WORKSPACE}/assets/two.json`]: 'OLD TWO'
		});
		const order: string[] = [];
		const traced: FileHost = {
			...files,
			writeBytes: (path, bytes) => {
				order.push(path);
				if (path === DB) throw new Error('ENOSPC');
				files.writeBytes(path, bytes);
			}
		};
		const plan = planCopy(files, [
			{ from: '/in/site.sqlite', to: DB },
			{ from: '/in/two.json', to: `${WORKSPACE}/assets/two.json` }
		]);
		expect(() => applyCopy(traced, plan, WORKSPACE, NOW)).toThrow('ENOSPC');

		// both backups landed before the destination that blew up was touched
		expect(order.slice(0, 2)).toEqual([
			`${STAMP}/assets__drupal__site.sqlite`,
			`${STAMP}/assets__two.json`
		]);
		expect(files.readText(`${STAMP}/assets__drupal__site.sqlite`)).toBe('OLD DATABASE');
		expect(files.readText(`${STAMP}/assets__two.json`)).toBe('OLD TWO');
	});

	it('refuses to overwrite when a backup does not read back as what it copied', () => {
		const files = tree({ [DB]: 'OLD DATABASE' });
		const lying: FileHost = {
			...files,
			writeBytes: (path, bytes) => {
				files.writeBytes(
					path,
					path.includes('.drangler-backup') ? new Uint8Array() : bytes
				);
			}
		};
		const plan = planCopy(files, [{ from: '/in/site.sqlite', to: DB }]);
		expect(() => applyCopy(lying, plan, WORKSPACE, NOW)).toThrow(DranglerError);
		expect(files.readText(DB)).toBe('OLD DATABASE');
	});

	it('skips an identical file entirely: no backup, no write', () => {
		const files = tree({ [DB]: 'NEW DATABASE' });
		const result = applyCopy(
			files,
			planCopy(files, [{ from: '/in/site.sqlite', to: DB }]),
			WORKSPACE,
			NOW
		);
		expect(result).toMatchObject({ backupDir: null, written: [], unchanged: [DB] });
		expect(files.exists(STAMP)).toBe(false);
	});

	it('keeps a destination outside the workspace addressable in the backup set', () => {
		const files = tree({ '/elsewhere/x.json': 'OLD' });
		const plan = planCopy(files, [{ from: '/in/site.sqlite', to: '/elsewhere/x.json' }]);
		const result = applyCopy(files, plan, WORKSPACE, NOW);
		expect(result.backedUp[0]?.backup).toBe(`${STAMP}/elsewhere__x.json`);
	});

	it('moves bytes that are not text, which a real site.sqlite is', () => {
		const files = memoryFiles({});
		const raw = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0xff, 0xfe, 0x80]);
		files.writeBytes('/in/site.sqlite', raw);
		files.writeBytes(DB, new Uint8Array([0x00, 0x01]));

		applyCopy(files, planCopy(files, [{ from: '/in/site.sqlite', to: DB }]), WORKSPACE, NOW);
		expect([...files.readBytes(DB)]).toEqual([...raw]);
		expect([...files.readBytes(`${STAMP}/assets__drupal__site.sqlite`)]).toEqual([0x00, 0x01]);
	});
});

describe('restoreBackup', () => {
	function backedUp() {
		const files = tree({ [DB]: 'OLD DATABASE' });
		applyCopy(files, planCopy(files, [{ from: '/in/site.sqlite', to: DB }]), WORKSPACE, NOW);
		return files;
	}

	it('puts the original bytes back', () => {
		const files = backedUp();
		expect(files.readText(DB)).toBe('NEW DATABASE');
		expect(restoreBackup(files, STAMP)).toHaveLength(1);
		expect(files.readText(DB)).toBe('OLD DATABASE');
	});

	it('tolerates a trailing slash on the directory', () => {
		const files = backedUp();
		expect(restoreBackup(files, `${STAMP}/`)).toHaveLength(1);
	});

	it('refuses a directory with no manifest, rather than guessing what is in it', () => {
		expect(() => restoreBackup(memoryFiles({ '/b/x': 'y' }), '/b')).toThrow(UsageError);
	});

	it('refuses an unparseable manifest', () => {
		expect(() => restoreBackup(memoryFiles({ [`/b/${BACKUP_MANIFEST}`]: '{' }), '/b')).toThrow(
			UsageError
		);
	});

	it('verifies every digest BEFORE the first write, so a tampered set restores nothing', () => {
		const files = backedUp();
		files.writeText(`${STAMP}/assets__drupal__site.sqlite`, 'TAMPERED');
		expect(() => restoreBackup(files, STAMP)).toThrow(/does not match its manifest/);
		expect(files.readText(DB)).toBe('NEW DATABASE');
	});

	it('names a backup file that has gone missing', () => {
		const files = backedUp();
		const manifest = JSON.parse(
			files.readText(`${STAMP}/${BACKUP_MANIFEST}`)
		) as BackupManifest;
		manifest.entries[0]!.backup = `${STAMP}/gone`;
		files.writeText(`${STAMP}/${BACKUP_MANIFEST}`, JSON.stringify(manifest));
		expect(() => restoreBackup(files, STAMP)).toThrow(/is missing/);
	});

	it('restores an empty set without complaining', () => {
		const files = memoryFiles({
			[`/b/${BACKUP_MANIFEST}`]: JSON.stringify({ version: 1, takenAt: '', entries: [] })
		});
		expect(restoreBackup(files, '/b')).toEqual([]);
	});
});
