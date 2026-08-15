import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_WORKER_REF, DEFAULT_WORKER_SOURCE } from '../../../src/workspace/source';
import { sh } from './docker';

/** where this lane clones from; the published repository unless something points it elsewhere */
export const WORKER_SOURCE = process.env.DRANGLER_WORKER_SOURCE ?? DEFAULT_WORKER_SOURCE;
export const WORKER_REF = process.env.DRANGLER_WORKER_REF ?? DEFAULT_WORKER_REF;

/**
 * Whether the clone lane should skip itself.
 *
 * Same asymmetry as `dockerGate`: a developer offline should not see red, and a CI run that
 * skipped must not be indistinguishable from one that passed. `git ls-remote` is the probe because
 * it is the cheapest thing that proves both facts this lane rests on -- the network is up, and the
 * repository answers without a credential -- and it works unchanged against a local `--source`.
 */
export async function cloneGate(): Promise<boolean> {
	const probe = await sh('git', ['ls-remote', '--heads', WORKER_SOURCE, WORKER_REF], {
		timeoutMs: 120_000
	});
	if (probe.code === 0 && probe.stdout.trim() !== '') return false;
	if (process.env.REQUIRE_CLONE) {
		throw new Error(
			`e2e: ${WORKER_SOURCE} has no ${WORKER_REF}, and REQUIRE_CLONE says this lane clones it.\n` +
				`  git ls-remote exited ${probe.code}: ${probe.stderr.trim() || 'no detail'}\n` +
				'Check the network and that the repository is readable anonymously, or unset ' +
				'REQUIRE_CLONE to narrow what this lane claims to cover.'
		);
	}
	return true;
}

/** where the generated tree would come from, and which of the two it is */
export type Payload =
	| { kind: 'local'; from: string; detail: string }
	| { kind: 'release'; tag: string; detail: string };

/** `owner/name` out of a github remote, in either the https or the scp form */
export function repoSlug(source: string): string | null {
	const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(source);
	return match === null ? null : `${match[1]}/${match[2]}`;
}

/**
 * Which payload the lane can hydrate from, if any.
 *
 * Two sources and they are NOT equivalent. `DRANGLER_E2E_PAYLOAD` names a tarball somebody built,
 * which proves the hydrate path and nothing about what is published; a release tag proves the path
 * a user actually walks. The spec asserts more against the second, so which one it was is returned
 * rather than flattened into a boolean.
 *
 * The probe asks about the RELEASE, never the asset. The payload's filename is the worker's format
 * and `bun run hydrate` is what builds that URL; a second copy of the convention here is the drift
 * `CLAUDE.md` bans, and it would go stale silently because a wrong name reads as a missing release.
 */
export async function resolvePayload(): Promise<Payload | null> {
	const local = process.env.DRANGLER_E2E_PAYLOAD;
	if (local !== undefined && local.trim() !== '') {
		const path = resolve(local);
		if (!existsSync(path)) {
			throw new Error(`DRANGLER_E2E_PAYLOAD names ${path}, which is not on disk`);
		}
		return { kind: 'local', from: path, detail: `local payload ${path}` };
	}

	const slug = process.env.DRUPFLARE_REPO ?? repoSlug(WORKER_SOURCE);
	if (slug === null) {
		return missing(`${WORKER_SOURCE} is not a github remote, so it publishes no release`);
	}
	const version = await sourceVersion(slug);
	if (version === null) {
		return missing(`${slug} did not answer for the package.json on ${WORKER_REF}`);
	}
	const tag = `v${version}`;
	if (await reachable(`https://github.com/${slug}/releases/tag/${tag}`)) {
		return { kind: 'release', tag, detail: `${slug} release ${tag}` };
	}
	return missing(`${slug} has no ${tag}`);
}

/** the absence is a skip unless the lane declares otherwise, and then it names what to do */
function missing(why: string): null {
	if (process.env.REQUIRE_PAYLOAD) {
		throw new Error(
			`e2e: ${why}, and REQUIRE_PAYLOAD says this lane hydrates.\n` +
				'Cut the release, or point DRANGLER_E2E_PAYLOAD at a tarball from ' +
				'`bun run release:payload`,\nor unset REQUIRE_PAYLOAD to narrow what this lane ' +
				'claims to cover.'
		);
	}
	return null;
}

/**
 * The version the tag is derived from, read off the ref being cloned rather than off this disk.
 *
 * A local `--source` is read from its own `package.json`; a github one over raw. Either way it is
 * the same file `hydrate` reads to decide which release to fetch, so the probe and the download
 * cannot disagree about which tag they mean.
 */
async function sourceVersion(slug: string): Promise<string | null> {
	const localPkg = join(WORKER_SOURCE, 'package.json');
	const text = existsSync(localPkg)
		? readFileSync(localPkg, 'utf8')
		: await body(`https://raw.githubusercontent.com/${slug}/${WORKER_REF}/package.json`);
	if (text === null) return null;
	try {
		const version = (JSON.parse(text) as { version?: unknown }).version;
		return typeof version === 'string' ? version : null;
	} catch {
		return null;
	}
}

async function reachable(url: string): Promise<boolean> {
	try {
		return (await fetch(url, { method: 'HEAD', redirect: 'follow' })).ok;
	} catch {
		return false;
	}
}

async function body(url: string): Promise<string | null> {
	try {
		const res = await fetch(url);
		return res.ok ? await res.text() : null;
	} catch {
		return null;
	}
}
