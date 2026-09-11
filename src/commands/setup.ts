import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { DranglerError } from '../errors';
import { emit, kv } from '../format';
import { ownerCall, ownerTarget } from '../owner';

/**
 * The three `setup/*` owner routes, which had no CLI at all.
 *
 * `/setup/cf`, `/setup/mail` and `/setup/oidc` are owner-gated and documented, and `/setup/mail`
 * had neither a command here nor a control in the admin surface -- 45 KB of mail onboarding
 * reachable only by hand-crafting a request with a bearer token.
 *
 * Each is a READ by default and a write only when asked, because every one of them is something an
 * operator wants to look at more often than change.
 */

export interface SetupOptions {
	/** apply the change rather than reporting the current state */
	apply?: boolean;
	/** the zone a sending subdomain is created in */
	zone?: string;
	/** the sending subdomain's name */
	name?: string;
	/** the OIDC issuer */
	issuer?: string;
	/** the OIDC client id */
	clientId?: string;
	/** clear the stored configuration instead of writing one */
	clear?: boolean;
	globals: GlobalOptions;
}

export interface SetupReport {
	site: string;
	surface: 'cloudflare' | 'mail' | 'identity';
	/** whether this call asked for a change */
	applied: boolean;
	ok: boolean;
	/** the route's own body, unreshaped: these three report different things and flattening them
	 * into one schema would lose whichever half the caller came for */
	state: Record<string, unknown>;
	notes: string[];
}

/** Reports or connects the Cloudflare account grant. */
export async function runSetupCloudflare(
	ctx: Context,
	target: string | undefined,
	opts: SetupOptions & { disconnect?: boolean; clientIdArg?: string }
): Promise<void> {
	const owner = ownerTarget(opts.globals, target);
	const disconnect = opts.disconnect === true && !opts.globals.dryRun;
	const params: Record<string, string> = disconnect
		? { action: 'disconnect' }
		: { action: 'status' };
	const reply = await ownerCall(ctx, owner, '/setup/cf', { params });
	if (reply.status >= 400) {
		throw new DranglerError(
			'setup-cf',
			`${owner.origin} refused /setup/cf (${reply.status}): ${String(reply.body['error'] ?? '')}`
		);
	}
	const report: SetupReport = {
		site: owner.origin,
		surface: 'cloudflare',
		applied: disconnect,
		ok: reply.body['ok'] === true,
		state: reply.body,
		notes: []
	};
	if (reply.body['connected'] !== true && !disconnect) {
		// the consent screen is a browser flow, so the CLI can only say where it is
		report.notes.push(
			`no account is connected; start the grant at ${owner.origin}/_cfw/deploy, which is the only place the consent redirect can land`
		);
	}
	emit(ctx.io, opts.globals.json, report, () => render(report));
}

/** Reports or advances sending-domain onboarding. */
export async function runSetupMail(
	ctx: Context,
	target: string | undefined,
	opts: SetupOptions
): Promise<void> {
	const owner = ownerTarget(opts.globals, target);
	const apply = opts.apply === true && !opts.globals.dryRun;
	const params: Record<string, string> = {};
	if (opts.zone) params['zone'] = opts.zone;
	if (opts.name) params['name'] = opts.name;
	if (apply) params['action'] = 'apply';

	const reply = await ownerCall(ctx, owner, '/setup/mail', { params });
	const report: SetupReport = {
		site: owner.origin,
		surface: 'mail',
		applied: apply,
		ok: reply.body['ok'] === true,
		state: reply.body,
		notes: []
	};
	if (reply.status >= 400) {
		const error = String(reply.body['error'] ?? `HTTP ${reply.status}`);
		// the one failure an operator will hit first, and the message alone does not say what to do
		if (error.includes('no Cloudflare token')) {
			report.notes.push(
				'connect a Cloudflare account first: `drangler setup cloudflare` reports whether one is connected, and the grant itself is started from the Deploy page'
			);
		}
		report.notes.push(error);
		emit(ctx.io, opts.globals.json, report, () => render(report));
		throw new DranglerError('setup-mail', `${owner.origin} refused /setup/mail: ${error}`);
	}
	if (opts.apply === true && opts.globals.dryRun) {
		report.notes.push('dry run: the state was read and no change was asked for');
	}
	emit(ctx.io, opts.globals.json, report, () => render(report));
}

/** Reports, writes or clears the OpenID Connect provider. */
export async function runSetupIdentity(
	ctx: Context,
	target: string | undefined,
	opts: SetupOptions
): Promise<void> {
	const owner = ownerTarget(opts.globals, target);
	const writing = (opts.clear === true || opts.issuer !== undefined) && !opts.globals.dryRun;
	const params: Record<string, string> = {};
	if (opts.clear === true) params['action'] = 'clear';
	else {
		if (opts.issuer) params['issuer'] = opts.issuer;
		if (opts.clientId) params['clientId'] = opts.clientId;
	}

	const reply = await ownerCall(ctx, owner, '/setup/oidc', { params });
	if (reply.status >= 400) {
		throw new DranglerError(
			'setup-oidc',
			`${owner.origin} refused /setup/oidc (${reply.status}): ${String(reply.body['error'] ?? '')}`
		);
	}
	const report: SetupReport = {
		site: owner.origin,
		surface: 'identity',
		applied: writing,
		ok: reply.body['ok'] === true,
		state: reply.body,
		notes: []
	};
	// the start URL is the thing nothing printed anywhere: the surface showed the CALLBACK uri, so
	// a fully configured provider had no discoverable way in
	if (reply.body['issuer']) {
		report.notes.push(`people sign in at ${owner.origin}/oidc`);
	}
	if (opts.clear === true && opts.globals.dryRun) {
		report.notes.push('dry run: nothing was cleared');
	}
	emit(ctx.io, opts.globals.json, report, () => render(report));
}

function render(report: SetupReport): string[] {
	const rows: [string, string][] = [
		['site', report.site],
		['surface', report.surface],
		['changed', report.applied ? 'yes' : 'no']
	];
	for (const [key, value] of Object.entries(report.state)) {
		if (key === 'ok' || key === 'how') continue;
		if (value === null || typeof value === 'object') continue;
		rows.push([key, String(value)]);
	}
	return [...kv(rows), ...report.notes.map((n) => `  ${n}`)];
}
