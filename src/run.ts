import { CommanderError } from 'commander';
import type { Context } from './context';
import { DranglerError, EXIT } from './errors';
import { buildProgram } from './program';

/**
 * Parses and runs one invocation, returning the exit code instead of taking the process down.
 *
 * `cli.ts` is then three lines and every path through the CLI -- including the failures and the help
 * output -- is reachable from a spec.
 */
export async function run(ctx: Context, argv: readonly string[]): Promise<number> {
	try {
		await buildProgram(ctx).parseAsync([...argv], { from: 'user' });
		return EXIT.OK;
	} catch (e) {
		if (e instanceof CommanderError) {
			// `--help` and `--version` unwind through the same path as a parse failure
			return e.code === 'commander.helpDisplayed' || e.code === 'commander.version'
				? EXIT.OK
				: EXIT.USAGE;
		}
		if (e instanceof DranglerError) {
			ctx.io.err(`drangler: ${e.message}`);
			return e.exitCode;
		}
		ctx.io.err(`drangler: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
		return EXIT.FAILED;
	}
}
