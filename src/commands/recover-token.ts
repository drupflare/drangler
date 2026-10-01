/**
 * Gets a lost owner token back by proving write access to the site's Cloudflare account.
 *
 * The owner token is shown once, at the claim. This is the other way to it: drangler writes a
 * one-minute, single-use proof into the site's `CONFIG_KV` namespace through wrangler, so only
 * somebody holding KV edit rights on that account can produce it, then presents the proof to the
 * site's public `/recover-token` route, which checks it, deletes it and answers with the token.
 *
 * The nonce never leaves this process except in that one request. What reaches KV, and so
 * wrangler's argv, is its sha256, which proves nothing to anyone who reads it.
 * @module
 */

import { createHash, randomBytes } from 'node:crypto';
import { parseWranglerConfig } from '../cloudflare/config';
import type { GlobalOptions } from '../config/globals';
import type { Context } from '../context';
import { AuthError, DranglerError, ProbeError, UsageError } from '../errors';
import { emit, kv } from '../format';
import { pause, siteOriginOf } from '../owner';
import { storeOwnerToken, type StoreResult } from '../owner-token';
import { numberFlag } from './site';

/** the KV key prefix the worker reads; the worker's `RECOVER_KEY_PREFIX` is the same string */
export const RECOVER_KEY_PREFIX = 'recover';

/** how long the proof lives; KV refuses a TTL under 60 seconds, so this is the floor */
export const RECOVER_TTL_S = 60;

/**
 * The most attempts one run makes.
 *
 * The worker refuses a client after 12 failures in 60 seconds, and an attempt before the proof has
 * propagated is a counted failure, so a retry loop must stop well short of that.
 */
export const MAX_ATTEMPTS = 8;

const BINDING = 'CONFIG_KV';

export interface RecoverTokenOptions {
	/** also write the token to the system keychain */
	store?: boolean;
	kvNamespace?: string;
	/** how long to wait for the proof to reach the site */
	wait?: string | number;
	/** the first pause between attempts; attempt n waits n times this */
	interval?: string | number;
	globals: GlobalOptions;
}

export interface RecoverTokenReport {
	site: string;
	namespace: string | null;
	/** the KV key written; it carries a hash of the nonce, never the nonce */
	key: string | null;
	attempts: number;
	ownerToken: string | null;
	stored: StoreResult | 'not requested';
	error: string | null;
	notes: string[];
}

/** the nonce, as the worker expects it: 32 random bytes in base64url */
export function mintNonce(): string {
	return randomBytes(32).toString('base64url');
}

/** the KV key for a nonce: bound to the host it was minted for, and hashed so KV never holds it */
export function proofKey(host: string, nonce: string): string {
	const hash = createHash('sha256').update(nonce).digest('hex');
	return `${RECOVER_KEY_PREFIX}:${host.toLowerCase()}:${hash}`;
}

/** how many attempts fit in `waitMs` when attempt n is preceded by a pause of n * `intervalMs` */
export function attemptsWithin(waitMs: number, intervalMs: number): number {
	let attempts = 1;
	let elapsed = 0;
	while (attempts < MAX_ATTEMPTS) {
		elapsed += intervalMs * attempts;
		if (elapsed > waitMs) break;
		attempts++;
	}
	return attempts;
}

/** Writes the proof, presents it, and prints the token. */
export async function runRecoverToken(
	ctx: Context,
	target: string | undefined,
	opts: RecoverTokenOptions
): Promise<void> {
	const { globals } = opts;
	const origin = siteOriginOf(globals, target);
	const url = new URL(origin);
	if (url.protocol !== 'https:') {
		throw new UsageError(
			`${origin} is not https; the owner token comes back in the response, and a local \`wrangler dev\` site has no remote KV to prove against`
		);
	}
	const waitMs = numberFlag(opts.wait, 75_000, '--wait');
	const intervalMs = numberFlag(opts.interval, 5_000, '--interval');

	const report: RecoverTokenReport = {
		site: origin,
		namespace: null,
		key: null,
		attempts: 0,
		ownerToken: null,
		stored: 'not requested',
		error: null,
		notes: []
	};

	const env = accountEnv(ctx, globals);
	report.namespace = await findNamespace(ctx, opts.kvNamespace, env);

	if (globals.dryRun) {
		report.notes.push('dry run: nothing was written and nothing was sent');
		emit(ctx.io, globals.json, report, () => render(report));
		return;
	}

	const nonce = mintNonce();
	const key = proofKey(url.host, nonce);
	report.key = key;
	const exp = ctx.now().getTime() + RECOVER_TTL_S * 1000;
	const put = await ctx.runner.run(
		'wrangler',
		[
			'kv',
			'key',
			'put',
			`--namespace-id=${report.namespace}`,
			'--remote',
			`--ttl=${RECOVER_TTL_S}`,
			key,
			JSON.stringify({ host: url.host.toLowerCase(), exp })
		],
		{ env }
	);
	if (put.code !== 0) {
		const why = firstLine(put.stderr) || firstLine(put.stdout) || `exit ${put.code}`;
		if (/auth|login|token|permission|forbidden/i.test(why)) {
			throw new AuthError(
				`wrangler could not write to the KV namespace: ${why}; the credential needs KV edit rights on the account holding ${origin}`
			);
		}
		throw new DranglerError('wrangler', `wrangler could not write the proof: ${why}`);
	}

	const attempts = attemptsWithin(waitMs, intervalMs);
	for (let n = 0; n < attempts; n++) {
		if (n > 0) await pause(intervalMs * n);
		report.attempts = n + 1;
		const reply = await present(ctx, globals, `${origin}/recover-token`, nonce);
		if (reply.status === 200 && typeof reply.body['ownerToken'] === 'string') {
			report.ownerToken = reply.body['ownerToken'];
			break;
		}
		if (reply.status === 404 && reply.body['reason'] === 'unknown') continue;
		throw refusal(origin, reply);
	}

	if (report.ownerToken === null) {
		report.error = `the proof did not reach ${origin} in ${report.attempts} attempts`;
		emit(ctx.io, globals.json, report, () => render(report));
		throw new DranglerError('recover-token', report.error, {
			retryable: true,
			next: `drangler recover-token ${origin}`
		});
	}

	if (opts.store === true) report.stored = await storeOwnerToken(ctx, origin, report.ownerToken);
	emit(ctx.io, globals.json, report, () => render(report));
}

/** the account wrangler acts on, when one was named; otherwise wrangler's own login decides */
function accountEnv(ctx: Context, globals: GlobalOptions): NodeJS.ProcessEnv {
	const account = globals.config.account.value;
	return account === null ? ctx.env : { ...ctx.env, CLOUDFLARE_ACCOUNT_ID: account };
}

function firstLine(text: string): string {
	return (text.split('\n').find((l) => l.trim() !== '') ?? '').trim();
}

interface ProofReply {
	status: number;
	body: Record<string, unknown>;
	retryAfter: string | null;
}

async function present(
	ctx: Context,
	globals: GlobalOptions,
	url: string,
	nonce: string
): Promise<ProofReply> {
	let response: Response;
	try {
		response = await ctx.fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ nonce }),
			signal: AbortSignal.timeout(globals.timeoutMs)
		});
	} catch (e) {
		throw new ProbeError(`${url}: ${e instanceof Error ? e.message : String(e)}`);
	}
	const text = await response.text();
	let body: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(text) as unknown;
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			body = parsed as Record<string, unknown>;
		}
	} catch {
		body = {};
	}
	return { status: response.status, body, retryAfter: response.headers.get('retry-after') };
}

/** every status that ends the run, each with the command that fixes it where there is one */
function refusal(origin: string, reply: ProofReply): DranglerError {
	const said = typeof reply.body['error'] === 'string' ? reply.body['error'] : null;
	switch (reply.status) {
		case 429:
			return new DranglerError(
				'recover-token',
				`${origin} has refused this address after too many failed attempts` +
					(reply.retryAfter === null ? '' : `; try again in ${reply.retryAfter} seconds`),
				{ retryable: true }
			);
		case 409:
			return new DranglerError(
				'recover-token',
				`${origin} has no owner token yet because nobody has claimed it`,
				{ next: `drangler site claim ${origin}` }
			);
		case 410:
			return new DranglerError(
				'recover-token',
				`${origin} says the proof expired or was already used; run the command again`,
				{ retryable: true, next: `drangler recover-token ${origin}` }
			);
		case 403:
			return new DranglerError(
				'recover-token',
				`${origin} says the proof was written for a different host`
			);
		case 501:
			return new DranglerError(
				'recover-token',
				`${origin} has no CONFIG_KV binding, so it has nothing to check a proof against`
			);
		case 400:
			return new DranglerError(
				'recover-token',
				`${origin} refused the request: ${said ?? 'malformed'}`
			);
		default:
			return new DranglerError(
				'recover-token',
				`${origin} does not answer /recover-token (HTTP ${reply.status}); it predates the route, so update it first`,
				{ next: `drangler update` }
			);
	}
}

/** The CONFIG_KV namespace id: the flag, then a wrangler config, then the account. */
async function findNamespace(
	ctx: Context,
	given: string | undefined,
	env: NodeJS.ProcessEnv
): Promise<string> {
	if (given !== undefined && given.trim() !== '') return given.trim();

	for (const name of ['wrangler.jsonc', 'wrangler.json']) {
		const path = `${ctx.cwd.replace(/\/+$/, '')}/${name}`;
		if (!ctx.files.exists(path)) continue;
		const bound = parseWranglerConfig(ctx.files.readText(path)).kv_namespaces?.find(
			(n) => n.binding === BINDING
		);
		if (typeof bound?.id === 'string' && bound.id !== '') return bound.id;
	}

	const list = await ctx.runner.run('wrangler', ['kv', 'namespace', 'list'], { env });
	if (list.code !== 0) {
		const why = firstLine(list.stderr) || `exit ${list.code}`;
		throw new AuthError(
			`wrangler could not list KV namespaces: ${why}; run \`wrangler login\`, or pass --kv-namespace`
		);
	}
	const namespaces = readNamespaces(list.stdout);
	const matches = namespaces.filter((n) => n.title.toUpperCase().includes(BINDING));
	if (matches.length === 1 && matches[0] !== undefined) return matches[0].id;
	throw new UsageError(
		matches.length === 0
			? `no KV namespace on this account has ${BINDING} in its title; pass --kv-namespace with the id the site's ${BINDING} binding uses`
			: `${matches.length} KV namespaces have ${BINDING} in their title (${matches.map((m) => `${m.title}: ${m.id}`).join(', ')}); pass --kv-namespace with the one this site uses`
	);
}

/** wrangler prints a banner on some versions, so parsing starts at the first bracket */
function readNamespaces(stdout: string): { id: string; title: string }[] {
	const start = stdout.indexOf('[');
	if (start < 0) return [];
	try {
		const parsed = JSON.parse(stdout.slice(start)) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((n: unknown) => {
			const row = n as { id?: unknown; title?: unknown } | null;
			return typeof row?.id === 'string' && typeof row.title === 'string'
				? [{ id: row.id, title: row.title }]
				: [];
		});
	} catch {
		return [];
	}
}

function render(report: RecoverTokenReport): string[] {
	const rows: [string, string][] = [
		['site', report.site],
		['kv namespace', report.namespace ?? 'unresolved'],
		['attempts', String(report.attempts)]
	];
	if (report.ownerToken !== null) rows.push(['owner token', report.ownerToken]);
	rows.push([
		'stored in keychain',
		report.stored === 'not requested' ? 'no; pass --store' : report.stored
	]);
	if (report.error !== null) rows.push(['error', report.error]);
	const lines = kv(rows);
	if (report.notes.length > 0) lines.push('', ...report.notes.map((n) => `  ${n}`));
	return lines;
}
