import { AuthError } from '../errors';
import type { CommandRunner } from '../host/exec';

export interface CloudflareAccount {
	id: string;
	name: string;
}

export interface CloudflareAuth {
	/** which credential drangler would use, in the order wrangler itself resolves them */
	source: 'api-token' | 'wrangler-oauth' | 'none';
	authenticated: boolean;
	email: string | null;
	accountId: string | null;
	accounts: CloudflareAccount[];
	/** true when CLOUDFLARE_API_TOKEN is set; the value is never read into the report */
	tokenPresent: boolean;
	wrangler: string | null;
	/** what to run when the answer is "not logged in" */
	remedy: string | null;
}

const ACCOUNT_ID = /\b[0-9a-f]{32}\b/;

export interface WhoamiFields {
	authenticated: boolean;
	email: string | null;
	accounts: CloudflareAccount[];
}

/**
 * Reads `wrangler whoami`.
 *
 * Parsed loosely on purpose: the output is a box-drawing table whose column order and decoration have
 * changed across wrangler majors, and the only two things that have not are the sentence carrying the
 * email and the fact that an account id is 32 hex characters. Anchoring on those survives a redesign;
 * anchoring on the table does not.
 */
export function parseWhoami(stdout: string): WhoamiFields {
	// the sentence ends in a full stop, and an address cannot, so it is stripped after the match
	const raw = /associated with the email\s+([^\s,]+@[^\s,]+)/i.exec(stdout)?.[1] ?? null;
	const email = raw === null ? null : raw.replace(/[.,]+$/, '');
	const accounts: CloudflareAccount[] = [];
	for (const line of stdout.split('\n')) {
		const id = ACCOUNT_ID.exec(line)?.[0];
		if (id === undefined) continue;
		const cells = line
			.split(/[│|]/)
			.map((c) => c.trim())
			.filter((c) => c !== '' && c !== id);
		accounts.push({ id, name: cells[0] ?? id });
	}
	const authenticated =
		!/not authenticated|you are not logged in/i.test(stdout) && email !== null;
	return { authenticated, email, accounts };
}

/**
 * Resolves how drangler would authenticate, without authenticating.
 *
 * An API token in the environment WINS, because that is the order wrangler resolves in and a CLI that
 * reported the OAuth identity while wrangler used the token would be describing a different account
 * than the one about to be acted on.
 */
export async function resolveAuth(
	runner: CommandRunner,
	env: NodeJS.ProcessEnv
): Promise<CloudflareAuth> {
	const token = env.CLOUDFLARE_API_TOKEN ?? env.CF_API_TOKEN ?? null;
	const envAccount = env.CLOUDFLARE_ACCOUNT_ID ?? env.CF_ACCOUNT_ID ?? null;

	const version = await runner.run('wrangler', ['--version']);
	const wrangler =
		version.code === 0 ? (/(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1] ?? null) : null;

	if (token !== null && token !== '') {
		return {
			source: 'api-token',
			authenticated: true,
			email: null,
			accountId: envAccount,
			accounts:
				envAccount === null ? [] : [{ id: envAccount, name: 'from CLOUDFLARE_ACCOUNT_ID' }],
			tokenPresent: true,
			wrangler,
			remedy:
				envAccount === null
					? 'set CLOUDFLARE_ACCOUNT_ID; a token alone does not say which account to act on'
					: null
		};
	}

	const whoami = await runner.run('wrangler', ['whoami']);
	if (whoami.code !== 0) {
		return {
			source: 'none',
			authenticated: false,
			email: null,
			accountId: null,
			accounts: [],
			tokenPresent: false,
			wrangler,
			remedy:
				wrangler === null
					? 'install wrangler, then run `bunx wrangler login`'
					: 'run `bunx wrangler login`'
		};
	}

	const fields = parseWhoami(whoami.stdout);
	return {
		source: fields.authenticated ? 'wrangler-oauth' : 'none',
		authenticated: fields.authenticated,
		email: fields.email,
		accountId: envAccount ?? fields.accounts[0]?.id ?? null,
		accounts: fields.accounts,
		tokenPresent: false,
		wrangler,
		remedy: fields.authenticated ? null : 'run `bunx wrangler login`'
	};
}

/** The credential an API call needs, or a named refusal saying which of the two ways to supply it. */
export function requireToken(env: NodeJS.ProcessEnv): string {
	const token = env.CLOUDFLARE_API_TOKEN ?? env.CF_API_TOKEN ?? '';
	if (token === '') {
		throw new AuthError(
			'no CLOUDFLARE_API_TOKEN in the environment; the REST API needs a token, and `wrangler login` stores an OAuth credential this cannot read'
		);
	}
	return token;
}

/** The account to act on, from the environment or from the resolved login. */
export function requireAccount(auth: CloudflareAuth, override: string | null): string {
	const id = override ?? auth.accountId;
	if (id === null) {
		throw new AuthError(
			'no account id: set CLOUDFLARE_ACCOUNT_ID or pass --account, since a token can reach several accounts'
		);
	}
	return id;
}
