import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	attemptsWithin,
	MAX_ATTEMPTS,
	mintNonce,
	proofKey,
	RECOVER_KEY_PREFIX,
	RECOVER_TTL_S,
	runRecoverToken,
	type RecoverTokenReport
} from '../src/commands/recover-token';
import { AuthError, DranglerError, EXIT, ProbeError, UsageError } from '../src/errors';
import type { CommandRunner, RecordedCall } from '../src/host/exec';
import { memoryFiles } from '../src/host/files';
import { memoryKeychain, unavailableKeychain } from '../src/host/keychain';
import { buildProgram } from '../src/program';
import { run } from '../src/run';
import { testContext, testGlobals, type TestContext } from './helpers';

const ORIGIN = 'https://mysite.example';
const NS = '0123456789abcdef0123456789abcdef';
const OWNER_TOKEN = 'owner-token-that-must-not-leak';
const NOW = new Date('2026-08-14T00:00:00.000Z');

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

interface Put {
	key: string;
	value: { host: string; exp: number };
	argv: string[];
	env: NodeJS.ProcessEnv | undefined;
}

/**
 * The worker's side of the proof, as the design specifies it, in one object.
 *
 * `visibleAfter` is how many lookups miss before the written proof is seen, which is KV's eventual
 * consistency: a read at another colo can miss a key written seconds ago.
 */
function site(
	over: {
		visibleAfter?: number;
		claimed?: boolean;
		namespaces?: string;
		wranglerFails?: string;
		respond?: (call: { host: string; nonce: string }) => Response | undefined;
	} = {}
) {
	const proofs = new Map<string, { host: string; exp: number }>();
	const spent = new Set<string>();
	const puts: Put[] = [];
	const posts: { url: string; nonce: string }[] = [];
	const calls: RecordedCall[] = [];
	let misses = over.visibleAfter ?? 0;

	const runner: CommandRunner = {
		async run(file, args, opts) {
			calls.push({ file, args: [...args], mode: 'run' });
			if (args[0] === 'kv' && args[1] === 'namespace') {
				return { code: 0, stdout: over.namespaces ?? '[]', stderr: '' };
			}
			if (over.wranglerFails !== undefined) {
				return { code: 1, stdout: '', stderr: `${over.wranglerFails}\nmore detail` };
			}
			const key = String(args.at(-2));
			const value = JSON.parse(String(args.at(-1))) as { host: string; exp: number };
			proofs.set(key, value);
			puts.push({ key, value, argv: [...args], env: opts?.env });
			return { code: 0, stdout: '', stderr: '' };
		},
		async spawn() {
			return 0;
		},
		async runToFile() {
			return { code: 0, stderr: '', bytes: 0 };
		}
	};

	const fetch = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const { nonce } = JSON.parse(String(init?.body)) as { nonce: string };
		posts.push({ url: String(input), nonce });
		const mocked = over.respond?.({ host: url.host, nonce });
		if (mocked !== undefined) return mocked;
		const key = `recover:${url.host}:${sha256(nonce)}`;
		const found = proofs.get(key);
		if (found === undefined || misses-- > 0) {
			return Response.json({ error: 'no such proof', reason: 'unknown' }, { status: 404 });
		}
		if (found.host !== url.host)
			return Response.json({ reason: 'wrong-host' }, { status: 403 });
		if (spent.has(key) || found.exp < NOW.getTime()) {
			return Response.json({ reason: 'spent' }, { status: 410 });
		}
		spent.add(key);
		if (over.claimed === false) return Response.json({ reason: 'unclaimed' }, { status: 409 });
		return Response.json({ ok: true, ownerToken: OWNER_TOKEN });
	}) as unknown as typeof globalThis.fetch;

	return { runner, fetch, puts, posts, calls };
}

function context(model: ReturnType<typeof site>, over: Partial<TestContext> = {}): TestContext {
	return testContext({
		runner: model.runner,
		fetch: model.fetch,
		now: () => NOW,
		env: { HOME: '/home/me' },
		cwd: '/work',
		...over
	});
}

const globalsFor = (ctx: TestContext, over = {}) => testGlobals({ json: true, ...over }, ctx, {});

const recover = (
	ctx: TestContext,
	opts: Partial<Parameters<typeof runRecoverToken>[2]> = {},
	target = ORIGIN
) =>
	runRecoverToken(ctx, target, {
		kvNamespace: NS,
		interval: 0,
		globals: globalsFor(ctx),
		...opts
	});

describe('recover-token proof', () => {
	it('writes a hashed, host-bound, one-minute proof and returns the token', async () => {
		const model = site();
		const ctx = context(model);
		await recover(ctx);

		const nonce = model.posts[0]?.nonce as string;
		const put = model.puts[0] as Put;
		expect(put.key).toBe(`recover:mysite.example:${sha256(nonce)}`);
		expect(put.value).toEqual({ host: 'mysite.example', exp: NOW.getTime() + 60_000 });
		expect(put.argv.slice(0, 6)).toEqual([
			'kv',
			'key',
			'put',
			`--namespace-id=${NS}`,
			'--remote',
			'--ttl=60'
		]);
		expect(model.posts[0]?.url).toBe(`${ORIGIN}/recover-token`);
		expect(ctx.io.json<RecoverTokenReport>()).toMatchObject({
			ownerToken: OWNER_TOKEN,
			attempts: 1,
			key: put.key
		});
	});

	// what reaches argv is visible to every process on the machine; only the hash may go there
	it('never puts the nonce on a command line, and never prints the token to stderr', async () => {
		const model = site();
		const ctx = context(model);
		await recover(ctx);
		const nonce = model.posts[0]?.nonce as string;
		expect(nonce).toHaveLength(43);
		expect(model.calls.flatMap((c) => c.args).join(' ')).not.toContain(nonce);
		expect(ctx.io.stderr.join('\n')).not.toContain(OWNER_TOKEN);
		expect(ctx.io.stdout.join('\n')).not.toContain(nonce);
	});

	it('binds the proof to the host, port included', async () => {
		const model = site();
		const ctx = context(model);
		await recover(ctx, {}, 'https://mysite.example:8443');
		expect(model.puts[0]?.key.startsWith('recover:mysite.example:8443:')).toBe(true);
		expect(model.puts[0]?.value.host).toBe('mysite.example:8443');
	});

	it('mints a fresh nonce for every run and presents one nonce within a run', async () => {
		const model = site({ visibleAfter: 2 });
		await recover(context(model));
		await recover(context(model));
		const nonces = model.posts.map((p) => p.nonce);
		expect(new Set(nonces.slice(0, 3)).size).toBe(1);
		expect(new Set(nonces).size).toBe(2);
		expect(mintNonce()).not.toBe(mintNonce());
		expect(proofKey('A.Example', 'n')).toBe(`recover:a.example:${sha256('n')}`);
	});

	it('waits out KV propagation, which is a 404 that names the proof as unknown', async () => {
		const model = site({ visibleAfter: 2 });
		const ctx = context(model);
		await recover(ctx);
		expect(model.posts).toHaveLength(3);
		expect(ctx.io.json<RecoverTokenReport>()).toMatchObject({
			attempts: 3,
			ownerToken: OWNER_TOKEN
		});
	});

	// the worker refuses a client after 12 failures a minute, and a miss is a counted failure
	it('stops before the failure budget and says the run can be repeated', async () => {
		const model = site({ visibleAfter: 99 });
		const ctx = context(model);
		const failure = await recover(ctx, { wait: 10 ** 9 }).catch((e: unknown) => e);
		expect(model.posts).toHaveLength(MAX_ATTEMPTS);
		expect(MAX_ATTEMPTS).toBeLessThan(12);
		expect(failure).toBeInstanceOf(DranglerError);
		expect(failure).toMatchObject({
			retryable: true,
			next: `drangler recover-token ${ORIGIN}`
		});
		expect(ctx.io.json<RecoverTokenReport>().ownerToken).toBeNull();
	});

	it('paces attempts so a default run fits the budget with room to spare', () => {
		expect(attemptsWithin(75_000, 5_000)).toBe(6);
		expect(attemptsWithin(0, 5_000)).toBe(1);
		expect(attemptsWithin(10 ** 9, 0)).toBe(MAX_ATTEMPTS);
	});

	it.each([
		[410, { reason: 'spent' }, /expired or was already used/, true],
		[403, { reason: 'wrong-host' }, /different host/, false],
		[409, { reason: 'unclaimed' }, /nobody has claimed it/, false],
		[501, { reason: 'no-kv' }, /no CONFIG_KV binding/, false],
		[400, { reason: 'malformed', error: 'bad nonce' }, /refused the request: bad nonce/, false]
	])('stops at once on a %s and says why', async (status, body, message, retryable) => {
		const model = site({ respond: () => Response.json(body, { status }) });
		const failure = await recover(context(model)).catch((e: unknown) => e);
		expect(model.posts).toHaveLength(1);
		expect((failure as Error).message).toMatch(message);
		expect((failure as DranglerError).retryable).toBe(retryable);
	});

	it('names the claim command when the site has no token to give', async () => {
		const model = site({ claimed: false });
		const failure = await recover(context(model)).catch((e: unknown) => e);
		expect(failure).toMatchObject({ next: `drangler site claim ${ORIGIN}` });
	});

	it('reports a refused address with the wait the site asked for', async () => {
		const model = site({
			respond: () =>
				new Response(JSON.stringify({ reason: 'rate' }), {
					status: 429,
					headers: { 'retry-after': '42' }
				})
		});
		const failure = await recover(context(model)).catch((e: unknown) => e);
		expect(model.posts).toHaveLength(1);
		expect((failure as Error).message).toContain('try again in 42 seconds');
		expect((failure as DranglerError).retryable).toBe(true);
	});

	// an older worker answers an unknown path with Drupal's own 404 page, which is HTML
	it('does not retry a 404 that is not the proof route speaking', async () => {
		const model = site({
			respond: () => new Response('<html>Page not found</html>', { status: 404 })
		});
		const failure = await recover(context(model)).catch((e: unknown) => e);
		expect(model.posts).toHaveLength(1);
		expect((failure as Error).message).toMatch(
			/does not answer \/recover-token.*predates the route/
		);
		expect(failure).toMatchObject({ next: 'drangler update' });
	});

	it('reports a transport failure as a probe error', async () => {
		const model = site();
		const ctx = context(model, {
			fetch: (async () => {
				throw new Error('connection refused');
			}) as unknown as typeof fetch
		});
		await expect(recover(ctx)).rejects.toBeInstanceOf(ProbeError);
	});

	it('refuses a plain-http origin before writing anything', async () => {
		const model = site();
		await expect(recover(context(model), {}, 'http://mysite.example')).rejects.toBeInstanceOf(
			UsageError
		);
		expect(model.calls).toEqual([]);
	});

	it('--dry-run writes nothing and sends nothing', async () => {
		const model = site();
		const ctx = context(model);
		await recover(ctx, { globals: globalsFor(ctx, { dryRun: true }) });
		expect(model.puts).toEqual([]);
		expect(model.posts).toEqual([]);
		expect(ctx.io.json<RecoverTokenReport>().notes[0]).toMatch(/dry run/);
	});
});

describe('recover-token wrangler', () => {
	it('sends a credential refusal as an auth error and never contacts the site', async () => {
		const model = site({ wranglerFails: 'Authentication error [code: 10000]' });
		const failure = await recover(context(model)).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(AuthError);
		expect((failure as Error).message).toContain('KV edit rights');
		expect(model.posts).toEqual([]);
	});

	it('reports any other wrangler failure by its first line', async () => {
		const model = site({ wranglerFails: 'namespace not found' });
		const failure = await recover(context(model)).catch((e: unknown) => e);
		expect(failure).toMatchObject({ code: 'wrangler' });
		expect((failure as Error).message).toBe(
			'wrangler could not write the proof: namespace not found'
		);
	});

	it('acts on the account --account names', async () => {
		const model = site();
		const ctx = context(model);
		await recover(ctx, { globals: globalsFor(ctx, {}) });
		expect(model.puts[0]?.env?.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
		const named = testGlobals({ json: true }, ctx, { account: 'acct-123' });
		await recover(ctx, { globals: named });
		expect(model.puts[1]?.env?.CLOUDFLARE_ACCOUNT_ID).toBe('acct-123');
	});
});

describe('recover-token namespace', () => {
	const list = (rows: object[]) => JSON.stringify(rows);

	it('prefers --kv-namespace and asks the account nothing', async () => {
		const model = site();
		await recover(context(model));
		expect(model.calls.some((c) => c.args[1] === 'namespace')).toBe(false);
	});

	it('reads the CONFIG_KV id out of a wrangler config in the working directory', async () => {
		const model = site();
		const files = memoryFiles({
			'/work/wrangler.jsonc': `{
				// the ids differ so the right binding has to be chosen
				"kv_namespaces": [{ "binding": "PAGE_KV", "id": "aaaa" }, { "binding": "CONFIG_KV", "id": "${NS}" }]
			}`
		});
		await recover(context(model, { files }), { kvNamespace: undefined });
		expect(model.puts[0]?.argv).toContain(`--namespace-id=${NS}`);
		expect(model.calls.some((c) => c.args[1] === 'namespace')).toBe(false);
	});

	it('falls back to the one namespace on the account with CONFIG_KV in its title', async () => {
		const model = site({
			namespaces: `banner line\n${list([
				{ id: 'bbbb', title: 'drupflare-PAGE_KV' },
				{ id: NS, title: 'drupflare-CONFIG_KV' }
			])}`
		});
		await recover(context(model), { kvNamespace: undefined });
		expect(model.puts[0]?.argv).toContain(`--namespace-id=${NS}`);
	});

	it('refuses to guess between two matches and lists them', async () => {
		const model = site({
			namespaces: list([
				{ id: 'one', title: 'a-CONFIG_KV' },
				{ id: 'two', title: 'b-CONFIG_KV' }
			])
		});
		const failure = await recover(context(model), { kvNamespace: undefined }).catch(
			(e: unknown) => e
		);
		expect(failure).toBeInstanceOf(UsageError);
		expect((failure as Error).message).toMatch(
			/2 KV namespaces.*a-CONFIG_KV: one.*b-CONFIG_KV: two.*--kv-namespace/
		);
		expect(model.puts).toEqual([]);
	});

	it('refuses when no namespace matches', async () => {
		const model = site({ namespaces: list([{ id: 'x', title: 'other' }]) });
		await expect(recover(context(model), { kvNamespace: undefined })).rejects.toThrow(
			/no KV namespace on this account has CONFIG_KV/
		);
	});
});

describe('recover-token keychain', () => {
	it('does not touch the keychain without --store', async () => {
		const keychain = memoryKeychain();
		const ctx = context(site(), { keychain });
		await recover(ctx);
		expect(keychain.entries.size).toBe(0);
		expect(ctx.io.json<RecoverTokenReport>().stored).toBe('not requested');
	});

	it('--store writes it, then reports already, then replaces a stale one', async () => {
		const keychain = memoryKeychain();
		const first = context(site(), { keychain });
		await recover(first, { store: true });
		expect(keychain.entries.get(ORIGIN)).toBe(OWNER_TOKEN);
		expect(first.io.json<RecoverTokenReport>().stored).toBe('stored');

		const again = context(site(), { keychain });
		await recover(again, { store: true });
		expect(again.io.json<RecoverTokenReport>().stored).toBe('already');

		keychain.entries.set(ORIGIN, 'stale');
		const stale = context(site(), { keychain });
		await recover(stale, { store: true });
		expect(keychain.entries.get(ORIGIN)).toBe(OWNER_TOKEN);
		expect(stale.io.json<RecoverTokenReport>().stored).toBe('replaced');
	});

	it('still prints the token, with one notice, when there is no keychain', async () => {
		const ctx = context(site(), { keychain: unavailableKeychain('no secret service') });
		await recover(ctx, { store: true });
		const report = ctx.io.json<RecoverTokenReport>();
		expect(report).toMatchObject({ ownerToken: OWNER_TOKEN, stored: 'unavailable' });
		expect(ctx.io.stderr).toHaveLength(1);
		expect(ctx.io.stderr[0]).toContain('system keychain unavailable (no secret service)');
	});

	it('prints the token as text on stdout when --json is off', async () => {
		const ctx = context(site());
		await recover(ctx, { globals: globalsFor(ctx, { json: false }) });
		expect(ctx.io.text()).toMatch(new RegExp(`owner token\\s+${OWNER_TOKEN}`));
	});
});

describe('recover-token command name', () => {
	const recoverCommand = (ctx: TestContext) =>
		buildProgram(ctx).commands.find((c) => c.name() === 'recover');

	it('is a top-level command of its own', () => {
		const ctx = testContext();
		const names = buildProgram(ctx).commands.map((c) => c.name());
		expect(names).toContain('recover-token');
		expect(names).toContain('recover');
	});

	// `drangler recover` is point-in-time recovery; a subcommand there would shadow its [target]
	it('leaves `drangler recover` without subcommands and with its own options', () => {
		const command = recoverCommand(testContext());
		expect(command?.commands).toEqual([]);
		expect(command?.options.map((o) => o.long)).toEqual(['--at', '--bookmark', '--yes']);
	});

	it('renders help for both', async () => {
		for (const name of ['recover', 'recover-token']) {
			const ctx = testContext();
			expect(await run(ctx, [name, '--help'])).toBe(EXIT.OK);
			expect(ctx.io.text()).toContain(`Usage: drangler ${name} `);
		}
	});

	it('runs end to end through the parser, storing with --store', async () => {
		const model = site();
		const keychain = memoryKeychain();
		const ctx = context(model, { keychain });
		const code = await run(ctx, [
			'--json',
			'recover-token',
			ORIGIN,
			'--store',
			'--kv-namespace',
			NS,
			'--interval',
			'0'
		]);
		expect(code).toBe(EXIT.OK);
		expect(ctx.io.json<RecoverTokenReport>().ownerToken).toBe(OWNER_TOKEN);
		expect(keychain.entries.get(ORIGIN)).toBe(OWNER_TOKEN);
	});
});

/**
 * The proof key, against the sibling rather than against drangler's own copy.
 *
 * The client writes the key and the site derives it again from the request, so two implementations
 * of one formula have to agree byte for byte or no proof ever matches. The vector below also sits
 * the worker's `owner-recovery.spec.ts`. Skips when the sibling is absent and FAILS under
 * `REQUIRE_SIBLINGS=1`, like `tests/modify-rev.spec.ts`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const RECOVERY = resolve(HERE, '..', '..', 'worker', 'src', 'ops', 'owner-recovery.ts');
const recoverySource = existsSync(RECOVERY) ? readFileSync(RECOVERY, 'utf8') : null;
if (recoverySource === null && process.env.REQUIRE_SIBLINGS) {
	throw new Error(
		`no worker checkout at ${RECOVERY}, and REQUIRE_SIBLINGS says this lane has one.`
	);
}

describe('the proof key', () => {
	it('is the golden vector the worker spec pins', () => {
		expect(proofKey('mysite.example', 'a'.repeat(43))).toBe(
			'recover:mysite.example:66d34fba71f8f450f7e45598853e53bfc23bbd129027cbb131a2f4ffd7878cd0'
		);
	});

	it('uses a 60 second TTL the worker accepts as a life', () => {
		expect(RECOVER_TTL_S).toBe(60);
	});
});

describe.skipIf(recoverySource === null)('the proof key tracks the worker', () => {
	const literal = (name: string) =>
		new RegExp(`export const ${name} = ('([^']*)'|([0-9_]+));`).exec(recoverySource as string);

	it('uses the same route and key prefix', () => {
		expect(literal('RECOVER_PATH')?.[2]).toBe('/recover-token');
		expect(literal('RECOVER_KEY_PREFIX')?.[2]).toBe(RECOVER_KEY_PREFIX);
	});

	// a record claiming more than the worker allows is refused as malformed
	it('writes a life the worker will not refuse as too long', () => {
		const max = Number(literal('RECOVER_MAX_LIFE_MS')?.[3]?.replaceAll('_', ''));
		expect(RECOVER_TTL_S * 1000).toBeLessThanOrEqual(max);
	});

	it('hashes with sha256 over the host and the nonce, as the key function does', () => {
		expect(recoverySource).toContain("crypto.subtle.digest('SHA-256'");
		expect(recoverySource).toContain(
			'${RECOVER_KEY_PREFIX}:${host.toLowerCase()}:${await sha256Hex(nonce)}'
		);
	});
});
