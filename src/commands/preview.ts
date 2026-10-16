import { join } from 'node:path';
import { workersPlan } from '../cloudflare/api';
import { target as cloudflareTarget } from '../cloudflare/client';
import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { DranglerError, FindingError, UsageError } from '../errors';
import { emit, bytes as humanBytes, kv, table } from '../format';
import { convertDump } from '../migrate/convert';
import {
	blankingOverrides,
	blankOverrideCredentials,
	describeCredential,
	mergeOverrides,
	readCredentials,
	type Credential
} from '../migrate/credentials';
import {
	discoverLayout,
	discoveryCommands,
	drushPrefix,
	type SourceLayout
} from '../migrate/discover';
import { MAIL_SENDER_OVERRIDE, readMailSender, WORKER_MAIL_PLUGIN } from '../migrate/mail-system';
import { buildPlan, renderPlan } from '../migrate/plan';
import {
	assetHeadersFile,
	buildSiteDb,
	CODE_DIRS,
	codeCommand,
	codeTree,
	composerLockCommands,
	devVarLine,
	dialectOf,
	domainsText,
	dumpCommand,
	filesCommand,
	missingLibraries,
	parseConfigOverrides,
	parseHtaccess,
	parseSettings,
	privateFilesCommand,
	publishableRootFiles,
	readOnlyTransport,
	rootFilesCommand,
	rootListCommand,
	serverRulesCommands,
	settingsCommands,
	settingsOverrides,
	settingsReport,
	trustedHosts,
	walkFiles,
	wellKnownCommand,
	type CodeTree,
	type ConfigOverrides,
	type ServerRules,
	type SettingsAssignment,
	type SiteDbReport
} from '../migrate/preview';
import { parseRedisState, REDIS_STATE_SCRIPT, type RedisRow } from '../migrate/redis-state';
import { SOURCE_FINDING_IDS, type Finding } from '../migrate/rules';
import { runSurvey, surveyPlan, type SiteSurvey } from '../migrate/survey';
import { parseTarget, type SshTarget } from '../migrate/target';
import { assumedTarget, statedTarget } from '../migrate/target-runtime';
import { sshTransport, type Transport } from '../migrate/transport';
import { ownerCall, type OwnerTarget } from '../owner';
import { workerGaps } from '../workspace/capabilities';
import { readState } from '../workspace/layout';
import { runInstallCommand } from './migrate';
import { requirePackages } from './modify';
import { deployDuplicate } from './preview-deploy';
import { followModules, followRoot, parseFollow, type Follow } from './preview-follow';
import { driveUpdb } from './site';
import { DEV_PORT, runBuildCommand, runDevCommand } from './workspace';

export interface PreviewOptions {
	host: string;
	/** the Drupal docroot; discovered from the web server config when absent */
	root?: string | undefined;
	/** which hostname to take when the host serves several Drupal sites */
	site?: string | undefined;
	/** the host again, as the non-interactive form of typing it at the prompt */
	confirm?: string | undefined;
	/** the Workers plan the duplicate models; detected from the account when deploying */
	plan?: 'free' | 'paid' | undefined;
	/** extra paths the check compares against the source, beside `/` and the login page */
	check?: string[] | undefined;
	/** `module=repository`: modules to keep current from git once the duplicate is up */
	follow?: string[] | undefined;
	/** minutes between polls of a followed repository; the worker floors it at 5 */
	followInterval?: string | number | undefined;
	/** credential-bearing config values to carry instead of blanking, by key id or config name */
	carryKey?: string[] | undefined;
	/** local only: queue mail in the duplicate and never send it, so a code can be read from the queue */
	holdMail?: boolean | undefined;
	identity?: string;
	/** where the dump, the files and the preview's own worker checkout land */
	out?: string;
	/** every step after one typed confirmation */
	full?: boolean;
	/** deploy the duplicate as `drupflare-preview-<host>` instead of running it locally */
	deploy?: boolean;
	/** with --deploy, who may open the copy through Access; defaults to the wrangler login's email */
	accessEmail?: string | undefined;
	/** the live source site; the check then compares each page's status against it */
	sourceUrl?: string;
	port?: string | number;
	targetPhp?: string;
	globals: GlobalOptions;
	/** @internal the ssh seam, for a spec */
	transport?: Transport;
}

export const PREVIEW_STEPS = [
	{ id: 'discover', title: 'Find the Site on the Host' },
	{ id: 'survey', title: 'Survey the Source' },
	{ id: 'plan', title: 'Score the Move' },
	{ id: 'dump', title: 'Stream the Database' },
	{ id: 'files', title: 'Stream the Public Files' },
	{ id: 'code', title: 'Stream the Modules, Themes and Libraries' },
	{ id: 'settings', title: 'Read Config Overrides and Root Files' },
	{ id: 'redis', title: 'Read the App State Kept in Redis' },
	{ id: 'convert', title: 'Build the SQLite Database' },
	{ id: 'install', title: 'Install Into a Preview Workspace' },
	{ id: 'up', title: 'Bring Up the Duplicate' },
	{ id: 'verify', title: 'Check the Duplicate' }
] as const;

export type PreviewStepId = (typeof PREVIEW_STEPS)[number]['id'];

/** how long a fresh duplicate may take to replay its pack before the check gives up */
export const UP_TIMEOUT_MS = 15 * 60_000;
const UP_POLL_MS = 2_000;
const DEV_BOOTS = 5;

/**
 * A worker name that can only ever be a preview, so a deploy cannot land on a real site.
 *
 * The source id keeps two sites behind one ssh alias apart; the host is cut, never the id.
 */
export function previewName(host: string, id?: string): string {
	const slug = host
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	const tail = id === undefined ? '' : `-${id}`;
	return `drupflare-preview-${slug}`
		.slice(0, 63 - tail.length)
		.replace(/-+$/, '')
		.concat(tail);
}

export interface PreviewPlan {
	plan: 'free' | 'paid';
	source: 'stated' | 'detected' | 'assumed';
}

/**
 * The plan profile the duplicate runs under, and where that value came from.
 *
 * The worker defaults to `free` and enforces that plan's daily row budget even under `wrangler
 * dev`, so replaying a real database trips it: earth-app's 80 MB left the duplicate read-only for
 * 22 hours. A deploy reads the account's own subscription; a local run has no bill and assumes
 * `paid`, which the summary says.
 */
export async function previewPlan(ctx: Context, opts: PreviewOptions): Promise<PreviewPlan> {
	if (opts.plan !== undefined) return { plan: opts.plan, source: 'stated' };
	if (opts.deploy !== true) return { plan: 'paid', source: 'assumed' };
	const reading = await workersPlan(await cloudflareTarget(ctx, null));
	return reading.plan === 'unknown'
		? { plan: 'free', source: 'assumed' }
		: { plan: reading.plan, source: 'detected' };
}

function localCommands(
	opts: PreviewOptions,
	out: string,
	workspace: string,
	id?: string
): string[] {
	return [
		`tar -xf ${join(out, 'files.tar')} -C ${out}`,
		...CODE_DIRS.map((d) => `tar -xf ${join(out, `${d}.tar`)} -C ${out}`),
		`drangler migrate install --db ${join(out, 'site.sqlite')} --repack --workspace ${workspace}`,
		opts.deploy === true
			? `bunx wrangler deploy --name ${previewName(parseTarget(opts.host, opts.root ?? '/').host, id)}`
			: `bunx wrangler dev --port ${opts.port ?? DEV_PORT}`
	];
}

interface Done {
	step: PreviewStepId | 'follow';
	summary: string;
}

/**
 * Makes a working duplicate of a VPS Drupal site: survey, convert, bring up, check.
 *
 * A DUPLICATE, NEVER A REPLACEMENT. Every command sent to the host passes the read-only allow-list
 * in `readOnlyTransport()`, the database and files come back on stdout, and the duplicate lives in
 * its own workspace, so neither the source site nor the user's own worker checkout changes.
 *
 * It always asks. `--yes` does not apply; `--full` replaces the per-step question with one typed
 * confirmation, and with no terminal to type into it refuses.
 */
/**
 * Fills each decision a flag left open from `DRANGLER_PREVIEW_<NAME>`, so a CI step or a wrapper can
 * answer without flags. A flag always wins; lists are comma separated; booleans are `1`.
 */
export function previewEnv(opts: PreviewOptions, env: NodeJS.ProcessEnv): PreviewOptions {
	const get = (name: string): string | undefined => {
		const value = env[`DRANGLER_PREVIEW_${name}`]?.trim();
		return value === undefined || value === '' ? undefined : value;
	};
	const list = (name: string): string[] | undefined =>
		get(name)
			?.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	const plan = get('PLAN');
	if (opts.plan === undefined && plan !== undefined && plan !== 'free' && plan !== 'paid') {
		throw new UsageError(`DRANGLER_PREVIEW_PLAN is ${plan}; it must be free or paid`);
	}
	return {
		...opts,
		root: opts.root ?? get('ROOT'),
		site: opts.site ?? get('SITE'),
		confirm: opts.confirm ?? get('CONFIRM'),
		plan: opts.plan ?? (plan as 'free' | 'paid' | undefined),
		accessEmail: opts.accessEmail ?? get('ACCESS_EMAIL'),
		followInterval: opts.followInterval ?? get('FOLLOW_INTERVAL'),
		follow: opts.follow ?? list('FOLLOW'),
		check: opts.check ?? list('CHECK'),
		carryKey: opts.carryKey ?? list('CARRY_KEYS'),
		deploy: opts.deploy ?? (get('DEPLOY') === '1' ? true : undefined),
		holdMail: opts.holdMail ?? (get('HOLD_MAIL') === '1' ? true : undefined)
	};
}

export async function runPreviewCommand(ctx: Context, given: PreviewOptions): Promise<void> {
	const opts = previewEnv(given, ctx.env);
	if (opts.holdMail === true && opts.deploy === true) {
		throw new UsageError(
			'--hold-mail is for a local duplicate: a deployed one would queue mail without limit',
			'drop --deploy, or drop --hold-mail and carry no mail credential'
		);
	}
	const target = parseTarget(opts.host, opts.root ?? '/', opts.identity);
	let out = opts.out ?? join(ctx.cwd, '.drangler', 'preview', target.host);
	let workspace = join(out, 'worker');
	const json = opts.globals.json;
	let layout: SourceLayout | null = null;
	let drush: string | undefined;
	let siteDir = 'default';

	if (opts.globals.dryRun) {
		const report = {
			target,
			out,
			workspace,
			steps: PREVIEW_STEPS,
			remote:
				opts.root === undefined
					? [
							...discoveryCommands(null).filter((c) => !c.endsWith('/site.conf')),
							'cat <each file those listings name>',
							'then, for the docroot it finds: the survey, dump, files, code and settings commands, run as the web user with the project drush'
						]
					: [
							...discoveryCommands(target.root),
							...surveyPlan(target.root).map((s) => s.command),
							`${dumpCommand(target.root, 'mysql')} (or the pgsql form)`,
							filesCommand(target.root),
							'tar -cf - -C <parent> <private> (only when drush reports a private files path)',
							...CODE_DIRS.map((d) => codeCommand(target.root, d)),
							...settingsCommands(target.root),
							...composerLockCommands(target.root),
							rootListCommand(target.root),
							`tar -cf - -C ${target.root} <the verification pages and root files the listing finds>`,
							wellKnownCommand(target.root),
							...serverRulesCommands(target.root),
							`redis-cli eval "${REDIS_STATE_SCRIPT}" 0`
						],
			local: localCommands(opts, out, workspace)
		};
		emit(ctx.io, json, report, () => [
			`dry run against ${opts.host}; nothing was executed`,
			'',
			...PREVIEW_STEPS.map((s, i) => `${i + 1}. ${s.title}`),
			'',
			'read-only commands on the host',
			...report.remote.map((c) => `  $ ${c}`),
			'',
			'local commands',
			...report.local.map((c) => `  $ ${c}`)
		]);
		return;
	}

	const ask = await interaction(ctx, opts, target);
	const transport = readOnlyTransport(opts.transport ?? sshTransport(ctx.runner, target));
	const done: Done[] = [];
	const finish = (stopped: PreviewStepId | null) =>
		emit(ctx.io, json, { target, out, workspace, done, stopped }, () => [
			'',
			...table(
				['step', 'result'],
				done.map((d) => [d.step, d.summary])
			),
			...(stopped === null ? [] : ['', `stopped before ${stopped}; nothing after it ran`])
		]);

	let survey: SiteSurvey | null = null;
	let dialect: ReturnType<typeof dialectOf> = null;
	let db: SiteDbReport | null = null;
	let fileList: string[] = [];
	let privateList: string[] = [];
	let code: CodeTree = { files: [], skipped: [] };
	let overrides: ConfigOverrides = { config: {}, expressions: [] };
	let assignments: SettingsAssignment[] = [];
	let settingsPhp = '';
	// what the worker reads as secrets: DRUPAL_CONFIG, REDIS_URL and the two rule levers, never printed
	const secrets: Record<string, string> = {};
	const targetRuntime =
		opts.targetPhp === undefined ? assumedTarget() : statedTarget(opts.targetPhp);
	let rootFiles: string[] = [];
	let wellKnown = false;
	let sourceLock: string | null = null;
	let serverRules: ServerRules | null = null;
	let moduleSettingCount = 0;
	let redisRows: RedisRow[] = [];
	let settingsBlanked: Credential[] = [];
	let missingLibs: { name: string; version: string }[] = [];
	const follows = (opts.follow ?? []).map(parseFollow);
	let followPlan: (Follow & { root: string })[] = [];
	const followInterval = Number(opts.followInterval ?? 5);

	/**
	 * Everything after the duplicate answers, the same for a local run and a deployed one: claim it,
	 * check it against the source as carried, then follow the repositories and check it again.
	 * Returns the first failure instead of throwing, so the summary is printed either way.
	 */
	const settle = async (
		origin: string,
		headers?: Record<string, string>
	): Promise<DranglerError | null> => {
		const claimed = await claimDuplicate(ctx, origin, out, opts, headers);
		done.push({ step: 'up', summary: claimed.summary });
		if (missingLibs.length > 0 && claimed.owner !== null && !opts.globals.dryRun) {
			const rows = await requirePackages(ctx, claimed.owner, missingLibs, {});
			const failed = rows.filter((r) => !r.installed);
			done.push({
				step: 'up',
				summary:
					`${rows.length - failed.length} of ${rows.length} composer librar${rows.length === 1 ? 'y' : 'ies'} the duplicate lacked installed from the registry` +
					(failed.length === 0
						? ''
						: `; not installed: ${failed.map((r) => `${r.name} (${r.error ?? 'refused'})`).join(', ')}; the commands are in composer-missing.txt`)
			});
		}
		const check = {
			sourceUrl: opts.sourceUrl ?? layout?.uri ?? undefined,
			siteDir,
			paths: opts.check,
			...(headers === undefined ? {} : { headers })
		};
		const verified = await verify(ctx, origin, survey!, db!, fileList, check);
		done.push({ step: 'verify', summary: verified.summary });
		let failure: DranglerError | null = verified.failed;
		if (followPlan.length > 0) {
			if (claimed.owner === null) {
				const why =
					'not followed: the worker has no migrated claim, so there is no owner token';
				done.push({ step: 'follow', summary: why });
				failure ??= new FindingError('follow-failed', why);
			} else {
				for (const one of await followModules(
					ctx,
					claimed.owner,
					followPlan,
					followInterval
				)) {
					done.push({ step: 'follow', summary: `${one.module}: ${one.summary}` });
					if (!one.ok) failure ??= new FindingError('follow-failed', one.summary);
				}
				const again = await verify(ctx, origin, survey!, db!, fileList, check);
				done.push({ step: 'verify', summary: `after following: ${again.summary}` });
				failure ??= again.failed;
			}
		}
		finish(null);
		return failure;
	};

	for (const step of PREVIEW_STEPS) {
		if (!(await ask(step.title))) return finish(step.id);
		switch (step.id) {
			case 'discover': {
				layout = await discoverLayout(transport, {
					root: opts.root,
					site: opts.site,
					host: opts.host
				});
				target.root = layout.docroot;
				out =
					opts.out ??
					join(ctx.cwd, '.drangler', 'preview', `${target.host}-${layout.id}`);
				workspace = join(out, 'worker');
				drush = drushPrefix(layout);
				siteDir = layout.siteDir;
				ctx.files.writeText(
					join(out, 'layout.json'),
					`${JSON.stringify(layout, null, 2)}\n`
				);
				done.push({
					step: step.id,
					summary:
						`${layout.docroot} (sites/${layout.siteDir}), ` +
						(layout.drush === null
							? 'a global drush assumed'
							: `project drush as ${layout.drush.user ?? 'the ssh user'}`) +
						`, source ${layout.id}`
				});
				break;
			}
			case 'survey': {
				survey = await runSurvey(
					{ transport, now: ctx.now },
					opts.host,
					target.root,
					null,
					{
						...(drush === undefined ? {} : { drush }),
						siteDir
					}
				);
				ctx.files.writeText(
					join(out, 'survey.json'),
					`${JSON.stringify(survey, null, 2)}\n`
				);
				done.push({
					step: step.id,
					summary: `Drupal ${survey.drupal.version ?? '?'} on ${survey.database.driver ?? '?'}, ${survey.modules.length} modules, ${survey.nodes ?? '?'} nodes`
				});
				break;
			}
			case 'plan': {
				const plan = buildPlan(survey!, 'to-worker', targetRuntime);
				if (!json) for (const line of renderPlan(plan)) ctx.io.out(line);
				if (plan.counts.blocker > 0) {
					finish(step.id);
					throw new FindingError(
						'blockers',
						`${plan.counts.blocker} blocker(s); the duplicate would not run`
					);
				}
				done.push({
					step: step.id,
					summary: `${plan.counts.warning} warning(s), ${plan.counts.note} note(s)`
				});
				break;
			}
			case 'dump': {
				dialect = dialectOf(survey!.database.driver);
				if (dialect === null) {
					throw new UsageError(
						`the source database is ${survey!.database.driver ?? 'unknown'}; preview converts MySQL, MariaDB, PostgreSQL and SQLite`
					);
				}
				const got = await transport.download(
					dumpCommand(target.root, dialect, drush),
					join(out, 'source.sql')
				);
				if (got.code !== 0) {
					throw new DranglerError(
						'dump',
						`the dump exited ${got.code}: ${got.stderr.trim() || 'no detail'}`
					);
				}
				done.push({ step: step.id, summary: `${humanBytes(got.bytes)} of ${dialect}` });
				break;
			}
			case 'files': {
				const tar = join(out, 'files.tar');
				const got = await transport.download(filesCommand(target.root, siteDir), tar);
				if (got.code !== 0) {
					throw new DranglerError(
						'files',
						`the files stream exited ${got.code}: ${got.stderr.trim() || 'no detail'}`
					);
				}
				const x = await ctx.runner.run('tar', ['-xf', tar, '-C', out]);
				if (x.code !== 0) {
					throw new DranglerError(
						'files',
						`tar could not unpack ${tar}: ${x.stderr.trim()}`
					);
				}
				const dir = join(out, 'files');
				const protectedDirs: string[] = [];
				fileList = ctx.files.exists(dir)
					? walkFiles(ctx.files, dir, '', protectedDirs)
					: [];
				let privateNote = '';
				const privatePath = survey!.files.private ?? null;
				if (privatePath !== null) {
					const command = privateFilesCommand(target.root, privatePath);
					const into = join(out, 'private');
					const ptar = join(out, 'private.tar');
					const pgot = command === null ? null : await transport.download(command, ptar);
					if (command === null || pgot === null || pgot.code !== 0) {
						privateNote = `; private files at ${privatePath} not carried`;
					} else {
						ctx.files.writeText(join(into, '.keep'), '');
						await ctx.runner.run('tar', ['-xf', ptar, '-C', into]);
						const top = join(into, privatePath.split('/').filter(Boolean).at(-1)!);
						privateList = ctx.files.exists(top) ? walkFiles(ctx.files, top) : [];
						privateNote = `; ${privateList.length} private file(s)`;
					}
				}
				done.push({
					step: step.id,
					summary:
						`${fileList.length} file(s), ${humanBytes(got.bytes)} streamed${privateNote}` +
						(protectedDirs.length > 0
							? `; ${protectedDirs.length} protected director${protectedDirs.length === 1 ? 'y' : 'ies'} left out (${protectedDirs.join(', ')})`
							: '')
				});
				break;
			}
			case 'code': {
				const absent: string[] = [];
				for (const tree of CODE_DIRS) {
					const tar = join(out, `${tree}.tar`);
					const got = await transport.download(codeCommand(target.root, tree), tar);
					if (got.code !== 0) {
						// a site with no libraries/ or profiles/ is ordinary; anything else stops the run
						if (/No such file|Cannot stat/i.test(got.stderr)) {
							absent.push(tree);
							continue;
						}
						throw new DranglerError(
							'code',
							`streaming ${tree}/ exited ${got.code}: ${got.stderr.trim() || 'no detail'}`
						);
					}
					// the archive's top entry is the tree's own name, so it lands at <out>/<tree>
					const x = await ctx.runner.run('tar', ['-xf', tar, '-C', out]);
					if (x.code !== 0) {
						throw new DranglerError(
							'code',
							`tar could not unpack ${tar}: ${x.stderr.trim()}`
						);
					}
				}
				code = codeTree(ctx.files, out);
				followPlan = follows.map((f) => ({
					...f,
					root: followRoot(
						f.module,
						code.files.map((file) => file.path)
					)
				}));
				if (code.skipped.length > 0) {
					ctx.files.writeText(
						join(out, 'code-skipped.txt'),
						`${code.skipped.join('\n')}\n`
					);
				}
				done.push({
					step: step.id,
					summary:
						`${code.files.length} file(s)` +
						(code.skipped.length > 0
							? `, ${code.skipped.length} binary or oversized not carried (code-skipped.txt)`
							: '') +
						(absent.length > 0 ? `, no ${absent.join('/, ')}/` : '')
				});
				break;
			}
			case 'settings': {
				for (const command of settingsCommands(target.root, siteDir)) {
					const got = await transport.exec(command);
					// settings.local.php is optional; a missing settings.php is a survey finding already
					if (got.code === 0) {
						overrides = parseConfigOverrides(got.stdout, overrides);
						assignments = [...assignments, ...parseSettings(got.stdout)];
						settingsPhp += `${got.stdout}\n`;
					}
				}
				for (const command of composerLockCommands(target.root)) {
					const got = await transport.exec(command);
					if (got.code === 0) {
						sourceLock = got.stdout;
						break;
					}
				}
				const listed = await transport.exec(rootListCommand(target.root));
				rootFiles =
					listed.code === 0 ? publishableRootFiles(listed.stdout, target.root) : [];
				const root = join(out, 'root');
				if (rootFiles.length > 0) {
					const tar = join(out, 'root.tar');
					const got = await transport.download(
						rootFilesCommand(target.root, rootFiles),
						tar
					);
					if (got.code !== 0) {
						throw new DranglerError(
							'settings',
							`streaming root files exited ${got.code}`
						);
					}
					ctx.files.writeText(join(root, '.keep'), '');
					await ctx.runner.run('tar', ['-xf', tar, '-C', root]);
				}
				const wk = await transport.download(
					wellKnownCommand(target.root),
					join(out, 'well-known.tar')
				);
				if (wk.code === 0) {
					ctx.files.writeText(join(root, '.keep'), '');
					await ctx.runner.run('tar', ['-xf', join(out, 'well-known.tar'), '-C', root]);
					wellKnown = true;
				}
				const [htaccessCommand, stockCommand] = serverRulesCommands(target.root);
				const htaccess = await transport.exec(htaccessCommand!);
				if (htaccess.code === 0) {
					const stock = await transport.exec(stockCommand!);
					serverRules = parseHtaccess(
						htaccess.stdout,
						stock.code === 0 ? stock.stdout : ''
					);
					if (serverRules.redirects.length > 0) {
						secrets['REDIRECTS'] = JSON.stringify(serverRules.redirects);
					}
					if (serverRules.headers.length > 0) {
						secrets['RESPONSE_HEADERS'] = JSON.stringify(serverRules.headers);
					}
					if (serverRules.unparsed.length > 0) {
						ctx.files.writeText(
							join(out, 'server-rules-unparsed.txt'),
							`${serverRules.unparsed.join('\n\n')}\n`
						);
					}
				}
				const hosts = trustedHosts(settingsPhp);
				if (hosts.hosts.length + hosts.patterns.length > 0) {
					ctx.files.writeText(join(out, 'domains.txt'), domainsText(hosts));
				}
				settingsBlanked = blankOverrideCredentials(overrides.config, opts.carryKey ?? []);
				const carried = Object.keys(overrides.config).length;
				if (opts.holdMail === true) {
					secrets['MAIL_TRANSPORT'] = 'smtp';
					secrets['SMTP_HOST'] = 'mail-held.invalid';
					secrets['MAIL_DRAIN_ON_ALARM'] = '0';
				}
				const settings = settingsReport(assignments);
				if (carried > 0) secrets['DRUPAL_CONFIG'] = JSON.stringify(overrides.config);
				const plan = await previewPlan(ctx, opts);
				secrets['PLAN'] = plan.plan;
				const moduleSettings = settingsOverrides(assignments);
				const settingNames = Object.keys(moduleSettings.settings);
				moduleSettingCount = settingNames.length;
				if (settingNames.length > 0) {
					secrets['DRUPAL_SETTINGS'] = JSON.stringify(moduleSettings.settings);
				}
				if (settings.redisUrl !== null) secrets['REDIS_URL'] = settings.redisUrl;
				if (Object.keys(secrets).length > 0) {
					ctx.files.writeSecret(
						join(out, 'secrets.json'),
						`${JSON.stringify(secrets)}\n`
					);
				}
				const found = buildPlan(survey!, 'to-worker', targetRuntime, null, {
					files: code.files,
					lock: sourceLock,
					settings
				}).findings.filter((f) => SOURCE_FINDING_IDS.includes(f.id));
				if (!json) reportFindings(ctx, found);
				const blockers = found.filter((f) => f.severity === 'blocker');
				done.push({
					step: step.id,
					summary:
						`plan ${plan.plan} (${plan.source}), ` +
						`${carried} config override(s) carried as DRUPAL_CONFIG` +
						(settingNames.length > 0
							? `, ${settingNames.length} module setting(s) carried as DRUPAL_SETTINGS (${settingNames.join(', ')})`
							: '') +
						(moduleSettings.expressions.length > 0
							? `, ${moduleSettings.expressions.length} set by expression not carried: ${moduleSettings.expressions.join(', ')}`
							: '') +
						(settings.redisUrl === null
							? ''
							: ', redis.connection carried as REDIS_URL') +
						(overrides.expressions.length > 0
							? `, ${overrides.expressions.length} set by expression not carried: ${overrides.expressions.join(', ')}`
							: '') +
						`, ${rootFiles.length} root file(s)${wellKnown ? ' and .well-known/' : ''}` +
						(serverRules === null
							? ', no .htaccess'
							: `, ${serverRules.redirects.length} redirect(s) and ${Object.keys(serverRules.headers[0]?.set ?? {}).length} header(s) from .htaccess` +
								(serverRules.unparsed.length > 0
									? `, ${serverRules.unparsed.length} rule(s) not translated (server-rules-unparsed.txt)`
									: '')) +
						(hosts.hosts.length + hosts.patterns.length > 0
							? `, ${hosts.hosts.length} hostname(s) from trusted_host_patterns (domains.txt)`
							: '') +
						`, ${found.length} finding(s) from the source's own files`
				});
				if (blockers.length > 0) {
					finish(step.id);
					throw new FindingError(
						'blockers',
						`${blockers.length} blocker(s) in the source's own files; the duplicate would not run`
					);
				}
				break;
			}
			case 'redis': {
				const seen = survey!.redis;
				const appKeys = seen === null || seen === undefined ? 0 : seen.keys - seen.cache;
				if (appKeys <= 0) {
					done.push({
						step: step.id,
						summary:
							seen === null || seen === undefined
								? 'no Redis answered, so none was read'
								: 'nothing outside the Drupal cache bins'
					});
					break;
				}
				const got = await transport.exec(`redis-cli eval "${REDIS_STATE_SCRIPT}" 0`);
				const carry =
					got.code === 0
						? parseRedisState(got.stdout, Math.floor(ctx.now().getTime() / 1000))
						: null;
				if (carry === null) {
					const why = `${appKeys} app key(s) sit in Redis and the read script did not answer`;
					ctx.io.err(`WARNING redis-state: ${why}; the copy starts without them`);
					done.push({ step: step.id, summary: `${why}; not carried` });
					break;
				}
				redisRows = carry.rows;
				const other = Object.entries(carry.other)
					.map(([type, n]) => `${type} x${n}`)
					.join(', ');
				if (other !== '' || carry.big > 0 || carry.truncated) {
					ctx.io.err(
						`WARNING redis-state: not carried: ${[
							other === ''
								? null
								: `${other} (the stand-in answers string keys only)`,
							carry.big > 0 ? `${carry.big} value(s) over 64 KiB` : null,
							carry.truncated ? 'keys past the first 5,000' : null
						]
							.filter((part) => part !== null)
							.join('; ')}`
					);
				}
				done.push({
					step: step.id,
					summary:
						`${carry.rows.length} key(s) carried into key_value_expire` +
						(other === '' ? '' : `; ${other} not carried`) +
						(carry.big > 0 ? `; ${carry.big} over 64 KiB not carried` : '') +
						(carry.truncated ? '; stopped at 5,000 keys' : '')
				});
				break;
			}
			case 'convert': {
				const source = ctx.files.readText(join(out, 'source.sql'));
				const converted =
					dialect === 'sqlite'
						? { sql: source, skipped: [], overLimit: [] }
						: convertDump(source, {
								from: dialect!,
								to: 'sqlite',
								skipUnsupported: true,
								// the dump replays into a local file with no statement ceiling, and the
								// worker's pack builder splits wide values itself, so no row is dropped here
								maxStatementChars: 0
							});
				// replaying into a database a run already filled fails on its first CREATE TABLE
				if (ctx.files.exists(join(out, 'site.sqlite'))) {
					throw new UsageError(
						`${out} already holds a preview database, and nothing here deletes one`,
						`drangler preview --host ${opts.host} --out <a folder that does not exist yet>`
					);
				}
				ctx.files.writeText(join(out, 'converted.sql'), converted.sql);
				const dir = join(out, 'files');
				db = buildSiteDb(
					join(out, 'site.sqlite'),
					converted.sql,
					[
						...fileList.map((rel) => ({
							rel,
							bytes: ctx.files.readBytes(join(dir, rel))
						})),
						...privateList.map((rel) => ({
							rel,
							scheme: 'private' as const,
							bytes: ctx.files.readBytes(
								join(
									out,
									'private',
									survey!.files.private!.split('/').filter(Boolean).at(-1)!,
									rel
								)
							)
						}))
					],
					ctx.now().getTime(),
					code.files,
					redisRows
				);
				const found = readCredentials(join(out, 'site.sqlite'));
				let carry = opts.carryKey ?? [];
				if (found.length > 0 && opts.confirm === undefined && opts.carryKey === undefined) {
					const names = found.map(describeCredential).join(', ');
					const typed = await ctx.ask(
						`The database holds ${found.length} credential(s): ${names}. Names to carry into the duplicate, comma separated, or enter for none:`
					);
					carry = (typed ?? '')
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean);
				}
				const credentials = blankingOverrides(found, carry);
				const blanked = [...settingsBlanked, ...credentials.blanked];
				const mailSender = readMailSender(join(out, 'site.sqlite'));
				if (credentials.blanked.length > 0 || mailSender !== null) {
					overrides = {
						...overrides,
						config: mergeOverrides(
							mergeOverrides(overrides.config, credentials.overrides),
							mailSender === null ? {} : MAIL_SENDER_OVERRIDE
						)
					};
					secrets['DRUPAL_CONFIG'] = JSON.stringify(overrides.config);
					ctx.files.writeSecret(
						join(out, 'secrets.json'),
						`${JSON.stringify(secrets)}\n`
					);
				}
				if (mailSender !== null) {
					ctx.io.err(
						`mail: the Mail System sender ${mailSender} opens its own socket, which a Worker cannot, so it is moved onto the worker's mail layer (${WORKER_MAIL_PLUGIN})`
					);
				}
				if (blanked.length > 0) {
					ctx.io.err(
						`credentials: ${blanked.length} blanked in the duplicate, so it cannot act as production with them: ${blanked.map(describeCredential).join(', ')}; carry one with --carry-key <name>`
					);
				}
				if (credentials.carried.length > 0) {
					ctx.io.err(
						`credentials: ${credentials.carried.length} carried by request: ${credentials.carried.map(describeCredential).join(', ')}`
					);
				}
				const dropped = converted.overLimit.map((o) => o.table);
				done.push({
					step: step.id,
					summary:
						`${db.tables} tables, ${db.filesStored} file(s) and ${db.codeFiles} code file(s) stored` +
						(blanked.length > 0 ? `, ${blanked.length} credential(s) blanked` : '') +
						(mailSender === null
							? ''
							: `, mail sender ${mailSender} moved to ${WORKER_MAIL_PLUGIN}`) +
						(credentials.carried.length > 0
							? `, ${credentials.carried.length} carried`
							: '') +
						(converted.skipped.length > 0
							? `, ${converted.skipped.length} statement(s) skipped`
							: '') +
						(dropped.length > 0 ? `, rows too wide in ${dropped.join(', ')}` : '')
				});
				break;
			}
			case 'install': {
				if (!readState(ctx.files, workspace).checkout) {
					await runBuildCommand(ctx, { workspace, globals: opts.globals });
				}
				refuseOldWorker(ctx, workspace);
				for (const gap of workerGaps(ctx.files, workspace, {
					moduleSettings: moduleSettingCount > 0,
					followMount: followPlan.length > 0
				})) {
					ctx.io.err(`WARNING worker-${gap.id}: ${gap.symptom}`);
				}
				publishRootFiles(ctx, join(out, 'root'), workspace, rootFiles, wellKnown);
				if (serverRules !== null && serverRules.headers.length > 0) {
					publishAssetHeaders(ctx, workspace, assetHeadersFile(serverRules.headers));
				}
				if (Object.keys(secrets).length > 0) {
					// wrangler dev reads .dev.vars; a deploy gets the same values as secrets below
					ctx.files.writeSecret(
						join(workspace, '.dev.vars'),
						Object.entries(secrets)
							.map(([name, value]) => devVarLine(name, value))
							.join('\n') + '\n'
					);
				}
				await runInstallCommand(ctx, {
					workspace,
					db: join(out, 'site.sqlite'),
					repack: true,
					resume: true,
					checkpoint: join(out, 'migration.json'),
					globals: opts.globals
				});
				const workerLock = join(workspace, 'composer.lock');
				const missing =
					sourceLock !== null && ctx.files.exists(workerLock)
						? missingLibraries(sourceLock, ctx.files.readText(workerLock))
						: [];
				missingLibs = missing.map((m) => ({ name: m.name, version: m.version }));
				if (missing.length > 0) {
					ctx.files.writeText(
						join(out, 'composer-missing.txt'),
						missing
							.map(
								(m) => `drangler modify require ${m.name} --constraint ${m.version}`
							)
							.join('\n') + '\n'
					);
				}
				done.push({
					step: step.id,
					summary:
						workspace +
						(missing.length > 0
							? `; ${missing.length} composer librar${missing.length === 1 ? 'y' : 'ies'} the duplicate lacks (composer-missing.txt)`
							: sourceLock === null
								? '; no composer.lock read on the source'
								: '')
				});
				break;
			}
			case 'up': {
				if (opts.deploy === true) {
					const name = previewName(target.host, layout?.id);
					const deployed = await deployDuplicate(ctx, {
						name,
						out,
						workspace,
						hasSecrets: Object.keys(secrets).length > 0,
						accessEmail: opts.accessEmail,
						globals: opts.globals
					});
					done.push({
						step: step.id,
						summary: `deployed as ${name} behind Access at ${deployed.origin}`
					});
					if (!(await waitForSite(ctx, deployed.origin, deployed.headers))) {
						throw new DranglerError(
							'up',
							`${deployed.origin} did not answer 200 within the limit`
						);
					}
					const failure = await settle(deployed.origin, deployed.headers);
					if (failure) throw failure;
					return;
				}
				const port = opts.port === undefined ? DEV_PORT : Number(opts.port);
				const origin = `http://localhost:${port}`;
				// wrangler dev does not return until it is stopped, so it runs beside the check
				const { running } = await bootDuplicate(ctx, origin, () =>
					runDevCommand(ctx, [], { workspace, port, globals: opts.globals })
				);
				done.push({ step: step.id, summary: origin });
				const failure = await settle(origin);
				ctx.io.err(`the duplicate is running at ${origin}; stop it with Ctrl-C`);
				// stopping the duplicate is how the user ends a preview, not a failure
				await running.catch(() => {});
				if (failure) throw failure;
				return;
			}
			case 'verify':
				// both ways of bringing the duplicate up run the check themselves and return
				break;
		}
	}
	finish(null);
}

function reportFindings(ctx: Context, findings: readonly Finding[]): void {
	for (const f of findings) {
		ctx.io.out(`${f.severity.toUpperCase()} ${f.id}: ${f.title}`);
		ctx.io.out(`  ${f.detail}`);
	}
}

/**
 * The question each step waits on.
 *
 * Returns the per-step asker. With `--full` the one typed confirmation happens here and every later
 * step proceeds; without it each step asks. Either way, no terminal is a refusal.
 */
async function interaction(
	ctx: Context,
	opts: PreviewOptions,
	target: SshTarget
): Promise<(title: string) => Promise<boolean>> {
	const noTerminal = () =>
		new UsageError(
			'preview asks before it runs, and there is no terminal to ask on',
			'run it from a terminal; --dry-run prints every step without running any'
		);
	if (opts.confirm !== undefined) {
		if (opts.confirm !== target.host) {
			throw new UsageError(
				`--confirm ${opts.confirm} does not name ${target.host}; nothing ran`
			);
		}
		return async () => true;
	}
	if (opts.full === true) {
		const typed = await ctx.ask(`Type ${target.host} to run every step against it:`);
		if (typed === null) throw noTerminal();
		if (typed.trim() !== target.host) {
			throw new UsageError(`that was not ${target.host}; nothing ran`);
		}
		return async () => true;
	}
	return async (title) => {
		const answer = await ctx.ask(`${title}? [y/n]`, ['y', 'n']);
		if (answer === null) throw noTerminal();
		return answer === 'y';
	};
}

/**
 * The first wrangler release whose `dev` survives a request that arrives while the site boots its
 * second interpreter.
 *
 * Measured by bisecting 4.127.1 to 4.151.0 on a 98 MB database: 4.129.0 ends with an empty error and
 * "Network connection lost", 4.129.1 serves the same request. Its changelog names the cause (a
 * request arriving as an idle internal connection closes took the dev server down, workers-sdk
 * #15252). The same bundle driven through Miniflare directly never failed, so the worker is not at
 * fault.
 */
export const WRANGLER_DEV_FIXED = '4.129.1';

/**
 * Starts `wrangler dev` and waits until the site answers twice in a row, starting it again when it
 * ends first.
 *
 * A fresh object replays the whole database on its first boot, and the alarm then boots a second
 * interpreter for a few seconds. On a wrangler older than {@link WRANGLER_DEV_FIXED} a request that
 * lands in that window ends `wrangler dev`. The replay resumes, and a clean workspace took three
 * boots to stay up. Only wrangler's own non-zero exit is retried; a refusal from the workspace gate
 * would fail the same way again. Returns the run that stayed up.
 */
export async function bootDuplicate(
	ctx: Context,
	origin: string,
	start: () => Promise<void>,
	pollMs = UP_POLL_MS
): Promise<{ running: Promise<void> }> {
	let running = start();
	for (let boots = 1; ; boots++) {
		const end: { done: boolean; error: unknown } = { done: false, error: undefined };
		const ended = running.then(
			() => {
				end.done = true;
			},
			(e: unknown) => {
				end.done = true;
				end.error = e;
			}
		);
		const ready = await Promise.race([
			waitForSite(ctx, origin, undefined, { confirm: 2, giveUp: () => end.done, pollMs }),
			ended.then(() => false)
		]);
		if (ready) return { running };
		const error = end.error;
		if (!(error instanceof DranglerError && error.code === 'wrangler' && boots < DEV_BOOTS)) {
			if (error instanceof Error) throw error;
			throw new DranglerError('up', `${origin} did not answer 200 within the limit`);
		}
		ctx.io.err(
			`${error.message} during the first boot; starting it again, the database replay resumes (boot ${boots + 1} of ${DEV_BOOTS}). wrangler before ${WRANGLER_DEV_FIXED} ends when a request arrives while the site is still booting`
		);
		running = start();
	}
}

async function waitForSite(
	ctx: Context,
	origin: string,
	headers?: Record<string, string>,
	opts: { confirm?: number; giveUp?: () => boolean; pollMs?: number } = {}
): Promise<boolean> {
	const until = ctx.now().getTime() + UP_TIMEOUT_MS;
	const need = opts.confirm ?? 1;
	let streak = 0;
	while (ctx.now().getTime() < until && opts.giveUp?.() !== true) {
		try {
			const res = await ctx.fetch(new URL('/', origin).toString(), {
				redirect: 'manual',
				...(headers === undefined ? {} : { headers })
			});
			streak = res.status === 200 ? streak + 1 : 0;
			if (streak >= need) return true;
		} catch {
			streak = 0;
		}
		await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? UP_POLL_MS));
	}
	return false;
}

/**
 * Compares the duplicate against the source.
 *
 * Counts come from the database that shipped, against the survey; pages and a public file come
 * from the running duplicate. A mismatch is reported in full before it fails the run.
 */
export interface VerifyOptions {
	/** the live site; each checked page must then match its status and, for JSON, its key set */
	sourceUrl?: string | undefined;
	/** the site directory the first public file is served under */
	siteDir?: string | undefined;
	/** paths checked beside `/` and the login page */
	paths?: readonly string[] | undefined;
	/** sent to the duplicate only, such as an Access service token */
	headers?: Record<string, string> | undefined;
}

export async function verify(
	ctx: Context,
	origin: string,
	survey: SiteSurvey,
	db: SiteDbReport,
	files: readonly string[],
	options: string | VerifyOptions | undefined = undefined
): Promise<{ summary: string; failed: FindingError | null }> {
	const opts: VerifyOptions =
		typeof options === 'string' ? { sourceUrl: options } : (options ?? {});
	const sourceUrl = opts.sourceUrl;
	const checks: [string, string, boolean][] = [];
	if (survey.nodes !== null) {
		checks.push(['nodes', `${db.nodes ?? '?'} of ${survey.nodes}`, db.nodes === survey.nodes]);
	}
	if (survey.fileRows !== null) {
		checks.push([
			'file rows',
			`${db.fileRows ?? '?'} of ${survey.fileRows}`,
			db.fileRows === survey.fileRows
		]);
	}
	const paths = [
		...new Set([
			'/',
			'/user/login',
			...(sourceUrl === undefined ? [] : ['/node/1']),
			...(files[0] === undefined
				? []
				: [`/sites/${opts.siteDir ?? 'default'}/files/${files[0]}`]),
			...(opts.paths ?? [])
		])
	];
	const fetchPage = async (
		base: string,
		path: string,
		headers?: Record<string, string>
	): Promise<{ status: number; keys: string | null; gated: boolean }> => {
		try {
			const res = await ctx.fetch(new URL(path, base).toString(), {
				redirect: 'manual',
				...(headers === undefined ? {} : { headers })
			});
			const gated =
				(res.headers.get('www-authenticate') ?? '').startsWith('Cloudflare-Access') ||
				/^https:\/\/[^/]*\.cloudflareaccess\.com\//.test(res.headers.get('location') ?? '');
			let keys: string | null = null;
			if ((res.headers.get('content-type') ?? '').includes('json')) {
				try {
					const body: unknown = await res.json();
					keys =
						body !== null && typeof body === 'object' && !Array.isArray(body)
							? Object.keys(body).sort().join(',')
							: Array.isArray(body)
								? 'array'
								: typeof body;
				} catch {
					keys = 'unparsable';
				}
			}
			return { status: res.status, keys, gated };
		} catch {
			return { status: 0, keys: null, gated: false };
		}
	};
	const notCompared: string[] = [];
	for (const path of paths) {
		const got = await fetchPage(origin, path, opts.headers);
		// with a source to compare against, a page the source itself fails is a match, not a fault
		const want = sourceUrl === undefined ? null : await fetchPage(sourceUrl, path);
		if (want?.gated === true) {
			// the edge answers for the source here, so its status says nothing about Drupal
			notCompared.push(path);
			ctx.io.err(
				`${path}  not compared: the source is behind Cloudflare Access on this path`
			);
			continue;
		}
		const wantStatus = want === null ? 200 : want.status;
		checks.push([
			path,
			`${got.status || 'no answer'}${want === null ? '' : ` (source ${want.status || 'no answer'})`}`,
			got.status !== 0 && got.status === wantStatus
		]);
		if (want !== null && want.keys !== null && got.keys !== null) {
			checks.push([
				`${path} keys`,
				got.keys === want.keys ? 'same' : `${got.keys} (source ${want.keys})`,
				got.keys === want.keys
			]);
		}
	}
	const bad = checks.filter(([, , ok]) => !ok);
	for (const line of kv(checks.map(([name, got, ok]) => [name, ok ? got : `${got}  MISMATCH`]))) {
		ctx.io.err(line);
	}
	return {
		summary:
			`${checks.length - bad.length} of ${checks.length} checks passed` +
			(notCompared.length === 0
				? ''
				: `, ${notCompared.length} not compared (${notCompared.join(', ')} sit behind Cloudflare Access on the source)`),
		failed:
			bad.length === 0
				? null
				: new FindingError(
						'mismatch',
						`${bad.map(([n]) => n).join(', ')} did not match the source`
					)
	};
}

/**
 * Copies the carried root files into the workspace's assets and un-ignores each one.
 *
 * The worker's `.assetsignore` denies by default, so a file copied there without its line is
 * built and then served by nobody.
 */
export function publishRootFiles(
	ctx: Context,
	from: string,
	workspace: string,
	names: readonly string[],
	wellKnown: boolean
): void {
	const assets = join(workspace, 'assets');
	const ignore = join(assets, '.assetsignore');
	const lines = ctx.files.exists(ignore) ? ctx.files.readText(ignore).split('\n') : ['/*'];
	const copy = (rel: string) => {
		ctx.files.writeBytes(join(assets, rel), ctx.files.readBytes(join(from, rel)));
	};
	for (const name of names) {
		copy(name);
		if (!lines.includes(`!/${name}`)) lines.push(`!/${name}`);
	}
	if (wellKnown) {
		const walk = (rel: string) => {
			for (const entry of ctx.files.readDir(join(from, rel))) {
				const next = `${rel}/${entry.name}`;
				if (entry.directory) walk(next);
				else copy(next);
			}
		};
		walk('.well-known');
		if (!lines.includes('!/.well-known/')) lines.push('!/.well-known/');
	}
	if (names.length > 0 || wellKnown) {
		ctx.files.writeText(ignore, `${lines.join('\n').trimEnd()}\n`);
	}
}

/** the first worker release a migrated duplicate runs correctly on */
export const PREVIEW_MIN_WORKER = '1.0.4';

/** refuses a checkout older than preview needs; one with no version to read is let through */
export function refuseOldWorker(ctx: Context, workspace: string): void {
	const manifest = join(workspace, 'package.json');
	if (!ctx.files.exists(manifest)) return;
	const version = (JSON.parse(ctx.files.readText(manifest)) as { version?: unknown }).version;
	if (
		typeof version === 'string' &&
		version.localeCompare(PREVIEW_MIN_WORKER, undefined, { numeric: true }) < 0
	) {
		throw new UsageError(
			`the workspace worker is ${version}; preview needs ${PREVIEW_MIN_WORKER} or later, which claims a migrated site, reads DRUPAL_CONFIG, applies REDIRECTS and RESPONSE_HEADERS and hands request headers to Drupal. Move it with: drangler update --to v${PREVIEW_MIN_WORKER}`
		);
	}
}

/** the asset layer answers static files before the worker runs, so it needs the headers as `_headers` */
export function publishAssetHeaders(ctx: Context, workspace: string, text: string): void {
	const assets = join(workspace, 'assets');
	const ignore = join(assets, '.assetsignore');
	ctx.files.writeText(join(assets, '_headers'), text);
	const lines = ctx.files.exists(ignore) ? ctx.files.readText(ignore).split('\n') : ['/*'];
	if (!lines.includes('!/_headers')) {
		lines.push('!/_headers');
		ctx.files.writeText(ignore, `${lines.join('\n').trimEnd()}\n`);
	}
}

/** how many update beats a duplicate may take before the run reports it rather than waiting */
export const PREVIEW_UPDB_BEATS = 500;

/**
 * Claims the duplicate the migrated way and runs its database updates.
 *
 * A normal claim rewrites uid 1, which on a migrated site is the real administrator, so the claim
 * asks the worker to mint the owner token and change nothing else. A worker too old to offer that
 * refuses, and the run says the updates were not run instead of failing.
 */
export async function ownDuplicate(
	ctx: Context,
	origin: string,
	out: string,
	opts: Pick<PreviewOptions, 'globals'>,
	headers?: Record<string, string>
): Promise<string> {
	return (await claimDuplicate(ctx, origin, out, opts, headers)).summary;
}

/** the claim, with the owner target it minted so a later step can act as the owner */
export async function claimDuplicate(
	ctx: Context,
	origin: string,
	out: string,
	opts: Pick<PreviewOptions, 'globals'>,
	headers?: Record<string, string>
): Promise<{ summary: string; owner: OwnerTarget | null }> {
	const anonymous: OwnerTarget = {
		origin,
		site: null,
		token: '',
		timeoutMs: opts.globals.timeoutMs,
		...(headers === undefined ? {} : { headers })
	};
	const claim = await ownerCall(ctx, anonymous, '/firstrun', {
		method: 'POST',
		body: { migrated: true }
	});
	const token = claim.body['ownerToken'];
	if (claim.body['ok'] !== true || typeof token !== 'string') {
		return {
			summary:
				'not claimed: this worker has no migrated claim, so database updates were not run',
			owner: null
		};
	}
	ctx.files.writeSecret(join(out, 'owner-token'), `${token}\n`);
	const owner: OwnerTarget = { ...anonymous, token };
	const report = await driveUpdb(ctx, owner, PREVIEW_UPDB_BEATS);
	const phase = report.phase ?? 'none needed';
	if (report.phase === 'halted') {
		throw new FindingError('updb-halted', report.haltReason ?? 'the update chain halted');
	}
	return {
		summary: `claimed (token in owner-token); updates ${phase} after ${report.beats} beat(s)`,
		owner
	};
}
