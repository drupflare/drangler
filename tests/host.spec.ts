import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeRunner, scriptedRunner } from '../src/host/exec';
import { memoryFiles, nodeFiles, readJson } from '../src/host/files';

describe('memoryFiles', () => {
	const files = () =>
		memoryFiles({
			'/ws/worker/package.json': '{"name":"w","version":"1.0.0"}',
			'/ws/worker/src/site.ts': 'export {};',
			'/ws/rom/composer.json': 'not json'
		});

	it('derives directories from the file keys', () => {
		const fs = files();
		expect(fs.exists('/ws/worker')).toBe(true);
		expect(fs.exists('/ws/worker/src')).toBe(true);
		expect(fs.exists('/ws/nothing')).toBe(false);
	});

	it('lists a directory with its subdirectories marked', () => {
		expect(files().readDir('/ws/worker')).toEqual([
			{ name: 'package.json', directory: false },
			{ name: 'src', directory: true }
		]);
	});

	it('records what was written and reads it back', () => {
		const fs = files();
		fs.writeText('/out/x.sql', 'SELECT 1;');
		expect(fs.readText('/out/x.sql')).toBe('SELECT 1;');
		expect(fs.written.get('/out/x.sql')).toBe('SELECT 1;');
	});

	it('throws on a missing file rather than returning empty', () => {
		expect(() => files().readText('/nope')).toThrow(/ENOENT/);
		expect(() => files().size('/nope')).toThrow(/ENOENT/);
		expect(() => files().readDir('/nope')).toThrow(/ENOENT/);
	});

	it('reports a size in bytes, not characters', () => {
		const fs = memoryFiles({ '/a': 'é' });
		expect(fs.size('/a')).toBe(3);
	});
});

describe('readJson', () => {
	it('returns null for absent and for unparseable', () => {
		const fs = memoryFiles({ '/bad.json': '{' });
		expect(readJson(fs, '/missing.json')).toBeNull();
		expect(readJson(fs, '/bad.json')).toBeNull();
	});

	it('parses a good document', () => {
		const fs = memoryFiles({ '/good.json': '{"a":1}' });
		expect(readJson(fs, '/good.json')).toEqual({ a: 1 });
	});
});

describe('scriptedRunner', () => {
	it('answers a matching command line and records the call', async () => {
		const runner = scriptedRunner({
			'git --version': { code: 0, stdout: 'git 2.0', stderr: '' }
		});
		expect(await runner.run('git', ['--version'])).toEqual({
			code: 0,
			stdout: 'git 2.0',
			stderr: ''
		});
		expect(runner.calls).toEqual([{ file: 'git', args: ['--version'] }]);
	});

	it('answers 127 for an unscripted command', async () => {
		const result = await scriptedRunner({}).run('ssh', ['host', 'ls']);
		expect(result.code).toBe(127);
		expect(result.stderr).toContain('ssh host ls');
	});

	it('supports a function entry and records the cwd', async () => {
		const runner = scriptedRunner({
			'git status': (args) => ({ code: 0, stdout: args.join('|'), stderr: '' })
		});
		const result = await runner.run('git', ['status'], { cwd: '/ws' });
		expect(result.stdout).toBe('status');
		expect(runner.calls[0]?.cwd).toBe('/ws');
	});
});

describe('nodeRunner', () => {
	it('runs a real process and reports its output', async () => {
		const result = await nodeRunner().run('node', ['-e', 'process.stdout.write("hi")']);
		expect(result).toEqual({ code: 0, stdout: 'hi', stderr: '' });
	});

	it('reports a non-zero exit as data rather than throwing', async () => {
		const result = await nodeRunner().run('node', ['-e', 'process.exit(3)']);
		expect(result.code).toBe(3);
	});

	it('reports a missing binary as 127', async () => {
		const result = await nodeRunner().run('drangler-not-a-real-binary', []);
		expect(result.code).toBe(127);
	});
});

describe('nodeFiles', () => {
	it('reads this repository back off disk', () => {
		const fs = nodeFiles();
		expect(fs.exists(`${process.cwd()}/package.json`)).toBe(true);
		expect(fs.size(`${process.cwd()}/package.json`)).toBeGreaterThan(0);
		expect(readJson<{ name: string }>(fs, `${process.cwd()}/package.json`)?.name).toBe(
			'@drupflare/drangler'
		);
		expect(fs.readDir(process.cwd()).some((e) => e.name === 'src' && e.directory)).toBe(true);
	});

	it('creates the parent directory on write', () => {
		const fs = nodeFiles();
		const dir = mkdtempSync(join(tmpdir(), 'drangler-'));
		try {
			fs.writeText(`${dir}/nested/deep/out.sql`, 'SELECT 1;');
			expect(fs.readText(`${dir}/nested/deep/out.sql`)).toBe('SELECT 1;');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
