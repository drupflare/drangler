import { resolveConfig, siteOrigin, type ResolvedConfig } from './config/file';
import type { RawGlobals } from './config/globals';
import type { Context } from './context';
import { KeychainUnavailable } from './host/keychain';

/** what {@link storeOwnerToken} did, so a report can say it rather than imply it */
export type StoreResult = 'stored' | 'replaced' | 'already' | 'unavailable';

/** the one-line notice for a keychain that cannot be reached; the command carries on without it */
function unavailable(ctx: Context, reason: string, consequence: string): void {
	ctx.io.err(`drangler: system keychain unavailable (${reason}); ${consequence}`);
}

/**
 * Writes an owner token to the system keychain, keyed by site origin.
 *
 * An unreachable backend is a notice and a result, never an exception: a headless Linux box with no
 * secret service must still print the token it was asked for.
 */
export async function storeOwnerToken(
	ctx: Context,
	origin: string,
	token: string
): Promise<StoreResult> {
	try {
		const held = await ctx.keychain.get(origin);
		if (held === token) return 'already';
		await ctx.keychain.set(origin, token);
		return held === undefined ? 'stored' : 'replaced';
	} catch (e) {
		if (!(e instanceof KeychainUnavailable)) throw e;
		unavailable(ctx, e.message, 'the owner token was not stored there');
		return 'unavailable';
	}
}

/** whether an argument looks like a site rather than a file or a word */
function originOf(value: unknown): string | undefined {
	if (typeof value !== 'string' || value === '') return undefined;
	try {
		return siteOrigin(value);
	} catch {
		return undefined;
	}
}

/**
 * Reads the keychain entries a command could need, before it runs.
 *
 * The lookup is async and the config resolution is not, so it happens once per invocation in a
 * `preAction` hook and the result rides into `resolveGlobals`. The candidates are the configured
 * site and a positional `[target]`. Nothing is read when the flag or the environment already
 * supplies a token, so a CI run never touches a keychain it does not have.
 */
export async function preloadKeychain(
	ctx: Context,
	raw: RawGlobals,
	positional: string | undefined
): Promise<Record<string, string>> {
	if ((raw.token ?? '').trim() !== '') return {};
	if ((ctx.env.DRUPFLARE_OWNER_TOKEN ?? '').trim() !== '') return {};

	let config: ResolvedConfig | undefined;
	try {
		config = resolveConfig(ctx, {
			...(raw.profile === undefined ? {} : { profile: raw.profile }),
			...(raw.configFile === undefined ? {} : { configFile: raw.configFile }),
			...(raw.site === undefined ? {} : { site: raw.site })
		});
	} catch {
		// the command resolves the same config next and raises the real error
		config = undefined;
	}
	const candidates = new Set<string>();
	if (config?.site.value) candidates.add(config.site.value);
	const target = originOf(positional);
	if (target !== undefined) candidates.add(target);

	const found: Record<string, string> = {};
	for (const origin of candidates) {
		try {
			const token = await ctx.keychain.get(origin);
			if (token !== undefined && token !== '') found[origin] = token;
		} catch (e) {
			if (!(e instanceof KeychainUnavailable)) throw e;
			// the global file still answers, so this is only worth a line when nothing else does
			if (config?.token.value == null && raw.quiet !== true) {
				unavailable(ctx, e.message, 'owner tokens are read from the global config');
			}
			return found;
		}
	}
	return found;
}
