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
 * Deploys the duplicate behind Cloudflare Access.
 *
 * ORDER IS THE POINT. The Access app goes up before the worker exists and the deploy waits until
 * the edge turns an unauthenticated visitor away, so there is no moment at which a site holding
 * production rows answers anyone who finds its address, and none at which `/firstrun` is open to
 * whoever asks first. Drangler then reaches it with a service token, never a login.
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

	const guarded = await waitGuarded({ fetch: ctx.fetch, sleep: input.sleep ?? pause }, origin);
	if (!guarded) {
		throw new DranglerError(
			'guard',
			`${origin} still answers without a login 90 seconds after its Access app was created; nothing was deployed`,
			{ next: `drangler preview --out ${input.out}`, retryable: true }
		);
	}

	await (
		input.deploy ??
		((args) =>
			runDeployCommand(ctx, args, { workspace: input.workspace, globals: input.globals }))
	)(['--name', input.name]);
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
