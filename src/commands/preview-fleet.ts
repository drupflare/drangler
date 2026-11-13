import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Context } from '../context';
import { DranglerError, FindingError, UsageError } from '../errors';
import { emit, table } from '../format';
import {
	discoverLayout,
	discoverSites,
	type SiteGroup,
	type SourceLayout
} from '../migrate/discover';
import { readOnlyTransport, settingsCommands } from '../migrate/preview';
import { readSourceIdentity } from '../migrate/read-identity';
import {
	assertUniqueDestinations,
	destinationKey,
	workerName,
	type DestinationKey
} from '../migrate/source-identity';
import { parseTarget } from '../migrate/target';
import { sshTransport } from '../migrate/transport';
import { isWorkerCheckout } from '../workspace/layout';
import { interaction, previewEnv, runPreviewCommand, type PreviewOptions } from './preview';
import { readReceipt } from './preview-receipt';
import { DEV_PORT, runBuildCommand } from './workspace';

export type ActionState = 'pending' | 'running' | 'unknown' | 'failed' | 'done';

export interface FleetSite {
	siteDir: string;
	host: string | null;
	aliases: string[];
	/** the short id a single-site run of this site names its folder with */
	id: string;
	uuid: string;
	/** the full source digest, which the duplicate's receipt must carry */
	digest: string;
	worker: string;
}

export interface FleetPlan {
	version: 1;
	host: string;
	docroot: string;
	sites: FleetSite[];
}

export interface FleetAction {
	state: ActionState;
	attempts: number;
	/** the folder of the latest attempt */
	out: string | null;
	error: string | null;
}

export interface FleetState {
	version: 1;
	/** the digest of the plan this state belongs to; a different plan is a different fleet */
	planDigest: string;
	plan: FleetPlan;
	/** raised by every run that takes the state, so a stale run cannot overwrite a newer one */
	epoch: number;
	actions: Record<string, FleetAction>;
}

export const FLEET_FILE = 'fleet.json';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** the plan's digest, over its content only, so it is the same on every run against the same host */
export function planDigest(plan: FleetPlan): string {
	return sha(JSON.stringify(plan));
}

/** the action's name: the worker label, which is unique per source site */
export const actionKey = (site: FleetSite): string => site.worker;

/**
 * Reads what a fleet is on the host: the docroot, every site under it, and each site's identity.
 *
 * A host name that sites.php maps to a site already in the list is an alias of it, so two names for
 * one site make one action. Two sites that resolve to one destination are refused.
 */
export async function planFleet(
	ctx: Context,
	opts: PreviewOptions
): Promise<{ plan: FleetPlan; layouts: Map<string, SourceLayout> }> {
	const target = parseTarget(opts.host, opts.root ?? '/', opts.identity);
	const transport = readOnlyTransport(opts.transport ?? sshTransport(ctx.runner, target));
	const base = await discoverLayout(transport, { root: opts.root, host: opts.host });
	const groups: SiteGroup[] = await discoverSites(transport, base.docroot);
	if (groups.length === 0) {
		throw new FindingError(
			'no-sites',
			`${base.docroot} on ${opts.host} holds no site with a readable settings.php`
		);
	}
	const sites: FleetSite[] = [];
	const layouts = new Map<string, SourceLayout>();
	const keys: DestinationKey[] = [];
	for (const group of groups) {
		// the same discovery a single-site run does, so both name the site by the same uri
		const layout = await discoverLayout(
			transport,
			group.host === null
				? { root: base.docroot, host: opts.host }
				: { root: opts.root, host: opts.host, site: group.host }
		);
		const settings = (await transport.exec(settingsCommands(base.docroot, group.siteDir)[0]!))
			.stdout;
		const identity = await readSourceIdentity(transport, {
			host: opts.host,
			docroot: layout.docroot,
			siteDir: group.siteDir,
			uri: layout.uri,
			driver: null,
			drush: drushPrefixOf(layout),
			settings,
			aliases: group.aliases
		});
		const key = destinationKey({
			organisation: 'local',
			plane: 'preview',
			account: 'local',
			source: identity.id,
			environment: 'preview'
		});
		keys.push(key);
		const site: FleetSite = {
			siteDir: group.siteDir,
			host: group.host,
			aliases: group.aliases,
			id: layout.id,
			uuid: identity.input.siteUuid,
			digest: identity.digest,
			worker: workerName('drupflare-preview', key)
		};
		sites.push(site);
		layouts.set(actionKey(site), layout);
	}
	assertUniqueDestinations(keys);
	return { plan: { version: 1, host: opts.host, docroot: base.docroot, sites }, layouts };
}

function drushPrefixOf(layout: SourceLayout): string {
	return layout.drush === null
		? `cd ${layout.docroot} && drush`
		: `${layout.drush.user === null ? '' : `runuser -u ${layout.drush.user} -- `}${layout.drush.bin} --root=${layout.docroot}${layout.uri === null ? '' : ` --uri=${layout.uri}`}`;
}

export function readFleet(ctx: Context, base: string): FleetState | null {
	const path = join(base, FLEET_FILE);
	if (!ctx.files.exists(path)) return null;
	const state = JSON.parse(ctx.files.readText(path)) as FleetState;
	if (state.version !== 1 || typeof state.epoch !== 'number' || state.actions === undefined) {
		throw new UsageError(`${path} is not a fleet state this drangler reads`);
	}
	return state;
}

/**
 * Writes the state, unless a newer run has taken it.
 *
 * Each run raises the epoch when it starts, and every write by an older one is refused, so a run
 * that was only slow cannot put back an action a later run has already finished.
 */
export function saveFleet(ctx: Context, base: string, state: FleetState): void {
	const stored = readFleet(ctx, base);
	if (stored !== null && stored.epoch > state.epoch) {
		throw new FindingError(
			'fenced',
			`another run took ${join(base, FLEET_FILE)} at epoch ${stored.epoch}; this run is at ${state.epoch} and stops`
		);
	}
	ctx.files.writeText(join(base, FLEET_FILE), `${JSON.stringify(state, null, '\t')}\n`);
}

/** top-level entries a cloned workspace leaves behind: dev state, and secrets from the last run */
const NOT_CLONED = new Set(['.wrangler', '.dev.vars']);

/**
 * Gives a site its own copy of a hydrated worker checkout.
 *
 * Each duplicate writes its own database, secrets and wrangler state into its workspace, so sites
 * cannot share one. Copy-on-write where the filesystem has it, so a second copy of a few gigabytes
 * costs seconds.
 */
export async function cloneWorkspace(ctx: Context, from: string, to: string): Promise<void> {
	const flags =
		process.platform === 'darwin'
			? ['-cR']
			: process.platform === 'linux'
				? ['-R', '--reflink=auto']
				: ['-R'];
	ctx.files.writeText(join(to, '.keep'), '');
	for (const entry of ctx.files.readDir(from)) {
		if (NOT_CLONED.has(entry.name)) continue;
		const done = await ctx.runner.run('cp', [
			...flags,
			join(from, entry.name),
			join(to, entry.name)
		]);
		if (done.code !== 0) {
			throw new DranglerError(
				'workspace',
				`copying ${entry.name} into ${to} exited ${done.code}: ${done.stderr.trim()}`
			);
		}
	}
}

export interface FleetOptions extends PreviewOptions {
	/** a hydrated worker checkout each site's workspace is copied from, instead of building one */
	workspaceFrom?: string | undefined;
	/** @internal the one-site preview, for a spec */
	runSite?: typeof runPreviewCommand;
}

/**
 * Previews every site a docroot serves, one duplicate per site, and finishes only when each one is
 * observed verified.
 *
 * The plan is the sites and their identities, fixed by its digest. Each site is an action that is
 * `pending`, `running`, `done`, `failed` or `unknown`; a run that was killed leaves `running`, which
 * the next run reads as unknown and repeats in a new attempt folder. A failed site never stops the
 * others, and stays retryable: the same command again picks up every action that is not done. A
 * `done` action is believed only when its receipt, read back from disk, says `verified` for the
 * same source digest.
 */
export async function runFleetCommand(ctx: Context, given: FleetOptions): Promise<void> {
	const opts: FleetOptions = {
		...previewEnv(given, ctx.env),
		workspaceFrom: given.workspaceFrom
	};
	if (opts.login === undefined) {
		throw new UsageError(
			'--all-sites verifies every site by workflow and needs --login <user>',
			'drangler preview --host <target> --all-sites --login admin   (password in DRANGLER_PREVIEW_PASSWORD)'
		);
	}
	if (
		ctx.env['DRANGLER_PREVIEW_PASSWORD'] === undefined ||
		ctx.env['DRANGLER_PREVIEW_PASSWORD'] === ''
	) {
		throw new UsageError('--login needs its password in DRANGLER_PREVIEW_PASSWORD');
	}
	if (opts.deploy === true) {
		throw new UsageError(
			'--all-sites runs local duplicates; --deploy is for one site at a time'
		);
	}
	const target = parseTarget(opts.host, opts.root ?? '/', opts.identity);
	const base = opts.out ?? join(ctx.cwd, '.drangler', 'preview', `${target.host}-fleet`);
	const json = opts.globals.json;
	if (opts.globals.dryRun) {
		emit(ctx.io, json, { target, base, steps: FLEET_STEPS }, () => [
			`dry run against ${opts.host}; nothing was executed`,
			'',
			...FLEET_STEPS.map((s, i) => `${i + 1}. ${s}`),
			'',
			`state and duplicates land in ${base}`
		]);
		return;
	}
	const ask = await interaction(ctx, opts, target);
	if (!(await ask('Preview every site on the host'))) return;

	const { plan } = await planFleet(ctx, opts);
	const digest = planDigest(plan);
	const stored = readFleet(ctx, base);
	if (stored !== null && stored.planDigest !== digest) {
		const was = stored.plan.sites.map((s) => `${s.siteDir}:${s.uuid}`).sort();
		const now = plan.sites.map((s) => `${s.siteDir}:${s.uuid}`).sort();
		throw new FindingError(
			'plan-changed',
			`${join(base, FLEET_FILE)} belongs to a different set of sites (was ${was.join(', ')}; now ${now.join(', ')}); nothing was changed`,
			`drangler preview --host ${opts.host} --all-sites --out <a folder that does not exist yet>`
		);
	}
	const state: FleetState = {
		version: 1,
		planDigest: digest,
		plan,
		epoch: (stored?.epoch ?? 0) + 1,
		actions: stored?.actions ?? {}
	};
	for (const site of plan.sites) {
		const have = state.actions[actionKey(site)];
		state.actions[actionKey(site)] =
			have === undefined
				? { state: 'pending', attempts: 0, out: null, error: null }
				: // a run that was killed left its action running, and nobody observed how it ended
					have.state === 'running'
					? { ...have, state: 'unknown' }
					: have;
	}
	saveFleet(ctx, base, state);

	const baseWorkspace = opts.workspaceFrom ?? join(base, 'worker-base');
	if (!isWorkerCheckout(ctx.files, baseWorkspace)) {
		await runBuildCommand(ctx, {
			workspace: baseWorkspace,
			globals: opts.globals,
			...(typeof opts.edge === 'string' ? { edge: opts.edge } : {})
		});
	}

	const runSite = opts.runSite ?? runPreviewCommand;
	const basePort = opts.port === undefined ? DEV_PORT : Number(opts.port);
	const rows: string[][] = [];
	for (const [index, site] of plan.sites.entries()) {
		const key = actionKey(site);
		const action = state.actions[key]!;
		const observed = action.out === null ? null : readReceipt(ctx, action.out);
		if (
			action.state === 'done' &&
			observed?.state === 'verified' &&
			observed.source === site.digest &&
			observed.expiresAt > ctx.now().getTime()
		) {
			rows.push([
				site.siteDir,
				'done',
				`already verified at ${observed.origin}; not repeated`
			]);
			continue;
		}
		const attempt = action.attempts + 1;
		const out = join(base, `${target.host}-${site.id}`, `attempt-${attempt}`);
		state.actions[key] = { state: 'running', attempts: attempt, out, error: null };
		saveFleet(ctx, base, state);
		try {
			ctx.files.writeText(join(out, '.keep'), '');
			const workspace = join(out, 'worker');
			await cloneWorkspace(ctx, baseWorkspace, workspace);
			await runSite(ctx, {
				...opts,
				root: site.host === null ? plan.docroot : opts.root,
				site: site.host ?? undefined,
				out,
				workspace,
				port: basePort + index,
				...(opts.sourceUrl === undefined
					? {}
					: { sourceUrl: opts.sourceUrl.replaceAll('{host}', site.host ?? '') }),
				expectUuid: site.uuid,
				epoch: state.epoch,
				confirm: target.host,
				full: false,
				stopAfterCheck: true
			});
			const receipt = readReceipt(ctx, out);
			if (receipt?.state !== 'verified' || receipt.source !== site.digest) {
				throw new FindingError(
					'unverified',
					`the run ended and ${join(out, 'receipt.json')} ${receipt === null ? 'does not exist' : `says ${receipt.state}`}`
				);
			}
			state.actions[key] = { state: 'done', attempts: attempt, out, error: null };
			rows.push([site.siteDir, 'done', `verified (attempt ${attempt}), ${out}`]);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			state.actions[key] = { state: 'failed', attempts: attempt, out, error: message };
			rows.push([site.siteDir, 'failed', message]);
			// a fenced run has lost the state to a newer one and must not go on
			if (e instanceof FindingError && e.code === 'fenced') throw e;
		}
		saveFleet(ctx, base, state);
	}
	const failed = plan.sites.filter((s) => state.actions[actionKey(s)]!.state !== 'done');
	emit(ctx.io, json, { base, epoch: state.epoch, plan, actions: state.actions }, () => [
		'',
		...table(['site', 'state', 'detail'], rows),
		'',
		...plan.sites
			.filter((s) => s.aliases.length > 0)
			.map(
				(s) =>
					`${s.siteDir} is also served as ${s.aliases.join(', ')}; the alias has no duplicate of its own`
			)
	]);
	if (failed.length > 0) {
		throw new FindingError(
			'fleet-incomplete',
			`${failed.length} of ${plan.sites.length} sites are not verified (${failed.map((s) => s.siteDir).join(', ')}); the same command again retries them and leaves the verified ones alone`,
			`drangler preview --host ${opts.host} --all-sites --out ${base}`
		);
	}
}

export const FLEET_STEPS = [
	'Find the docroot and every site under it, and group aliases with the site they map to',
	'Read each site identity: its UUID, database endpoint, schema and prefix',
	'Fix the plan by its digest, and refuse a state file written for another set of sites',
	'For each site that is not verified: clone a workspace, run the single-site preview, sign in and drive create, edit, upload twice and logout',
	'Finish when every site holds a verified receipt, and name the ones that do not'
] as const;
