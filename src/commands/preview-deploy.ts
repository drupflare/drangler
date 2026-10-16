import { join } from 'node:path';
import { resolveAuth } from '../cloudflare/auth';
import { target as cloudflareTarget } from '../cloudflare/client';
import {
	createGuard,
	guardHeaders,
	waitGuarded,
	workerOrigin,
	workersSubdomain,
	type RawClient,
	type StoredGuard
} from '../cloudflare/guard';
import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { DranglerError, UsageError } from '../errors';
import { pause } from '../owner';
import { runDeployCommand } from './workspace';

export interface DeployInput {
	name: string;
	out: string;
	workspace: string;
	/** whether `secrets.json` holds anything to hand the deployed worker */
	hasSecrets: boolean;
	/** values the worker's own config declares as vars, which a secret of the same name would collide with */
	vars?: Record<string, string> | undefined;
	accessEmail?: string | undefined;
	globals: GlobalOptions;
	/** @internal the wrangler deploy, for a spec */
	deploy?: (args: string[]) => Promise<void>;
	/** @internal the wait between guard checks, for a spec */
	sleep?: (ms: number) => Promise<void>;
}

export interface Deployed {
	origin: string;
	/** sent on every request to the copy, in place of a login */
	headers: Record<string, string>;
	guard: StoredGuard;
}

/** who may open the copy: the flag, then the account wrangler is logged in as */
async function accessEmail(ctx: Context, given: string | undefined): Promise<string> {
	if (given !== undefined) return given;
	const auth = await resolveAuth(ctx.runner, {});
	if (auth.email === null) {
		throw new UsageError(
			'no email to let through Cloudflare Access, and wrangler is not logged in',
			'drangler preview --access-email you@example.com'
		);
	}
	return auth.email;
}

/**
 * Splits the values the duplicate needs into vars and secrets.
 *
 * A Worker cannot hold a var and a secret under one name (`Binding name 'PLAN' already in use`,
 * code 10053), and the workspace's `wrangler.jsonc` declares `PLAN` among its vars. Locally
 * `.dev.vars` overrides a var, so the whole set is written there; a deploy has to send the declared
 * names as `--var` and only the rest as secrets. Found 2026-10-16 when `secret bulk` refused the
 * file after the worker was already up.
 */
export function splitDeployValues(
	ctx: Context,
	workspace: string,
	values: Record<string, string>
): { vars: Record<string, string>; secrets: Record<string, string> } {
	const config = join(workspace, 'wrangler.jsonc');
	let declared: string[] = [];
	if (ctx.files.exists(config)) {
		const text = ctx.files
			.readText(config)
			.split('\n')
			.filter((line) => !/^\s*\/\//.test(line))
			.join('\n');
		try {
			declared = Object.keys(
				(JSON.parse(text) as { vars?: Record<string, unknown> }).vars ?? {}
			);
		} catch {
			// a config this cannot read keeps every value a secret, which is the behaviour before this
		}
	}
	const vars: Record<string, string> = {};
	const secrets: Record<string, string> = {};
	for (const [name, value] of Object.entries(values)) {
		(declared.includes(name) ? vars : secrets)[name] = value;
	}
	return { vars, secrets };
}

/**
 * Takes the fleet registry out of the duplicate's own config before it is deployed.
 *
 * `wrangler.jsonc` binds `FLEET_DB` to a D1 database by NAME, and a name that already exists on the
 * account resolves to that database. The first deploy of the earth-app copy registered itself in the
 * `drupflare-fleet` database the user's other deployments share, and its cron reads that table to
 * warm the sites in it. A preview copy joins no fleet and touches no other deployment's database; the
 * worker runs without the binding. The workspace is the preview's own checkout, so editing it
 * changes nothing the user deploys from.
 */
export function leaveFleet(ctx: Context, workspace: string): boolean {
	const config = join(workspace, 'wrangler.jsonc');
	if (!ctx.files.exists(config)) return false;
	let parsed: { d1_databases?: { binding?: string }[] };
	try {
		parsed = JSON.parse(
			ctx.files
				.readText(config)
				.split('\n')
				.filter((line) => !/^\s*\/\//.test(line))
				.join('\n')
		);
	} catch {
		throw new DranglerError(
			'up',
			`${config} could not be read, so the fleet database could not be taken out of the copy before it was deployed`
		);
	}
	const kept = (parsed.d1_databases ?? []).filter((d) => d.binding !== 'FLEET_DB');
	if (kept.length === (parsed.d1_databases ?? []).length) return false;
	if (kept.length === 0) delete parsed.d1_databases;
	else parsed.d1_databases = kept;
	ctx.files.writeText(config, `${JSON.stringify(parsed, null, '\t')}\n`);
	return true;
}

/** whether a script of this name is already on the account, so a placeholder would replace real code */
async function scriptExists(raw: RawClient, account: string, name: string): Promise<boolean> {
	try {
		await raw.request(`/accounts/${account}/workers/scripts/${name}/settings`);
		return true;
	} catch (e) {
		if (
			e instanceof Error &&
			/NotFound|HTTP 404\b/.test(`${e.constructor.name} ${e.message}`)
		) {
			return false;
		}
		throw e;
	}
}

/** a script that answers one line and reads nothing, so what is exposed before Access applies is nothing */
const PLACEHOLDER = 'export default { fetch: () => new Response("guard check") };\n';

async function deployPlaceholder(ctx: Context, input: DeployInput): Promise<void> {
	const dir = join(input.out, 'guard-placeholder');
	const config = join(dir, 'wrangler.jsonc');
	ctx.files.writeText(
		config,
		`${JSON.stringify({ name: input.name, main: 'index.js', compatibility_date: '2026-08-01', workers_dev: true })}\n`
	);
	ctx.files.writeText(join(dir, 'index.js'), PLACEHOLDER);
	const code = await ctx.runner.spawn('bunx', ['wrangler', 'deploy', '-c', config], {
		cwd: input.workspace
	});
	if (code !== 0)
		throw new DranglerError('up', `wrangler deploy of the placeholder exited ${code}`);
}

/**
 * Deploys the duplicate behind Cloudflare Access.
 *
 * ORDER IS THE POINT. The Access app goes up before the worker exists, so the first answer the
 * hostname ever gives is the login redirect: there is no moment at which a site holding production
 * rows answers anyone who finds its address, and none at which `/firstrun` is open to whoever asks
 * first. A data-free placeholder is deployed under the guarded name and the edge is confirmed to turn
 * a visitor away from it before the real worker goes up, and again before any secret is sent or any
 * claim is made. drangler reaches the copy with a service token, never a login.
 */
export async function deployDuplicate(ctx: Context, input: DeployInput): Promise<Deployed> {
	const t = await cloudflareTarget(ctx, null);
	const origin = workerOrigin(input.name, await workersSubdomain(t));
	const hostname = new URL(origin).host;
	const stored = join(input.out, 'access-guard.json');

	let guard: StoredGuard;
	if (ctx.files.exists(stored)) {
		guard = JSON.parse(ctx.files.readText(stored)) as StoredGuard;
		if (guard.hostname !== hostname) {
			throw new UsageError(
				`${stored} guards ${guard.hostname}, not ${hostname}; this folder belongs to a different preview`
			);
		}
	} else {
		const email = await accessEmail(ctx, input.accessEmail);
		const made = await createGuard(t.client.raw as RawClient, t.account, {
			hostname,
			email,
			name: input.name
		});
		guard = { ...made, email };
		ctx.files.writeSecret(stored, `${JSON.stringify(guard, null, 2)}\n`);
	}

	// A PLACEHOLDER GOES FIRST, and it holds nothing. The check cannot run before any script exists:
	// a workers.dev name with no script answers a bare 404 and Access is never consulted. So a script
	// with no data and no routes is put under the guarded name, and the real worker follows only once
	// the edge has turned a visitor away from it. Measured 2026-10-16: 404, then a 302 to the Access
	// login on the first answer from the script, never a 200
	leaveFleet(ctx, input.workspace);
	const wait = () => waitGuarded({ fetch: ctx.fetch, sleep: input.sleep ?? pause }, origin);
	// a rerun finds the real worker already there; a placeholder over it would replace working code,
	// so the guard is only confirmed against what answers
	const raw = t.client.raw as RawClient;
	if (!(await scriptExists(raw, t.account, input.name))) await deployPlaceholder(ctx, input);
	if (!(await wait())) {
		throw new DranglerError(
			'guard',
			`${origin} answers without a login 90 seconds after the Access app was created, so the site was not deployed`,
			{ next: `wrangler delete --name ${input.name}`, retryable: false }
		);
	}

	await (
		input.deploy ??
		((args) =>
			runDeployCommand(ctx, args, { workspace: input.workspace, globals: input.globals }))
	)([
		'--name',
		input.name,
		...Object.entries(input.vars ?? {}).flatMap(([name, value]) => [
			'--var',
			`${name}:${value}`
		])
	]);
	if (!(await wait())) {
		throw new DranglerError(
			'guard',
			`${origin} answers without a login after the deploy; it was left unclaimed and the secrets were not sent`,
			{ next: `wrangler delete --name ${input.name}`, retryable: false }
		);
	}
	if (input.hasSecrets) {
		const code = await ctx.runner.spawn(
			'bunx',
			['wrangler', 'secret', 'bulk', join(input.out, 'secrets.json'), '--name', input.name],
			{ cwd: input.workspace }
		);
		if (code !== 0) throw new DranglerError('up', `wrangler secret bulk exited ${code}`);
	}
	return { origin, headers: guardHeaders(guard), guard };
}
