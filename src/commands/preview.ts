import { join } from 'node:path';
import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { DranglerError, FindingError, UsageError } from '../errors';
import { emit, bytes as humanBytes, kv, table } from '../format';
import { convertDump } from '../migrate/convert';
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
import { SOURCE_FINDING_IDS, type Finding } from '../migrate/rules';
import { runSurvey, surveyPlan, type SiteSurvey } from '../migrate/survey';
import { parseTarget, type SshTarget } from '../migrate/target';
import { assumedTarget, statedTarget } from '../migrate/target-runtime';
import { sshTransport, type Transport } from '../migrate/transport';
import { ownerCall } from '../owner';
import { readState } from '../workspace/layout';
import { runInstallCommand } from './migrate';
import { driveUpdb } from './site';
import { DEV_PORT, runBuildCommand, runDeployCommand, runDevCommand } from './workspace';

export interface PreviewOptions {
	host: string;
	root: string;
	identity?: string;
	/** where the dump, the files and the preview's own worker checkout land */
	out?: string;
	/** every step after one typed confirmation */
	full?: boolean;
	/** deploy the duplicate as `drupflare-preview-<host>` instead of running it locally */
	deploy?: boolean;
	/** the deployed origin to verify; wrangler prints it and drangler cannot read it back */
	url?: string;
	/** the live source site; the check then compares each page's status against it */
	sourceUrl?: string;
	port?: string | number;
	targetPhp?: string;
	globals: GlobalOptions;
	/** @internal the ssh seam, for a spec */
	transport?: Transport;
}

export const PREVIEW_STEPS = [
	{ id: 'survey', title: 'Survey the Source' },
	{ id: 'plan', title: 'Score the Move' },
	{ id: 'dump', title: 'Stream the Database' },
	{ id: 'files', title: 'Stream the Public Files' },
	{ id: 'code', title: 'Stream the Modules, Themes and Libraries' },
	{ id: 'settings', title: 'Read Config Overrides and Root Files' },
	{ id: 'convert', title: 'Build the SQLite Database' },
	{ id: 'install', title: 'Install Into a Preview Workspace' },
	{ id: 'up', title: 'Bring Up the Duplicate' },
	{ id: 'verify', title: 'Check the Duplicate' }
] as const;

export type PreviewStepId = (typeof PREVIEW_STEPS)[number]['id'];

/** how long a fresh duplicate may take to replay its pack before the check gives up */
export const UP_TIMEOUT_MS = 15 * 60_000;
const UP_POLL_MS = 2_000;

/** A worker name that can only ever be a preview, so a deploy cannot land on a real site. */
export function previewName(host: string): string {
	const slug = host
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return `drupflare-preview-${slug}`.slice(0, 63).replace(/-+$/, '');
}

function localCommands(opts: PreviewOptions, out: string, workspace: string): string[] {
	return [
		`tar -xf ${join(out, 'files.tar')} -C ${out}`,
		...CODE_DIRS.map((d) => `tar -xf ${join(out, `${d}.tar`)} -C ${out}`),
		`drangler migrate install --db ${join(out, 'site.sqlite')} --repack --workspace ${workspace}`,
		opts.deploy === true
			? `bunx wrangler deploy --name ${previewName(parseTarget(opts.host, opts.root).host)}`
			: `bunx wrangler dev --port ${opts.port ?? DEV_PORT}`
	];
}

interface Done {
	step: PreviewStepId;
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
export async function runPreviewCommand(ctx: Context, opts: PreviewOptions): Promise<void> {
	const target = parseTarget(opts.host, opts.root, opts.identity);
	const out = opts.out ?? join(ctx.cwd, '.drangler', 'preview', target.host);
	const workspace = join(out, 'worker');
	const json = opts.globals.json;

	if (opts.globals.dryRun) {
		const report = {
			target,
			out,
			workspace,
			steps: PREVIEW_STEPS,
			remote: [
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
				...serverRulesCommands(target.root)
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

	for (const step of PREVIEW_STEPS) {
		if (!(await ask(step.title))) return finish(step.id);
		switch (step.id) {
			case 'survey': {
				survey = await runSurvey({ transport, now: ctx.now }, opts.host, target.root);
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
					dumpCommand(target.root, dialect),
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
				const got = await transport.download(filesCommand(target.root), tar);
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
				for (const command of settingsCommands(target.root)) {
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
				const carried = Object.keys(overrides.config).length;
				const settings = settingsReport(assignments);
				if (carried > 0) secrets['DRUPAL_CONFIG'] = JSON.stringify(overrides.config);
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
						`${carried} config override(s) carried as DRUPAL_CONFIG` +
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
					code.files
				);
				const dropped = converted.overLimit.map((o) => o.table);
				done.push({
					step: step.id,
					summary:
						`${db.tables} tables, ${db.filesStored} file(s) and ${db.codeFiles} code file(s) stored` +
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
				if (missing.length > 0) {
					ctx.files.writeText(
						join(out, 'composer-missing.txt'),
						missing
							.map((m) => `drangler modify require ${m.name} --version ${m.version}`)
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
					const name = previewName(target.host);
					await runDeployCommand(ctx, ['--name', name], {
						workspace,
						globals: opts.globals
					});
					if (Object.keys(secrets).length > 0) {
						const code = await ctx.runner.spawn(
							'bunx',
							[
								'wrangler',
								'secret',
								'bulk',
								join(out, 'secrets.json'),
								'--name',
								name
							],
							{ cwd: workspace }
						);
						if (code !== 0) {
							throw new DranglerError('up', `wrangler secret bulk exited ${code}`);
						}
					}
					done.push({ step: step.id, summary: `deployed as ${name}` });
					break;
				}
				const port = opts.port === undefined ? DEV_PORT : Number(opts.port);
				const origin = `http://localhost:${port}`;
				// wrangler dev does not return until it is stopped, so it runs beside the check
				const running = runDevCommand(ctx, [], { workspace, port, globals: opts.globals });
				const ready = await Promise.race([
					waitForSite(ctx, origin),
					running.then(() => false)
				]);
				if (!ready) {
					throw new DranglerError('up', `${origin} did not answer 200 within the limit`);
				}
				done.push({ step: step.id, summary: origin });
				done.push({ step: 'up', summary: await ownDuplicate(ctx, origin, out, opts) });
				const verified = await verify(ctx, origin, survey!, db!, fileList, opts.sourceUrl);
				done.push({ step: 'verify', summary: verified.summary });
				finish(null);
				ctx.io.err(`the duplicate is running at ${origin}; stop it with Ctrl-C`);
				// stopping the duplicate is how the user ends a preview, not a failure
				await running.catch(() => {});
				if (verified.failed) throw verified.failed;
				return;
			}
			case 'verify': {
				if (opts.url === undefined) {
					done.push({
						step: step.id,
						summary: 'not checked; pass --url with the origin wrangler printed'
					});
					break;
				}
				done.push({ step: 'up', summary: await ownDuplicate(ctx, opts.url, out, opts) });
				const verified = await verify(
					ctx,
					opts.url,
					survey!,
					db!,
					fileList,
					opts.sourceUrl
				);
				done.push({ step: step.id, summary: verified.summary });
				finish(null);
				if (verified.failed) throw verified.failed;
				return;
			}
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

async function waitForSite(ctx: Context, origin: string): Promise<boolean> {
	const until = ctx.now().getTime() + UP_TIMEOUT_MS;
	while (ctx.now().getTime() < until) {
		try {
			const res = await ctx.fetch(new URL('/', origin).toString(), { redirect: 'manual' });
			if (res.status === 200) return true;
		} catch {
			// not listening yet
		}
		await new Promise((resolve) => setTimeout(resolve, UP_POLL_MS));
	}
	return false;
}

/**
 * Compares the duplicate against the source.
 *
 * Counts come from the database that shipped, against the survey; pages and a public file come
 * from the running duplicate. A mismatch is reported in full before it fails the run.
 */
export async function verify(
	ctx: Context,
	origin: string,
	survey: SiteSurvey,
	db: SiteDbReport,
	files: readonly string[],
	sourceUrl?: string
): Promise<{ summary: string; failed: FindingError | null }> {
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
		'/',
		'/user/login',
		...(sourceUrl === undefined ? [] : ['/node/1']),
		...(files[0] === undefined ? [] : [`/sites/default/files/${files[0]}`])
	];
	const statusOf = async (base: string, path: string): Promise<number> => {
		try {
			return (await ctx.fetch(new URL(path, base).toString(), { redirect: 'manual' })).status;
		} catch {
			return 0;
		}
	};
	for (const path of paths) {
		const status = await statusOf(origin, path);
		// with a source to compare against, a page the source itself fails is a match, not a fault
		const want = sourceUrl === undefined ? 200 : await statusOf(sourceUrl, path);
		checks.push([
			path,
			`${status || 'no answer'}${sourceUrl === undefined ? '' : ` (source ${want || 'no answer'})`}`,
			status !== 0 && status === want
		]);
	}
	const bad = checks.filter(([, , ok]) => !ok);
	for (const line of kv(checks.map(([name, got, ok]) => [name, ok ? got : `${got}  MISMATCH`]))) {
		ctx.io.err(line);
	}
	return {
		summary: `${checks.length - bad.length} of ${checks.length} checks passed`,
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
export const PREVIEW_MIN_WORKER = '1.0.3';

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
			`the workspace worker is ${version}; preview needs ${PREVIEW_MIN_WORKER} or later, which claims a migrated site, reads DRUPAL_CONFIG and applies REDIRECTS and RESPONSE_HEADERS. Move it with: drangler update --to v${PREVIEW_MIN_WORKER}`
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
	opts: Pick<PreviewOptions, 'globals'>
): Promise<string> {
	const owner = { origin, site: null, token: '', timeoutMs: opts.globals.timeoutMs };
	const claim = await ownerCall(ctx, owner, '/firstrun', {
		method: 'POST',
		body: { migrated: true }
	});
	const token = claim.body['ownerToken'];
	if (claim.body['ok'] !== true || typeof token !== 'string') {
		return 'not claimed: this worker has no migrated claim, so database updates were not run';
	}
	ctx.files.writeSecret(join(out, 'owner-token'), `${token}\n`);
	const report = await driveUpdb(ctx, { ...owner, token }, PREVIEW_UPDB_BEATS);
	const phase = report.phase ?? 'none needed';
	if (report.phase === 'halted') {
		throw new FindingError('updb-halted', report.haltReason ?? 'the update chain halted');
	}
	return `claimed (token in owner-token); updates ${phase} after ${report.beats} beat(s)`;
}
