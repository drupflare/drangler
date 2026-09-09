/**
 * Exit codes drangler uses, as a closed set.
 *
 * `FINDING` exists so a script can tell "the check could not run" from "the check ran and the answer
 * is no". Collapsing those two onto 1 is what makes a CI step that greps output instead of reading
 * the status.
 */
export const EXIT = {
	OK: 0,
	FAILED: 1,
	USAGE: 2,
	FINDING: 3
} as const;

/** what a caller passes when it raises one of these */
export interface ErrorFacts {
	exitCode?: number;
	/** whether re-running the same command could succeed with nothing else changing */
	retryable?: boolean;
	/** the command to run next, or null when there is not one */
	next?: string | null;
}

/**
 * Base for every error drangler raises on purpose; anything else is a bug and becomes `internal`.
 *
 * **`retryable` is about the OPERATION, not about the network.** A 503 from a warming site is
 * retryable because the same request will succeed once the replay finishes; a 401 is not, even
 * though it may also stop happening, because nothing about re-running it changes the answer.
 * Nothing here loops on the flag; it exists so a wrapper does not have to pattern-match a message.
 *
 * **`next` is a COMMAND, never advice.** `drangler site claim https://...` is a next step; "check
 * your credentials" is not, and is left out rather than padded.
 */
export class DranglerError extends Error {
	readonly code: string;
	readonly exitCode: number;
	readonly retryable: boolean;
	readonly next: string | null;

	constructor(code: string, message: string, facts: ErrorFacts | number = {}) {
		super(message);
		const settled = typeof facts === 'number' ? { exitCode: facts } : facts;
		this.name = new.target.name;
		this.code = code;
		this.exitCode = settled.exitCode ?? CODES[code]?.exit ?? EXIT.FAILED;
		this.retryable = settled.retryable ?? CODES[code]?.retryable ?? false;
		this.next = settled.next ?? CODES[code]?.next ?? null;
	}

	/** the object `--json` prints on the failure path, so stdout parses either way */
	toJSON(): { ok: false; error: Record<string, unknown> } {
		return {
			ok: false,
			error: {
				code: this.code,
				message: this.message,
				retryable: this.retryable,
				next: this.next
			}
		};
	}
}

/**
 * Every code this CLI raises, with its exit, whether a retry could work, and what to run next.
 *
 * One table rather than a field on each `throw`, so two call sites cannot disagree about what
 * `export-unauthorized` means. A `throw` may still override any of the three where the answer is
 * specific to the call -- `build-step`'s next step depends on which step failed.
 */
export const CODES: Record<string, { exit: number; retryable: boolean; next: string | null }> = {
	usage: { exit: EXIT.USAGE, retryable: false, next: null },
	internal: { exit: EXIT.FAILED, retryable: false, next: null },
	probe: { exit: EXIT.FAILED, retryable: true, next: null },
	transport: { exit: EXIT.FAILED, retryable: true, next: null },
	convert: {
		exit: EXIT.FAILED,
		retryable: false,
		next: 'drangler migrate convert --skip-unsupported'
	},
	workspace: { exit: EXIT.FAILED, retryable: false, next: 'drangler build' },
	auth: { exit: EXIT.FAILED, retryable: false, next: 'wrangler login' },
	backup: { exit: EXIT.FAILED, retryable: false, next: null },
	restore: { exit: EXIT.FAILED, retryable: false, next: null },
	refresh: { exit: EXIT.FAILED, retryable: true, next: null },
	'refresh-dirty': { exit: EXIT.FAILED, retryable: false, next: null },
	'refresh-diverged': { exit: EXIT.FAILED, retryable: false, next: null },
	'build-step': { exit: EXIT.FAILED, retryable: true, next: null },
	repack: { exit: EXIT.FAILED, retryable: true, next: null },
	wrangler: { exit: EXIT.FAILED, retryable: true, next: null },
	modify: { exit: EXIT.FAILED, retryable: false, next: null },
	claim: { exit: EXIT.FAILED, retryable: false, next: null },
	invalidate: { exit: EXIT.FAILED, retryable: true, next: null },
	reconcile: { exit: EXIT.FAILED, retryable: true, next: null },
	sweep: { exit: EXIT.FAILED, retryable: true, next: null },
	git: { exit: EXIT.FAILED, retryable: false, next: null },
	'export-unauthorized': { exit: EXIT.FAILED, retryable: false, next: 'drangler site claim' },
	'export-missing': { exit: EXIT.FAILED, retryable: false, next: 'drangler update' },
	'export-unreplayable': { exit: EXIT.FAILED, retryable: false, next: null },
	'export-failed': { exit: EXIT.FAILED, retryable: true, next: null },
	'export-stalled': {
		exit: EXIT.FINDING,
		retryable: false,
		next: 'drangler migrate export --resume'
	},
	'export-torn': { exit: EXIT.FAILED, retryable: false, next: null },
	'checkpoint-mismatch': { exit: EXIT.USAGE, retryable: false, next: null },
	'checkpoint-unreadable': { exit: EXIT.USAGE, retryable: false, next: null },
	'source-broken': { exit: EXIT.FINDING, retryable: false, next: null },
	'site-quarantined': { exit: EXIT.FINDING, retryable: false, next: null },
	'site-degraded': { exit: EXIT.FINDING, retryable: true, next: null },
	'updb-halted': { exit: EXIT.FINDING, retryable: false, next: null },
	'updb-stalled': { exit: EXIT.FINDING, retryable: false, next: null },
	'reconcile-failed': { exit: EXIT.FINDING, retryable: false, next: null },
	'reconcile-refused': { exit: EXIT.FINDING, retryable: false, next: null },
	// the meter drains, so the same command succeeds later with nothing else changing
	'sweep-refused': { exit: EXIT.FINDING, retryable: true, next: null },
	'replay-stalled': { exit: EXIT.FINDING, retryable: false, next: null },
	'eligibility-unmeasured': {
		exit: EXIT.FAILED,
		retryable: false,
		next: 'drangler migrate eligibility --assume-worst'
	},
	'repair-refused': { exit: EXIT.USAGE, retryable: false, next: null },
	'rig-unavailable': { exit: EXIT.FAILED, retryable: true, next: null }
};

/** Bad input from the caller: a malformed flag value, a missing required pair, an unknown mode. */
export class UsageError extends DranglerError {
	constructor(message: string, next: string | null = null) {
		super('usage', message, { exitCode: EXIT.USAGE, retryable: false, next });
	}
}

/** The check ran to completion and found something the caller asked to be told about. */
export class FindingError extends DranglerError {
	constructor(code: string, message: string, next: string | null = null) {
		super(code, message, { exitCode: EXIT.FINDING, retryable: false, next });
	}
}

/** A remote command could not be issued or came back in a shape the parser refuses. */
export class TransportError extends DranglerError {
	constructor(message: string) {
		super('transport', message);
	}
}

/** An HTTP probe could not reach its target, or reached something that is not what it claims. */
export class ProbeError extends DranglerError {
	constructor(message: string, next: string | null = null) {
		super('probe', message, { retryable: true, next });
	}
}

/** A SQL dump held a construct the converter refuses to guess at. */
export class ConvertError extends DranglerError {
	readonly statement: string;

	constructor(message: string, statement: string) {
		super('convert', message);
		this.statement = statement;
	}
}

/** The local workspace is not laid out the way `status` needs. */
export class WorkspaceError extends DranglerError {
	constructor(message: string) {
		super('workspace', message);
	}
}

/** Cloudflare credentials are absent, rejected, or point at no account. */
export class AuthError extends DranglerError {
	constructor(message: string) {
		super('auth', message);
	}
}
