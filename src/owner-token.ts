import {
	globalConfigPath,
	resolveConfig,
	siteOrigin,
	type DranglerConfig,
	type ResolvedConfig
} from './config/file';
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

/** what {@link replaceConfigToken} did to the global config */
export type ConfigStoreResult = 'replaced' | 'already' | 'none' | 'unreadable';

/**
 * Overwrites the owner token the global config holds for a site, and only that one.
 *
 * It never adds an entry: a plaintext token that was not in the file is not moved there. A file it
 * cannot parse or write is a result, not an exception, because the caller holds the only copy of a
 * token that has already been rotated.
 */
export function replaceConfigToken(ctx: Context, origin: string, token: string): ConfigStoreResult {
	const path = globalConfigPath(ctx.env);
	try {
		if (!ctx.files.exists(path)) return 'none';
		const config = JSON.parse(ctx.files.readText(path)) as DranglerConfig;
		const held = config.sites?.[origin]?.ownerToken;
		if (held === undefined) return 'none';
		if (held === token) return 'already';
		const merged: DranglerConfig = {
			...config,
			sites: { ...config.sites, [origin]: { ...config.sites?.[origin], ownerToken: token } }
		};
		ctx.files.writeSecret(path, `${JSON.stringify(merged, null, '\t')}\n`);
		return 'replaced';
	} catch (e) {
		ctx.io.err(
			`drangler: could not update ${path} (${e instanceof Error ? e.message : String(e)}); the old owner token is still in it`
		);
		return 'unreadable';
	}
}

/**
 * Where a token other than `current` is still held for a site: the flag, the environment, the
 * keychain and the global config. Read straight from each place rather than from the resolved
 * config, because the keychain preload skips itself when the flag or the environment answers.
 */
export async function otherTokenHolders(
	ctx: Context,
	origin: string,
	current: string,
	flagged: boolean
): Promise<string[]> {
	const holders: string[] = [];
	const differs = (value: string | undefined | null): boolean =>
		value !== undefined && value !== null && value.trim() !== '' && value !== current;
	if (flagged) holders.push('--token');
	if (differs(ctx.env.DRUPFLARE_OWNER_TOKEN)) holders.push('DRUPFLARE_OWNER_TOKEN');
	try {
		if (differs(await ctx.keychain.get(origin))) holders.push('the system keychain');
	} catch (e) {
		if (!(e instanceof KeychainUnavailable)) throw e;
	}
	const path = globalConfigPath(ctx.env);
	try {
		if (ctx.files.exists(path)) {
			const config = JSON.parse(ctx.files.readText(path)) as DranglerConfig;
			if (differs(config.sites?.[origin]?.ownerToken)) holders.push(path);
		}
	} catch {
		// an unreadable file is reported when a write to it is attempted
	}
	return holders;
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
