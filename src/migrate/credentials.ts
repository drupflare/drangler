import { DatabaseSync } from 'node:sqlite';

/** one credential-bearing value, named by where it sits and never by what it holds */
export interface Credential {
	/** the config object, such as `key.key.mantle2_api_key` */
	config: string;
	/** the keys from the top of the object to the value */
	path: readonly string[];
}

type Php = string | number | boolean | null | Php[] | { [key: string]: Php };

const KEY_PREFIX = 'key.key.';
const KEY_VALUE = ['key_provider_settings', 'key_value'] as const;
const SECRET_NAME = /(^|_)(secret|passw(or)?d|private_key|api_?key|access_key|token)(_|$)/i;

/**
 * Reads the subset of PHP serialize() that Drupal writes config in: arrays, strings, integers,
 * floats, booleans and null. Strings are read as latin1 so a length counts bytes, the way PHP
 * counts them.
 */
export function unserialize(text: string): Php {
	let at = 0;
	const fail = (): never => {
		throw new Error(`not serialized config at offset ${at}`);
	};
	const until = (stop: string): string => {
		const end = text.indexOf(stop, at);
		if (end < 0) fail();
		const got = text.slice(at, end);
		at = end + stop.length;
		return got;
	};
	const value = (): Php => {
		const type = text[at];
		if (type === 'N') {
			at += 2;
			return null;
		}
		at += 2;
		switch (type) {
			case 'b':
				return until(';') === '1';
			case 'i':
				return Number(until(';'));
			case 'd':
				return Number(until(';'));
			case 's': {
				const length = Number(until(':'));
				if (text[at] !== '"') fail();
				const body = text.slice(at + 1, at + 1 + length);
				at += length + 3;
				return body;
			}
			case 'a': {
				const length = Number(until(':'));
				if (text[at] !== '{') fail();
				at += 1;
				const out: { [key: string]: Php } = {};
				for (let i = 0; i < length; i++) {
					const key = value();
					out[String(key)] = value();
				}
				if (text[at] !== '}') fail();
				at += 1;
				return out;
			}
			default:
				return fail();
		}
	};
	return value();
}

function isPublicCertificate(pem: string): boolean {
	return pem.includes('-----BEGIN CERTIFICATE-----') && !pem.includes('PRIVATE KEY');
}

/** the credential-bearing values inside one config object */
export function credentialsIn(name: string, data: Php): Credential[] {
	if (data === null || typeof data !== 'object' || Array.isArray(data)) return [];
	if (name.startsWith(KEY_PREFIX)) {
		const settings = data['key_provider_settings'];
		const held =
			data['key_provider'] === 'config' &&
			settings !== null &&
			typeof settings === 'object' &&
			!Array.isArray(settings)
				? settings['key_value']
				: undefined;
		return typeof held === 'string' && held.trim() !== '' && !isPublicCertificate(held)
			? [{ config: name, path: KEY_VALUE }]
			: [];
	}
	const found: Credential[] = [];
	const walk = (node: Php, path: string[]): void => {
		if (node === null || typeof node !== 'object') return;
		for (const [key, child] of Object.entries(node)) {
			if (typeof child === 'string') {
				const named = SECRET_NAME.test(key) || key === 'smtp_username';
				if (named && child.trim() !== '')
					found.push({ config: name, path: [...path, key] });
			} else {
				walk(child, [...path, key]);
			}
		}
	};
	walk(data, []);
	return found;
}

/** every credential in the `config` table of a converted site database, in table order */
export function readCredentials(path: string): Credential[] {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const rows = db.prepare("SELECT name, data FROM config WHERE collection = ''").all() as {
			name: string;
			data: Uint8Array | string;
		}[];
		const found: Credential[] = [];
		for (const row of rows) {
			const text =
				typeof row.data === 'string' ? row.data : Buffer.from(row.data).toString('latin1');
			try {
				found.push(...credentialsIn(row.name, unserialize(text)));
			} catch {
				// a row that is not serialized config holds nothing this can name
			}
		}
		return found;
	} catch {
		return [];
	} finally {
		db.close();
	}
}

/** the name a `--carry-key` argument matches: the object, its key id, or `object:leaf` */
export function isCarried(credential: Credential, carry: readonly string[]): boolean {
	const leaf = credential.path.at(-1) ?? '';
	const id = credential.config.startsWith(KEY_PREFIX)
		? credential.config.slice(KEY_PREFIX.length)
		: credential.config;
	return carry.some(
		(want) =>
			want === credential.config || want === id || want === `${credential.config}:${leaf}`
	);
}

/** the label a report prints for one credential */
export function describeCredential(credential: Credential): string {
	return credential.config.startsWith(KEY_PREFIX)
		? credential.config.slice(KEY_PREFIX.length)
		: `${credential.config}:${credential.path.at(-1) ?? ''}`;
}

/** a `$config` override that empties each credential, shaped for DRUPAL_CONFIG */
export function blankingOverrides(
	found: readonly Credential[],
	carry: readonly string[]
): { overrides: Record<string, unknown>; blanked: Credential[]; carried: Credential[] } {
	const overrides: Record<string, unknown> = {};
	const blanked: Credential[] = [];
	const carried: Credential[] = [];
	for (const credential of found) {
		if (isCarried(credential, carry)) {
			carried.push(credential);
			continue;
		}
		blanked.push(credential);
		let node = (overrides[credential.config] ??= {}) as Record<string, unknown>;
		for (const key of credential.path.slice(0, -1)) {
			node = (node[key] ??= {}) as Record<string, unknown>;
		}
		node[credential.path.at(-1)!] = '';
	}
	return { overrides, blanked, carried };
}

/**
 * Empties the credential-bearing leaves of `$config` overrides read from settings.php, which carry
 * a literal secret the same way the database does. Returns what it blanked.
 */
export function blankOverrideCredentials(
	config: Record<string, unknown>,
	carry: readonly string[]
): Credential[] {
	const blanked: Credential[] = [];
	for (const [name, data] of Object.entries(config)) {
		for (const credential of credentialsIn(name, data as Php)) {
			if (isCarried(credential, carry)) continue;
			let node = data as Record<string, unknown>;
			for (const key of credential.path.slice(0, -1))
				node = node[key] as Record<string, unknown>;
			node[credential.path.at(-1)!] = '';
			blanked.push(credential);
		}
	}
	return blanked;
}

/** merges `extra` into `base` key by key, so one object's other overrides survive */
export function mergeOverrides(
	base: Record<string, unknown>,
	extra: Record<string, unknown>
): Record<string, unknown> {
	const out = { ...base };
	for (const [key, value] of Object.entries(extra)) {
		const have = out[key];
		out[key] =
			value !== null &&
			typeof value === 'object' &&
			have !== null &&
			typeof have === 'object' &&
			!Array.isArray(have)
				? mergeOverrides(have as Record<string, unknown>, value as Record<string, unknown>)
				: value;
	}
	return out;
}
