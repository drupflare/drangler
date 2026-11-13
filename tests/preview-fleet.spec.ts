import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	cloneWorkspace,
	planDigest,
	readFleet,
	runFleetCommand,
	saveFleet,
	type FleetOptions
} from '../src/commands/preview-fleet';
import { readReceipt, writeReceipt } from '../src/commands/preview-receipt';
import { nodeRunner, type CommandResult } from '../src/host/exec';
import { nodeFiles } from '../src/host/files';
import type { Transport } from '../src/migrate/transport';
import { ok, testContext, testGlobals } from './helpers';

const DOCROOT = '/opt/drupal/web';
const LISTING = ['index.php', 'autoload.php', 'update.php']
	.map((n) => `${DOCROOT}/${n}`)
	.join('\n');
const UUID = {
	'site-a': 'aaaaaaaa-0000-4000-8000-000000000001',
	'site-b': 'bbbbbbbb-0000-4000-8000-000000000002'
};
const row = (uuid: string) => `a:2:{s:4:"uuid";s:36:"${uuid}";s:4:"name";s:1:"x";}`;
const settings = (db: string, driver: string, host: string) =>
	`<?php\n$databases['default']['default'] = array (\n  'database' => '${db}',\n  'driver' => '${driver}',\n  'host' => '${host}',\n  'prefix' => '',\n);\n`;
const drush = (host: string) =>
	`${DOCROOT.replace('/web', '')}/vendor/bin/drush --root=${DOCROOT} --uri=http://${host}`;

/** the multisite fixture as ssh shows it: one vhost naming no host, a symlinked root, three hosts */
function fixtureHost(over: Record<string, CommandResult> = {}): Transport {
	const answers: Record<string, CommandResult> = {
		'id -u': ok('33\n'),
		'ls /etc/apache2/sites-enabled': ok('000-default.conf\n'),
		'cat /etc/apache2/sites-enabled/000-default.conf': ok(
			'<VirtualHost *:80>\n\tDocumentRoot /var/www/html\n</VirtualHost>\n'
		),
		'readlink -f /var/www/html': ok(`${DOCROOT}\n`),
		[`find ${DOCROOT} -maxdepth 1 -type f`]: ok(LISTING),
		'ls /opt/drupal/vendor/bin': ok('drush\n'),
		[`ls ${DOCROOT}/sites`]: ok('default\nsite-a\nsite-b\nsites.php\n'),
		[`cat ${DOCROOT}/sites/sites.php`]: ok(
			"<?php\n$sites['site-a.fixture.localhost'] = 'site-a';\n$sites['alias-a.fixture.localhost'] = 'site-a';\n$sites['site-b.fixture.localhost'] = 'site-b';\n"
		),
		[`cat ${DOCROOT}/sites/site-a/settings.php`]: ok(settings('site_a', 'mysql', 'mysql')),
		[`cat ${DOCROOT}/sites/site-b/settings.php`]: ok(settings('site_b', 'pgsql', 'postgres')),
		[`${drush('site-a.fixture.localhost')} sql:query "SELECT data FROM config WHERE name = 'system.site'"`]:
			ok(row(UUID['site-a'])),
		[`${drush('site-b.fixture.localhost')} sql:query "SELECT data FROM config WHERE name = 'system.site'"`]:
			ok(row(UUID['site-b'])),
		...over
	};
	return {
		label: 'fixture',
		async exec(command) {
			return answers[command] ?? { code: 2, stdout: '', stderr: 'No such file or directory' };
		},
		async download() {
			throw new Error('planning downloads nothing');
		}
	};
}

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
	const dir = mkdtempSync(join(tmpdir(), 'drangler-fleet-'));
	scratch.push(dir);
	const worker = join(dir, 'worker');
	mkdirSync(worker, { recursive: true });
	writeFileSync(join(worker, 'package.json'), '{"name":"@drupflare/worker","version":"1.0.4"}');
	writeFileSync(join(worker, '.dev.vars'), 'PW_DIAGNOSTICS=secret\n');
	mkdirSync(join(worker, '.wrangler'), { recursive: true });
	writeFileSync(join(worker, 'a.txt'), 'a');
	const base = join(dir, 'fleet');
	const ctx = testContext({ files: nodeFiles(), runner: nodeRunner(), cwd: dir });
	const options = (over: Partial<FleetOptions> = {}): FleetOptions => ({
		host: 'www-data@127.0.0.1:2280',
		login: 'admin',
		confirm: '127.0.0.1',
		out: base,
		workspaceFrom: worker,
		transport: fixtureHost(),
		globals: testGlobals({}, ctx),
		...over
	});
	return { ctx: { ...ctx, env: { DRANGLER_PREVIEW_PASSWORD: 'pw' } }, base, worker, options };
}

/** a one-site preview that ends the way a real one does: with a receipt, or with a throw */
function sites(behave: (site: string, attempt: number) => 'verified' | 'claimed' | Error) {
	const seen: {
		site: string;
		out: string;
		port: unknown;
		expectUuid: unknown;
		epoch: unknown;
	}[] = [];
	const counts = new Map<string, number>();
	const runSite: FleetOptions['runSite'] = async (ctx, o) => {
		const site = String(o.site);
		const attempt = (counts.get(site) ?? 0) + 1;
		counts.set(site, attempt);
		seen.push({ site, out: o.out!, port: o.port, expectUuid: o.expectUuid, epoch: o.epoch });
		const result = behave(site, attempt);
		if (result instanceof Error) throw result;
		// the real run writes the receipt from the identity it read; this one reads the same plan
		const digest = JSON.parse(ctx.files.readText(join(o.out!, 'source-site.json')))
			.digest as string;
		writeReceipt(ctx, o.out!, {
			origin: `http://localhost:${o.port}`,
			source: digest,
			epoch: o.epoch ?? 0,
			revision: '1.0.4',
			state: result,
			findings: []
		});
	};
	return { runSite, seen, counts };
}

describe('the fleet plan', () => {
	it('makes two actions of three hosts, and keeps the alias as an attribute of its site', async () => {
		const h = harness();
		const { runSite, seen } = sites(() => 'verified');
		const wrapped: FleetOptions['runSite'] = async (ctx, o) => {
			// stand in for the identity file the real run writes
			const { planFleet } = await import('../src/commands/preview-fleet');
			const { plan } = await planFleet(ctx, h.options());
			const site = plan.sites.find((s) => s.host === o.site)!;
			ctx.files.writeText(
				join(o.out!, 'source-site.json'),
				JSON.stringify({ digest: site.digest })
			);
			return await runSite(ctx, o);
		};
		await runFleetCommand(h.ctx, h.options({ runSite: wrapped }));
		expect(seen.map((s) => s.site)).toEqual([
			'site-a.fixture.localhost',
			'site-b.fixture.localhost'
		]);
		expect(seen.map((s) => s.expectUuid)).toEqual([UUID['site-a'], UUID['site-b']]);
		expect(seen.map((s) => s.port)).toEqual([8787, 8788]);
		const state = readFleet(h.ctx, h.base)!;
		expect(Object.keys(state.actions)).toHaveLength(2);
		expect(state.plan.sites[0]!.aliases).toEqual(['alias-a.fixture.localhost']);
		expect(Object.values(state.actions).map((a) => a.state)).toEqual(['done', 'done']);
		expect(h.ctx.io.text()).toContain(
			'alias-a.fixture.localhost; the alias has no duplicate of its own'
		);
	});

	it('gives two sites two worker names that differ only by their suffix', async () => {
		const h = harness();
		const { planFleet } = await import('../src/commands/preview-fleet');
		const { plan } = await planFleet(h.ctx, h.options());
		const [a, b] = plan.sites;
		expect(a!.worker).toMatch(/^drupflare-preview-[0-9a-f]{8}$/);
		expect(b!.worker).toMatch(/^drupflare-preview-[0-9a-f]{8}$/);
		expect(a!.worker).not.toBe(b!.worker);
		expect(a!.digest).not.toBe(b!.digest);
	});

	it('is the same plan, byte for byte, on every run', async () => {
		const h = harness();
		const { planFleet } = await import('../src/commands/preview-fleet');
		const one = await planFleet(h.ctx, h.options());
		const two = await planFleet(h.ctx, h.options());
		expect(planDigest(one.plan)).toBe(planDigest(two.plan));
	});

	it('keeps two sites in different directories apart even when they share a site uuid', async () => {
		const h = harness();
		const { planFleet } = await import('../src/commands/preview-fleet');
		const same = fixtureHost({
			[`cat ${DOCROOT}/sites/site-b/settings.php`]: ok(settings('site_a', 'mysql', 'mysql')),
			[`${drush('site-b.fixture.localhost')} sql:query "SELECT data FROM config WHERE name = 'system.site'"`]:
				ok(row(UUID['site-a']))
		});
		// the directory differs, so the sources differ; only an identical source collides
		const { plan } = await planFleet(h.ctx, h.options({ transport: same }));
		expect(new Set(plan.sites.map((s) => s.worker)).size).toBe(2);
	});

	it('stops on an empty database before anything is planned', async () => {
		const h = harness();
		const { planFleet } = await import('../src/commands/preview-fleet');
		const empty = fixtureHost({
			[`${drush('site-b.fixture.localhost')} sql:query "SELECT data FROM config WHERE name = 'system.site'"`]:
				{ code: 1, stdout: '', stderr: "Table 'x.config' doesn't exist" }
		});
		await expect(planFleet(h.ctx, h.options({ transport: empty }))).rejects.toMatchObject({
			code: 'empty-source'
		});
	});
});

describe('resuming a fleet', () => {
	/** runs the fleet with a one-site preview that writes the identity file the way the real one does */
	const run = async (h: ReturnType<typeof harness>, behave: Parameters<typeof sites>[0]) => {
		const { planFleet } = await import('../src/commands/preview-fleet');
		const { plan } = await planFleet(h.ctx, h.options());
		const inner = sites(behave);
		const runSite: FleetOptions['runSite'] = async (ctx, o) => {
			const site = plan.sites.find((s) => s.host === o.site)!;
			ctx.files.writeText(
				join(o.out!, 'source-site.json'),
				JSON.stringify({ digest: site.digest })
			);
			return await inner.runSite(ctx, o);
		};
		const failure = await runFleetCommand(h.ctx, h.options({ runSite })).then(
			() => null,
			(e: unknown) => e
		);
		return { failure, ...inner };
	};

	it('keeps a failed site retryable and leaves the verified one alone', async () => {
		const h = harness();
		const first = await run(h, (site) =>
			site.startsWith('site-b') ? new Error('boom') : 'verified'
		);
		expect(first.failure).toMatchObject({ code: 'fleet-incomplete' });
		expect((first.failure as Error).message).toContain(
			'1 of 2 sites are not verified (site-b)'
		);
		let state = readFleet(h.ctx, h.base)!;
		expect(Object.values(state.actions).map((a) => [a.state, a.attempts])).toEqual([
			['done', 1],
			['failed', 1]
		]);

		const second = await run(h, () => 'verified');
		expect(second.failure).toBeNull();
		expect([...second.counts]).toEqual([['site-b.fixture.localhost', 1]]);
		state = readFleet(h.ctx, h.base)!;
		expect(Object.values(state.actions).map((a) => [a.state, a.attempts])).toEqual([
			['done', 1],
			['done', 2]
		]);
		expect(state.epoch).toBe(2);
		expect(h.ctx.io.text()).toContain('already verified');
	});

	it('reads a killed run as unknown and repeats it in a new attempt folder', async () => {
		const h = harness();
		const first = await run(h, (site) =>
			site.startsWith('site-b') ? new Error('x') : 'verified'
		);
		expect(first.failure).not.toBeNull();
		// a run killed while site-b was running leaves it running and no receipt
		const state = readFleet(h.ctx, h.base)!;
		const key = state.plan.sites[1]!.worker;
		state.actions[key] = { ...state.actions[key]!, state: 'running' };
		saveFleet(h.ctx, h.base, state);
		const second = await run(h, () => 'verified');
		expect(second.failure).toBeNull();
		const out = readFleet(h.ctx, h.base)!.actions[key]!.out!;
		expect(out.endsWith('/attempt-2')).toBe(true);
	});

	it('does not believe a done action whose receipt is not verified', async () => {
		const h = harness();
		await run(h, () => 'verified');
		const state = readFleet(h.ctx, h.base)!;
		const key = state.plan.sites[0]!.worker;
		const out = state.actions[key]!.out!;
		const receipt = readReceipt(h.ctx, out)!;
		writeReceipt(h.ctx, out, { ...receipt, state: 'claimed' });
		const again = await run(h, () => 'verified');
		expect([...again.counts]).toEqual([['site-a.fixture.localhost', 1]]);
		expect(readFleet(h.ctx, h.base)!.actions[key]!.attempts).toBe(2);
	});

	it('fails a site whose run ended without a verified receipt', async () => {
		const h = harness();
		const result = await run(h, () => 'claimed');
		expect(result.failure).toMatchObject({ code: 'fleet-incomplete' });
		const state = readFleet(h.ctx, h.base)!;
		expect(Object.values(state.actions).map((a) => a.state)).toEqual(['failed', 'failed']);
		expect(Object.values(state.actions)[0]!.error).toContain('says claimed');
	});

	it('refuses a state file written for another set of sites', async () => {
		const h = harness();
		await run(h, () => 'verified');
		const other = fixtureHost({
			[`ls ${DOCROOT}/sites`]: ok('default\nsite-a\nsites.php\n'),
			[`cat ${DOCROOT}/sites/sites.php`]: ok(
				"<?php\n$sites['site-a.fixture.localhost'] = 'site-a';\n"
			)
		});
		await expect(runFleetCommand(h.ctx, h.options({ transport: other }))).rejects.toMatchObject(
			{
				code: 'plan-changed'
			}
		);
	});

	it('refuses a write from a run an older epoch', async () => {
		const h = harness();
		await run(h, () => 'verified');
		const state = readFleet(h.ctx, h.base)!;
		expect(() => saveFleet(h.ctx, h.base, { ...state, epoch: state.epoch - 1 })).toThrow(
			/another run took/
		);
	});
});

describe('the fleet command line', () => {
	it('needs a login, because each site is verified by workflow', async () => {
		const h = harness();
		await expect(runFleetCommand(h.ctx, h.options({ login: undefined }))).rejects.toThrow(
			/needs --login/
		);
	});

	it('needs the password in the environment', async () => {
		const h = harness();
		await expect(runFleetCommand({ ...h.ctx, env: {} }, h.options())).rejects.toThrow(
			/DRANGLER_PREVIEW_PASSWORD/
		);
	});

	it('refuses --deploy, which is one site at a time', async () => {
		const h = harness();
		await expect(runFleetCommand(h.ctx, h.options({ deploy: true }))).rejects.toThrow(
			/--deploy/
		);
	});

	it('prints its steps on a dry run and touches nothing', async () => {
		const h = harness();
		const ctx = { ...h.ctx };
		await runFleetCommand(ctx, h.options({ globals: testGlobals({ dryRun: true }, ctx) }));
		expect(ctx.io.text()).toContain('nothing was executed');
		expect(readFleet(ctx, h.base)).toBeNull();
	});
});

describe('cloneWorkspace', () => {
	it('copies the checkout and leaves out dev state and the last run secrets', async () => {
		const h = harness();
		const to = join(h.base, 'copy');
		await cloneWorkspace(h.ctx, h.worker, to);
		expect(h.ctx.files.exists(join(to, 'package.json'))).toBe(true);
		expect(h.ctx.files.exists(join(to, 'a.txt'))).toBe(true);
		expect(h.ctx.files.exists(join(to, '.dev.vars'))).toBe(false);
		expect(h.ctx.files.exists(join(to, '.wrangler'))).toBe(false);
	});
});
