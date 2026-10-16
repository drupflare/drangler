import { describe, expect, it } from 'vitest';
import { followModules, followRoot, parseFollow } from '../src/commands/preview-follow';
import { UsageError } from '../src/errors';
import type { OwnerTarget } from '../src/owner';
import { fakeFetch, testContext } from './helpers';

const OWNER: OwnerTarget = {
	origin: 'http://localhost:8787',
	site: null,
	token: 'tok',
	timeoutMs: 5000
};

describe('parseFollow', () => {
	it('reads module=owner/repo as a GitHub repository', () => {
		expect(parseFollow('mantle2=earth-app/mantle2')).toEqual({
			module: 'mantle2',
			url: 'https://github.com/earth-app/mantle2.git'
		});
		expect(parseFollow('x=owner/repo.name.git').url).toBe(
			'https://github.com/owner/repo.name.git'
		);
	});

	it('takes an https clone URL as given, for any host', () => {
		expect(parseFollow('mod=https://git.example.edu/team/mod.git')).toEqual({
			module: 'mod',
			url: 'https://git.example.edu/team/mod.git'
		});
	});

	it('refuses everything that is not module=repository, naming what it got', () => {
		for (const bad of [
			'mantle2',
			'=owner/repo',
			'Mantle2=owner/repo',
			'mantle2=',
			'mantle2=http://example.edu/r.git',
			'mantle2=git@github.com:owner/repo.git',
			'mantle2=file:///etc/passwd',
			'mantle2=one two'
		]) {
			expect(() => parseFollow(bad), bad).toThrow(UsageError);
		}
	});
});

describe('followRoot', () => {
	const paths = [
		'modules/mantle2/mantle2.info.yml',
		'modules/mantle2/src/A.php',
		'modules/contrib/redis/redis.info.yml',
		'themes/custom/bright/bright.info.yml'
	];

	it('is the directory the carried info file sits in, wherever the host kept the module', () => {
		expect(followRoot('mantle2', paths)).toBe('modules/mantle2');
		expect(followRoot('bright', paths)).toBe('themes/custom/bright');
		expect(followRoot('x', ['web/modules/deep/er/x.info.yml'])).toBe('web/modules/deep/er');
	});

	it('refuses a module that was not carried, and lists the ones that were, minus contrib', () => {
		const err = (() => {
			try {
				followRoot('nope', paths);
			} catch (e) {
				return e as UsageError;
			}
			return null;
		})();
		expect(err).toBeInstanceOf(UsageError);
		expect(err?.message).toContain('no nope.info.yml was carried');
		expect(err?.message).toContain('mantle2');
		expect(err?.message).toContain('bright');
		expect(err?.message).not.toContain('redis');
	});

	it('refuses a module carried at two places, which has no one path to follow it at', () => {
		expect(() => followRoot('m', ['modules/a/m.info.yml', 'modules/b/m.info.yml'])).toThrow(
			/carried at 2 places/
		);
	});

	it('refuses an info file at the root of the carried tree, which names no directory', () => {
		expect(() => followRoot('m', ['m.info.yml'])).toThrow(UsageError);
	});
});

describe('followModules', () => {
	const follow = {
		module: 'mantle2',
		url: 'https://github.com/earth-app/mantle2.git',
		root: 'modules/mantle2'
	};

	/** answers /git add and pull from a table and records what was sent */
	function worker(add: Response, pull: Response) {
		const seen: { action: string; params: Record<string, string>; auth: string | null }[] = [];
		const fetch = fakeFetch((url, init) => {
			const u = new URL(String(url));
			const action = u.searchParams.get('action') ?? '';
			seen.push({
				action,
				params: Object.fromEntries(u.searchParams),
				auth: new Headers((init as RequestInit | undefined)?.headers).get('authorization')
			});
			return action === 'add' ? add.clone() : pull.clone();
		});
		return { ctx: testContext({ fetch }), seen };
	}

	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});

	it('adds the remote with its mount and interval as the owner, then pulls it by id', async () => {
		const { ctx, seen } = worker(
			json({ ok: true, id: 'generic:earth-app/mantle2@master' }),
			json({ ok: true, sha: 'e0b02785bec991ca', counts: { added: 78, modified: 2 } })
		);
		const out = await followModules(ctx, OWNER, [follow], 5);
		expect(out).toEqual([
			{
				module: 'mantle2',
				ok: true,
				summary:
					'mantle2 follows https://github.com/earth-app/mantle2.git at modules/mantle2, polled every 5 min; pulled e0b0278, 80 file(s) written and Drupal booted against them'
			}
		]);
		expect(seen.map((s) => s.action)).toEqual(['add', 'pull']);
		expect(seen[0]?.params).toMatchObject({
			provider: 'generic',
			repo: follow.url,
			interval: '5',
			mount: 'modules/mantle2'
		});
		expect(seen[1]?.params['id']).toBe('generic:earth-app/mantle2@master');
		expect(seen.every((s) => s.auth === 'Bearer tok')).toBe(true);
	});

	it("reports a refused add with the worker's reason, and does not pull", async () => {
		const { ctx, seen } = worker(
			json(
				{ ok: false, error: 'mount must be a path inside modules, themes or profiles' },
				400
			),
			json({ ok: true })
		);
		const out = await followModules(ctx, OWNER, [follow], 5);
		expect(out[0]?.ok).toBe(false);
		expect(out[0]?.summary).toContain('mount must be a path inside');
		expect(seen.map((s) => s.action)).toEqual(['add']);
	});

	it('says the duplicate still runs the carried code when the first pull fails', async () => {
		const { ctx } = worker(
			json({ ok: true, id: 'r1' }),
			json({ ok: false, error: 'rolled back: the kernel refused to boot' }, 409)
		);
		const out = await followModules(ctx, OWNER, [follow], 5);
		expect(out[0]?.ok).toBe(false);
		expect(out[0]?.summary).toContain('rolled back: the kernel refused to boot');
		expect(out[0]?.summary).toContain('still runs the carried code');
	});

	it('follows each module in order and reports each on its own', async () => {
		const { ctx, seen } = worker(
			json({ ok: true, id: 'r' }),
			json({ ok: true, sha: 'abcdef1234', counts: { added: 1 } })
		);
		const out = await followModules(
			ctx,
			OWNER,
			[
				follow,
				{
					module: 'bright',
					url: 'https://github.com/o/bright.git',
					root: 'themes/custom/bright'
				}
			],
			10
		);
		expect(out.map((o) => o.module)).toEqual(['mantle2', 'bright']);
		expect(seen.map((s) => s.action)).toEqual(['add', 'pull', 'add', 'pull']);
		expect(seen[2]?.params['interval']).toBe('10');
	});
});
