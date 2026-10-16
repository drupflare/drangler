import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
	blankingOverrides,
	blankOverrideCredentials,
	credentialsIn,
	describeCredential,
	isCarried,
	mergeOverrides,
	readCredentials,
	unserialize
} from '../src/migrate/credentials';
import { phpSerialize as php } from './helpers';

const keyEntity = (provider: string, value: string) => ({
	key_provider: provider,
	key_provider_settings: { key_value: value },
	key_input: 'text_field'
});

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('unserialize', () => {
	it('reads every shape Drupal config uses', () => {
		const value = { a: 1, b: 'two', c: true, d: null, e: { f: 'g' } };
		expect(unserialize(php(value))).toEqual(value);
	});

	it('counts string length in bytes, so a multibyte value does not shift the rest', () => {
		const latin1 = Buffer.from('cafÃ©', 'utf8').toString('latin1');
		expect(unserialize(php({ name: latin1, next: 'x' }))).toEqual({ name: latin1, next: 'x' });
	});

	it('throws on text that is not serialized', () => {
		expect(() => unserialize('not php')).toThrow(/not serialized config/);
	});
});

describe('credentialsIn', () => {
	it('names a config-provider key and nothing else about it', () => {
		expect(
			credentialsIn('key.key.stripe', unserialize(php(keyEntity('config', 'sk_live_x'))))
		).toEqual([{ config: 'key.key.stripe', path: ['key_provider_settings', 'key_value'] }]);
	});

	it('leaves a key that lives in the environment or a file, which holds no value here', () => {
		expect(
			credentialsIn('key.key.a', unserialize(php(keyEntity('env', 'MANTLE2_KEY'))))
		).toEqual([]);
		expect(credentialsIn('key.key.a', unserialize(php(keyEntity('config', ' '))))).toEqual([]);
	});

	it('keeps a public certificate and blanks a service account that holds a private key', () => {
		const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
		const account = '{"private_key": "-----BEGIN PRIVATE KEY-----\\nabc"}';
		expect(credentialsIn('key.key.root', unserialize(php(keyEntity('config', cert))))).toEqual(
			[]
		);
		expect(
			credentialsIn('key.key.fcm', unserialize(php(keyEntity('config', account))))
		).toHaveLength(1);
	});

	it('finds named leaves at any depth in other config, and the smtp login', () => {
		const smtp = {
			smtp_host: 'mx.example.com',
			smtp_username: 'mailer',
			smtp_password: 'hunter2',
			smtp_on: false
		};
		expect(credentialsIn('smtp.settings', unserialize(php(smtp))).map((c) => c.path)).toEqual([
			['smtp_username'],
			['smtp_password']
		]);
		const oidc = { settings: { client_id: 'abc', client_secret: 's3cret', empty_token: '' } };
		expect(credentialsIn('openid_connect.client.x', unserialize(php(oidc)))).toEqual([
			{ config: 'openid_connect.client.x', path: ['settings', 'client_secret'] }
		]);
	});

	it('does not read a word that only contains a credential word', () => {
		const data = { tokenizer: 'x', keyboard: 'y', passwordless: 'z', use_token: true };
		expect(credentialsIn('system.site', unserialize(php(data)))).toEqual([]);
	});
});

describe('readCredentials', () => {
	it('reads the config table of a built site database, and a missing table reads as none', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cred-'));
		dirs.push(dir);
		const path = join(dir, 'site.sqlite');
		const db = new DatabaseSync(path);
		db.exec(
			'CREATE TABLE config (collection TEXT, name TEXT, data BLOB, PRIMARY KEY (collection, name))'
		);
		const put = db.prepare('INSERT INTO config VALUES (?, ?, ?)');
		put.run('', 'key.key.api', Buffer.from(php(keyEntity('config', 'live-key')), 'latin1'));
		put.run('', 'system.site', Buffer.from(php({ name: 'Site' }), 'latin1'));
		put.run('', 'broken', Buffer.from('garbage', 'latin1'));
		put.run(
			'language.fr',
			'key.key.other',
			Buffer.from(php(keyEntity('config', 'fr')), 'latin1')
		);
		db.close();
		expect(readCredentials(path).map((c) => c.config)).toEqual(['key.key.api']);

		const empty = join(dir, 'empty.sqlite');
		new DatabaseSync(empty).close();
		expect(readCredentials(empty)).toEqual([]);
	});
});

describe('blanking', () => {
	const found = [
		{ config: 'key.key.mantle2_api_key', path: ['key_provider_settings', 'key_value'] },
		{ config: 'smtp.settings', path: ['smtp_password'] },
		{ config: 'smtp.settings', path: ['smtp_username'] }
	];

	it('empties each one through a nested override and reports it by key id, never by value', () => {
		const got = blankingOverrides(found, []);
		expect(got.overrides).toEqual({
			'key.key.mantle2_api_key': { key_provider_settings: { key_value: '' } },
			'smtp.settings': { smtp_password: '', smtp_username: '' }
		});
		expect(got.blanked.map(describeCredential)).toEqual([
			'mantle2_api_key',
			'smtp.settings:smtp_password',
			'smtp.settings:smtp_username'
		]);
	});

	it('carries what was asked for, by key id, config name or config:leaf', () => {
		expect(isCarried(found[0]!, ['mantle2_api_key'])).toBe(true);
		expect(isCarried(found[0]!, ['key.key.mantle2_api_key'])).toBe(true);
		expect(isCarried(found[1]!, ['smtp.settings'])).toBe(true);
		expect(isCarried(found[1]!, ['smtp.settings:smtp_username'])).toBe(false);
		const got = blankingOverrides(found, ['mantle2_api_key', 'smtp.settings:smtp_password']);
		expect(got.carried).toHaveLength(2);
		expect(got.overrides).toEqual({ 'smtp.settings': { smtp_username: '' } });
	});

	it('blanks a literal secret that settings.php overrides, leaving the rest of the object', () => {
		const config = {
			'smtp.settings': { smtp_password: 'x', smtp_host: 'mx' },
			'system.site': { name: 'A' }
		};
		const blanked = blankOverrideCredentials(config, []);
		expect(blanked).toHaveLength(1);
		expect(config).toEqual({
			'smtp.settings': { smtp_password: '', smtp_host: 'mx' },
			'system.site': { name: 'A' }
		});
		const carried = { 'smtp.settings': { smtp_password: 'x' } };
		expect(blankOverrideCredentials(carried, ['smtp.settings'])).toEqual([]);
		expect(carried['smtp.settings'].smtp_password).toBe('x');
	});

	it('merges overrides without losing a sibling key of the same object', () => {
		expect(
			mergeOverrides(
				{ 'smtp.settings': { smtp_host: 'mx' }, 'system.site': { name: 'A' } },
				{ 'smtp.settings': { smtp_password: '' } }
			)
		).toEqual({
			'smtp.settings': { smtp_host: 'mx', smtp_password: '' },
			'system.site': { name: 'A' }
		});
	});
});
