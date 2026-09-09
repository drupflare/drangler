import type { Context } from '../context';
import { UsageError } from '../errors';
import type { CommandRunner } from '../host/exec';
import type { Io } from '../io';
import { resolveConfig, type ResolvedConfig } from './file';

/**
 * The flags every command inherits.
 *
 * Declared once on the program and read here, so no two commands can disagree about what `--json`
 * or `--timeout` means. `--site` in particular used to be the Durable Object identity on three
 * commands and a deployment origin on a fourth.
 */
export interface GlobalOptions {
	json: boolean;
	quiet: boolean;
	verbose: boolean;
	yes: boolean;
	dryRun: boolean;
	timeoutMs: number;
	config: ResolvedConfig;
}

/** the raw commander bag, before any of it is trusted */
export interface RawGlobals {
	json?: boolean;
	quiet?: boolean;
	verbose?: boolean;
	yes?: boolean;
	dryRun?: boolean;
	timeout?: string | number;
	profile?: string;
	configFile?: string;
	site?: string;
	siteName?: string;
	workspace?: string;
	account?: string;
	token?: string;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Validates the global flags and resolves the config behind them.
 *
 * `--quiet` and `--verbose` together is a usage error rather than a precedence rule: the two ask for
 * opposite things and guessing which one the caller meant is how a script ends up silently missing
 * the output it was written around.
 */
export function resolveGlobals(ctx: Context, raw: RawGlobals = {}): GlobalOptions {
	if (raw.quiet === true && raw.verbose === true) {
		throw new UsageError('--quiet and --verbose ask for opposite things; pass one of them');
	}
	const timeoutMs = raw.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(raw.timeout);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new UsageError('--timeout must be a positive number of milliseconds');
	}
	return {
		json: raw.json === true,
		quiet: raw.quiet === true,
		verbose: raw.verbose === true,
		yes: raw.yes === true,
		dryRun: raw.dryRun === true,
		timeoutMs,
		config: resolveConfig(ctx, {
			...(raw.profile === undefined ? {} : { profile: raw.profile }),
			...(raw.configFile === undefined ? {} : { configFile: raw.configFile }),
			...(raw.site === undefined ? {} : { site: raw.site }),
			...(raw.siteName === undefined ? {} : { siteName: raw.siteName }),
			...(raw.workspace === undefined ? {} : { workspace: raw.workspace }),
			...(raw.account === undefined ? {} : { account: raw.account }),
			...(raw.token === undefined ? {} : { token: raw.token })
		})
	};
}

/**
 * The context a command runs against, with `--quiet` and `--verbose` applied.
 *
 * Both act on stderr only, so stdout stays exactly one report either way and `--json` keeps parsing.
 * `run.ts` holds the UNWRAPPED context, so a `--quiet` run still prints the error that ended it.
 */
export function withVerbosity(ctx: Context, globals: GlobalOptions): Context {
	if (globals.quiet) return { ...ctx, io: quietErrors(ctx.io) };
	if (globals.verbose) {
		return { ...ctx, runner: tracedRunner(ctx.runner, ctx.io), fetch: tracedFetch(ctx) };
	}
	return ctx;
}

function quietErrors(io: Io): Io {
	return { out: io.out, err: () => {} };
}

/** every subprocess argv, so a failing step can be re-run by hand from the transcript */
function tracedRunner(runner: CommandRunner, io: Io): CommandRunner {
	return {
		run: async (file, args, opts) => {
			io.err(`$ ${[file, ...args].join(' ')}`);
			return await runner.run(file, args, opts);
		},
		spawn: async (file, args, opts) => {
			io.err(`$ ${[file, ...args].join(' ')}`);
			return await runner.spawn(file, args, opts);
		}
	};
}

/** every request line, which is the other half of "what did it actually do" */
function tracedFetch(ctx: Context): Context['fetch'] {
	const inner = ctx.fetch;
	return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		ctx.io.err(`> ${String(init?.method ?? 'GET')} ${String(input)}`);
		return await inner(input, init);
	}) as Context['fetch'];
}
