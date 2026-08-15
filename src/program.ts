import { Command, Option } from 'commander';
import { runCpu, runWhoami, runWorkers } from './commands/cf';
import { runConfigCheck } from './commands/config';
import { runDoctor } from './commands/doctor';
import { runHealth } from './commands/health';
import {
	runConvertCommand,
	runExportCommand,
	runPlanCommand,
	runSurveyCommand
} from './commands/migrate';
import { runSecretsScan } from './commands/secrets';
import { runStatus } from './commands/status';
import type { Context } from './context';

export const VERSION = '0.1.0';

const DESCRIPTION =
	'Start, maintain and migrate a drupflare site. Read-only by default: nothing here deploys, ' +
	'deletes or writes to a remote host.';

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

	return program;
}
