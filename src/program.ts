import { Command, Option } from 'commander';
import { runCpu, runWhoami, runWorkers } from './commands/cf';
import { runConfigCheck } from './commands/config';
import { runDoctor } from './commands/doctor';
import { runHealth } from './commands/health';
import {
	runConvertCommand,
	runExportCommand,
	runInstallCommand,
	runPlanCommand,
	runRestoreCommand,
	runSurveyCommand
} from './commands/migrate';
import { runSecretsScan } from './commands/secrets';
import { runStatus } from './commands/status';
import {
	runBuildCommand,
	runDeployCommand,
	runDevCommand,
	runValidateCommand
} from './commands/workspace';
import type { Context } from './context';

export const VERSION = '0.1.0';

const DESCRIPTION =
	'Start, maintain and migrate a drupflare site. Read-only apart from four commands that say ' +
	'what they write: build, dev, deploy and migrate install.';

/** every command that works on a local checkout takes the same three, so they are declared once */
function withWorkspace(command: Command): Command {
	return command
		.option('--workspace <dir>', 'the drupflare/worker checkout to work in')
		.option('--source <path-or-url>', 'where to clone the worker from; a local path is fine')
		.option('--ref <ref>', 'branch or tag to clone');
}

/**
 * Builds the whole command tree against one context.
 *
 * Exported rather than assembled in `cli.ts` so a spec drives the real parser -- flag names, defaults
 * and help text included -- instead of calling the handlers directly and leaving the wiring untested.
 */
export function buildProgram(ctx: Context): Command {
	const program = new Command();
	program
		.name('drangler')
		.description(DESCRIPTION)
		.version(VERSION)
		.showHelpAfterError()
		.exitOverride()
		.configureOutput({
			writeOut: (str) => ctx.io.out(str.replace(/\n$/, '')),
			writeErr: (str) => ctx.io.err(str.replace(/\n$/, ''))
		});

	program
		.command('status')
		.argument('<target>', 'the deployed site origin, with or without a scheme')
		.description('Report what is deployed: plan, generation, header contract, diagnostics')
		.option('--path <path>', 'the Drupal path to read the identity from', '/')
		.option('--site <name>', 'worker site identity, which selects the Durable Object', 'site')
		.option('--config <file>', 'a wrangler config to read the deploy name from')
		.option('--timeout <ms>', 'per-request timeout', '15000')
		.option('--json', 'emit the report as JSON')
		.action(
			async (target: string, opts) =>
				void (await runStatus(ctx, target, {
					path: opts.path,
					site: opts.site,
					config: opts.config,
					timeoutMs: Number(opts.timeout),
					json: opts.json === true
				}))
		);

	program
		.command('doctor')
		.description('Preflight the toolchain and the Cloudflare credential')
		.option('--json', 'emit the report as JSON')
		.action(async (opts) => void (await runDoctor(ctx, opts)));

	withWorkspace(program.command('build'))
		.description('Clone drupflare/worker and build it into a deployable tree')
		.option(
			'--from <tarball>',
			'hydrate from a local release payload instead of downloading one'
		)
		.option('--refresh', 'fetch and fast-forward an existing checkout; refuses on a dirty tree')
		.option('--force', 'redo the install and hydrate steps even when their output is present')
		.option('--dry-run', 'print the step plan and run nothing')
		.option('--json', 'emit the report as JSON')
		.action(async (opts) => void (await runBuildCommand(ctx, opts)));

	program
		.command('validate')
		.description('Everything that has to hold before dev or deploy will work')
		.option('--workspace <dir>', 'the drupflare/worker checkout to check')
		.option(
			'--config <file>',
			'the wrangler config to score, workspace-relative',
			'wrangler.jsonc'
		)
		.option(
			'--only <checks>',
			'a comma-separated subset: workspace,artifacts,config,scrub,bundle'
		)
		.option('--json', 'emit the report as JSON')
		.action(async (opts) => void (await runValidateCommand(ctx, opts)));

	withWorkspace(program.command('dev'))
		.argument('[wrangler-args...]', 'passed through to wrangler, after a `--`')
		.description('Build if needed, validate, then run a local Drupal under `wrangler dev`')
		.option(
			'--config <file>',
			'the wrangler config to run, workspace-relative',
			'wrangler.jsonc'
		)
		.option(
			'--from <tarball>',
			'hydrate from a local release payload instead of downloading one'
		)
		.option('--no-build', 'fail rather than building a workspace that is not ready')
		.option('--skip-validate', 'run wrangler without the gate')
		.action(
			async (extra: string[], opts) => void (await runDevCommand(ctx, extra ?? [], opts))
		);

	withWorkspace(program.command('deploy'))
		.argument('[wrangler-args...]', 'passed through to wrangler, after a `--`')
		.description('Build if needed, validate, then deploy to your own Cloudflare account')
		.option(
			'--config <file>',
			'the wrangler config to deploy, workspace-relative',
			'wrangler.jsonc'
		)
		.option(
			'--from <tarball>',
			'hydrate from a local release payload instead of downloading one'
		)
		.option('--no-build', 'fail rather than building a workspace that is not ready')
		.option('--skip-validate', 'deploy without the gate')
		.action(
			async (extra: string[], opts) => void (await runDeployCommand(ctx, extra ?? [], opts))
		);

	program
		.command('health')
		.argument('<target>', 'origin to probe, with or without a scheme')
		.description('Probe a deployed worker or a VPS Drupal and report what answered')
		.option('--path <path>', 'the Drupal path to request', '/')
		.option('--site <name>', 'worker site identity, which selects the Durable Object', 'site')
		.addOption(
			new Option('--kind <kind>', 'what to probe')
				.choices(['auto', 'worker', 'vps'])
				.default('auto')
		)
		.option('--skip-edge', 'bypass the edge cache so the probe reaches the object')
		.option('--diagnostics', 'also try /stats, which is PW_DIAGNOSTICS-gated')
		.option('--timeout <ms>', 'per-request timeout', '15000')
		.option('--json', 'emit the report as JSON')
		.action(
			async (target: string, opts) =>
				void (await runHealth(ctx, target, {
					path: opts.path,
					site: opts.site,
					kind: opts.kind,
					skipEdge: opts.skipEdge === true,
					diagnostics: opts.diagnostics === true,
					timeoutMs: Number(opts.timeout),
					json: opts.json === true
				}))
		);

	const config = program.command('config').description('Inspect a wrangler configuration');
	config
		.command('check')
		.argument('<file>', 'path to wrangler.jsonc')
		.description(
			'Score a wrangler config against the deployments this project has shipped wrong'
		)
		.option('--account <id>', 'account whose plan the `PLAN` var is compared against')
		.addOption(
			new Option('--plan <plan>', 'state the account plan instead of looking it up').choices([
				'free',
				'paid',
				'unknown'
			])
		)
		.option('--json', 'emit the report as JSON')
		.action(async (file: string, opts) => void (await runConfigCheck(ctx, file, opts)));

	const cf = program.command('cf').description('Read-only Cloudflare account operations');
	cf.command('whoami')
		.description('Report which Cloudflare credential drangler would use')
		.option('--json', 'emit the report as JSON')
		.action(async (opts) => void (await runWhoami(ctx, opts)));
	cf.command('workers')
		.description('List the account workers, and compare against a saved baseline')
		.option('--account <id>', 'account id; defaults to CLOUDFLARE_ACCOUNT_ID')
		.option('--save <file>', 'write the current list as a baseline')
		.option('--compare <file>', 'exit 3 when the list differs from this baseline')
		.option('--json', 'emit the report as JSON')
		.action(async (opts) => void (await runWorkers(ctx, opts)));
	cf.command('cpu')
		.argument('<capture>', 'a saved `wrangler tail --format json` capture')
		.description('Summarise cpuTime per execution model, and refuse an untrustworthy capture')
		.option('--json', 'emit the report as JSON')
		.action(async (capture: string, opts) => void (await runCpu(ctx, capture, opts)));

	const secrets = program
		.command('secrets')
		.description('Credential checks on migration artifacts');
	secrets
		.command('scan')
		.argument('<paths...>', 'files or directories to scan')
		.description('Find credentials in a dump, a settings.php or a tree, without printing them')
		.option('--json', 'emit the report as JSON')
		.action(async (paths: string[], opts) => void (await runSecretsScan(ctx, paths, opts)));

	const migrate = program
		.command('migrate')
		.description('Move a site between a VPS and Cloudflare Workers, in either direction');

	migrate
		.command('survey')
		.description('Read a VPS Drupal over SSH: versions, database, modules, files')
		.requiredOption('--host <target>', 'ssh destination, as [user@]host[:port]')
		.requiredOption('--root <path>', 'absolute Drupal root on that host')
		.option('--identity <file>', 'ssh private key, passed to ssh as -i')
		.option('--dry-run', 'print the command plan and connect to nothing')
		.option('--replay <file>', 'drive the survey from a recorded transcript')
		.option('--out <file>', 'write the survey as JSON')
		.option('--json', 'emit the survey as JSON')
		.action(async (opts) => void (await runSurveyCommand(ctx, opts)));

	migrate
		.command('plan')
		.description('Score a survey against the platform limits and order the work')
		.option('--survey <file>', 'a survey written by `migrate survey --out`')
		.option('--target-php <version>', 'the PHP version the destination runs, if you know it')
		.option('--site <origin>', 'read the destination PHP version from its /php route, if open')
		.addOption(
			new Option('--to <where>', 'direction of travel')
				.choices(['workers', 'vps'])
				.default('workers')
		)
		.option('--json', 'emit the plan as JSON')
		.action(async (opts) => void (await runPlanCommand(ctx, opts)));

	migrate
		.command('export')
		.description('Pull a deployed site database out through /export')
		.requiredOption('--url <origin>', 'the deployed worker origin')
		.option('--site <name>', 'worker site identity', 'site')
		.option(
			'--token <token>',
			'site owner token, as returned once by /firstrun; also read from DRUPFLARE_OWNER_TOKEN'
		)
		.option('--all', 'include the regenerable bins, which are structure-only by default')
		.option('--out <file>', 'write the dump')
		.option('--json', 'emit the report as JSON')
		.action(async (opts) => void (await runExportCommand(ctx, opts)));

	migrate
		.command('convert')
		.description('Convert a SQL dump between MySQL and SQLite')
		.requiredOption('--in <file>', 'the dump to read')
		.addOption(
			new Option('--from <dialect>', 'source dialect')
				.choices(['mysql', 'sqlite'])
				.makeOptionMandatory()
		)
		.addOption(
			new Option('--to <dialect>', 'target dialect')
				.choices(['mysql', 'sqlite'])
				.makeOptionMandatory()
		)
		.option('--out <file>', 'write the converted dump')
		.option('--skip-unsupported', 'record an unconvertible statement and continue')
		.option('--no-split-rows', 'keep multi-row VALUES lists instead of one INSERT per row')
		.option(
			'--max-statement-chars <n>',
			'refuse a row wider than this; 0 turns the ceiling off (default: 100000 into SQLite)'
		)
		.option('--json', 'emit the report as JSON')
		.action(
			async (opts) =>
				void (await runConvertCommand(ctx, {
					...opts,
					...(opts.maxStatementChars === undefined
						? {}
						: { maxStatementChars: Number(opts.maxStatementChars) })
				}))
		);

	migrate
		.command('install')
		.description(
			'Land a migrated database or asset in a workspace, backing up what it replaces'
		)
		.option('--workspace <dir>', 'the drupflare/worker checkout to write into')
		.option('--db <file>', 'a SQLite database file to install as assets/drupal/site.sqlite')
		.option(
			'--asset <from=to>',
			'any other file, with a workspace-relative destination; repeatable',
			(value: string, all: string[] = []) => [...all, value]
		)
		.option('--repack', 'run `bun run assets:sql` afterwards, which is what makes --db ship')
		.option('--dry-run', 'print what would be written and what would be backed up first')
		.option('--json', 'emit the report as JSON')
		.action(async (opts) => void (await runInstallCommand(ctx, opts)));

	migrate
		.command('restore')
		.description('Put a backup set taken by `migrate install` back where it came from')
		.requiredOption('--backup <dir>', 'a directory holding backup.json')
		.option('--json', 'emit the report as JSON')
		.action(async (opts) => void (await runRestoreCommand(ctx, opts)));

	return program;
}
