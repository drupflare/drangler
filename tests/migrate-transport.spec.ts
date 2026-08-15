import { describe, expect, it } from 'vitest';
import { TransportError, UsageError } from '../src/errors';
import { scriptedRunner } from '../src/host/exec';
import { destination, normaliseRoot, parseTarget } from '../src/migrate/target';
import {
	refusingTransport,
	replayTransport,
	sshArgs,
	sshTransport
} from '../src/migrate/transport';
import { ok } from './helpers';

describe('parseTarget', () => {
	it('reads user, host and port', () => {
		expect(parseTarget('deploy@10.0.0.4:2222', '/var/www/html')).toEqual({
			user: 'deploy',
			host: '10.0.0.4',
			port: 2222,
			identity: undefined,
			root: '/var/www/html'
		});
	});

	it('accepts a bare host', () => {
		const target = parseTarget('example.com', '/srv/drupal');
		expect(target).toMatchObject({ user: null, host: 'example.com', port: null });
		expect(destination(target)).toBe('example.com');
	});

	it('carries an identity through untouched', () => {
		expect(parseTarget('a@b', '/x', '/home/me/.ssh/id_ed25519').identity).toBe(
			'/home/me/.ssh/id_ed25519'
		);
	});

	it('refuses an empty spec', () => {
		expect(() => parseTarget('  ', '/x')).toThrow(UsageError);
	});

	it('refuses a username that could become an ssh flag', () => {
		expect(() => parseTarget('bad user@host', '/x')).toThrow(/not a username/);
	});

	it('refuses a hostname with a shell metacharacter', () => {
		expect(() => parseTarget('host;rm -rf /', '/x')).toThrow(/not a hostname/);
		expect(() => parseTarget('-oProxyCommand=x', '/x')).toThrow(/not a hostname/);
	});

	it('refuses a non-numeric or out-of-range port', () => {
		expect(() => parseTarget('host:ssh', '/x')).toThrow(/not a port/);
		expect(() => parseTarget('host:99999', '/x')).toThrow(/out of range/);
	});
});

describe('normaliseRoot', () => {
	it('strips a trailing slash', () => {
		expect(normaliseRoot('/var/www/html/')).toBe('/var/www/html');
	});

	it('keeps the filesystem root', () => {
		expect(normaliseRoot('/')).toBe('/');
	});

	it('refuses empty, relative, traversing and shell-unsafe roots', () => {
		expect(() => normaliseRoot('')).toThrow(/absolute path/);
		expect(() => normaliseRoot('var/www')).toThrow(/must be absolute/);
		expect(() => normaliseRoot('/var/../etc')).toThrow(/must not contain \.\./);
		expect(() => normaliseRoot('/var/www;id')).toThrow(/shell metacharacters/);
	});
});

describe('sshArgs', () => {
	it('sets BatchMode so a missing key fails instead of prompting', () => {
		const args = sshArgs(parseTarget('me@host', '/x'), 'php -v');
		expect(args).toEqual([
			'-o',
			'BatchMode=yes',
			'-o',
			'StrictHostKeyChecking=accept-new',
			'me@host',
			'php -v'
		]);
	});

	it('adds the port and the identity when present', () => {
		const args = sshArgs(parseTarget('me@host:2222', '/x', '/k'), 'ls');
		expect(args).toContain('-p');
		expect(args).toContain('2222');
		expect(args).toContain('-i');
		expect(args).toContain('/k');
	});
});

describe('sshTransport', () => {
	it('runs the command through the injected runner', async () => {
		const runner = scriptedRunner({
			'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new me@host php -v':
				ok('PHP 8.3.6')
		});
		const transport = sshTransport(runner, parseTarget('me@host', '/x'));
		expect(transport.label).toBe('me@host');
		expect((await transport.exec('php -v')).stdout).toBe('PHP 8.3.6');
	});

	it('turns ssh exit 255 into a named connection failure', async () => {
		const runner = scriptedRunner({
			'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new me@host ls': {
				code: 255,
				stdout: '',
				stderr: 'Permission denied (publickey).'
			}
		});
		const transport = sshTransport(runner, parseTarget('me@host', '/x'));
		await expect(transport.exec('ls')).rejects.toThrow(/could not connect.*publickey/s);
	});

	it('passes a non-zero exit that is not 255 back as data', async () => {
		const runner = scriptedRunner({});
		const transport = sshTransport(runner, parseTarget('me@host', '/x'));
		expect((await transport.exec('drush status')).code).toBe(127);
	});
});

describe('replayTransport', () => {
	it('answers from the transcript', async () => {
		const transport = replayTransport({ 'php -v': ok('PHP 8.3.6') });
		expect((await transport.exec('php -v')).stdout).toBe('PHP 8.3.6');
	});

	it('refuses a command the transcript does not hold', async () => {
		await expect(replayTransport({}).exec('php -v')).rejects.toThrow(TransportError);
	});
});

describe('refusingTransport', () => {
	it('refuses everything, naming the command it would have run', async () => {
		await expect(refusingTransport('host').exec('rm -rf /')).rejects.toThrow(
			/dry run.*rm -rf/s
		);
	});
});
