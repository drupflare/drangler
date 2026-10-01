/** the service every drangler keychain entry lives under; the account is the site origin */
export const KEYCHAIN_SERVICE = 'drupflare-owner-token';

/**
 * The OS credential store, as far as drangler uses it.
 *
 * Absence is `undefined`. A backend that cannot answer at all (no secret service on a headless
 * Linux box, a locked keychain, a missing native module) throws {@link KeychainUnavailable}, which
 * is how a caller tells "no entry" from "cannot look".
 */
export interface Keychain {
	get(account: string): Promise<string | undefined>;
	set(account: string, secret: string): Promise<void>;
}

/** the backend could not be reached; the message is the reason, ready for a one-line notice */
export class KeychainUnavailable extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'KeychainUnavailable';
	}
}

/** the slice of `@napi-rs/keyring` this file uses, so a spec supplies a fake */
export interface KeyringModule {
	AsyncEntry: new (
		service: string,
		username: string
	) => {
		getPassword(): Promise<string | undefined | null>;
		setPassword(password: string): Promise<void>;
	};
}

function reasonOf(e: unknown): string {
	const text = e instanceof Error ? e.message : String(e);
	return (text.split('\n')[0] ?? '').trim() || 'unknown error';
}

/**
 * The real store: Keychain Services on macOS, Credential Manager on Windows, the Secret Service on
 * Linux, through `@napi-rs/keyring`.
 *
 * The module is imported on first use, inside the try, so a platform with no prebuilt binary or a
 * compiled binary that did not embed the addon degrades to {@link KeychainUnavailable} rather than
 * failing at startup.
 */
export function nodeKeychain(
	load: () => Promise<KeyringModule> = () => import('@napi-rs/keyring')
): Keychain {
	const entry = async (account: string) => {
		try {
			const { AsyncEntry } = await load();
			return new AsyncEntry(KEYCHAIN_SERVICE, account);
		} catch (e) {
			throw new KeychainUnavailable(reasonOf(e));
		}
	};
	return {
		async get(account) {
			const e = await entry(account);
			try {
				return (await e.getPassword()) ?? undefined;
			} catch (err) {
				throw new KeychainUnavailable(reasonOf(err));
			}
		},
		async set(account, secret) {
			const e = await entry(account);
			try {
				await e.setPassword(secret);
			} catch (err) {
				throw new KeychainUnavailable(reasonOf(err));
			}
		}
	};
}

/** a keychain that holds its entries in a map, for a spec */
export interface MemoryKeychain extends Keychain {
	readonly entries: Map<string, string>;
}

export function memoryKeychain(seed: Record<string, string> = {}): MemoryKeychain {
	const entries = new Map(Object.entries(seed));
	return {
		entries,
		async get(account) {
			return entries.get(account);
		},
		async set(account, secret) {
			entries.set(account, secret);
		}
	};
}

/** a keychain that always refuses, which is a headless Linux box with no secret service */
export function unavailableKeychain(reason: string): Keychain {
	return {
		async get() {
			throw new KeychainUnavailable(reason);
		},
		async set() {
			throw new KeychainUnavailable(reason);
		}
	};
}
