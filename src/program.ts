import { Command, Option } from 'commander';
import { runCpu, runWhoami, runWorkers } from './commands/cf';
import { runConfigCheck, runConfigLevers, runConfigWhere } from './commands/config';
import { runDoctor } from './commands/doctor';
import { runEligibility } from './commands/eligibility';
import { runHeal } from './commands/heal';
import { runHealth } from './commands/health';
import { runInit } from './commands/init';
import {
	runConvertCommand,
	runCutoverCommand,
	runDeltaCommand,
	runExportCommand,
	runFilesCommand,
	runInstallCommand,
	runPlanCommand,
	runRestoreCommand,
	runSurveyCommand
} from './commands/migrate';
import {
	runModifyActivate,
	runModifyCheck,
	runModifyDiff,
	runModifyDrop,
	runModifyEnable,
	runModifyInit,
	runModifyRelease,
	runModifyRequire,
	runModifyRevisions,
	runModifyRollback,
	runModifyStatus,
	runModifyUpload
} from './commands/modify';
import { runReconcile } from './commands/reconcile';
import { runRecover } from './commands/recover';
import { runSecretsScan } from './commands/secrets';
import { runSetupCloudflare, runSetupIdentity, runSetupMail } from './commands/setup';
import { runSiteClaim, runSiteInvalidate, runSiteUpdb, runSiteUpgrade } from './commands/site';
import { runStatus } from './commands/status';
import { runSweep } from './commands/sweep';
import { runUpdateCommand } from './commands/update';
import {
	runBuildCommand,
	runDeployCommand,
	runDevCommand,
	runValidateCommand
} from './commands/workspace';
import { resolveGlobals, withVerbosity, type GlobalOptions } from './config/globals';
import type { Context } from './context';
import { VERSION } from './version';

export { VERSION };

const DESCRIPTION =
	'Start, maintain and migrate a drupflare site. Read-only apart from the commands that say ' +
	'what they write: build, dev, deploy, update and migrate install write to a local workspace ' +
	'or your own Cloudflare account; site, heal --release, modify, reconcile --run and sweep --run ' +
	'write to a live site and each needs the owner token.';

/** every command that works on a local checkout takes the same two, so they are declared once */
function withSource(command: Command): Command {
	return command
		.option('--source <path-or-url>', 'where to clone the worker from; a local path is fine')
		.option('--ref <ref>', 'branch or tag to clone');
}

/**
 * The flags every command inherits.
 *
 * Declared once and read through `optsWithGlobals()`, so no command re-declares one and no two
 * commands can disagree about what `--json`, `--timeout` or `--site` means. `--site` used to be the
 * Durable Object identity on three commands and a deployment origin on a fourth; it is always an
 * origin now, and `--site-name` is the identity.
 */
function withGlobals(program: Command): Command {
	return program
		.option('--json', 'stdout is one JSON object, the same one the text is built from')
		.option('-q, --quiet', 'suppress progress on stderr; the report still prints')
		.option('-v, --verbose', 'every subprocess argv and every request line, on stderr')
		.option('--site <origin>', 'the site to act on, as an origin')
		.option('--site-name <name>', 'the Durable Object identity inside that site')
		.option('--profile <name>', 'which config block to read')
		.option('--config-file <path>', 'a config file, which replaces the search')
		.option('-y, --yes', 'consent for anything that writes to a live site')
		.option('--dry-run', 'print the plan, execute nothing')
		.option('--timeout <ms>', 'per-request timeout', '15000')
		.option('--token <token>', 'site owner token; also read from DRUPFLARE_OWNER_TOKEN')
		.option('--workspace <dir>', 'the drupflare/worker checkout to work in')
		.option('--account <id>', 'the Cloudflare account to act on');
}

/**
 * Builds the whole command tree against one context.
 *
 * Exported rather than assembled in `cli.ts` so a spec drives the real parser -- flag names, defaults
 * and help text included -- instead of calling the handlers directly and leaving the wiring untested.
 */
export function buildProgram(ctx: Context): Command {
	const program = new Command();
	withGlobals(program)
		.name('drangler')
		.description(DESCRIPTION)
		.version(VERSION)
		.showHelpAfterError()
		.exitOverride()
		.configureOutput({
			writeOut: (str) => ctx.io.out(str.replace(/\n$/, '')),
			writeErr: (str) => ctx.io.err(str.replace(/\n$/, ''))
		});

	/** resolves the inherited flags for one invocation and applies `--quiet` / `--verbose` */
	const bind = (command: Command): { ctx: Context; globals: GlobalOptions } => {
		const globals = resolveGlobals(ctx, command.optsWithGlobals());
		return { ctx: withVerbosity(ctx, globals), globals };
	};

	program
		.command('init')
		.description('Connect this machine to a site and write down where the answers went')
		.addOption(
			new Option('--intent <what>', 'what you came here to do').choices([
				'local',
				'deploy',
				'connect',
				'module'
			])
		)
		.addOption(
			new Option('--write <where>', 'where the answers land').choices([
				'project',
				'global',
				'none'
			])
		)
		.action(async (opts, command) => {
			const bound = bind(command);
			await runInit(bound.ctx, {
				...(opts.intent === undefined ? {} : { intent: opts.intent }),
				...(opts.write === undefined ? {} : { write: opts.write }),
				globals: bound.globals
			});
		});

	program
		.command('status')
		.argument('[target]', 'the deployed site origin; defaults to --site or the config')
		.description(
			'Report what is deployed: plan, generation, header contract, claim state, diagnostics'
		)
		.option('--path <path>', 'the Drupal path to read the identity from', '/')
		.option('--config <file>', 'a wrangler config to read the deploy name from')
		.action(async (target: string | undefined, opts, command) => {
			const bound = bind(command);
			await runStatus(bound.ctx, target ?? bound.globals.config.site.value, {
				path: opts.path,
				site: bound.globals.config.siteName.value ?? 'site',
				timeoutMs: bound.globals.timeoutMs,
				json: bound.globals.json,
				...(opts.config === undefined ? {} : { config: opts.config })
			});
		});

	program
		.command('doctor')
		.description('Preflight the toolchain, the credential, and optionally a source or a site')
		.option('--source <ssh-target>', 'also survey a VPS and score what came back')
		.option('--root <path>', 'the Drupal root on that host', '/var/www/html')
		.option('--identity <file>', 'ssh private key, passed to ssh as -i')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler doctor',
				'  drangler doctor --source deploy@old.example --root /var/www/html',
				'  drangler doctor --site https://mysite.example'
			].join('\n')
		)
		.action(async (opts, command) => {
			const bound = bind(command);
			const globals = bound.globals;
			await runDoctor(bound.ctx, {
				json: globals.json,
				config: globals.config,
				timeoutMs: globals.timeoutMs,
				...(opts.source === undefined ? {} : { source: opts.source }),
				...(opts.root === undefined ? {} : { root: opts.root }),
				...(opts.identity === undefined ? {} : { identity: opts.identity }),
				...(globals.config.site.value === null ? {} : { site: globals.config.site.value }),
				...(globals.config.siteName.value === null
					? {}
					: { siteName: globals.config.siteName.value }),
				...(globals.config.token.value === null
					? {}
					: { token: globals.config.token.value }),
				...(globals.config.workspace.value === null
					? {}
					: { workspace: globals.config.workspace.value })
			});
		});

	withSource(program.command('build'))
		.description('Clone drupflare/worker and build it into a deployable tree')
		.option(
			'--from <tarball>',
			'hydrate from a local release payload instead of downloading one'
		)
		.option(
			'--from-source',
			'rebuild the artifacts in the checkout; needs PHP, composer, node 24+, zstd and Docker'
		)
		.option(
			'--payload-only',
			'fail when no release payload exists, rather than building the artifacts from source'
		)
		.option('--refresh', 'fetch and fast-forward an existing checkout; refuses on a dirty tree')
		.option('--force', 'redo the install and hydrate steps even when their output is present')
		.action(async (opts, command) => {
			const bound = bind(command);
			await runBuildCommand(bound.ctx, { ...opts, globals: bound.globals });
		});

	program
		.command('update')
		.argument('[worker]', 'a deployed worker to update; omit to update the local checkout')
		.description('Move a checkout to another drupflare version, and the worker running it')
		.option('--source <path-or-url>', 'where to fetch the worker from; a local path is fine')
		.option('--to <ref>', 'the version to move to: a tag, a branch or a sha')
		.option('--config <file>', 'the wrangler config to deploy, workspace-relative')
		.option('--skip-validate', 'deploy without the gate')
		.action(async (worker: string | undefined, opts, command) => {
			const bound = bind(command);
			await runUpdateCommand(bound.ctx, worker, {
				...opts,
				...(bound.globals.config.account.value === null
					? {}
					: { account: bound.globals.config.account.value }),
				globals: bound.globals
			});
		});

	program
		.command('validate')
		.description('Everything that has to hold before dev or deploy will work')
		.option(
			'--config <file>',
			'the wrangler config to score, workspace-relative',
			'wrangler.jsonc'
		)
		.option(
			'--only <checks>',
			'a comma-separated subset: workspace,artifacts,config,scrub,bundle'
		)
		.action(async (opts, command) => {
			const bound = bind(command);
			await runValidateCommand(bound.ctx, { ...opts, globals: bound.globals });
		});

	withSource(program.command('dev'))
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
		.option(
			'--from-source',
			'rebuild the artifacts in the checkout; needs PHP, composer, node 24+, zstd and Docker'
		)
		.option(
			'--payload-only',
			'fail when no release payload exists, rather than building the artifacts from source'
		)
		.option('--no-build', 'fail rather than building a workspace that is not ready')
		.option('--skip-validate', 'run wrangler without the gate')
		.option(
			'--modify <dir>',
			'mount a local module project into the dev site; repeatable',
			(value: string, all: string[] = []) => [...all, value]
		)
		.option('--no-watch', 'upload each --modify tree once instead of on every change')
		.option('--interval <ms>', 'how long between change polls under --modify')
		.option('--port <n>', 'the port wrangler listens on')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler dev',
				'  drangler dev --modify . --port 8788',
				'  drangler dev -- --local'
			].join('\n')
		)
		.action(async (extra: string[], opts, command) => {
			const bound = bind(command);
			await runDevCommand(bound.ctx, extra ?? [], { ...opts, globals: bound.globals });
		});

	withSource(program.command('deploy'))
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
		.option(
			'--from-source',
			'rebuild the artifacts in the checkout; needs PHP, composer, node 24+, zstd and Docker'
		)
		.option(
			'--payload-only',
			'fail when no release payload exists, rather than building the artifacts from source'
		)
		.option('--no-build', 'fail rather than building a workspace that is not ready')
		.option('--skip-validate', 'deploy without the gate')
		.action(async (extra: string[], opts, command) => {
			const bound = bind(command);
			await runDeployCommand(bound.ctx, extra ?? [], { ...opts, globals: bound.globals });
		});

	program
		.command('health')
		.argument('[target]', 'origin to probe; defaults to --site or the config')
		.description('Probe a deployed worker or a VPS Drupal and report what answered')
		.option('--path <path>', 'the Drupal path to request', '/')
		.addOption(
			new Option('--kind <kind>', 'what to probe')
				.choices(['auto', 'worker', 'vps'])
				.default('auto')
		)
		.option('--skip-edge', 'bypass the edge cache so the probe reaches the object')
		.option('--diagnostics', 'also try /stats, which is PW_DIAGNOSTICS-gated')
		.action(async (target: string | undefined, opts, command) => {
			const bound = bind(command);
			await runHealth(bound.ctx, target ?? bound.globals.config.site.value, {
				path: opts.path,
				site: bound.globals.config.siteName.value ?? 'site',
				kind: opts.kind,
				skipEdge: opts.skipEdge === true,
				diagnostics: opts.diagnostics === true,
				timeoutMs: bound.globals.timeoutMs,
				json: bound.globals.json
			});
		});

	const site = program
		.command('site')
		.description('Claim, upgrade and maintain a deployed drupflare site');

	site.command('claim')
		.argument('[target]', 'the site origin; defaults to --site or the config')
		.description('Claim a site: mint the administrator password and the owner token')
		.option('--title <name>', 'the Drupal site name to set')
		.option('--admin-pass <pass>', 'set this password instead of one the site mints')
		.option('--admin-mail <address>', "the administrator's email address")
		.option('--force', 'reconfigure a site that is already claimed; needs the owner token')
		.option('--save', 'write the owner token to the global config without asking')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler site claim https://mysite.example',
				'  drangler site claim --title "My Site" --save'
			].join('\n')
		)
		.action(async (target: string | undefined, opts, command) => {
			const bound = bind(command);
			await runSiteClaim(bound.ctx, target, { ...opts, globals: bound.globals });
		});

	site.command('updb')
		.argument('[target]', 'the site origin; defaults to --site or the config')
		.description('Read the Drupal update chain, and drive beats of it')
		.option('--step', 'advance exactly one beat before reading the cursor')
		.option('--steps <n>', 'advance at most n beats, stopping on a terminal phase')
		.option('--snapshot <dir>', 'take an /export into this directory first')
		.option('--no-snapshot', 'state that a snapshot was declined')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler site updb',
				'  drangler site updb --step',
				'  drangler site updb --steps 5 --no-snapshot'
			].join('\n')
		)
		.action(async (target: string | undefined, opts, command) => {
			const bound = bind(command);
			await runSiteUpdb(bound.ctx, target, { ...opts, globals: bound.globals });
		});

	site.command('invalidate')
		.argument('[target]', 'the site origin; defaults to --site or the config')
		.description('Purge a site cache, by tag or by bumping the generation')
		.option('--tags <list>', 'comma-separated cache tags (default: rendered)')
		.option('--bump', 'bump the generation, which invalidates every edge-cached URL')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler site invalidate --bump',
				'  drangler site invalidate --tags node:12,rendered'
			].join('\n')
		)
		.action(async (target: string | undefined, opts, command) => {
			const bound = bind(command);
			await runSiteInvalidate(bound.ctx, target, { ...opts, globals: bound.globals });
		});

	site.command('upgrade')
		.argument('[target]', 'the site origin; defaults to --site or the config')
		.description('Deploy, wait for the database replay, then run the update chain')
		.option('--no-deploy', 'wait on a site somebody else deployed')
		.option('--config <file>', 'the wrangler config to deploy, workspace-relative')
		.option('--skip-validate', 'deploy without the gate')
		.option('--wait <ms>', 'how long to wait for both halves (default: 600000)')
		.option('--interval <ms>', 'how long between polls (default: 2000)')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler site upgrade',
				'  drangler site upgrade https://mysite.example --no-deploy'
			].join('\n')
		)
		.action(async (target: string | undefined, opts, command) => {
			const bound = bind(command);
			await runSiteUpgrade(bound.ctx, target, { ...opts, globals: bound.globals });
		});

	// no `--yes` on --run, unlike the other live writers: it drives the same step the site's alarm
	// chain drives unattended, so a consent gate would only stop an operator getting the fix sooner
	program
		.command('reconcile')
		.argument('[target]', 'the site origin; defaults to --site or the config')
		.description(
			'What a site still owes the pack that ships today, and drive the steps it owes'
		)
		.option('--run', 'drive one step now')
		.option('--all', 'drive steps until the site drives nothing or one reports failed')
		.addHelpText(
			'after',
			[
				'',
				'The alarm chain drives one step per firing on its own. Use --run or --all when you',
				'want a fix now rather than at the next firing.',
				'',
				'Examples:',
				'  drangler reconcile',
				'  drangler reconcile --run',
				'  drangler reconcile https://mysite.example --all'
			].join('\n')
		)
		.action(async (target: string | undefined, opts, command) => {
			const bound = bind(command);
			await runReconcile(bound.ctx, target, { ...opts, globals: bound.globals });
		});

	program
		.command('sweep')
		.argument('[target]', 'the site origin; defaults to --site or the config')
		.description('How much of a site has a stored page, and what the sweep governor decided')
		.option('--run', 'force a step now, off the interval the alarm chain waits out')
		.addHelpText(
			'after',
			[
				'',
				'The sweep RUNS unless `SWEEP` is `0`, and it spends at most a declared share of',
				'each daily meter: `SWEEP_ROWS_FRACTION`, clamped 0.01-0.5, and smaller when unasked.',
				'',
				'Examples:',
				'  drangler sweep',
				'  drangler sweep --run',
				'  drangler sweep https://mysite.example --json'
			].join('\n')
		)
		.action(async (target: string | undefined, opts, command) => {
			const bound = bind(command);
			await runSweep(bound.ctx, target, { ...opts, globals: bound.globals });
		});

	// THE SWEEP DEFAULT INVERTED. It runs unless `SWEEP` is `0`, and the help text below said the
	// opposite for as long as it had been wrong.
	program
		.command('recover')
		.argument('[target]', 'the site origin; defaults to --site or the config')
		.description("Read the platform's 30-day recovery window, or schedule a restore from it")
		.option('--at <when>', 'an ISO timestamp or epoch ms to resolve to a bookmark')
		.option('--bookmark <id>', 'schedule a restore to this bookmark')
		.option('--yes', 'confirm a restore; required, because it replaces the database')
		.addHelpText(
			'after',
			[
				'',
				'Cloudflare keeps a 30-day change log for a Durable Object and exposes it as',
				'bookmarks. There is no wrangler command and no dashboard button for it, which is',
				"why this exists. A restore is applied on the object's NEXT START, and the call",
				'that schedules it is the only place the undo bookmark can be obtained -- keep it.',
				'',
				'`drangler migrate restore` is a different thing: it replays a dump from disk.',
				'',
				'Examples:',
				'  drangler recover',
				'  drangler recover --at 2026-09-10T12:00:00Z',
				'  drangler recover --bookmark 00000001-... --yes'
			].join('\n')
		)
		.action(async (target: string | undefined, opts, command) => {
			const bound = bind(command);
			await runRecover(bound.ctx, target, { ...opts, globals: bound.globals });
		});

	const setup = program
		.command('setup')
		.description('The three account-level surfaces: Cloudflare, mail and identity');

	setup
		.command('cloudflare')
		.argument('[target]', 'the site origin; defaults to --site or the config')
		.description('Whether a Cloudflare account grant is connected, and give it back')
		.option('--disconnect', 'revoke the grant at Cloudflare and clear it here')
		.action(async (target: string | undefined, opts, command) => {
			const bound = bind(command);
			await runSetupCloudflare(bound.ctx, target, { ...opts, globals: bound.globals });
		});

	setup
		.command('mail')
		.argument('[target]', 'the site origin; defaults to --site or the config')
		.description('Sending-domain onboarding: what is set up, and take the next step')
		.option('--zone <id>', 'the Cloudflare zone the sending subdomain lives in')
		.option('--name <name>', 'the sending subdomain to create')
		.option('--apply', 'take the next onboarding step rather than only reporting')
		.addHelpText(
			'after',
			[
				'',
				'This needs a connected Cloudflare account; `drangler setup cloudflare` says whether',
				'there is one. Read-only without --apply, so a long DNS wait can be watched.',
				'',
				'Examples:',
				'  drangler setup mail',
				'  drangler setup mail --zone <zone-id> --apply'
			].join('\n')
		)
		.action(async (target: string | undefined, opts, command) => {
			const bound = bind(command);
			await runSetupMail(bound.ctx, target, { ...opts, globals: bound.globals });
		});

	setup
		.command('identity')
		.argument('[target]', 'the site origin; defaults to --site or the config')
		.description('The OpenID Connect provider: read it, set it, or clear it')
		.option('--issuer <url>', 'the provider issuer; saving fetches its discovery document')
		.option('--client-id <id>', 'the client id registered with that provider')
		.option('--clear', 'remove the stored configuration')
		.addHelpText(
			'after',
			[
				'',
				'People sign in at <site>/oidc. That URL is not printed by the provider and was not',
				'printed anywhere else either, which is why a fully configured provider could be',
				'undiscoverable.',
				'',
				'Examples:',
				'  drangler setup identity',
				'  drangler setup identity --issuer https://accounts.example.com --client-id abc',
				'  drangler setup identity --clear'
			].join('\n')
		)
		.action(async (target: string | undefined, opts, command) => {
			const bound = bind(command);
			await runSetupIdentity(bound.ctx, target, { ...opts, globals: bound.globals });
		});

	program
		.command('heal')
		.argument('[target]', 'the site origin; defaults to --site or the config')
		.description('Report a site repair ladder, and clear a quarantine')
		.option('--watch', 're-read until the site is clean or --wait runs out')
		.option('--wait <ms>', 'how long --watch keeps re-reading (default: 300000)')
		.option('--interval <ms>', 'how long between reads (default: 2000)')
		.option('--release', 'clear the quarantine; needs --yes')
		.option('--replay', 'drive the packed database replay forward')
		.option('--armfill', 're-arm a stalled fill; spends the rows the drain writes')
		.option('--invalidate <tags>', 'invalidate cache tags; spends a render each')
		.option('--bump', 'bump the generation, which re-renders the whole site')
		.option('--unpin <remote>', 'release a preview pin without reaching the remote')
		.option(
			'--auto',
			'perform only what may run unattended, stopping at the first that may not'
		)
		.option('--snapshot <dir>', 'take an /export into this directory first')
		.option('--no-snapshot', 'state that a snapshot was declined')
		.option('--ledger <n>', 'how many ledger rows to read')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler heal',
				'  drangler heal --watch --interval 5000',
				'  drangler heal --auto --yes'
			].join('\n')
		)
		.action(async (target: string | undefined, opts, command) => {
			const bound = bind(command);
			await runHeal(bound.ctx, target, { ...opts, globals: bound.globals });
		});

	const modify = program
		.command('modify')
		.description('Develop a module against a deployed site, one revision at a time');

	/** every subcommand reads the same project, so the two that find it are declared once */
	const withProject = (command: Command): Command =>
		command
			.option('--dir <path>', 'the project directory; defaults to the working directory')
			.option('--package <name>', 'which package, when the project holds several');

	withProject(modify.command('init'))
		.argument('[dir]', 'the project directory')
		.description('Link a module project to a site and write down where the answers went')
		.option('--name <package>', 'override the detected package name')
		.option('--global', 'write the link to the global config instead of drangler.json')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler modify init --site https://mysite.example',
				'  drangler modify init ../mantle2 --name mantle2'
			].join('\n')
		)
		.action(async (dir: string | undefined, opts, command) => {
			const bound = bind(command);
			await runModifyInit(bound.ctx, {
				...opts,
				...(dir === undefined ? {} : { dir }),
				globals: bound.globals
			});
		});

	withProject(modify.command('status'))
		.description('What is live on the site, against what is on this disk')
		.addHelpText(
			'after',
			['', 'Examples:', '  drangler modify status', '  drangler modify status --json'].join(
				'\n'
			)
		)
		.action(async (opts, command) => {
			const bound = bind(command);
			await runModifyStatus(bound.ctx, { ...opts, globals: bound.globals });
		});

	withProject(modify.command('diff'))
		.description('What differs between this disk and the site, file by file')
		.option('--name-only', 'paths only, without the counts')
		.option('--against <rev>', 'a stored revision instead of what is mounted')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler modify diff',
				'  drangler modify diff --name-only',
				'  drangler modify diff --against previous'
			].join('\n')
		)
		.action(async (opts, command) => {
			const bound = bind(command);
			await runModifyDiff(bound.ctx, { ...opts, globals: bound.globals });
		});

	withProject(modify.command('check'))
		.description('Everything that can be known before bytes leave this machine')
		.option('--php <path>', 'a local PHP binary, for `php -l`')
		.option('--deps', 'resolve every declared dependency against /installable')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler modify check',
				'  drangler modify check --php php --deps'
			].join('\n')
		)
		.action(async (opts, command) => {
			const bound = bind(command);
			await runModifyCheck(bound.ctx, { ...opts, globals: bound.globals });
		});

	withProject(modify.command('upload'))
		.description('Send what the site is missing and make the result live')
		.option('--message <text>', 'the revision label; defaults to the git subject')
		.option('--php <path>', 'a local PHP binary, for `php -l`')
		.option('--force', 'upload despite a check finding')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler modify upload',
				'  drangler modify upload --message "add the streak service"'
			].join('\n')
		)
		.action(async (opts, command) => {
			const bound = bind(command);
			await runModifyUpload(bound.ctx, { ...opts, globals: bound.globals });
		});

	withProject(modify.command('revisions'))
		.description('The stored revisions of a package, newest first')
		.option('--limit <n>', 'how many to list', '20')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler modify revisions',
				'  drangler modify revisions --limit 5'
			].join('\n')
		)
		.action(async (opts, command) => {
			const bound = bind(command);
			await runModifyRevisions(bound.ctx, { ...opts, globals: bound.globals });
		});

	withProject(modify.command('activate'))
		.argument('<rev>', 'the revision to make live')
		.description('Make a stored revision live, with no bytes on the wire')
		.addHelpText(
			'after',
			['', 'Examples:', '  drangler modify activate 9f2c1ab4... --yes'].join('\n')
		)
		.action(async (rev: string, opts, command) => {
			const bound = bind(command);
			await runModifyActivate(bound.ctx, rev, { ...opts, globals: bound.globals });
		});

	withProject(modify.command('rollback'))
		.description('Activate the revision before the active one')
		.addHelpText('after', ['', 'Examples:', '  drangler modify rollback --yes'].join('\n'))
		.action(async (opts, command) => {
			const bound = bind(command);
			await runModifyRollback(bound.ctx, { ...opts, globals: bound.globals });
		});

	withProject(modify.command('drop'))
		.argument('<rev>', 'the revision to delete')
		.description('Delete a stored revision and the blobs nothing else names')
		.addHelpText(
			'after',
			['', 'Examples:', '  drangler modify drop 3d81ee07... --yes'].join('\n')
		)
		.action(async (rev: string, opts, command) => {
			const bound = bind(command);
			await runModifyDrop(bound.ctx, rev, { ...opts, globals: bound.globals });
		});

	withProject(modify.command('release'))
		.description('Upload from a tagged commit, refusing a dirty tree')
		.requiredOption('--tag <tag>', 'the git tag to release from')
		.option('--message <text>', 'the revision label; defaults to the tag')
		.option('--php <path>', 'a local PHP binary, for `php -l`')
		.option('--force', 'upload despite a check finding')
		.addHelpText(
			'after',
			['', 'Examples:', '  drangler modify release --tag v1.2.0'].join('\n')
		)
		.action(async (opts, command) => {
			const bound = bind(command);
			await runModifyRelease(bound.ctx, { ...opts, globals: bound.globals });
		});

	modify
		.command('require')
		.argument('<names...>', 'composer or npm package names')
		.description('Install a package from a registry, and optionally turn it on')
		.option('--version <constraint>', 'a version constraint')
		.addOption(
			new Option('--registry <registry>', 'where to fetch it from').choices([
				'composer',
				'npm'
			])
		)
		.option('--enable', 'also enable each package after it installs')
		.option('--force', 'install despite an /installable refusal')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler modify require drupal/key --enable',
				'  drangler modify require drupal/redis --version ^1.10'
			].join('\n')
		)
		.action(async (names: string[], opts, command) => {
			const bound = bind(command);
			await runModifyRequire(bound.ctx, names, { ...opts, globals: bound.globals });
		});

	modify
		.command('enable')
		.argument('<names...>', 'module machine names')
		.description('Turn modules on, once their files are on the site')
		.addHelpText('after', ['', 'Examples:', '  drangler modify enable mantle2'].join('\n'))
		.action(async (names: string[], opts, command) => {
			const bound = bind(command);
			await runModifyEnable(bound.ctx, names, { ...opts, globals: bound.globals });
		});

	// `dev` already clones the worker, hydrates it and hands the terminal to wrangler, and mounting
	// a module needs all of that first; a second command would mean a second workspace and two
	// wrangler processes on one port
	modify
		.command('dev')
		.argument('[wrangler-args...]', 'passed through to wrangler, after a `--`')
		.description('Alias for `drangler dev --modify .`')
		.option('--dir <path>', 'the project directory; defaults to the working directory')
		.option('--no-watch', 'upload once instead of on every change')
		.option('--interval <ms>', 'how long between change polls')
		.option('--port <n>', 'the port wrangler listens on')
		.addHelpText(
			'after',
			['', 'Examples:', '  drangler modify dev', '  drangler modify dev --port 8788'].join(
				'\n'
			)
		)
		.action(async (extra: string[], opts, command) => {
			const bound = bind(command);
			await runDevCommand(bound.ctx, extra ?? [], {
				...opts,
				modify: [opts.dir ?? bound.ctx.cwd],
				globals: bound.globals
			});
		});

	const config = program.command('config').description('Inspect a wrangler configuration');
	config
		.command('check')
		.argument('<file>', 'path to wrangler.jsonc')
		.description(
			'Score a wrangler config against the deployments this project has shipped wrong'
		)
		.addOption(
			new Option('--plan <plan>', 'state the account plan instead of looking it up').choices([
				'free',
				'paid',
				'unknown'
			])
		)
		.action(async (file: string, opts, command) => {
			const bound = bind(command);
			await runConfigCheck(bound.ctx, file, {
				...opts,
				json: bound.globals.json,
				...(bound.globals.config.account.value === null
					? {}
					: { account: bound.globals.config.account.value })
			});
		});
	config
		.command('levers')
		.argument('<file>', 'path to wrangler.jsonc')
		.description('The optional levers a config declares, and the real state of each')
		.option('--check', 'request the origin FILES_PUBLIC_URL names and report what it answered')
		.addHelpText(
			'after',
			[
				'',
				'Every lever here is optional and the site is correct without it, so an unset one is',
				'reported rather than warned about.',
				'',
				'Examples:',
				'  drangler config levers wrangler.jsonc',
				'  drangler config levers wrangler.jsonc --check'
			].join('\n')
		)
		.action(async (file: string, opts, command) => {
			const bound = bind(command);
			await runConfigLevers(bound.ctx, file, {
				...opts,
				json: bound.globals.json,
				timeoutMs: bound.globals.timeoutMs
			});
		});
	config
		.command('where')
		.description('Which file supplied each setting, and which files were searched')
		.action((_opts, command) => {
			const bound = bind(command);
			runConfigWhere(bound.ctx, bound.globals.config, { json: bound.globals.json });
		});

	const cf = program.command('cf').description('Read-only Cloudflare account operations');
	cf.command('whoami')
		.description('Report which Cloudflare credential drangler would use')
		.action(async (_opts, command) => {
			const bound = bind(command);
			await runWhoami(bound.ctx, { json: bound.globals.json });
		});
	cf.command('workers')
		.description('List the account workers, and compare against a saved baseline')
		.option('--save <file>', 'write the current list as a baseline')
		.option('--compare <file>', 'exit 3 when the list differs from this baseline')
		.action(async (opts, command) => {
			const bound = bind(command);
			await runWorkers(bound.ctx, {
				...opts,
				json: bound.globals.json,
				...(bound.globals.config.account.value === null
					? {}
					: { account: bound.globals.config.account.value })
			});
		});
	cf.command('cpu')
		.argument('<capture>', 'a saved `wrangler tail --format json` capture')
		.description('Summarise cpuTime per execution model, and refuse an untrustworthy capture')
		.action(async (capture: string, _opts, command) => {
			const bound = bind(command);
			await runCpu(bound.ctx, capture, { json: bound.globals.json });
		});

	const secrets = program
		.command('secrets')
		.description('Credential checks on migration artifacts');
	secrets
		.command('scan')
		.argument('<paths...>', 'files or directories to scan')
		.description('Find credentials in a dump, a settings.php or a tree, without printing them')
		.action(async (paths: string[], _opts, command) => {
			const bound = bind(command);
			await runSecretsScan(bound.ctx, paths, { json: bound.globals.json });
		});

	const migrate = program
		.command('migrate')
		.description('Move a site between a VPS and Cloudflare Workers, in either direction');

	migrate
		.command('survey')
		.description('Read a VPS Drupal over SSH: versions, database, modules, files')
		.requiredOption('--host <target>', 'ssh destination, as [user@]host[:port]')
		.requiredOption('--root <path>', 'absolute Drupal root on that host')
		.option('--identity <file>', 'ssh private key, passed to ssh as -i')
		.option('--replay <file>', 'drive the survey from a recorded transcript')
		.option('--out <file>', 'write the survey as JSON')
		.option('--resume', 're-run only the steps with neither a value nor a recorded error')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler migrate survey --host deploy@old.example --root /var/www/html',
				'  drangler migrate survey --host deploy@old.example --root /var/www/html --dry-run',
				'  drangler migrate survey --host deploy@old.example --root /var/www/html --resume --out survey.json'
			].join('\n')
		)
		.action(async (opts, command) => {
			const bound = bind(command);
			await runSurveyCommand(bound.ctx, {
				...opts,
				json: bound.globals.json,
				dryRun: bound.globals.dryRun
			});
		});

	migrate
		.command('plan')
		.description('Score a survey against the platform limits and order the work')
		.option('--survey <file>', 'a survey written by `migrate survey --out`')
		.option('--target-php <version>', 'the PHP version the destination runs, if you know it')
		.addOption(
			new Option('--to <where>', 'direction of travel')
				.choices(['workers', 'vps'])
				.default('workers')
		)
		.action(async (opts, command) => {
			const bound = bind(command);
			await runPlanCommand(bound.ctx, {
				...opts,
				json: bound.globals.json,
				...(bound.globals.config.site.value === null
					? {}
					: { site: bound.globals.config.site.value })
			});
		});

	migrate
		.command('eligibility')
		.description('Can this site move in this direction today, and what would have to change')
		.addOption(
			new Option('--to <where>', 'direction of travel')
				.choices(['workers', 'vps'])
				.default('workers')
		)
		.option('--survey <file>', 'a survey written by `migrate survey --out`')
		.option('--target-php <version>', 'the PHP version the destination runs, if you know it')
		.option('--assume-worst', 'score every unmeasured criterion as a blocker')
		.addOption(new Option('--require <verdict>', 'exit 3 below this verdict').choices(['go']))
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler migrate eligibility --survey survey.json',
				'  drangler migrate eligibility --to vps --survey survey.json',
				'  drangler migrate eligibility --survey survey.json --assume-worst'
			].join('\n')
		)
		.action(async (opts, command) => {
			const bound = bind(command);
			await runEligibility(bound.ctx, { ...opts, globals: bound.globals });
		});

	migrate
		.command('export')
		.description('Pull a deployed site database out through /export')
		.option('--url <origin>', 'the deployed worker origin; defaults to --site or the config')
		.option('--all', 'include the regenerable bins, which are structure-only by default')
		.option('--out <file>', 'write the dump')
		.option('--chunked', 'pull the dump one chunk at a time, recording a cursor as it goes')
		.option('--resume', 'continue from the cursor a previous run recorded')
		.option(
			'--checkpoint <file>',
			'where that cursor lives (default: .drangler/migration.json)'
		)
		.option('--chunk-chars <n>', 'characters per chunk')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler migrate export --out worker.sql',
				'  drangler migrate export --chunked --out worker.sql',
				'  drangler migrate export --resume --out worker.sql'
			].join('\n')
		)
		.action(async (opts, command) => {
			const bound = bind(command);
			await runExportCommand(bound.ctx, {
				...opts,
				json: bound.globals.json,
				site: bound.globals.config.siteName.value ?? 'site',
				...(opts.url === undefined && bound.globals.config.site.value !== null
					? { url: bound.globals.config.site.value }
					: {}),
				...(bound.globals.config.token.value === null
					? {}
					: { token: bound.globals.config.token.value })
			});
		});

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
		.action(async (opts, command) => {
			const bound = bind(command);
			await runConvertCommand(bound.ctx, {
				...opts,
				json: bound.globals.json,
				...(opts.maxStatementChars === undefined
					? {}
					: { maxStatementChars: Number(opts.maxStatementChars) })
			});
		});

	migrate
		.command('install')
		.description(
			'Land a migrated database or asset in a workspace, backing up what it replaces'
		)
		.option('--db <file>', 'a SQLite database file to install as assets/drupal/site.sqlite')
		.option(
			'--asset <from=to>',
			'any other file, with a workspace-relative destination; repeatable',
			(value: string, all: string[] = []) => [...all, value]
		)
		.option('--repack', 'run `bun run assets:sql` afterwards, which is what makes --db ship')
		.option(
			'--resume',
			'report the backup set an earlier run took rather than refusing over it'
		)
		.option('--checkpoint <file>', 'where the migration checkpoint lives')
		.action(async (opts, command) => {
			const bound = bind(command);
			await runInstallCommand(bound.ctx, { ...opts, globals: bound.globals });
		});

	migrate
		.command('delta')
		.description('The second dump table set, and the re-seed that fails silently if skipped')
		.option('--survey <file>', 'a survey, so contrib entity tables reach the set')
		.addHelpText('after', ['', 'Examples:', '  drangler migrate delta'].join('\n'))
		.action((opts, command) => {
			const bound = bind(command);
			runDeltaCommand(bound.ctx, { ...opts, globals: bound.globals });
		});

	migrate
		.command('cutover')
		.description('The steps a human confirms, and the three things no mechanism catches')
		.option('--checklist', 'print the checklist; it is the only mode there is')
		.addHelpText(
			'after',
			['', 'Examples:', '  drangler migrate cutover --checklist'].join('\n')
		)
		.action((opts, command) => {
			const bound = bind(command);
			runCutoverCommand(bound.ctx, { ...opts, globals: bound.globals });
		});

	migrate
		.command('files')
		.description('Write the managed files in a dump back onto a filesystem')
		.requiredOption('--from-dump <file>', 'a dump written by `drangler migrate export`')
		.option('--out <dir>', 'where the tree lands')
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  drangler migrate files --from-dump worker.sql --out ./files',
				'  drangler migrate files --from-dump worker.sql --json'
			].join('\n')
		)
		.action((opts, command) => {
			const bound = bind(command);
			runFilesCommand(bound.ctx, { ...opts, globals: bound.globals });
		});

	migrate
		.command('restore')
		.description('Put a backup set taken by `migrate install` back where it came from')
		.requiredOption('--backup <dir>', 'a directory holding backup.json')
		.action(async (opts, command) => {
			const bound = bind(command);
			await runRestoreCommand(bound.ctx, { ...opts, json: bound.globals.json });
		});

	return program;
}
