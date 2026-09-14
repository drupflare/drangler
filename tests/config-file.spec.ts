import { describe, expect, it } from 'vitest';
import { runConfigWhere } from '../src/commands/config';
import {
	discoverConfigs,
	findProjectConfig,
	globalConfigPath,
	PROJECT_CONFIG_NAME,
	resolveConfig,
	siteOrigin
} from '../src/config/file';
import { DEFAULT_TIMEOUT_MS, resolveGlobals, withVerbosity } from '../src/config/globals';
import { UsageError } from '../src/errors';
import { scriptedRunner } from '../src/host/exec';
import { memoryFiles } from '../src/host/files';
import { fakeFetch, ok, testContext } from './helpers';

const HOME = '/home/me';
const CWD = '/home/me/work/mantle2';
const GLOBAL = `${HOME}/.config/drangler/config.json`;
const PROJECT = `${CWD}/${PROJECT_CONFIG_NAME}`;

const project = (over: object = {}) =>
	JSON.stringify({ site: { origin: 'https://project.example', name: 'blog' }, ...over });

const global = (over: object = {}) =>
	JSON.stringify({ site: { origin: 'https://global.example' }, ...over });

const host = (files: Record<string, string> = {}, env: NodeJS.ProcessEnv = {}) =>
	testContext({ files: memoryFiles(files), env: { HOME, ...env }, cwd: CWD });

describe('discovery', () => {
	it('finds a drangler.json in an ancestor, not only in the working directory', () => {
		const files = memoryFiles({ [`${HOME}/work/${PROJECT_CONFIG_NAME}`]: '{}' });
		expect(findProjectConfig(files, CWD)).toBe(`${HOME}/work/${PROJECT_CONFIG_NAME}`);
	});

	it('returns null when no ancestor has one, rather than walking off the root', () => {
		expect(findProjectConfig(memoryFiles({}), CWD)).toBeNull();
	});

	it('prefers XDG_CONFIG_HOME over the home directory for the global file', () => {
		expect(globalConfigPath({ HOME, XDG_CONFIG_HOME: '/xdg' })).toBe(
			'/xdg/drangler/config.json'
		);
		expect(globalConfigPath({ HOME })).toBe(GLOBAL);
	});

	it('reads the project file before the global one', () => {
		const sources = discoverConfigs(host({ [PROJECT]: project(), [GLOBAL]: global() }));
		expect(sources.map((s) => s.scope)).toEqual(['project', 'global']);
	});

	// a config file people edit by hand must not fail open; a dropped setting is silent
	it('refuses an unparseable file rather than treating it as absent', () => {
		expect(() => discoverConfigs(host({ [PROJECT]: '{' }))).toThrow(UsageError);
		expect(() => discoverConfigs(host({ [PROJECT]: '[]' }))).toThrow(/JSON object/);
	});

	it('lets --config-file replace the search rather than join it', () => {
		const sources = discoverConfigs(
			host({ [PROJECT]: project(), [GLOBAL]: global(), '/tmp/one.json': global() }),
			{ configFile: '/tmp/one.json' }
		);
		expect(sources.map((s) => s.path)).toEqual(['/tmp/one.json']);
	});

	it('refuses a --config-file that is not there', () => {
		expect(() => discoverConfigs(host({}), { configFile: '/tmp/none.json' })).toThrow(
			/no config file at/
		);
	});
});

/**
 * The five precedences, most specific first.
 *
 * Flag, environment, project file, global file, built-in default. The environment sits above both
 * files for the same reason it sits above the working directory in `resolveWorkspace`: an explicit
 * setting outranks one inferred from where the shell is.
 */
describe('precedence', () => {
	const files = { [PROJECT]: project(), [GLOBAL]: global() };

	it('takes the flag first', () => {
		const resolved = resolveConfig(host(files, { DRANGLER_SITE: 'https://env.example' }), {
			site: 'https://flag.example'
		});
		expect(resolved.site).toMatchObject({ value: 'https://flag.example', origin: 'flag' });
	});

	it('takes the environment next', () => {
		const resolved = resolveConfig(host(files, { DRANGLER_SITE: 'https://env.example' }));
		expect(resolved.site).toMatchObject({
			value: 'https://env.example',
			origin: 'env',
			from: 'DRANGLER_SITE'
		});
	});

	it('takes the project file next', () => {
		const resolved = resolveConfig(host(files));
		expect(resolved.site).toMatchObject({
			value: 'https://project.example',
			origin: 'project',
			from: PROJECT
		});
	});

	it('takes the global file next', () => {
		const resolved = resolveConfig(host({ [GLOBAL]: global() }));
		expect(resolved.site).toMatchObject({
			value: 'https://global.example',
			origin: 'global',
			from: GLOBAL
		});
	});

	// no built-in default for either: `?site=` is honoured only on a route that is not public, so a
	// name nobody asked for splits `site claim` from every owner call that follows it
	it('reports unset rather than inventing a site or a site name', () => {
		const resolved = resolveConfig(host({}));
		expect(resolved.siteName).toMatchObject({ value: null, origin: 'unset' });
		expect(resolved.site).toMatchObject({ value: null, origin: 'unset' });
	});
});

describe('profiles', () => {
	const withProfile = JSON.stringify({
		site: { origin: 'https://prod.example', name: 'site' },
		workspace: '/ws/prod',
		profiles: { staging: { site: { origin: 'https://staging.example' } } }
	});

	it('overrides the top level key by key', () => {
		const resolved = resolveConfig(host({ [PROJECT]: withProfile }), { profile: 'staging' });
		expect(resolved.site.value).toBe('https://staging.example');
		// the profile named no workspace, so the top-level one survives
		expect(resolved.workspace.value).toBe('/ws/prod');
		// nor a site name, so the top-level one survives too
		expect(resolved.siteName.value).toBe('site');
	});

	it('reads the profile from the environment when no flag names one', () => {
		const resolved = resolveConfig(
			host({ [PROJECT]: withProfile }, { DRANGLER_PROFILE: 'staging' })
		);
		expect(resolved.site.value).toBe('https://staging.example');
	});

	// a typo would otherwise resolve to the top-level block and look like it worked
	it('refuses a profile no file declares', () => {
		expect(() =>
			resolveConfig(host({ [PROJECT]: withProfile }), { profile: 'stagng' })
		).toThrow(/no `stagng` profile/);
	});

	it('does not refuse the default profile, which no file has to declare', () => {
		expect(resolveConfig(host({ [PROJECT]: withProfile })).site.value).toBe(
			'https://prod.example'
		);
	});
});

/**
 * The owner token is a credential, so the project file cannot supply it.
 *
 * `drangler.json` is a file people commit. The token lives in the global config keyed by origin,
 * which is also why it resolves after the site does.
 */
describe('the owner token', () => {
	const site = 'https://mysite.example';
	const globalWithToken = JSON.stringify({ sites: { [site]: { ownerToken: 'tok-global' } } });
	const projectWithToken = JSON.stringify({
		site: { origin: site },
		sites: { [site]: { ownerToken: 'tok-project' } }
	});

	it('reads it from the global file, keyed by the resolved origin', () => {
		const resolved = resolveConfig(host({ [GLOBAL]: globalWithToken }), { site });
		expect(resolved.token).toMatchObject({ value: 'tok-global', origin: 'global' });
	});

	it('never reads it from the project file', () => {
		const resolved = resolveConfig(host({ [PROJECT]: projectWithToken }));
		expect(resolved.token.value).toBeNull();
	});

	it('prefers the environment and then the flag', () => {
		expect(
			resolveConfig(
				host({ [GLOBAL]: globalWithToken }, { DRUPFLARE_OWNER_TOKEN: 'tok-env' }),
				{
					site
				}
			).token
		).toMatchObject({ value: 'tok-env', origin: 'env' });
		expect(
			resolveConfig(host({ [GLOBAL]: globalWithToken }), { site, token: 'tok-flag' }).token
		).toMatchObject({ value: 'tok-flag', origin: 'flag' });
	});

	it('finds no token for a site the global file does not name', () => {
		const resolved = resolveConfig(host({ [GLOBAL]: globalWithToken }), {
			site: 'https://other.example'
		});
		expect(resolved.token.value).toBeNull();
	});
});

/**
 * `--site` is an ORIGIN and `--site-name` is the Durable Object identity.
 *
 * They used to be one string with two meanings: the identity on `status`, `health` and
 * `migrate export`, an origin on `migrate plan`. A bare word has to fail loudly rather than resolve
 * to `https://blog`, which is somebody else's hostname.
 */
describe('siteOrigin', () => {
	it('normalises an origin, with or without a scheme', () => {
		expect(siteOrigin('mysite.example')).toBe('https://mysite.example');
		expect(siteOrigin('https://mysite.example/')).toBe('https://mysite.example');
	});

	it('accepts a local dev origin, which has no dot', () => {
		expect(siteOrigin('http://localhost:8787')).toBe('http://localhost:8787');
		expect(siteOrigin('localhost:8787')).toBe('https://localhost:8787');
	});

	it('refuses a bare word and names the flag that takes one', () => {
		expect(() => siteOrigin('blog')).toThrow(UsageError);
		expect(() => siteOrigin('blog')).toThrow(/--site-name/);
	});

	it('refuses a bare word arriving from a config file too, naming the file', () => {
		expect(() =>
			resolveConfig(host({ [PROJECT]: JSON.stringify({ site: { origin: 'blog' } }) }))
		).toThrow(new RegExp(PROJECT));
	});
});

describe('resolveGlobals', () => {
	it('refuses --quiet and --verbose together', () => {
		expect(() => resolveGlobals(host({}), { quiet: true, verbose: true })).toThrow(
			/opposite things/
		);
	});

	it('refuses a timeout that is not a positive number, and defaults when absent', () => {
		expect(() => resolveGlobals(host({}), { timeout: 'abc' })).toThrow(/positive number/);
		expect(() => resolveGlobals(host({}), { timeout: '0' })).toThrow(UsageError);
		expect(resolveGlobals(host({})).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
		expect(resolveGlobals(host({}), { timeout: '900' }).timeoutMs).toBe(900);
	});

	it('carries the booleans through as booleans', () => {
		expect(resolveGlobals(host({}), { json: true, yes: true, dryRun: true })).toMatchObject({
			json: true,
			yes: true,
			dryRun: true,
			quiet: false,
			verbose: false
		});
	});
});

/**
 * `--quiet` and `--verbose` act on stderr only.
 *
 * stdout carries exactly one report either way, which is what keeps `--json` parseable. `run.ts`
 * holds the unwrapped context, so a quiet run still prints the error that ended it.
 */
describe('withVerbosity', () => {
	it('drops progress on stderr under --quiet and leaves stdout alone', () => {
		const ctx = host({});
		const quiet = withVerbosity(ctx, resolveGlobals(ctx, { quiet: true }));
		quiet.io.err('progress');
		quiet.io.out('report');
		expect(ctx.io.stderr).toEqual([]);
		expect(ctx.io.stdout).toEqual(['report']);
	});

	it('traces every subprocess and every request under --verbose', async () => {
		const ctx = testContext({
			env: { HOME },
			cwd: CWD,
			files: memoryFiles({}),
			runner: scriptedRunner({ 'git --version': ok('git version 2.39.5') }),
			fetch: fakeFetch(() => new Response('{}'))
		});
		const verbose = withVerbosity(ctx, resolveGlobals(ctx, { verbose: true }));
		await verbose.runner.run('git', ['--version']);
		await verbose.fetch('https://x.dev/serve');
		expect(ctx.io.stderr).toEqual(['$ git --version', '> GET https://x.dev/serve']);
	});

	it('changes nothing when neither flag is given', () => {
		const ctx = host({});
		expect(withVerbosity(ctx, resolveGlobals(ctx))).toBe(ctx);
	});
});

describe('config where', () => {
	it('names the file that supplied each value', () => {
		const ctx = host({ [PROJECT]: project(), [GLOBAL]: global({ account: 'acct-123' }) });
		runConfigWhere(ctx, resolveConfig(ctx));
		const text = ctx.io.text();
		expect(text).toMatch(new RegExp(`site\\s+https://project.example\\s+${PROJECT}`));
		expect(text).toMatch(new RegExp(`account\\s+acct-123\\s+${GLOBAL}`));
		expect(text).toContain('siteName');
	});

	it('says what it searched when it found nothing', () => {
		const ctx = host({});
		runConfigWhere(ctx, resolveConfig(ctx));
		expect(ctx.io.text()).toContain('none; searched:');
		expect(ctx.io.text()).toContain(GLOBAL);
		expect(ctx.io.text()).toContain('nothing set it');
	});

	// the command someone runs when they are confused is a bad place to put a credential on screen
	it('reports the token as set and never prints it', () => {
		const ctx = host({
			[GLOBAL]: JSON.stringify({
				site: { origin: 'https://mysite.example' },
				sites: { 'https://mysite.example': { ownerToken: 'tok-secret' } }
			})
		});
		runConfigWhere(ctx, resolveConfig(ctx), { json: true });
		const report = JSON.stringify(ctx.io.json());
		expect(report).toContain('"value":"set"');
		expect(report).not.toContain('tok-secret');
	});
});
