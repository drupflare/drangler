import { describe, expect, it } from 'vitest';
import { runSiteClaim, type SiteClaimReport } from '../src/commands/site';
import { EXIT, UsageError } from '../src/errors';
import { memoryFiles } from '../src/host/files';
import {
	KEYCHAIN_SERVICE,
	KeychainUnavailable,
	memoryKeychain,
	nodeKeychain,
	unavailableKeychain,
	type Keychain,
	type KeyringModule
} from '../src/host/keychain';
import { ownerTarget } from '../src/owner';
import { preloadKeychain, storeOwnerToken } from '../src/owner-token';
import { run } from '../src/run';
import { fakeFetch, testContext, testGlobals } from './helpers';

const ORIGIN = 'https://mysite.example';
const HOME = '/home/me';
const GLOBAL = `${HOME}/.config/drangler/config.json`;

/** the slice of the keyring module the wrapper uses, recording what it was asked for */
function fakeKeyring(behaviour: {
	password?: string | null | undefined;
	get?: Error;
	set?: Error;
}): KeyringModule & { made: [string, string][]; written: string[] } {
	const made: [string, string][] = [];
	const written: string[] = [];
	class AsyncEntry {
		constructor(service: string, username: string) {
			made.push([service, username]);
		}
		async getPassword() {
			if (behaviour.get) throw behaviour.get;
			return behaviour.password;
		}
		async setPassword(password: string) {
			if (behaviour.set) throw behaviour.set;
			written.push(password);
		}
	}
	return { AsyncEntry, made, written };
}

/** counts reads, so a spec can prove the keychain was never touched */
function counting(inner: Keychain): Keychain & { gets: string[] } {
	const gets: string[] = [];
	return {
		gets,
		async get(account) {
			gets.push(account);
			return inner.get(account);
		},
		set: (account, secret) => inner.set(account, secret)
	};
}

describe('the keychain wrapper', () => {
	it('keys the entry by service and origin, and returns what is stored', async () => {
		const mod = fakeKeyring({ password: 'stored-token' });
		const keychain = nodeKeychain(async () => mod);
		expect(await keychain.get(ORIGIN)).toBe('stored-token');
		expect(mod.made).toEqual([[KEYCHAIN_SERVICE, ORIGIN]]);
	});

	it.each([undefined, null])('reads %s as no entry, not as a failure', async (none) => {
		const keychain = nodeKeychain(async () => fakeKeyring({ password: none }));
		expect(await keychain.get(ORIGIN)).toBeUndefined();
	});

	it('writes the secret through the entry', async () => {
		const mod = fakeKeyring({});
		await nodeKeychain(async () => mod).set(ORIGIN, 'new-token');
		expect(mod.written).toEqual(['new-token']);
	});

	// a native addon that did not load is the headless-box case, not a crash
	it('reports a module that will not load as unavailable, with the reason', async () => {
		const keychain = nodeKeychain(async () => {
			throw new Error("Cannot find module '@napi-rs/keyring-linux-x64-gnu'\nrequire stack");
		});
		const failure = await keychain.get(ORIGIN).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(KeychainUnavailable);
		expect((failure as Error).message).toBe(
			"Cannot find module '@napi-rs/keyring-linux-x64-gnu'"
		);
	});

	it('reports a store that refuses a read or a write as unavailable', async () => {
		const read = nodeKeychain(async () =>
			fakeKeyring({ get: new Error('The name org.freedesktop.secrets was not provided') })
		);
		await expect(read.get(ORIGIN)).rejects.toBeInstanceOf(KeychainUnavailable);
		const write = nodeKeychain(async () =>
			fakeKeyring({ set: new Error('keychain is locked') })
		);
		await expect(write.set(ORIGIN, 't')).rejects.toBeInstanceOf(KeychainUnavailable);
	});

	it('the memory and unavailable doubles behave as the real two states do', async () => {
		const memory = memoryKeychain({ [ORIGIN]: 'a' });
		await memory.set('https://b.example', 'b');
		expect([await memory.get(ORIGIN), await memory.get('https://b.example')]).toEqual([
			'a',
			'b'
		]);
		expect(await memory.get('https://c.example')).toBeUndefined();
		await expect(unavailableKeychain('nope').get(ORIGIN)).rejects.toThrow('nope');
		await expect(unavailableKeychain('nope').set(ORIGIN, 't')).rejects.toThrow('nope');
	});
});

describe('storing an owner token', () => {
	it('says stored, already and replaced rather than writing blindly', async () => {
		const keychain = memoryKeychain();
		const ctx = testContext({ keychain });
		expect(await storeOwnerToken(ctx, ORIGIN, 'one')).toBe('stored');
		expect(await storeOwnerToken(ctx, ORIGIN, 'one')).toBe('already');
		expect(await storeOwnerToken(ctx, ORIGIN, 'two')).toBe('replaced');
		expect(keychain.entries.get(ORIGIN)).toBe('two');
	});

	it('keys each origin separately', async () => {
		const keychain = memoryKeychain();
		const ctx = testContext({ keychain });
		await storeOwnerToken(ctx, ORIGIN, 'one');
		await storeOwnerToken(ctx, 'https://other.example', 'two');
		expect([...keychain.entries]).toEqual([
			[ORIGIN, 'one'],
			['https://other.example', 'two']
		]);
	});

	it('degrades to one stderr line and a result when there is no keychain', async () => {
		const ctx = testContext({ keychain: unavailableKeychain('no secret service') });
		expect(await storeOwnerToken(ctx, ORIGIN, 'one')).toBe('unavailable');
		expect(ctx.io.stderr).toEqual([
			'drangler: system keychain unavailable (no secret service); the owner token was not stored there'
		]);
		expect(ctx.io.stdout).toEqual([]);
	});

	// swallowing every error would hide a real bug behind the headless-Linux message
	it('does not swallow an error that is not the backend being absent', async () => {
		const ctx = testContext({
			keychain: {
				get: async () => {
					throw new TypeError('bug');
				},
				set: async () => {}
			}
		});
		await expect(storeOwnerToken(ctx, ORIGIN, 'one')).rejects.toThrow('bug');
	});
});

describe('reading the keychain before a command runs', () => {
	it('reads the configured site and a positional origin, and nothing else', async () => {
		const keychain = counting(
			memoryKeychain({ [ORIGIN]: 'site-token', 'https://arg.example': 'arg-token' })
		);
		const ctx = testContext({ keychain, env: { HOME } });
		const found = await preloadKeychain(ctx, { site: ORIGIN }, 'arg.example');
		expect(found).toEqual({ [ORIGIN]: 'site-token', 'https://arg.example': 'arg-token' });
		expect(keychain.gets).toEqual([ORIGIN, 'https://arg.example']);
	});

	it('ignores a positional argument that is a word rather than a site', async () => {
		const keychain = counting(memoryKeychain());
		const ctx = testContext({ keychain, env: { HOME } });
		await preloadKeychain(ctx, {}, 'blog');
		expect(keychain.gets).toEqual([]);
	});

	// a CI run with the token in its environment must not touch a keychain it does not have
	it.each([
		['the flag', { token: 'flag-token' }, {}],
		['the environment', {}, { DRUPFLARE_OWNER_TOKEN: 'env-token' }]
	])('does not read the keychain when %s supplies the token', async (_name, raw, env) => {
		const keychain = counting(memoryKeychain({ [ORIGIN]: 'kc' }));
		const ctx = testContext({ keychain, env: { HOME, ...env } });
		expect(await preloadKeychain(ctx, { site: ORIGIN, ...raw }, undefined)).toEqual({});
		expect(keychain.gets).toEqual([]);
	});

	it('is silent about a missing backend while the global config still has a token', async () => {
		const files = memoryFiles({
			[GLOBAL]: JSON.stringify({ sites: { [ORIGIN]: { ownerToken: 'cfg' } } })
		});
		const ctx = testContext({
			files,
			env: { HOME },
			keychain: unavailableKeychain('no service')
		});
		expect(await preloadKeychain(ctx, { site: ORIGIN }, undefined)).toEqual({});
		expect(ctx.io.stderr).toEqual([]);
	});

	it('says so once when there is no backend and no token anywhere, unless --quiet', async () => {
		const loud = testContext({ env: { HOME }, keychain: unavailableKeychain('no service') });
		await preloadKeychain(loud, { site: ORIGIN }, 'other.example');
		expect(loud.io.stderr).toEqual([
			'drangler: system keychain unavailable (no service); owner tokens are read from the global config'
		]);
		const quiet = testContext({ env: { HOME }, keychain: unavailableKeychain('no service') });
		await preloadKeychain(quiet, { site: ORIGIN, quiet: true }, undefined);
		expect(quiet.io.stderr).toEqual([]);
	});

	it('leaves a broken config to the command, which raises the real error', async () => {
		const files = memoryFiles({ [`${HOME}/work/drangler.json`]: '{ nope' });
		const ctx = testContext({ files, env: { HOME }, cwd: `${HOME}/work` });
		await expect(preloadKeychain(ctx, {}, undefined)).resolves.toEqual({});
	});
});

describe('which token a command sends', () => {
	const pitr = (calls: { authorization: string | null }[]) =>
		fakeFetch((_url, init) => {
			calls.push({ authorization: new Headers(init?.headers).get('authorization') });
			return Response.json({ supported: false });
		});

	async function sent(
		over: Parameters<typeof testContext>[0],
		argv: string[] = ['recover', ORIGIN]
	): Promise<{ authorization: string | null } | undefined> {
		const calls: { authorization: string | null }[] = [];
		const ctx = testContext({ fetch: pitr(calls), env: { HOME }, ...over });
		await run(ctx, argv);
		return calls[0];
	}

	const files = (token: string) =>
		memoryFiles({ [GLOBAL]: JSON.stringify({ sites: { [ORIGIN]: { ownerToken: token } } }) });

	it('takes the keychain over the global config', async () => {
		const call = await sent(
			{
				keychain: memoryKeychain({ [ORIGIN]: 'from-keychain' }),
				files: files('from-config'),
				env: { HOME }
			},
			['--site', ORIGIN, 'recover']
		);
		expect(call?.authorization).toBe('Bearer from-keychain');
	});

	it('takes the environment over the keychain, and the flag over both', async () => {
		const keychain = memoryKeychain({ [ORIGIN]: 'from-keychain' });
		const env = await sent({ keychain, env: { HOME, DRUPFLARE_OWNER_TOKEN: 'from-env' } }, [
			'--site',
			ORIGIN,
			'recover'
		]);
		expect(env?.authorization).toBe('Bearer from-env');
		const flag = await sent({ keychain, env: { HOME, DRUPFLARE_OWNER_TOKEN: 'from-env' } }, [
			'--site',
			ORIGIN,
			'--token',
			'from-flag',
			'recover'
		]);
		expect(flag?.authorization).toBe('Bearer from-flag');
	});

	it('falls back to the global config when the keychain has no entry or no backend', async () => {
		const empty = await sent({ keychain: memoryKeychain(), files: files('from-config') }, [
			'--site',
			ORIGIN,
			'recover'
		]);
		expect(empty?.authorization).toBe('Bearer from-config');
		const headless = await sent(
			{ keychain: unavailableKeychain('no service'), files: files('from-config') },
			['--site', ORIGIN, 'recover']
		);
		expect(headless?.authorization).toBe('Bearer from-config');
	});

	it('looks up the keychain entry for a positional origin that differs from --site', async () => {
		const call = await sent(
			{ keychain: memoryKeychain({ 'https://arg.example': 'arg-token' }) },
			['--site', ORIGIN, 'recover', 'https://arg.example']
		);
		expect(call?.authorization).toBe('Bearer arg-token');
	});

	it('never sends one site its neighbour keychain entry', async () => {
		const ctx = testContext({ env: { HOME } });
		const globals = testGlobals({ keychain: { [ORIGIN]: 'mine' } }, ctx, { site: ORIGIN });
		expect(ownerTarget(globals, ORIGIN).token).toBe('mine');
		expect(() => ownerTarget(globals, 'https://arg.example')).toThrow(UsageError);
	});

	// the preload skips the keychain in both cases, so this is the guard on the order itself
	it('lets the flag and the environment outrank a keychain entry that was loaded anyway', () => {
		const viaEnv = testContext({ env: { HOME, DRUPFLARE_OWNER_TOKEN: 'from-env' } });
		const env = testGlobals({ keychain: { [ORIGIN]: 'from-keychain' } }, viaEnv, {
			site: ORIGIN
		});
		expect(ownerTarget(env).token).toBe('from-env');
		const ctx = testContext({ env: { HOME } });
		const flag = testGlobals({ keychain: { [ORIGIN]: 'from-keychain' } }, ctx, {
			site: ORIGIN,
			token: 'from-flag'
		});
		expect(ownerTarget(flag).token).toBe('from-flag');
	});

	it('names the recovery command when there is no token anywhere', async () => {
		const ctx = testContext({ env: { HOME } });
		expect(() => ownerTarget(testGlobals({}, ctx), ORIGIN)).toThrow(
			`drangler recover-token ${ORIGIN} --store`
		);
	});

	it('leaves `drangler recover` itself a flat command with its own options', async () => {
		const ctx = testContext({ env: { HOME } });
		expect(await run(ctx, ['--token', 't', 'recover', ORIGIN, '--bookmark', 'abc'])).toBe(
			EXIT.USAGE
		);
		expect(ctx.io.stderr.join('\n')).toContain('scheduling a restore');
	});
});

describe('site claim and the keychain', () => {
	const claimFetch = () =>
		fakeFetch((_url, init) =>
			init?.method === 'POST'
				? Response.json({ ok: true, ownerToken: 'minted' })
				: new Response('ok')
		);
	const globals = (ctx: ReturnType<typeof testContext>) =>
		testGlobals({ json: true }, ctx, { site: ORIGIN });

	it('stores the minted token in the keychain and asks nothing about the config file', async () => {
		const files = memoryFiles({});
		const keychain = memoryKeychain();
		const ctx = testContext({
			fetch: claimFetch(),
			files,
			keychain,
			env: { HOME },
			ask: async () => {
				throw new Error('must not prompt when the keychain took the token');
			}
		});
		await runSiteClaim(ctx, ORIGIN, { globals: globals(ctx) });
		expect(keychain.entries.get(ORIGIN)).toBe('minted');
		expect(files.written.size).toBe(0);
		expect(ctx.io.json<SiteClaimReport>().saved).toBe('the system keychain');
	});

	it('--save writes the config file as well as the keychain', async () => {
		const files = memoryFiles({});
		const keychain = memoryKeychain();
		const ctx = testContext({ fetch: claimFetch(), files, keychain, env: { HOME } });
		await runSiteClaim(ctx, ORIGIN, { save: true, globals: globals(ctx) });
		expect(keychain.entries.get(ORIGIN)).toBe('minted');
		expect(files.written.has(GLOBAL)).toBe(true);
		expect(ctx.io.json<SiteClaimReport>().saved).toBe(`the system keychain and ${GLOBAL}`);
	});

	// the headless path must behave exactly as claim did before the keychain existed
	it('without a keychain it prompts for the config file as before', async () => {
		const files = memoryFiles({});
		const questions: string[] = [];
		const ctx = testContext({
			fetch: claimFetch(),
			files,
			env: { HOME },
			ask: async (q) => {
				questions.push(q);
				return 'yes';
			}
		});
		await runSiteClaim(ctx, ORIGIN, { globals: globals(ctx) });
		expect(questions).toEqual([
			`Write the owner token to your global config for ${ORIGIN}? (yes/no)`
		]);
		expect(files.written.has(GLOBAL)).toBe(true);
		expect(ctx.io.json<SiteClaimReport>().saved).toBe(GLOBAL);
		expect(ctx.io.stderr.join('\n')).toContain('system keychain unavailable');
	});
});
