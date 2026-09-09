import { CommanderError } from 'commander';
import { orientation } from './commands/init';
import { resolveConfig } from './config/file';
import type { Context } from './context';
import { DranglerError, EXIT } from './errors';
import { buildProgram } from './program';

/** whether this invocation asked for one JSON object, read before anything can throw */
function wantsJson(argv: readonly string[]): boolean {
	return argv.includes('--json');
}

/** whether the stack was asked for; the only way it reaches a terminal */
function wantsStack(argv: readonly string[]): boolean {
	return argv.includes('--verbose') || argv.includes('-v');
}

/**
 * Parses and runs one invocation, returning the exit code instead of taking the process down.
 *
 * `cli.ts` is then three lines and every path through the CLI -- including the failures and the help
 * output -- is reachable from a spec.
 *
 * **No arguments prints an orientation rather than commander's help.** The help lists every command
 * to somebody who has not decided anything yet; the orientation says what is configured and names
 * the three commands worth typing next. `--help` still reaches the full listing.
 *
 * **A stack trace is never printed to a user.** An exception that is not a `DranglerError` is a bug
 * in drangler, and the useful half of it is the message; the stack is noise to everybody except the
 * person fixing it, and `--verbose` is how that person asks for it.
 *
 * **Under `--json`, stdout parses on the failure path too.** A CI step should not have to branch on
 * the exit code before it can parse, so the error object IS the report there and "stdout carries the
 * report and nothing else" holds unchanged.
 */
export async function run(ctx: Context, argv: readonly string[]): Promise<number> {
	try {
		if (argv.length === 0) {
			for (const line of orientation(resolveConfig(ctx))) ctx.io.out(line);
			return EXIT.OK;
		}
		await buildProgram(ctx).parseAsync([...argv], { from: 'user' });
		return EXIT.OK;
	} catch (e) {
		if (e instanceof CommanderError) {
			// `--help` and `--version` unwind through the same path as a parse failure
			return e.code === 'commander.helpDisplayed' || e.code === 'commander.version'
				? EXIT.OK
				: EXIT.USAGE;
		}
		const failure =
			e instanceof DranglerError
				? e
				: new DranglerError('internal', e instanceof Error ? e.message : String(e), {
						next: null
					});
		if (wantsJson(argv)) {
			ctx.io.out(JSON.stringify(failure.toJSON(), null, 2));
		}
		ctx.io.err(`drangler: ${failure.message}`);
		if (failure.next !== null) ctx.io.err(`next: ${failure.next}`);
		if (!(e instanceof DranglerError)) {
			ctx.io.err(
				wantsStack(argv)
					? e instanceof Error
						? (e.stack ?? e.message)
						: String(e)
					: 're-run with --verbose for the stack'
			);
		}
		return failure.exitCode;
	}
}
