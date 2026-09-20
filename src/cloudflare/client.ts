import { cloudflare, workforce, type Workforce } from '@drupflare/workforce';
import type { Context } from '../context';
import { requireAccount, requireToken, resolveAuth } from './auth';

export interface CloudflareTarget {
	client: Workforce;
	account: string;
}

/**
 * One credential, one account, one client, resolved the same way for every `cf` subcommand.
 *
 * The library owns the envelope reading, the retry and the request budget, so nothing below this
 * line talks to `api.cloudflare.com` directly.
 */
export async function target(ctx: Context, account: string | null): Promise<CloudflareTarget> {
	const auth = await resolveAuth(ctx.runner, ctx.env);
	const accountId = requireAccount(auth, account);
	return {
		account: accountId,
		client: workforce({
			plane: cloudflare({
				accountId,
				token: requireToken(ctx.env),
				fetch: ctx.fetch
			})
		})
	};
}
