import { describe, expect, it } from 'vitest';
import { defaultContext } from '../src/context';
import { DranglerError, EXIT, FindingError, UsageError } from '../src/errors';
import { bytes, emit, kv, table } from '../src/format';
import { bufferIo, consoleIo } from '../src/io';

describe('kv', () => {
	it('aligns the keys', () => {
		expect(
			kv([
				['a', '1'],
				['long', '2']
			])
		).toEqual(['a     1', 'long  2']);
	});

	it('renders nothing for an empty list', () => {
		expect(kv([])).toEqual([]);
	});
});

describe('table', () => {
	it('rules the header and pads every cell', () => {
		expect(table(['name', 'n'], [['worker', '12']])).toEqual([
			'name    n',
			'------  --',
			'worker  12'
		]);
	});

	it('tolerates a row shorter than the header', () => {
		expect(table(['a', 'b'], [['x']])).toEqual(['a  b', '-  -', 'x']);
	});
});

describe('emit', () => {
	it('prints the same object it derives the text from', () => {
		const io = bufferIo();
		emit(io, true, { a: 1 }, () => ['unused']);
		expect(io.json()).toEqual({ a: 1 });
	});

	it('prints the text when json is off', () => {
		const io = bufferIo();
		emit(io, false, { a: 1 }, () => ['one', 'two']);
		expect(io.text()).toBe('one\ntwo');
	});
});

describe('bytes', () => {
	it('scales by decimal units', () => {
		expect(bytes(999)).toBe('999 B');
		expect(bytes(1000)).toBe('1.0 kB');
		expect(bytes(2_199_995)).toBe('2.2 MB');
	});

	it('reports an absent or infinite value as unknown', () => {
		expect(bytes(null)).toBe('unknown');
		expect(bytes(Number.POSITIVE_INFINITY)).toBe('unknown');
	});
});

describe('io', () => {
	it('buffers both streams separately', () => {
		const io = bufferIo();
		io.out('a');
		io.err('b');
		expect(io.stdout).toEqual(['a']);
		expect(io.stderr).toEqual(['b']);
	});

	it('writes a trailing newline to the real streams', () => {
		const written: string[] = [];
		const outWrite = process.stdout.write;
		const errWrite = process.stderr.write;
		process.stdout.write = ((s: string) => void written.push(`out:${s}`)) as never;
		process.stderr.write = ((s: string) => void written.push(`err:${s}`)) as never;
		try {
			const io = consoleIo();
			io.out('a');
			io.err('b');
		} finally {
			process.stdout.write = outWrite;
			process.stderr.write = errWrite;
		}
		expect(written).toEqual(['out:a\n', 'err:b\n']);
	});
});

describe('defaultContext', () => {
	it('wires the real seams and lets any of them be replaced', () => {
		const ctx = defaultContext();
		expect(ctx.cwd).toBe(process.cwd());
		expect(ctx.env).toBe(process.env);
		expect(ctx.now()).toBeInstanceOf(Date);
		expect(typeof ctx.fetch).toBe('function');
		expect(defaultContext({ cwd: '/elsewhere' }).cwd).toBe('/elsewhere');
	});
});

describe('errors', () => {
	it('carries a code and an exit code', () => {
		const error = new DranglerError('x', 'boom');
		expect(error.code).toBe('x');
		expect(error.exitCode).toBe(EXIT.FAILED);
		expect(error.name).toBe('DranglerError');
	});

	it('separates a usage failure from a finding', () => {
		expect(new UsageError('bad').exitCode).toBe(EXIT.USAGE);
		expect(new FindingError('f', 'found').exitCode).toBe(EXIT.FINDING);
	});
});
