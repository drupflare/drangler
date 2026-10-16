import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIL_SENDER_OVERRIDE, readMailSender } from '../src/migrate/mail-system';
import { phpSerialize } from './helpers';

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function site(rows: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), 'mail-'));
	dirs.push(dir);
	const path = join(dir, 'site.sqlite');
	const db = new DatabaseSync(path);
	db.exec('CREATE TABLE config (collection TEXT, name TEXT, data BLOB)');
	const put = db.prepare('INSERT INTO config VALUES (?, ?, ?)');
	for (const [name, data] of Object.entries(rows)) {
		put.run('', name, Buffer.from(phpSerialize(data), 'latin1'));
	}
	db.close();
	return path;
}

describe('readMailSender', () => {
	it('names the Mail System sender that would open its own socket', () => {
		const path = site({
			'mailsystem.settings': {
				defaults: { sender: 'SMTPMailSystem', formatter: 'mime_mail' }
			}
		});
		expect(readMailSender(path)).toBe('SMTPMailSystem');
	});

	it('is null without the module, with no sender, or when the sender is already the worker', () => {
		expect(readMailSender(site({ 'system.site': { name: 'A' } }))).toBeNull();
		expect(readMailSender(site({ 'mailsystem.settings': { defaults: {} } }))).toBeNull();
		expect(
			readMailSender(site({ 'mailsystem.settings': { defaults: { sender: 'cfw_mail' } } }))
		).toBeNull();
	});

	it('is null for a database with no config table', () => {
		const dir = mkdtempSync(join(tmpdir(), 'mail-'));
		dirs.push(dir);
		const path = join(dir, 'empty.sqlite');
		new DatabaseSync(path).close();
		expect(readMailSender(path)).toBeNull();
	});

	it('moves only the sender, leaving the formatter to the site', () => {
		expect(MAIL_SENDER_OVERRIDE).toEqual({
			'mailsystem.settings': { defaults: { sender: 'cfw_mail' } }
		});
	});
});
