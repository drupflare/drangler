import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors';
import { memoryFiles } from '../src/host/files';
import {
	assertSameMigration,
	CHECKPOINT_VERSION,
	digestOf,
	emptyCheckpoint,
	notePhase,
	readCheckpoint,
	surveyFingerprint,
	writeCheckpoint
} from '../src/migrate/checkpoint';
import { emptySurvey, type SiteSurvey } from '../src/migrate/survey';

const PATH = '/work/.drangler/migration.json';

function survey(over: Partial<SiteSurvey> = {}): SiteSurvey {
	return {
		...emptySurvey('me@old.example', '/var/www/html'),
		php: { version: '8.2.15', extensions: ['curl'] },
		nodes: 2000,
		...over
	};
}

/**
 * A resume must prove it is the same migration.
 *
 * Two spliced together produce a database that looks whole and is not, and afterwards nothing can
 * say which half a row came from. The worker's own `/export` refuses a spliced cursor with a 409 for
 * exactly this reason.
 */
describe('surveyFingerprint', () => {
	it('is stable across two runs of the same survey', async () => {
		expect(await surveyFingerprint(survey())).toBe(await surveyFingerprint(survey()));
	});

	// both move between two runs against the same host, and would make every fingerprint disagree
	it('does not move when capturedAt or errors move', async () => {
		const base = await surveyFingerprint(survey({ capturedAt: '2026-01-01T00:00:00Z' }));
		expect(await surveyFingerprint(survey({ capturedAt: '2026-09-08T11:04:22Z' }))).toBe(base);
		expect(
			await surveyFingerprint(survey({ errors: [{ id: 'nodes', detail: 'exit 1' }] }))
		).toBe(base);
	});

	it('moves when anything the migration depends on moves', async () => {
		const base = await surveyFingerprint(survey());
		expect(await surveyFingerprint(survey({ nodes: 2001 }))).not.toBe(base);
		expect(await surveyFingerprint(survey({ root: '/srv/drupal' }))).not.toBe(base);
	});

	it('ignores the order keys happen to be in', async () => {
		const one = survey();
		const flipped = JSON.parse(
			JSON.stringify(one, Object.keys(one).sort().reverse())
		) as SiteSurvey;
		expect(await surveyFingerprint({ ...flipped, ...one })).toBe(await surveyFingerprint(one));
	});
});

describe('the file', () => {
	it('round-trips through the filesystem seam', () => {
		const files = memoryFiles({});
		const checkpoint = emptyCheckpoint('abc', 'to-worker', '2026-09-08T11:04:22Z');
		writeCheckpoint(files, PATH, checkpoint);
		expect(readCheckpoint(files, PATH)).toEqual(checkpoint);
	});

	it('is absent rather than an error when nothing has written one', () => {
		expect(readCheckpoint(memoryFiles({}), PATH)).toBeNull();
	});

	/** treating a broken file as absent restarts a migration the user believed was resuming */
	it('refuses a file that is not JSON, and names how to clear it', () => {
		const files = memoryFiles({ [PATH]: 'not json' });
		expect(() => readCheckpoint(files, PATH)).toThrow(UsageError);
		try {
			readCheckpoint(files, PATH);
		} catch (e) {
			expect((e as UsageError).next).toBe(`rm ${PATH}`);
		}
	});

	it('refuses a version this drangler does not write', () => {
		const files = memoryFiles({
			[PATH]: JSON.stringify({ version: CHECKPOINT_VERSION + 1, phases: {} })
		});
		expect(() => readCheckpoint(files, PATH)).toThrow(/version/);
	});

	it('records one phase without touching the others', () => {
		const base = emptyCheckpoint('abc', 'to-worker', '2026-09-08T11:04:22Z');
		const noted = notePhase(base, 'export', { state: 'partial', cursor: '{"phase":"rows"}' });
		expect(noted.phases['export']).toMatchObject({ state: 'partial' });
		expect(noted.phases['survey']).toEqual({ state: 'pending' });
		expect(base.phases['export']).toEqual({ state: 'pending' });
	});
});

describe('assertSameMigration', () => {
	it('passes the same fingerprint and refuses a different one', () => {
		const checkpoint = emptyCheckpoint('a'.repeat(64), 'to-worker', 'x');
		expect(() => assertSameMigration(checkpoint, 'a'.repeat(64))).not.toThrow();
		expect(() => assertSameMigration(checkpoint, 'b'.repeat(64))).toThrow(UsageError);
	});

	// there is no --force: a spliced migration cannot be un-spliced afterwards
	it('names both fingerprints and offers no override', () => {
		const checkpoint = emptyCheckpoint('a'.repeat(64), 'to-worker', 'x');
		try {
			assertSameMigration(checkpoint, 'b'.repeat(64));
		} catch (e) {
			const failure = e as UsageError;
			expect(failure.message).toContain('aaaaaaaaaaaa');
			expect(failure.message).toContain('bbbbbbbbbbbb');
			expect(failure.message).toContain('no flag that overrides this');
			expect(failure.next).not.toContain('--force');
		}
	});
});

describe('digestOf', () => {
	it('is null for a file that is not there, and stable for one that is', async () => {
		const files = memoryFiles({ '/a.sql': 'INSERT INTO x VALUES (1);' });
		expect(await digestOf(files, '/absent.sql')).toBeNull();
		const first = await digestOf(files, '/a.sql');
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(await digestOf(files, '/a.sql')).toBe(first);
	});

	it('moves when the bytes move, which is what tells a written file from an edited one', async () => {
		const files = memoryFiles({ '/a.sql': 'one' });
		const before = await digestOf(files, '/a.sql');
		files.writeText('/a.sql', 'two');
		expect(await digestOf(files, '/a.sql')).not.toBe(before);
	});
});
