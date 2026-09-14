import { describe, expect, it } from 'vitest';
import {
	moduleNameOf,
	runModifyActivate,
	runModifyCheck,
	runModifyDiff,
	runModifyDrop,
	runModifyEnable,
	runModifyInit,
	runModifyRelease,
	runModifyRequire,
	runModifyRevisions,
	runModifyRollback,
	runModifyStatus,
	runModifyUpload,
	type ModifyDiffReport,
	type ModifyInitReport,
	type ModifyStatusReport
} from '../src/commands/modify';
import { DranglerError, EXIT, FindingError, UsageError } from '../src/errors';
import type { FetchLike } from '../src/health/probe';
import { scriptedRunner, type CommandResult } from '../src/host/exec';
import { memoryFiles, type MemoryFiles } from '../src/host/files';
import type { CheckReport } from '../src/modify/check';
import { detectProject, packageOf, RECORD_CAP } from '../src/modify/detect';
import { planBatches, sha256, uploadPackage, type UploadResult } from '../src/modify/upload';
import { ownerTarget } from '../src/owner';
import { run } from '../src/run';
import { fail, ok, testContext, testGlobals, type TestContext } from './helpers';

const ORIGIN = 'https://mysite.example';
const TOKEN = 'tok-owner-1';
const HOME = '/home/me';
const GLOBAL = `${HOME}/.config/drangler/config.json`;
const DIR = '/work/mantle2';
const MOUNT = 'modules/custom/mantle2';

function tree(over: Record<string, string> = {}): Record<string, string> {
	return {
		[`${DIR}/.git/HEAD`]: 'ref: refs/heads/master',
		[`${DIR}/mantle2.info.yml`]:
			'name: mantle2\ntype: module\ncore_version_requirement: ^11\n\ndependencies:\n  - drupal:node\n  - drupal:key\n',
		[`${DIR}/mantle2.module`]: '<?php\n// v1\n',
		[`${DIR}/src/Service/StreakService.php`]: '<?php\nclass StreakService {}\n',
		...over
	};
}

interface SiteState {
	blobs: Set<string>;
	revisions: {
		rev: string;
		label: string;
		files: number;
		createdAt: number;
		kind: string;
		manifest: Record<string, string>;
	}[];
	active: string | null;
	/** paths the site currently holds for this package */
	live: Map<string, string>;
	calls: { url: string; method: string; body: unknown }[];
	/** a commit the kernel refuses to boot against */
	refuseCommit: boolean;
	installable: string;
}

function fakeSite(over: Partial<SiteState> = {}): { fetch: FetchLike; state: SiteState } {
	const state: SiteState = {
		blobs: new Set(),
		revisions: [],
		active: null,
		live: new Map(),
		calls: [],
		refuseCommit: false,
		installable: 'installable',
		...over
	};

	const json = (body: unknown, status = 200): Response =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});

	const fn = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
		const url = new URL(String(input));
		const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		state.calls.push({ url: url.toString(), method: String(init.method ?? 'GET'), body });

		if (url.pathname === '/serve') {
			return new Response('<html></html>', { headers: { 'x-cfw-cache': 'MISS' } });
		}
		if (url.pathname === '/firstrun') {
			return json({ ok: true, configured: true, firstRunAt: 1 });
		}
		if (url.pathname === '/installable') {
			return json({
				name: url.searchParams.get('module'),
				verdict: state.installable,
				version: '1.4.2'
			});
		}
		if (url.pathname === '/install') {
			return json({ ok: true, name: url.searchParams.get('module') });
		}
		if (url.pathname === '/enable') {
			return json({ ok: true, module: url.searchParams.get('module') });
		}
		if (url.pathname !== '/modify') return json({ ok: false }, 404);

		const action = url.searchParams.get('action');
		if (action === 'status') {
			return json({
				ok: true,
				packages:
					state.active === null
						? []
						: [
								{
									package: url.searchParams.get('package'),
									rev: state.active,
									label: state.revisions.at(-1)?.label ?? '',
									files: state.live.size,
									bytes: 100,
									at: 1_757_000_000_000,
									revisions: state.revisions.length
								}
							]
			});
		}
		if (action === 'revisions') {
			return json({
				ok: true,
				revisions: [...state.revisions].reverse(),
				active: state.active
			});
		}
		if (action === 'plan') {
			const declared = (body as { files: { path: string; hash: string }[] }).files;
			const have = declared.filter((f) => state.blobs.has(f.hash)).map((f) => f.hash);
			const want = declared.filter((f) => !state.blobs.has(f.hash)).map((f) => f.hash);
			// the same walk `planDeclared()` does on the worker: over EVERY declared file, against
			// the mounted tree, rather than over the ones whose blobs are already here
			const counts = { added: 0, modified: 0, removed: 0, unchanged: 0 };
			const seen = new Set<string>();
			for (const file of declared) {
				seen.add(file.path);
				const before = state.live.get(file.path);
				if (before === undefined) counts.added++;
				else if (before === file.hash) counts.unchanged++;
				else counts.modified++;
			}
			const removed = [...state.live.keys()].filter((path) => !seen.has(path));
			counts.removed = removed.length;
			return json({
				ok: true,
				have,
				want,
				wantBytes: want.length * 32,
				counts,
				rowsWritten: counts.added + counts.modified + counts.removed,
				removed
			});
		}
		if (action === 'manifest') {
			const wanted = url.searchParams.get('rev') ?? 'active';
			const target =
				wanted === 'active'
					? state.revisions.at(-1)
					: wanted === 'previous'
						? state.revisions.at(-2)
						: state.revisions.find((r) => r.rev === wanted);
			if (target === undefined) return json({ ok: false, error: 'no such revision' }, 404);
			return json({
				ok: true,
				rev: target.rev,
				label: target.label,
				createdAt: target.createdAt,
				active: target.rev === state.active,
				manifest: target.manifest
			});
		}
		if (action === 'blobs') {
			const sent = (body as { blobs: { hash: string }[] }).blobs;
			for (const blob of sent) state.blobs.add(blob.hash);
			return json({ ok: true, stored: sent.length, skipped: 0, bytes: sent.length * 32 });
		}
		if (action === 'commit') {
			const files = (body as { files: { path: string; hash: string }[] }).files;
			const missing = files.filter((f) => !state.blobs.has(f.hash));
			if (missing.length > 0) {
				return json(
					{ ok: false, error: 'file(s) name a blob this site does not hold', missing },
					409
				);
			}
			// `hashManifest()` in the worker, byte for byte: sorted by path, NUL between the two
			// fields. It said space here and in `manifestRev()`, so the fake agreed with the code
			// it was checking and both were wrong against the site that actually stores revisions
			const rev = await sha256(
				[...files]
					.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
					.map((f) => `${f.path}\0${f.hash}`)
					.join('\n')
			);
			if (state.refuseCommit) {
				return json(
					{
						ok: false,
						rev,
						applied: false,
						rolledBack: true,
						error: 'rolled back: the kernel refused to boot'
					},
					409
				);
			}
			state.revisions.push({
				rev,
				label: url.searchParams.get('label') ?? '',
				files: files.length,
				createdAt: 1_757_000_000_000,
				kind: 'upload',
				manifest: Object.fromEntries(files.map((f) => [f.path, f.hash]))
			});
			state.active = rev;
			state.live = new Map(files.map((f) => [f.path, f.hash]));
			return json({ ok: true, rev, applied: true, rolledBack: false, counts: {} });
		}
		if (action === 'activate') {
			const wanted = url.searchParams.get('rev');
			const target =
				wanted === 'previous'
					? state.revisions.at(-2)
					: state.revisions.find((r) => r.rev === wanted);
			if (target === undefined) return json({ ok: false, error: 'no such revision' }, 404);
			state.active = target.rev;
			return json({ ok: true, rev: target.rev, applied: true, rolledBack: false });
		}
		if (action === 'drop') {
			const wanted = url.searchParams.get('rev');
			if (wanted === state.active) {
				return json({ ok: false, dropped: false, reason: 'that revision is active' }, 409);
			}
			state.revisions = state.revisions.filter((r) => r.rev !== wanted);
			return json({ ok: true, dropped: true, blobsFreed: 2 });
		}
		return json({ ok: false, error: `unknown action: ${action}` }, 400);
	};
	return { fetch: fn as unknown as FetchLike, state };
}

function ctxFor(
	files: MemoryFiles = memoryFiles(tree()),
	fetch: FetchLike = fakeSite().fetch,
	script: Record<string, CommandResult> = {}
): TestContext {
	return testContext({
		files,
		fetch,
		runner: scriptedRunner(script),
		env: { HOME },
		cwd: DIR
	});
}

const globalsFor = (ctx: TestContext, over = {}) =>
	testGlobals({ json: true, ...over }, ctx, { site: ORIGIN, token: TOKEN });

describe('modify init', () => {
	it('writes the module block to drangler.json and the token to the global config', async () => {
		const files = memoryFiles(tree());
		const ctx = ctxFor(files);
		await runModifyInit(ctx, { globals: globalsFor(ctx) });

		const project = JSON.parse(files.written.get(`${DIR}/drangler.json`) as string) as {
			site: { origin: string };
			module: { root: string; package: string };
		};
		expect(project.module).toEqual({ root: '.', package: 'mantle2' });
		expect(project.site.origin).toBe(ORIGIN);
		expect(files.written.get(`${DIR}/drangler.json`)).not.toContain(TOKEN);
		expect(files.written.get(GLOBAL)).toContain(TOKEN);
		expect(files.secrets.has(GLOBAL)).toBe(true);

		expect(ctx.io.json<ModifyInitReport>()).toMatchObject({
			shape: 'module-project',
			package: 'mantle2',
			mount: MOUNT,
			claimed: 'claimed'
		});
	});

	it('exits 2 on a directory that matches no shape, naming what it looked for', async () => {
		const ctx = ctxFor(memoryFiles({ '/work/mantle2/notes.txt': 'x' }));
		await expect(runModifyInit(ctx, { globals: globalsFor(ctx) })).rejects.toBeInstanceOf(
			UsageError
		);
	});
});

describe('modify status', () => {
	it('says clean when the local manifest is the live revision', async () => {
		const site = fakeSite();
		const files = memoryFiles(tree());
		const uploading = ctxFor(files, site.fetch);
		await runModifyUpload(uploading, { globals: globalsFor(uploading) });

		const ctx = ctxFor(files, site.fetch);
		await runModifyStatus(ctx, { globals: globalsFor(ctx) });
		const report = ctx.io.json<ModifyStatusReport>();
		expect(report.clean).toBe(true);
		expect(report.live?.rev).toBe(report.local.rev);
	});

	it('reports a site holding no revision of this package yet', async () => {
		const ctx = ctxFor();
		await runModifyStatus(ctx, { globals: globalsFor(ctx) });
		const report = ctx.io.json<ModifyStatusReport>();
		expect(report.live).toBeNull();
		expect(report.notes.join(' ')).toContain('no uploaded revision');
	});
});

describe('modify diff', () => {
	it('exits 3 on a difference and names the paths that would be sent', async () => {
		const ctx = ctxFor();
		await expect(runModifyDiff(ctx, { globals: globalsFor(ctx) })).rejects.toBeInstanceOf(
			FindingError
		);
		const report = ctx.io.json<ModifyDiffReport>();
		expect(report.clean).toBe(false);
		expect(report.comparedTo).toBe('what is live');
		expect(report.outgoing).toContain(`${MOUNT}/mantle2.module`);
		// nothing is mounted yet, so every declared file is an addition
		expect(report.counts).toMatchObject({ added: 3, modified: 0, removed: 0, unchanged: 0 });
		expect(report.changes.every((c) => c.kind === 'added')).toBe(true);
	});

	/**
	 * The split the site computes, attributed back to paths.
	 *
	 * The route used to count a modified file as REMOVED, because it planned over only the files
	 * whose blobs were already there and a changed file has none. It walks every declared file now,
	 * so an edit, an addition and a deletion each read as themselves in one report.
	 */
	it('separates added from modified from removed against a live tree', async () => {
		const site = fakeSite();
		const files = memoryFiles(tree());
		const uploading = ctxFor(files, site.fetch);
		await runModifyUpload(uploading, { globals: globalsFor(uploading) });

		files.writeText(`${DIR}/mantle2.module`, '<?php\n// edited\n');
		files.writeText(`${DIR}/src/Streak.php`, '<?php\nclass Streak {}\n');
		const ctx = ctxFor(files, site.fetch);
		// the info file is untouched, StreakService.php is gone from neither side
		await expect(runModifyDiff(ctx, { globals: globalsFor(ctx) })).rejects.toBeInstanceOf(
			FindingError
		);
		const report = ctx.io.json<ModifyDiffReport>();
		expect(report.counts).toMatchObject({ added: 1, modified: 1, removed: 0, unchanged: 2 });
		const byPath = new Map(report.changes.map((c) => [c.path, c.kind]));
		expect(byPath.get(`${MOUNT}/src/Streak.php`)).toBe('added');
		expect(byPath.get(`${MOUNT}/mantle2.module`)).toBe('modified');
		expect(byPath.get(`${MOUNT}/mantle2.info.yml`)).toBe('unchanged');
	});

	it('names a path the site holds and the local tree dropped as removed', async () => {
		const site = fakeSite();
		const files = memoryFiles(tree());
		const uploading = ctxFor(files, site.fetch);
		await runModifyUpload(uploading, { globals: globalsFor(uploading) });

		const shrunk = memoryFiles({
			[`${DIR}/.git/HEAD`]: 'ref: refs/heads/master',
			[`${DIR}/mantle2.info.yml`]: files.readText(`${DIR}/mantle2.info.yml`),
			[`${DIR}/mantle2.module`]: files.readText(`${DIR}/mantle2.module`)
		});
		const ctx = ctxFor(shrunk, site.fetch);
		await expect(runModifyDiff(ctx, { globals: globalsFor(ctx) })).rejects.toBeInstanceOf(
			FindingError
		);
		const report = ctx.io.json<ModifyDiffReport>();
		expect(report.counts).toMatchObject({ removed: 1, unchanged: 2 });
		expect(report.changes.find((c) => c.kind === 'removed')?.path).toBe(
			`${MOUNT}/src/Service/StreakService.php`
		);
	});

	/** a modified path can still need no bytes, when the site kept the blob from an earlier revision */
	it('separates what changed from what has to be sent', async () => {
		const site = fakeSite();
		const files = memoryFiles(tree());
		const first = ctxFor(files, site.fetch);
		await runModifyUpload(first, { globals: globalsFor(first) });
		files.writeText(`${DIR}/mantle2.module`, '<?php\n// v2\n');
		const second = ctxFor(files, site.fetch);
		await runModifyUpload(second, { globals: globalsFor(second) });
		// back to the first revision's bytes: the site still holds that blob
		files.writeText(`${DIR}/mantle2.module`, '<?php\n// v1\n');

		const ctx = ctxFor(files, site.fetch);
		await expect(runModifyDiff(ctx, { globals: globalsFor(ctx) })).rejects.toBeInstanceOf(
			FindingError
		);
		const report = ctx.io.json<ModifyDiffReport>();
		expect(report.counts).toMatchObject({ modified: 1 });
		expect(report.outgoing).toEqual([]);
		expect(report.notes.join(' ')).toContain('already holds from an earlier revision');
	});

	describe('--against', () => {
		async function twoRevisions() {
			const site = fakeSite();
			const files = memoryFiles(tree());
			const first = ctxFor(files, site.fetch);
			await runModifyUpload(first, { globals: globalsFor(first) });
			files.writeText(`${DIR}/mantle2.module`, '<?php\n// v2\n');
			const second = ctxFor(files, site.fetch);
			await runModifyUpload(second, { globals: globalsFor(second) });
			return { site, files };
		}

		it('compares against a stored revision rather than against what is mounted', async () => {
			const { site, files } = await twoRevisions();
			const ctx = ctxFor(files, site.fetch);
			await expect(
				runModifyDiff(ctx, { against: 'previous', globals: globalsFor(ctx) })
			).rejects.toBeInstanceOf(FindingError);
			const report = ctx.io.json<ModifyDiffReport>();
			expect(report.comparedTo).toBe(
				`rev ${(site.state.revisions[0]?.rev as string).slice(0, 8)}`
			);
			expect(report.counts).toMatchObject({ modified: 1, unchanged: 2 });
			expect(report.notes.join(' ')).toContain('not necessarily what is mounted');
		});

		it('is clean against the revision the local tree produced', async () => {
			const { site, files } = await twoRevisions();
			const ctx = ctxFor(files, site.fetch);
			await runModifyDiff(ctx, {
				against: site.state.revisions[1]?.rev as string,
				globals: globalsFor(ctx)
			});
			expect(ctx.io.json<ModifyDiffReport>().clean).toBe(true);
		});

		it('refuses a revision the site does not hold', async () => {
			const { site, files } = await twoRevisions();
			const ctx = ctxFor(files, site.fetch);
			await expect(
				runModifyDiff(ctx, { against: 'f'.repeat(64), globals: globalsFor(ctx) })
			).rejects.toThrow(/no such revision|no revision/);
		});
	});

	it('exits 0 when the site already holds every byte', async () => {
		const site = fakeSite();
		const files = memoryFiles(tree());
		const uploading = ctxFor(files, site.fetch);
		await runModifyUpload(uploading, { globals: globalsFor(uploading) });

		const ctx = ctxFor(files, site.fetch);
		await runModifyDiff(ctx, { globals: globalsFor(ctx) });
		expect(ctx.io.json<ModifyDiffReport>().clean).toBe(true);
	});

	it('prints paths and nothing else under --name-only', async () => {
		const ctx = ctxFor();
		await expect(
			runModifyDiff(ctx, { nameOnly: true, globals: globalsFor(ctx, { json: false }) })
		).rejects.toBeInstanceOf(FindingError);
		for (const line of ctx.io.stdout) expect(line.startsWith(MOUNT)).toBe(true);
		expect(ctx.io.stdout.length).toBe(3);
	});
});

describe('modify check', () => {
	it('passes a clean project and says the lint was skipped without --php', async () => {
		const ctx = ctxFor();
		await runModifyCheck(ctx, { globals: globalsFor(ctx) });
		const report = ctx.io.json<CheckReport>();
		expect(report).toMatchObject({ ok: true, package: 'mantle2', mount: MOUNT });
		expect(report.lint).toMatchObject({ ran: false });
		expect(report.lint.reason).toContain('--php');
	});

	it('exits 3 on a lint failure and repeats the parser message', async () => {
		const ctx = ctxFor(memoryFiles(tree()), fakeSite().fetch, {
			'php --version': ok('PHP 8.4.12 (cli)'),
			[`php -l ${DIR}/mantle2.info.yml`]: ok('No syntax errors detected'),
			[`php -l ${DIR}/mantle2.module`]: fail(
				255,
				'PHP Parse error: syntax error, unexpected'
			),
			[`php -l ${DIR}/src/Service/StreakService.php`]: ok('No syntax errors detected')
		});
		await expect(
			runModifyCheck(ctx, { php: 'php', globals: globalsFor(ctx) })
		).rejects.toBeInstanceOf(FindingError);
		const report = ctx.io.json<CheckReport>();
		expect(report.lint.ran).toBe(true);
		expect(report.findings.join(' ')).toContain('Parse error');
	});

	/**
	 * A file can pass the record cap and still have no request that carries it.
	 *
	 * `RECORD_CAP` is 2,199,995 and the body limit is 2 MiB, so the band between them is real and a
	 * blob cannot be split across two requests.
	 */
	it('names a file too big for a request body, which the record cap alone would let through', async () => {
		const files = memoryFiles(tree({ [`${DIR}/src/Big.php`]: '<?php\n' }));
		const inflated = {
			...files,
			size: (path: string) => (path.endsWith('Big.php') ? 2_150_000 : files.size(path))
		} as MemoryFiles;
		const ctx = ctxFor(inflated);
		await expect(runModifyCheck(ctx, { globals: globalsFor(ctx) })).rejects.toBeInstanceOf(
			FindingError
		);
		expect(ctx.io.json<CheckReport>().findings.join(' ')).toContain('request body limit');
		expect(2_150_000).toBeLessThan(RECORD_CAP);
	});

	it('refuses two packages in one project that want one mount', async () => {
		const files = memoryFiles({
			'/work/site/core/lib/Drupal.php': '<?php\n',
			'/work/site/modules/custom/a/mantle2.info.yml': 'name: A\ntype: module\n',
			'/work/site/modules/custom/b/mantle2.info.yml': 'name: B\ntype: module\n'
		});
		const ctx = testContext({
			files,
			fetch: fakeSite().fetch,
			env: { HOME },
			cwd: '/work/site'
		});
		await expect(
			runModifyCheck(ctx, { package: 'mantle2', globals: globalsFor(ctx) })
		).rejects.toBeInstanceOf(FindingError);
		expect(ctx.io.json<CheckReport>().collisions[0]?.path).toBe(MOUNT);
	});

	it('resolves every declared dependency against /installable under --deps', async () => {
		const site = fakeSite();
		const ctx = ctxFor(memoryFiles(tree()), site.fetch);
		await runModifyCheck(ctx, { deps: true, globals: globalsFor(ctx) });
		const report = ctx.io.json<CheckReport>();
		expect(report.dependencies.map((d) => d.name)).toEqual(['drupal/node', 'drupal/key']);
		expect(site.state.calls.filter((c) => c.url.includes('/installable'))).toHaveLength(2);
	});
});

describe('modify upload', () => {
	it('sends only what the site is missing on the second upload', async () => {
		const site = fakeSite();
		const files = memoryFiles(tree());
		const first = ctxFor(files, site.fetch);
		await runModifyUpload(first, { globals: globalsFor(first) });
		expect(first.io.json<UploadResult>()).toMatchObject({
			files: 3,
			stored: 3,
			applied: true,
			rolledBack: false
		});

		files.writeText(`${DIR}/mantle2.module`, '<?php\n// v2\n');
		const second = ctxFor(files, site.fetch);
		await runModifyUpload(second, { globals: globalsFor(second) });
		const report = second.io.json<UploadResult>();
		expect(report.plan.have).toHaveLength(2);
		expect(report.plan.want).toHaveLength(1);
		expect(report.stored).toBe(1);
	});

	/** the kernel refused to boot, so nothing the caller asked for happened: exit 1, not 3 */
	it('exits 1 when the commit rolled back, and says the previous revision is still serving', async () => {
		const site = fakeSite({ refuseCommit: true });
		const ctx = ctxFor(memoryFiles(tree()), site.fetch);
		await expect(runModifyUpload(ctx, { globals: globalsFor(ctx) })).rejects.toBeInstanceOf(
			DranglerError
		);
		expect(ctx.io.json<UploadResult>()).toMatchObject({ applied: false, rolledBack: true });
	});

	it('refuses to upload over a check finding, and exits 3 when --force overrides one', async () => {
		const files = memoryFiles(tree());
		const inflated = {
			...files,
			size: (path: string) => (path.endsWith('.module') ? 2_150_000 : files.size(path))
		} as MemoryFiles;
		const site = fakeSite();

		const refused = ctxFor(inflated, site.fetch);
		await expect(runModifyUpload(refused, { globals: globalsFor(refused) })).rejects.toThrow(
			/--force/
		);
		expect(site.state.calls).toHaveLength(0);

		const forced = ctxFor(inflated, site.fetch);
		await expect(
			runModifyUpload(forced, { force: true, globals: globalsFor(forced) })
		).rejects.toBeInstanceOf(FindingError);
		expect(forced.io.json<{ applied: boolean }>().applied).toBe(true);
	});

	it('sends nothing under --dry-run and still reports the plan', async () => {
		const site = fakeSite();
		const ctx = ctxFor(memoryFiles(tree()), site.fetch);
		await runModifyUpload(ctx, { globals: globalsFor(ctx, { dryRun: true }) });
		expect(site.state.calls.filter((c) => c.url.includes('action=blobs'))).toHaveLength(0);
		expect(ctx.io.json<UploadResult>().plan.want).toHaveLength(3);
	});

	it('labels the revision with the git subject when there is one', async () => {
		const site = fakeSite();
		const ctx = ctxFor(memoryFiles(tree()), site.fetch, {
			'git log -1 --format=%s': ok('add the streak service\n')
		});
		await runModifyUpload(ctx, { globals: globalsFor(ctx) });
		const commit = site.state.calls.find((c) => c.url.includes('action=commit'));
		expect(new URL(commit?.url as string).searchParams.get('label')).toBe(
			'add the streak service'
		);
	});
});

describe('batching', () => {
	/** the budget is measured on the ENCODED entry, because JSON escaping grows a source */
	it('splits blobs so no request exceeds the body limit', () => {
		const blobs = Array.from({ length: 4 }, (_, i) => ({
			hash: String(i).repeat(64),
			source: 'x'.repeat(400)
		}));
		expect(planBatches(blobs, 2_097_152)).toHaveLength(1);
		const split = planBatches(blobs, 1_024 + 1_000);
		expect(split.length).toBeGreaterThan(1);
		expect(split.flat()).toHaveLength(4);
	});

	it('gives a blob larger than the whole budget its own request', () => {
		const batches = planBatches([{ hash: 'a'.repeat(64), source: 'x'.repeat(5_000) }], 1_100);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(1);
	});

	it('returns nothing for nothing', () => {
		expect(planBatches([])).toEqual([]);
	});
});

describe('revisions, activate, rollback and drop', () => {
	async function twoRevisions(): Promise<{
		site: ReturnType<typeof fakeSite>;
		files: MemoryFiles;
	}> {
		const site = fakeSite();
		const files = memoryFiles(tree());
		const first = ctxFor(files, site.fetch);
		await runModifyUpload(first, { globals: globalsFor(first) });
		files.writeText(`${DIR}/mantle2.module`, '<?php\n// v2\n');
		const second = ctxFor(files, site.fetch);
		await runModifyUpload(second, { globals: globalsFor(second) });
		return { site, files };
	}

	it('lists the stored revisions with the active one marked', async () => {
		const { site, files } = await twoRevisions();
		const ctx = ctxFor(files, site.fetch);
		await runModifyRevisions(ctx, { globals: globalsFor(ctx, { json: false }) });
		expect(ctx.io.text()).toContain('*');
		expect(ctx.io.text().split('\n').length).toBeGreaterThan(3);
	});

	it('rolls back to the revision before the active one', async () => {
		const { site, files } = await twoRevisions();
		const firstRev = site.state.revisions[0]?.rev;
		const ctx = ctxFor(files, site.fetch);
		await runModifyRollback(ctx, { globals: globalsFor(ctx, { yes: true }) });
		expect(site.state.active).toBe(firstRev);
		expect(ctx.io.json<UploadResult>()).toMatchObject({ applied: true, rev: firstRev });
	});

	it('refuses to change what the site serves without --yes', async () => {
		const { site, files } = await twoRevisions();
		const ctx = ctxFor(files, site.fetch);
		await expect(runModifyRollback(ctx, { globals: globalsFor(ctx) })).rejects.toThrow(/--yes/);
	});

	it('refuses a revision the site does not hold', async () => {
		const { site, files } = await twoRevisions();
		const ctx = ctxFor(files, site.fetch);
		await expect(
			runModifyActivate(ctx, 'f'.repeat(64), { globals: globalsFor(ctx, { yes: true }) })
		).rejects.toThrow(/no such revision/);
	});

	it('drops a stored revision and refuses to drop the active one', async () => {
		const { site, files } = await twoRevisions();
		const stale = site.state.revisions[0]?.rev as string;
		const ctx = ctxFor(files, site.fetch);
		await runModifyDrop(ctx, stale, { globals: globalsFor(ctx, { yes: true }) });
		expect(site.state.revisions.map((r) => r.rev)).not.toContain(stale);

		const active = site.state.active as string;
		const refusing = ctxFor(files, site.fetch);
		await expect(
			runModifyDrop(refusing, active, { globals: globalsFor(refusing, { yes: true }) })
		).rejects.toThrow(/active/);
	});
});

describe('modify require and enable', () => {
	it('checks, installs and optionally enables, in that order', async () => {
		const site = fakeSite();
		const ctx = ctxFor(memoryFiles(tree()), site.fetch);
		await runModifyRequire(ctx, ['drupal/key'], {
			enable: true,
			globals: globalsFor(ctx)
		});
		expect(site.state.calls.map((c) => new URL(c.url).pathname)).toEqual([
			'/installable',
			'/install',
			'/enable'
		]);
		expect(
			ctx.io.json<{ packages: { installed: boolean; enabled: boolean }[] }>()
		).toMatchObject({ packages: [{ installed: true, enabled: true }] });
	});

	it('stops at the refusal when /installable says no, and passes force=1 when told to', async () => {
		const refusing = fakeSite({ installable: 'blocked' });
		const ctx = ctxFor(memoryFiles(tree()), refusing.fetch);
		await expect(
			runModifyRequire(ctx, ['drupal/key'], { globals: globalsFor(ctx) })
		).rejects.toThrow(/did not land/);
		expect(refusing.state.calls.map((c) => new URL(c.url).pathname)).toEqual(['/installable']);

		const forced = fakeSite({ installable: 'blocked' });
		const forcing = ctxFor(memoryFiles(tree()), forced.fetch);
		await runModifyRequire(forcing, ['drupal/key'], {
			force: true,
			globals: globalsFor(forcing)
		});
		const install = forced.state.calls.find((c) => new URL(c.url).pathname === '/install');
		expect(new URL(install?.url as string).searchParams.get('force')).toBe('1');
	});

	it('enables by machine name, which a registry name is not', async () => {
		expect(moduleNameOf('drupal/json_field')).toBe('json_field');
		expect(moduleNameOf('mantle2')).toBe('mantle2');
		const site = fakeSite();
		const ctx = ctxFor(memoryFiles(tree()), site.fetch);
		await runModifyEnable(ctx, ['drupal/json_field'], { globals: globalsFor(ctx) });
		expect(new URL(site.state.calls[0]?.url as string).searchParams.get('module')).toBe(
			'json_field'
		);
	});
});

describe('modify release', () => {
	const CLEAN = {
		'git status --porcelain': ok(''),
		'git rev-parse v1.2.0^{commit}': ok('abc1234def\n'),
		'git rev-parse HEAD': ok('abc1234def\n')
	};

	it('uploads from the tag and records the sha as the revision origin', async () => {
		const site = fakeSite();
		const ctx = ctxFor(memoryFiles(tree()), site.fetch, CLEAN);
		await runModifyRelease(ctx, { tag: 'v1.2.0', globals: globalsFor(ctx) });
		const commit = site.state.calls.find((c) => c.url.includes('action=commit'));
		const params = new URL(commit?.url as string).searchParams;
		expect(params.get('label')).toBe('v1.2.0');
		expect(params.get('origin')).toBe('abc1234def');
	});

	it('refuses a dirty tree before it reads the tag', async () => {
		const site = fakeSite();
		const ctx = ctxFor(memoryFiles(tree()), site.fetch, {
			...CLEAN,
			'git status --porcelain': ok(' M mantle2.module\n')
		});
		await expect(
			runModifyRelease(ctx, { tag: 'v1.2.0', globals: globalsFor(ctx) })
		).rejects.toThrow(/uncommitted changes/);
		expect(site.state.calls).toHaveLength(0);
	});

	it('refuses a tag that is not what is checked out, and names the checkout', async () => {
		const ctx = ctxFor(memoryFiles(tree()), fakeSite().fetch, {
			...CLEAN,
			'git rev-parse HEAD': ok('999999999\n')
		});
		await expect(
			runModifyRelease(ctx, { tag: 'v1.2.0', globals: globalsFor(ctx) })
		).rejects.toThrow(/git checkout v1\.2\.0/);
	});

	it('refuses a tag the repository does not have', async () => {
		const ctx = ctxFor(memoryFiles(tree()), fakeSite().fetch, {
			...CLEAN,
			'git rev-parse v1.2.0^{commit}': fail(128, 'unknown revision')
		});
		await expect(
			runModifyRelease(ctx, { tag: 'v1.2.0', globals: globalsFor(ctx) })
		).rejects.toThrow(/no tag/);
	});

	it('refuses a project with no repository around it', async () => {
		const files = tree();
		delete files[`${DIR}/.git/HEAD`];
		const ctx = ctxFor(memoryFiles(files), fakeSite().fetch, CLEAN);
		await expect(
			runModifyRelease(ctx, { tag: 'v1.2.0', globals: globalsFor(ctx) })
		).rejects.toThrow(/not a git checkout/);
	});
});

describe('the parser', () => {
	it('reads the project directory out of drangler.json', async () => {
		const site = fakeSite();
		const files = memoryFiles({
			...tree(),
			[`${DIR}/drangler.json`]: JSON.stringify({
				site: { origin: ORIGIN },
				module: { root: '.', package: 'mantle2' }
			}),
			[GLOBAL]: JSON.stringify({ sites: { [ORIGIN]: { ownerToken: TOKEN } } })
		});
		const ctx = ctxFor(files, site.fetch);
		expect(await run(ctx, ['modify', 'status'])).toBe(EXIT.OK);
		expect(ctx.io.text()).toContain('mantle2');
	});

	it('exits 3 from `modify diff` so a CI step reads a status', async () => {
		const files = memoryFiles({
			...tree(),
			[`${DIR}/drangler.json`]: JSON.stringify({ site: { origin: ORIGIN } }),
			[GLOBAL]: JSON.stringify({ sites: { [ORIGIN]: { ownerToken: TOKEN } } })
		});
		const ctx = ctxFor(files, fakeSite().fetch);
		expect(await run(ctx, ['modify', 'diff'])).toBe(EXIT.FINDING);
	});
});

/**
 * The text render, which the cases above skip by asking for `--json`.
 *
 * The two are built from the same object, so a render that threw would be invisible to a suite that
 * only reads the JSON.
 */
describe('the text render', () => {
	const plain = (ctx: TestContext) => globalsFor(ctx, { json: false });

	it('prints where init detected the project and where each answer landed', async () => {
		const ctx = ctxFor();
		await runModifyInit(ctx, { globals: plain(ctx) });
		expect(ctx.io.text()).toContain('detected     module-project');
		expect(ctx.io.text()).toContain('mounts to    modules/custom/mantle2');
		expect(ctx.io.text()).toContain('(mode 0600)');
	});

	it('prints live against local, and the history behind it', async () => {
		const site = fakeSite();
		const files = memoryFiles(tree());
		const uploading = ctxFor(files, site.fetch);
		await runModifyUpload(uploading, { globals: globalsFor(uploading) });

		const ctx = ctxFor(files, site.fetch);
		await runModifyStatus(ctx, { globals: plain(ctx) });
		expect(ctx.io.text()).toContain('(clean)');
		expect(ctx.io.text()).toContain('revision(s)');
	});

	it('prints the dependency table and the require line that follows from it', async () => {
		const ctx = ctxFor();
		await runModifyCheck(ctx, { deps: true, globals: plain(ctx) });
		expect(ctx.io.text()).toContain('drupal:json_field'.slice(0, 7));
		expect(ctx.io.text()).toContain('drangler modify require drupal/node drupal/key --enable');
	});

	it('prints the plan, the batches and the changed files an upload landed', async () => {
		const site = fakeSite();
		const ctx = ctxFor(memoryFiles(tree()), site.fetch);
		await runModifyUpload(ctx, { globals: plain(ctx) });
		expect(ctx.io.text()).toContain('3 files, 3 not on the site, 0 already there');
		expect(ctx.io.text()).toContain('verify     kernel booted');
		expect(ctx.io.stderr.join('\n')).toContain('uploading 3 blob(s)');
	});

	it('says there is no difference when there is none', async () => {
		const site = fakeSite();
		const files = memoryFiles(tree());
		const uploading = ctxFor(files, site.fetch);
		await runModifyUpload(uploading, { globals: globalsFor(uploading) });

		const ctx = ctxFor(files, site.fetch);
		await runModifyDiff(ctx, { globals: plain(ctx) });
		expect(ctx.io.text()).toContain('no difference');
	});

	it('says a site holds no revision rather than printing an empty table', async () => {
		const ctx = ctxFor();
		await runModifyRevisions(ctx, { globals: plain(ctx) });
		expect(ctx.io.text()).toContain('no stored revision of mantle2');
	});

	it('prints what a drop freed', async () => {
		const site = fakeSite();
		const files = memoryFiles(tree());
		const first = ctxFor(files, site.fetch);
		await runModifyUpload(first, { globals: globalsFor(first) });
		files.writeText(`${DIR}/mantle2.module`, '<?php\n// v2\n');
		const second = ctxFor(files, site.fetch);
		await runModifyUpload(second, { globals: globalsFor(second) });

		const ctx = ctxFor(files, site.fetch);
		await runModifyDrop(ctx, site.state.revisions[0]?.rev as string, {
			globals: globalsFor(ctx, { yes: true, json: false })
		});
		expect(ctx.io.text()).toContain('blobs freed  2');
	});
});

describe('resolving the project', () => {
	it('takes --dir relative to the working directory', async () => {
		const files = memoryFiles(tree());
		const ctx = testContext({
			files,
			fetch: fakeSite().fetch,
			env: { HOME },
			cwd: '/work'
		});
		await runModifyCheck(ctx, { dir: 'mantle2', globals: globalsFor(ctx) });
		expect(ctx.io.json<CheckReport>().package).toBe('mantle2');
	});

	it('reports a site that did not answer rather than abandoning init', async () => {
		const ctx = ctxFor(memoryFiles(tree()), (async () => {
			throw new Error('ENOTFOUND');
		}) as unknown as FetchLike);
		await runModifyInit(ctx, { globals: globalsFor(ctx) });
		expect(ctx.io.json<ModifyInitReport>()).toMatchObject({
			reachable: false,
			claimed: null
		});
	});

	it('writes only the global config under --global', async () => {
		const files = memoryFiles(tree());
		const ctx = ctxFor(files);
		await runModifyInit(ctx, { global: true, globals: globalsFor(ctx) });
		expect(files.written.has(`${DIR}/drangler.json`)).toBe(false);
		expect(files.secrets.has(GLOBAL)).toBe(true);
	});

	/**
	 * Reachable only through `--config-file`, which replaces the search.
	 *
	 * Every other route reads the global file during resolution and refuses there first; with the
	 * search replaced nothing has read it, so the write path is the last thing between a broken file
	 * and a clobbered one.
	 */
	it('refuses to overwrite a global config it cannot parse', async () => {
		const ctx = ctxFor(memoryFiles({ ...tree(), [GLOBAL]: 'not json', '/tmp/one.json': '{}' }));
		await expect(
			runModifyInit(ctx, {
				globals: testGlobals({ json: true }, ctx, {
					configFile: '/tmp/one.json',
					site: ORIGIN,
					token: TOKEN
				})
			})
		).rejects.toThrow(/not valid JSON/);
	});

	it('enables nothing under --dry-run', async () => {
		const site = fakeSite();
		const ctx = ctxFor(memoryFiles(tree()), site.fetch);
		await runModifyEnable(ctx, ['mantle2'], { globals: globalsFor(ctx, { dryRun: true }) });
		expect(site.state.calls).toHaveLength(0);
	});

	it('names at least one package for require and enable', async () => {
		const ctx = ctxFor();
		await expect(
			runModifyRequire(ctx, [], { globals: globalsFor(ctx) })
		).rejects.toBeInstanceOf(UsageError);
		await expect(runModifyEnable(ctx, [], { globals: globalsFor(ctx) })).rejects.toBeInstanceOf(
			UsageError
		);
	});

	it('needs a revision to activate, or the rollback command', async () => {
		const ctx = ctxFor();
		await expect(
			runModifyActivate(ctx, undefined, { globals: globalsFor(ctx, { yes: true }) })
		).rejects.toThrow(/modify rollback/);
	});

	// a revision with no files would unmount the package, so it is refused before anything is sent
	it('refuses a selection with no mountable file at all', async () => {
		const site = fakeSite();
		const ctx = ctxFor(memoryFiles(tree()), site.fetch);
		const pkg = packageOf(detectProject(ctx.files, DIR));
		await expect(
			uploadPackage(
				ctx,
				ownerTarget(globalsFor(ctx)),
				pkg,
				{ files: [], skipped: [], totalBytes: 0 },
				{
					label: 'empty',
					origin: DIR
				}
			)
		).rejects.toBeInstanceOf(DranglerError);
		expect(site.state.calls).toHaveLength(0);
	});

	it('reports a commit naming a blob the site does not hold', async () => {
		const site = fakeSite();
		const ctx = ctxFor(memoryFiles(tree()), site.fetch);
		// the blobs are dropped on the floor, so the manifest names nothing the site has
		site.state.blobs = { add: () => {}, has: () => false } as unknown as Set<string>;
		await expect(runModifyUpload(ctx, { globals: globalsFor(ctx) })).rejects.toThrow(
			/does not hold/
		);
		expect(ctx.io.json<UploadResult>().notes.join(' ')).toContain('does not hold');
	});
});
