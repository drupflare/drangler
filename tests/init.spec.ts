import { describe, expect, it } from 'vitest';
import { INTENTS, orientation, runInit, type InitReport } from '../src/commands/init';
import { resolveConfig, type DranglerConfig } from '../src/config/file';
import type { Ask } from '../src/context';
import { EXIT, UsageError } from '../src/errors';
import { scriptedRunner } from '../src/host/exec';
import { memoryFiles } from '../src/host/files';
import { run } from '../src/run';
import { VERSION } from '../src/version';
import { fakeFetch, ok, testContext, testGlobals, type TestContext } from './helpers';

const HOME = '/home/me';
const CWD = '/home/me/work/mantle2';
const GLOBAL = `${HOME}/.config/drangler/config.json`;
const PROJECT = `${CWD}/drangler.json`;

const SITE_HEADERS = { 'x-cfw-cache': 'MISS', 'x-cfw-v': '2', 'x-cfw-account-plan': 'free' };

/** `/serve` answers with the worker headers and `/firstrun` reports whether anyone owns it */
const deployed = (claimed = true) =>
	fakeFetch((url) =>
		url.includes('/firstrun')
			? new Response(JSON.stringify({ ok: true, configured: claimed, firstRunAt: null }))
			: new Response('<html></html>', { status: 200, headers: SITE_HEADERS })
	);

/** every answer scripted in order, so a spec drives the wizard the way a person would */
function scriptedAsk(answers: string[]): Ask & { asked: string[] } {
	const asked: string[] = [];
	const ask: Ask = async (question) => {
		asked.push(question);
		return answers.shift() ?? null;
	};
	return Object.assign(ask, { asked });
}

function ctxFor(over: Partial<TestContext> = {}, files: Record<string, string> = {}): TestContext {
	return testContext({
		cwd: CWD,
		env: { HOME },
		files: memoryFiles(files),
		fetch: deployed(),
		...over
	});
}

const globalsFor = (ctx: TestContext, over = {}) => testGlobals(over, ctx);

const reportOf = (ctx: TestContext): InitReport => ctx.io.json<InitReport>();

describe('orientation', () => {
	it('prints six lines and the version, not commander help', () => {
		const ctx = ctxFor();
		const lines = orientation(resolveConfig(ctx));
		expect(lines[0]).toBe(`drangler ${VERSION}`);
		expect(lines.join('\n')).toContain('Nothing is configured yet.');
		expect(lines.join('\n')).toContain('drangler init');
		expect(lines.join('\n')).toContain('drangler --help');
		expect(lines.join('\n')).not.toContain('Usage: drangler');
	});

	it('names the configured site and the file it came from', () => {
		const ctx = ctxFor(
			{},
			{ [PROJECT]: JSON.stringify({ site: { origin: 'https://x.dev' } }) }
		);
		expect(orientation(resolveConfig(ctx)).join('\n')).toContain(
			`Configured for https://x.dev, from ${PROJECT}`
		);
	});

	it('is what a bare `drangler` runs, at exit 0', async () => {
		const ctx = ctxFor();
		expect(await run(ctx, [])).toBe(EXIT.OK);
		expect(ctx.io.text()).toContain(`drangler ${VERSION}`);
		expect(ctx.io.text()).not.toContain('Usage: drangler');
	});
});

/**
 * The first question decides which of the rest are asked at all.
 *
 * That is what keeps the wizard at five questions rather than five per branch: running locally needs
 * no origin, no token and no Cloudflare account, and asking for them anyway is how a wizard becomes
 * something people skip.
 */
describe('question 1, every branch', () => {
	it.each(INTENTS)('accepts --intent %s', async (intent) => {
		const ctx = ctxFor();
		await runInit(ctx, {
			intent,
			write: 'none',
			globals: globalsFor(ctx, { json: true, config: resolveConfig(ctx, { site: 'x.dev' }) })
		});
		expect(reportOf(ctx).intent).toBe(intent);
	});

	it('asks nothing about a site when the answer is `local`', async () => {
		const ask = scriptedAsk([]);
		const ctx = ctxFor({ ask, fetch: fakeFetch(() => new Response('', { status: 500 })) });
		await runInit(ctx, {
			intent: 'local',
			write: 'none',
			globals: globalsFor(ctx, { json: true })
		});
		const report = reportOf(ctx);
		expect(report.site).toBeNull();
		expect(report.reachable).toBeNull();
		expect(report.next).toEqual(['drangler dev']);
		expect(ask.asked).toEqual([]);
	});

	it('probes the site for `connect`, and reports the tier and the claim state', async () => {
		const ctx = ctxFor();
		await runInit(ctx, {
			intent: 'connect',
			write: 'none',
			globals: globalsFor(ctx, {
				json: true,
				config: resolveConfig(ctx, { site: 'https://mysite.example' })
			})
		});
		const report = reportOf(ctx);
		expect(report).toMatchObject({
			site: 'https://mysite.example',
			reachable: true,
			drupflare: true,
			tier: 'MISS',
			claimed: 'claimed'
		});
	});

	it('resolves the Cloudflare account only for `deploy`', async () => {
		const runner = scriptedRunner({
			'wrangler --version': ok('wrangler 4.20.0'),
			'wrangler whoami': ok('me@example.com\n0123456789abcdef0123456789abcdef')
		});
		const ctx = ctxFor({ runner });
		const globals = globalsFor(ctx, {
			json: true,
			config: resolveConfig(ctx, { site: 'https://mysite.example' })
		});
		await runInit(ctx, { intent: 'deploy', write: 'none', globals });
		expect(reportOf(ctx).account).toBe('0123456789abcdef0123456789abcdef');

		const other = ctxFor({ runner });
		await runInit(other, {
			intent: 'module',
			write: 'none',
			globals: globalsFor(other, {
				json: true,
				config: resolveConfig(other, { site: 'https://mysite.example' })
			})
		});
		expect(reportOf(other).account).toBeNull();
	});

	it('refuses an intent outside the set', async () => {
		const ctx = ctxFor();
		await expect(
			runInit(ctx, { intent: 'sideways', write: 'none', globals: globalsFor(ctx) })
		).rejects.toThrow(UsageError);
	});
});

describe('the prompts', () => {
	it('asks for the intent and the origin when neither is given', async () => {
		const ask = scriptedAsk(['connect', 'mysite.example', 'none']);
		const ctx = ctxFor({ ask });
		await runInit(ctx, { globals: globalsFor(ctx, { json: true }) });
		expect(ask.asked[0]).toContain('What are you doing here?');
		expect(ask.asked[1]).toContain('Site origin?');
		expect(reportOf(ctx).site).toBe('https://mysite.example');
	});

	// a wizard blocking on a pipe is a hung CI job, so the refusal names the flag instead
	it('exits 2 naming the flag when there is no terminal to ask on', async () => {
		const ctx = ctxFor({ ask: async () => null });
		await expect(runInit(ctx, { globals: globalsFor(ctx) })).rejects.toThrow(/--intent/);
		expect(await run(ctx, ['init'])).toBe(EXIT.USAGE);
	});

	it('refuses a bare word as the site origin', async () => {
		const ctx = ctxFor({ ask: scriptedAsk(['connect', 'blog']) });
		await expect(runInit(ctx, { globals: globalsFor(ctx) })).rejects.toThrow(/--site-name/);
	});

	it('does not ask where to write under --yes', async () => {
		const ask = scriptedAsk(['local']);
		const ctx = ctxFor({ ask });
		await runInit(ctx, { globals: globalsFor(ctx, { json: true, yes: true }) });
		expect(ask.asked).toHaveLength(1);
		expect(reportOf(ctx).write).toBe('project');
	});
});

/**
 * Where each answer lands, and the one that may not land in a committed file.
 *
 * `drangler.json` gets the origin and the site name. The owner token goes to the global config
 * through the restricted-write seam, whatever `--write` says, because the project file is a file
 * people commit.
 */
describe('writing the answers', () => {
	const withToken = (ctx: TestContext) =>
		globalsFor(ctx, {
			json: true,
			config: resolveConfig(ctx, { site: 'https://mysite.example', token: 'tok-123' })
		});

	it('writes the origin and the site name to drangler.json', async () => {
		const files = memoryFiles({});
		const ctx = ctxFor({ files });
		await runInit(ctx, {
			intent: 'connect',
			write: 'project',
			globals: globalsFor(ctx, {
				json: true,
				config: resolveConfig(ctx, { site: 'https://mysite.example', siteName: 'blog' })
			})
		});
		expect(JSON.parse(files.written.get(PROJECT) as string)).toEqual({
			site: { origin: 'https://mysite.example', name: 'blog' }
		});
		expect(reportOf(ctx).wrote).toEqual([PROJECT]);
	});

	it('keeps the owner token out of drangler.json and writes it restricted', async () => {
		const files = memoryFiles({});
		const ctx = ctxFor({ files });
		await runInit(ctx, { intent: 'connect', write: 'project', globals: withToken(ctx) });

		expect(files.written.get(PROJECT)).not.toContain('tok-123');
		expect(files.written.get(GLOBAL)).toContain('tok-123');
		expect(files.secrets.has(GLOBAL)).toBe(true);
		expect(files.secrets.has(PROJECT)).toBe(false);
	});

	it('keys the token by origin and keeps the ones already there', async () => {
		const files = memoryFiles({
			[GLOBAL]: JSON.stringify({ sites: { 'https://other.example': { ownerToken: 'keep' } } })
		});
		const ctx = ctxFor({ files });
		await runInit(ctx, { intent: 'connect', write: 'global', globals: withToken(ctx) });
		const written = JSON.parse(files.written.get(GLOBAL) as string) as DranglerConfig;
		expect(written.sites?.['https://other.example']?.ownerToken).toBe('keep');
		expect(written.sites?.['https://mysite.example']?.ownerToken).toBe('tok-123');
		expect(written.site?.origin).toBe('https://mysite.example');
	});

	it('writes nothing under --write none, and says so', async () => {
		const files = memoryFiles({});
		const ctx = ctxFor({ files });
		await runInit(ctx, {
			intent: 'connect',
			write: 'none',
			globals: globalsFor(ctx, {
				config: resolveConfig(ctx, { site: 'https://mysite.example' })
			})
		});
		expect(files.written.size).toBe(0);
		expect(ctx.io.text()).toContain('pass --write project or --write global');
	});

	/**
	 * Reachable only through `--config-file`, which replaces the search.
	 *
	 * Any other route reads the global file during resolution and refuses there first. With the
	 * search replaced nothing has read it, so the write path is the last thing between a broken file
	 * and a clobbered one.
	 */
	it('refuses to overwrite a global config it cannot parse', async () => {
		const ctx = ctxFor({}, { [GLOBAL]: 'not json', '/tmp/one.json': '{}' });
		const globals = testGlobals({ json: true }, ctx, {
			configFile: '/tmp/one.json',
			site: 'https://mysite.example',
			token: 'tok-123'
		});
		await expect(runInit(ctx, { intent: 'connect', write: 'global', globals })).rejects.toThrow(
			/will not overwrite it/
		);
	});
});

describe('what it tells the user to do next', () => {
	it('names the claim step on a site nobody owns yet', async () => {
		const ctx = ctxFor({ fetch: deployed(false) });
		await runInit(ctx, {
			intent: 'connect',
			write: 'none',
			globals: globalsFor(ctx, {
				json: true,
				config: resolveConfig(ctx, { site: 'https://mysite.example' })
			})
		});
		const report = reportOf(ctx);
		expect(report.claimed).toBe('unclaimed');
		expect(report.token).toBe(false);
		expect(report.next.join(' ')).toContain('POST /firstrun');
	});

	it('reports an origin that did not answer rather than abandoning the answers', async () => {
		const ctx = ctxFor({
			fetch: fakeFetch(() => {
				throw new Error('ENOTFOUND');
			})
		});
		await runInit(ctx, {
			intent: 'connect',
			write: 'none',
			globals: globalsFor(ctx, {
				json: true,
				config: resolveConfig(ctx, { site: 'https://mysite.example' })
			})
		});
		expect(reportOf(ctx)).toMatchObject({ reachable: false, claimed: null });
	});

	it('says an origin that answered is not a drupflare worker', async () => {
		const ctx = ctxFor({ fetch: fakeFetch(() => new Response('<html></html>')) });
		await runInit(ctx, {
			intent: 'connect',
			write: 'none',
			globals: globalsFor(ctx, {
				config: resolveConfig(ctx, { site: 'https://mysite.example' })
			})
		});
		expect(ctx.io.text()).toContain('not a drupflare worker');
	});
});
