import { resolveAuth } from '../cloudflare/auth';
import {
	globalConfigPath,
	PROJECT_CONFIG_NAME,
	siteOrigin,
	type DranglerConfig,
	type ResolvedConfig
} from '../config/file';
import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { UsageError } from '../errors';
import { emit, kv } from '../format';
import { probeClaim, probeSite, type ClaimState } from '../health/probe';
import { VERSION } from '../version';

/** what the caller came here to do; it decides which of the later questions are asked at all */
export type InitIntent = 'local' | 'deploy' | 'connect' | 'module';

export const INTENTS: readonly InitIntent[] = ['local', 'deploy', 'connect', 'module'];

const INTENT_HELP: Record<InitIntent, string> = {
	local: 'run a site locally, from nothing',
	deploy: 'deploy a new site to your own Cloudflare account',
	connect: 'connect to a site that already exists',
	module: 'develop a module against a site'
};

/** where the answers land */
export type InitWrite = 'project' | 'global' | 'none';

export const WRITE_TARGETS: readonly InitWrite[] = ['project', 'global', 'none'];

export interface InitOptions {
	intent?: string;
	write?: string;
	globals: GlobalOptions;
}

export interface InitReport {
	intent: InitIntent;
	site: string | null;
	siteName: string;
	/** the probe's verdict on the origin, when one was given */
	reachable: boolean | null;
	drupflare: boolean | null;
	tier: string | null;
	claimed: ClaimState | null;
	account: string | null;
	/** whether an owner token was resolved; the token itself is never reported */
	token: boolean;
	write: InitWrite;
	wrote: string[];
	next: string[];
}

/**
 * The six lines `drangler` prints with no arguments.
 *
 * Commander's default help lists every command to somebody who has not decided anything yet. This
 * says what is configured and names the three commands worth typing next.
 */
export function orientation(config: ResolvedConfig): string[] {
	const configured =
		config.site.value === null
			? 'Nothing is configured yet.'
			: `Configured for ${config.site.value}, from ${config.site.from}.`;
	return [
		`drangler ${VERSION}`,
		'',
		configured,
		'',
		'  drangler dev              a local Drupal, from nothing',
		'  drangler init             connect to a site you already have',
		'  drangler --help           every command',
		'',
		'Docs: https://github.com/drupflare/drangler'
	];
}

/** asks, or refuses by naming the flag that answers it without a terminal */
async function answer(
	ctx: Context,
	question: string,
	choices: readonly string[],
	flag: string
): Promise<string> {
	const given = await ctx.ask(question, choices);
	if (given === null) {
		throw new UsageError(
			`${question} There is no terminal to ask on, so pass ${flag} (${choices.join(', ')})`
		);
	}
	return given;
}

/**
 * Connects a machine to a site, and writes down where the answers went.
 *
 * At most five questions and every one changes what gets written, which is the bar a wizard has to
 * clear to be worth more than a flag. The first answer decides which of the rest are asked: running
 * locally needs no origin, no token and no account.
 *
 * **The owner token never goes in `drangler.json`.** That file is committed; the token lands in the
 * global config through the restricted-write seam. `init` says where each one went rather than
 * leaving the user to assume.
 */
export async function runInit(ctx: Context, opts: InitOptions): Promise<void> {
	const { globals } = opts;
	const intent = (
		opts.intent ??
		(await answer(
			ctx,
			`What are you doing here? ${INTENTS.map((i) => `${i} = ${INTENT_HELP[i]}`).join('; ')}.`,
			INTENTS,
			'--intent'
		))
	).toLowerCase();
	if (!INTENTS.includes(intent as InitIntent)) {
		throw new UsageError(`--intent must be one of ${INTENTS.join(', ')}, not \`${intent}\``);
	}

	const report: InitReport = {
		intent: intent as InitIntent,
		site: null,
		siteName: globals.config.siteName.value ?? 'site',
		reachable: null,
		drupflare: null,
		tier: null,
		claimed: null,
		account: null,
		token: false,
		write: 'none',
		wrote: [],
		next: []
	};

	if (report.intent !== 'local') {
		report.site =
			globals.config.site.value ??
			siteOrigin(await answer(ctx, 'Site origin?', [], '--site'), '--site');
		await inspectSite(ctx, report, globals);
	}

	if (report.intent === 'deploy') report.account = await resolveAccount(ctx, globals);

	const write = (
		opts.write ??
		(globals.yes
			? 'project'
			: await answer(
					ctx,
					'Write the config where? project = ./drangler.json; global = your home config; none = print the flags instead.',
					WRITE_TARGETS,
					'--write'
				))
	).toLowerCase();
	if (!WRITE_TARGETS.includes(write as InitWrite)) {
		throw new UsageError(
			`--write must be one of ${WRITE_TARGETS.join(', ')}, not \`${write}\``
		);
	}
	report.write = write as InitWrite;
	writeAnswers(ctx, report, globals);
	buildNext(report);

	emit(ctx.io, globals.json, report, () => render(report));
}

/** one public request, reported rather than judged: is it drupflare, is it claimed, what answered */
async function inspectSite(
	ctx: Context,
	report: InitReport,
	globals: GlobalOptions
): Promise<void> {
	const target = report.site as string;
	try {
		const probe = await probeSite(
			{ fetch: ctx.fetch },
			{
				target,
				site: report.siteName,
				kind: 'worker',
				skipEdge: true,
				timeoutMs: globals.timeoutMs
			}
		);
		report.reachable = probe.status !== null;
		report.drupflare = probe.verdict !== 'not-drupflare';
		report.tier = probe.tier;
	} catch {
		// an unreachable origin is a thing to report, never a reason to abandon the answers so far
		report.reachable = false;
		report.drupflare = false;
	}
	if (report.drupflare !== true) return;

	const claim = await probeClaim(
		{ fetch: ctx.fetch },
		target,
		report.siteName,
		globals.timeoutMs
	);
	report.claimed = claim.state;
	// asking for a token nobody has minted yet wastes the one question that matters most
	report.token = claim.state === 'claimed' && globals.config.token.value !== null;
}

/** the account from `wrangler whoami`; asked only when it resolves more than one */
async function resolveAccount(ctx: Context, globals: GlobalOptions): Promise<string | null> {
	if (globals.config.account.value !== null) return globals.config.account.value;
	const auth = await resolveAuth(ctx.runner, ctx.env);
	if (auth.accounts.length === 1) return auth.accounts[0]?.id ?? null;
	if (auth.accounts.length === 0) return null;
	return await answer(
		ctx,
		`Which Cloudflare account? ${auth.accounts.map((a) => `${a.id} = ${a.name}`).join('; ')}.`,
		auth.accounts.map((a) => a.id),
		'--account'
	);
}

function writeAnswers(ctx: Context, report: InitReport, globals: GlobalOptions): void {
	if (report.write === 'none') return;

	if (report.write === 'project') {
		const path = `${ctx.cwd.replace(/\/+$/, '')}/${PROJECT_CONFIG_NAME}`;
		const project: DranglerConfig = {
			...(report.site === null
				? {}
				: { site: { origin: report.site, name: report.siteName } }),
			...(globals.config.workspace.value === null
				? {}
				: { workspace: globals.config.workspace.value })
		};
		ctx.files.writeText(path, `${JSON.stringify(project, null, '\t')}\n`);
		report.wrote.push(path);
	}

	const token = globals.config.token.value;
	const needsGlobal = report.write === 'global' || (token !== null && report.site !== null);
	if (!needsGlobal) return;

	const path = globalConfigPath(ctx.env);
	const existing = readGlobal(ctx, path);
	const merged: DranglerConfig = {
		...existing,
		...(report.write === 'global' && report.site !== null
			? { site: { origin: report.site, name: report.siteName } }
			: {}),
		...(report.account === null ? {} : { account: report.account }),
		...(token === null || report.site === null
			? {}
			: { sites: { ...existing.sites, [report.site]: { ownerToken: token } } })
	};
	ctx.files.writeSecret(path, `${JSON.stringify(merged, null, '\t')}\n`);
	report.wrote.push(path);
}

function readGlobal(ctx: Context, path: string): DranglerConfig {
	if (!ctx.files.exists(path)) return {};
	try {
		return JSON.parse(ctx.files.readText(path)) as DranglerConfig;
	} catch (e) {
		throw new UsageError(
			`${path} is not valid JSON and init will not overwrite it: ${e instanceof Error ? e.message : String(e)}`
		);
	}
}

function buildNext(report: InitReport): void {
	if (report.intent === 'local') {
		report.next.push('drangler dev');
		return;
	}
	if (report.reachable === false) {
		report.next.push(`drangler status ${report.site ?? ''}`.trim());
		return;
	}
	if (report.claimed === 'unclaimed') {
		report.next.push(
			`POST /firstrun on ${report.site} with a JSON body carrying adminPass and siteName, and keep the ownerToken it returns once`
		);
	}
	if (report.intent === 'deploy') report.next.push('drangler deploy');
	if (report.intent === 'module') report.next.push('drangler dev');
	report.next.push(`drangler status ${report.site ?? ''}`.trim());
}

function render(report: InitReport): string[] {
	const rows: [string, string][] = [['doing', `${report.intent}: ${INTENT_HELP[report.intent]}`]];
	if (report.site !== null) {
		rows.push(
			['site', report.site],
			['site name', report.siteName],
			[
				'answered',
				report.reachable === false
					? 'no'
					: report.drupflare === false
						? 'yes, but no x-cfw-* headers; this is not a drupflare worker'
						: `yes, from the ${report.tier ?? 'object'} tier`
			],
			['claimed', report.claimed ?? '-'],
			['owner token', report.token ? 'set' : 'not set']
		);
	}
	if (report.account !== null) rows.push(['cloudflare account', report.account]);

	const lines = kv(rows);
	lines.push('', 'wrote');
	if (report.wrote.length === 0) {
		lines.push('  nothing; pass --write project or --write global to keep these answers');
	} else {
		for (const path of report.wrote) {
			lines.push(`  ${path}${path.endsWith('config.json') ? ' (mode 0600)' : ''}`);
		}
	}
	if (report.next.length > 0) {
		lines.push('', 'next');
		for (const step of report.next) lines.push(`  ${step}`);
	}
	return lines;
}
