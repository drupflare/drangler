import type { Context } from '../context';
import { UsageError } from '../errors';
import { ownerCall, replyError, type OwnerTarget } from '../owner';

/** a module the duplicate keeps current from a git repository */
export interface Follow {
	module: string;
	/** the clone URL; a public repository needs no credential over smart HTTP */
	url: string;
}

/** what following one module came to */
export interface Followed {
	module: string;
	ok: boolean;
	summary: string;
}

const MODULE = /^[a-z0-9_]+$/;

/**
 * `mantle2=https://github.com/earth-app/mantle2.git` or `mantle2=earth-app/mantle2`.
 *
 * The short form is a GitHub repository, the host people mean when they leave one out. A clone URL
 * must be https: the worker reaches it over smart HTTP and nothing else.
 */
export function parseFollow(spec: string): Follow {
	const at = spec.indexOf('=');
	const module = at === -1 ? '' : spec.slice(0, at).trim();
	const target = at === -1 ? '' : spec.slice(at + 1).trim();
	if (!MODULE.test(module) || target === '') {
		throw new UsageError(
			`--follow takes module=repository, as in mantle2=earth-app/mantle2: ${spec}`
		);
	}
	if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)) {
		return { module, url: `https://github.com/${target.replace(/\.git$/, '')}.git` };
	}
	if (!/^https:\/\/[^\s/]+\/\S+$/.test(target)) {
		throw new UsageError(
			`the repository for ${module} must be owner/repo or an https clone URL: ${target}`
		);
	}
	return { module, url: target };
}

/**
 * The directory the carried copy of a module sits in, found from where its info file landed.
 *
 * Nothing assumes `modules/custom`: the module is wherever the host kept it, and the remote is
 * mounted there so a pull replaces the carried files rather than adding a second copy.
 */
export function followRoot(module: string, paths: readonly string[]): string {
	const info = `${module}.info.yml`;
	const found = paths.filter((p) => p === info || p.endsWith(`/${info}`));
	const roots = [
		...new Set(found.map((p) => p.slice(0, Math.max(0, p.length - info.length - 1))))
	];
	if (roots.length === 1 && roots[0] !== '') return roots[0]!;
	const known = [
		...new Set(
			paths
				.filter((p) => p.endsWith('.info.yml') && !p.includes('/contrib/'))
				.map((p) => p.slice(p.lastIndexOf('/') + 1).replace(/\.info\.yml$/, ''))
		)
	]
		.sort()
		.slice(0, 12);
	throw new UsageError(
		roots.length > 1
			? `${module} is carried at ${roots.length} places (${roots.join(', ')}), so there is no one path to follow it at`
			: `no ${info} was carried, so there is nothing to follow; modules that were: ${known.join(', ') || 'none'}`
	);
}

/**
 * Registers each repository as a remote of the duplicate, mounted where the module already is,
 * and pulls it once.
 *
 * The pull is the proof: the worker applies the files and boots Drupal against them, and puts the
 * old ones back if the boot fails, so a `FAILED` row means the duplicate still runs the code it was
 * carried with. Polling is the default and needs no token against a public repository.
 */
export async function followModules(
	ctx: Pick<Context, 'fetch' | 'io'>,
	owner: OwnerTarget,
	follows: readonly (Follow & { root: string })[],
	intervalMinutes: number
): Promise<Followed[]> {
	const out: Followed[] = [];
	for (const follow of follows) {
		const added = await ownerCall(ctx, owner, '/git', {
			method: 'POST',
			params: {
				action: 'add',
				provider: 'generic',
				repo: follow.url,
				interval: intervalMinutes,
				mount: follow.root
			}
		});
		const id = added.body['id'];
		if (added.status >= 400 || added.body['ok'] === false || typeof id !== 'string') {
			out.push({
				module: follow.module,
				ok: false,
				summary: `${follow.url} was refused: ${replyError(added, 'the remote was not added')}`
			});
			continue;
		}
		const pulled = await ownerCall(ctx, owner, '/git', {
			method: 'POST',
			params: { action: 'pull', id }
		});
		if (pulled.status >= 400 || pulled.body['ok'] === false) {
			out.push({
				module: follow.module,
				ok: false,
				summary:
					`added as ${id} but the first pull failed: ${replyError(pulled, 'the pull was refused')}; ` +
					'the duplicate still runs the carried code'
			});
			continue;
		}
		const counts = (pulled.body['counts'] ?? {}) as Record<string, number>;
		const sha = typeof pulled.body['sha'] === 'string' ? pulled.body['sha'].slice(0, 7) : '?';
		const written = (counts['added'] ?? 0) + (counts['modified'] ?? 0);
		out.push({
			module: follow.module,
			ok: true,
			summary:
				`${follow.module} follows ${follow.url} at ${follow.root}, polled every ${intervalMinutes} min; ` +
				`pulled ${sha}, ${written} file(s) written and Drupal booted against them`
		});
	}
	return out;
}
