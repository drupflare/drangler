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

/** Base for every error drangler raises on purpose; anything else is a bug and prints a stack. */
export class DranglerError extends Error {
	readonly code: string;
	readonly exitCode: number;

	constructor(code: string, message: string, exitCode: number = EXIT.FAILED) {
		super(message);
		this.name = new.target.name;
		this.code = code;
		this.exitCode = exitCode;
	}
}

/** Bad input from the caller: a malformed flag value, a missing required pair, an unknown mode. */
export class UsageError extends DranglerError {
	constructor(message: string) {
		super('usage', message, EXIT.USAGE);
	}
}

/** The check ran to completion and found something the caller asked to be told about. */
export class FindingError extends DranglerError {
	constructor(code: string, message: string) {
		super(code, message, EXIT.FINDING);
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
	constructor(message: string) {
		super('probe', message);
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
