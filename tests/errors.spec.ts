import { describe, expect, it } from 'vitest';
import { CODES, DranglerError, EXIT, FindingError, ProbeError, UsageError } from '../src/errors';

/**
 * The error model: a code, an exit, whether a retry could work, and what to run next.
 *
 * `retryable` exists so a wrapper does not have to pattern-match a message, and `next` is a command
 * rather than advice. Nothing in drangler loops on the flag itself.
 */
describe('the code table', () => {
	it('gives every code an exit inside the closed set', () => {
		const allowed: number[] = [EXIT.FAILED, EXIT.USAGE, EXIT.FINDING];
		for (const [code, facts] of Object.entries(CODES)) {
			expect(allowed, `${code} exits ${facts.exit}`).toContain(facts.exit);
		}
	});

	it('gives every code a retryable verdict and a next that is a command or nothing', () => {
		for (const [code, facts] of Object.entries(CODES)) {
			expect(typeof facts.retryable, code).toBe('boolean');
			if (facts.next === null) continue;
			// a command, never advice: it starts with something a shell can run
			expect(facts.next, code).toMatch(/^(drangler|wrangler|git|cd|bun) /);
		}
	});

	it('carries the table onto a raised error without repeating it at the throw', () => {
		const failed = new DranglerError('export-unauthorized', 'nope');
		expect(failed.exitCode).toBe(EXIT.FAILED);
		expect(failed.retryable).toBe(false);
		expect(failed.next).toBe('drangler site claim');

		const stalled = new DranglerError('export-stalled', 'the cursor did not move');
		expect(stalled.exitCode).toBe(EXIT.FINDING);
		expect(stalled.next).toBe('drangler migrate export --resume');
	});

	// a call site knows things the table cannot: which build step failed, which workspace it was in
	it('lets one throw override any of the three', () => {
		const step = new DranglerError('build-step', 'hydrate failed', {
			retryable: true,
			next: 'cd /ws && bun run build:local'
		});
		expect(step.retryable).toBe(true);
		expect(step.next).toBe('cd /ws && bun run build:local');
	});

	it('falls back to exit 1 and no retry for a code the table does not name', () => {
		const unknown = new DranglerError('something-new', 'x');
		expect(unknown.exitCode).toBe(EXIT.FAILED);
		expect(unknown.retryable).toBe(false);
		expect(unknown.next).toBeNull();
	});

	// the numeric third argument predates the facts object and every existing throw still uses it
	it('still accepts a bare exit code', () => {
		expect(new DranglerError('x', 'y', EXIT.FINDING).exitCode).toBe(EXIT.FINDING);
	});
});

describe('the subclasses', () => {
	it('fixes the exit code each one owns', () => {
		expect(new UsageError('bad flag').exitCode).toBe(EXIT.USAGE);
		expect(new FindingError('site-quarantined', 'x').exitCode).toBe(EXIT.FINDING);
		expect(new ProbeError('unreachable').exitCode).toBe(EXIT.FAILED);
	});

	it('treats a probe as retryable and a usage error as not', () => {
		expect(new ProbeError('unreachable').retryable).toBe(true);
		expect(new UsageError('bad flag').retryable).toBe(false);
	});

	it('takes a next step where the call site knows one', () => {
		expect(new UsageError('no token', 'drangler site claim https://x.example').next).toBe(
			'drangler site claim https://x.example'
		);
	});
});

describe('the JSON shape', () => {
	it('is the object --json prints on the failure path', () => {
		expect(new DranglerError('probe', 'x.example did not answer').toJSON()).toEqual({
			ok: false,
			error: {
				code: 'probe',
				message: 'x.example did not answer',
				retryable: true,
				next: null
			}
		});
	});
});
