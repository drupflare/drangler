import { UsageError } from '../errors';
import type { FileHost } from '../host/files';
import type { SiteSurvey } from './survey';

/**
 * One file that says how far a migration got, so a flake resumes rather than restarts.
 *
 * **A resume must prove it is the same migration.** Two migrations spliced together produce a
 * database that looks whole and is not, which is the failure the worker's own `/export` refuses with
 * a 409 for a spliced dump. The fingerprint is what proves it, and there is no `--force`.
 */

export const CHECKPOINT_VERSION = 1;

/** where the checkpoint goes when nothing names one */
export const DEFAULT_CHECKPOINT = '.drangler/migration.json';

export type PhaseState = 'pending' | 'partial' | 'done' | 'failed';

export interface CheckpointPhase {
	state: PhaseState;
	/** the file this phase wrote, when it wrote one */
	artifact?: string | null;
	/** over the bytes on disk when the phase ended, so a resume tells its file from an edited one */
	sha256?: string | null;
	/** an opaque `DumpCursor`, carried back to `/export?cursor=` verbatim */
	cursor?: string | null;
	/** the backup set `install` took, which a second run must not take again */
	backupDir?: string | null;
	error?: string | null;
}

export interface Checkpoint {
	version: number;
	fingerprint: string;
	direction: 'to-worker' | 'to-vps';
	startedAt: string;
	phases: Record<string, CheckpointPhase>;
}

/**
 * The identity of one migration.
 *
 * sha256 over the survey with sorted keys, with `capturedAt` and `errors` removed: both move
 * between two runs of the same survey against the same host, and leaving them in would make every
 * fingerprint disagree with itself.
 */
export async function surveyFingerprint(survey: SiteSurvey): Promise<string> {
	const { capturedAt: _at, errors: _errors, ...rest } = survey;
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonical(rest as unknown))
	);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** JSON with every object's keys sorted, so key order cannot change the fingerprint */
function canonical(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0
	);
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export function emptyCheckpoint(
	fingerprint: string,
	direction: Checkpoint['direction'],
	startedAt: string
): Checkpoint {
	return {
		version: CHECKPOINT_VERSION,
		fingerprint,
		direction,
		startedAt,
		phases: {
			survey: { state: 'pending' },
			export: { state: 'pending' },
			convert: { state: 'pending' },
			install: { state: 'pending' }
		}
	};
}

/**
 * Reads a checkpoint, refusing one that is not JSON rather than starting over silently.
 *
 * A checkpoint that cannot be parsed is a caller error rather than an absent file: treating it as
 * absent would restart a migration the user believed was resuming, and the export half of that is
 * the expensive one.
 */
export function readCheckpoint(files: FileHost, path: string): Checkpoint | null {
	if (!files.exists(path)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(files.readText(path));
	} catch (e) {
		throw new UsageError(
			`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
			`rm ${path}`
		);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new UsageError(`${path} must hold a JSON object`, `rm ${path}`);
	}
	const checkpoint = parsed as Checkpoint;
	if (checkpoint.version !== CHECKPOINT_VERSION) {
		throw new UsageError(
			`${path} is version ${checkpoint.version} and this drangler writes ${CHECKPOINT_VERSION}`,
			`rm ${path}`
		);
	}
	return checkpoint;
}

export function writeCheckpoint(files: FileHost, path: string, checkpoint: Checkpoint): void {
	files.writeText(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

/**
 * Refuses a resume against a different migration, naming the field that moved.
 *
 * No `--force`. A spliced migration produces a database that looks whole and is not, and there is no
 * way to tell afterwards which half a given row came from.
 */
export function assertSameMigration(checkpoint: Checkpoint, fingerprint: string): void {
	if (checkpoint.fingerprint === fingerprint) return;
	throw new UsageError(
		`this checkpoint belongs to a different migration: it records ${checkpoint.fingerprint.slice(0, 12)} and this survey is ${fingerprint.slice(0, 12)}. ` +
			'Two migrations spliced together produce a database that looks whole and is not, so there is no flag that overrides this',
		'drop --resume, or start from a fresh --checkpoint'
	);
}

/** sha256 of what is on disk, so a resume can tell the file it wrote from one somebody edited */
export async function digestOf(files: FileHost, path: string): Promise<string | null> {
	if (!files.exists(path)) return null;
	const bytes = files.readBytes(path);
	const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** records one phase's outcome, leaving the rest of the file alone */
export function notePhase(
	checkpoint: Checkpoint,
	phase: string,
	fields: CheckpointPhase
): Checkpoint {
	return {
		...checkpoint,
		phases: { ...checkpoint.phases, [phase]: { ...checkpoint.phases[phase], ...fields } }
	};
}
