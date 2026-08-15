/**
 * What the destination worker actually runs, and where that answer came from.
 *
 * So the version is now a VALUE with a PROVENANCE attached, never a bare constant. Every message
 * built from it says which it is, because "the worker ships PHP 8.5" and "the worker probably ships
 * PHP 8.5" are different claims and only one of them is safe to act on.
 */

/** where a target-runtime figure came from; the plan prints this rather than hiding it */
export type RuntimeSource = 'probed' | 'stated' | 'assumed';

export interface TargetRuntime {
	/** the PHP version the destination runs, as `major.minor` or fuller */
	php: string;
	source: RuntimeSource;
	/** how the figure was obtained, in a clause a plan can print verbatim */
	note: string;
}

/**
 * The fallback, used when nothing could be read.
 *
 * Correct as of the worker's `wrangler.jsonc` aliasing `./runtime/php-binary.js` to
 * `php-binary-85.ts`. `tests/target-runtime.spec.ts` reads that alias out of the sibling checkout
 * and fails when the two drift, so this constant is checked against the artifact rather than
 * against itself.
 *
 * **It is a fallback rather than a fact, and the normal case.** The only route that reports the
 * interpreter version is `/php`, which is diagnostic-gated -- so on a correctly configured
 * deployment drangler CANNOT read it, and `x-cfw-v` does not help: that is the header CONTRACT
 * version, bumped when a header is renamed, and it carries nothing about PHP.
 */
export const FALLBACK_TARGET_PHP = '8.5';

/** the labelled fallback; every caller that has nothing better uses this rather than a literal */
export function assumedTarget(php: string = FALLBACK_TARGET_PHP): TargetRuntime {
	return {
		php,
		source: 'assumed',
		note: `assumed; the interpreter version is only reported by /php, which is diagnostic-gated. Pass --target-php, or --site to read it from a deployment that exposes it`
	};
}

/** a version the operator supplied, which outranks the fallback and is not a measurement either */
export function statedTarget(php: string): TargetRuntime {
	return { php, source: 'stated', note: 'stated with --target-php' };
}

/** a version read off a live deployment */
export function probedTarget(php: string, origin: string): TargetRuntime {
	return { php, source: 'probed', note: `read from ${origin}/php` };
}

/** `8.5.2` and `8.5` both compare as 8.5; a missing minor is 0 rather than a guess */
export function versionParts(version: string): { major: number; minor: number } {
	const [major = 0, minor = 0] = String(version)
		.split('.')
		.map((p) => Number.parseInt(p, 10) || 0);
	return { major, minor };
}

/**
 * Whether `source` is older than `target`, at major.minor precision.
 *
 * Patch level is deliberately ignored: 8.5.1 against 8.5.2 is not a behaviour change worth warning
 * about, and warning on it would make the rule fire on every site forever.
 */
export function isOlderThan(source: string, target: string): boolean {
	const a = versionParts(source);
	const b = versionParts(target);
	return a.major < b.major || (a.major === b.major && a.minor < b.minor);
}

/**
 * Reads the interpreter version off a deployment's `/php` route.
 *
 * Returns null rather than throwing for every failure mode -- gated, absent, unreachable, or a body
 * without a `version` -- because not being able to read it is the expected case and must degrade to
 * the labelled fallback rather than failing a plan.
 */
export async function probeTargetPhp(
	fetchFn: typeof fetch,
	origin: string,
	site = 'site',
	timeoutMs = 15_000
): Promise<TargetRuntime | null> {
	const base = origin.startsWith('http') ? origin : `https://${origin}`;
	let url: URL;
	try {
		url = new URL('/php', base);
	} catch {
		return null;
	}
	url.searchParams.set('site', site);
	try {
		const res = await fetchFn(url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return null;
		const body = (await res.json()) as { version?: unknown };
		if (typeof body.version !== 'string' || body.version === '') return null;
		return probedTarget(body.version, new URL(base).origin);
	} catch {
		return null;
	}
}
