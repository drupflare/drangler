import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifestRev, sha256, type DeclaredFile } from '../src/modify/upload';

const FILES: DeclaredFile[] = [
	{ path: 'modules/custom/probe/src/Probe.php', hash: 'c'.repeat(64), bytes: 3 },
	{ path: 'modules/custom/probe/probe.info.yml', hash: 'a'.repeat(64), bytes: 1 },
	{ path: 'modules/custom/probe/probe.module', hash: 'b'.repeat(64), bytes: 2 }
];

describe('manifestRev', () => {
	it('joins each entry with a NUL and each line with a newline, sorted by path', async () => {
		const canonical = [
			`modules/custom/probe/probe.info.yml\0${'a'.repeat(64)}`,
			`modules/custom/probe/probe.module\0${'b'.repeat(64)}`,
			`modules/custom/probe/src/Probe.php\0${'c'.repeat(64)}`
		].join('\n');
		expect(await manifestRev(FILES)).toBe(await sha256(canonical));
	});

	// a space is what this used, and it is not a near miss: every id disagreed with the site's
	it('is not the space-separated form', async () => {
		const spaced = [...FILES]
			.sort((a, b) => (a.path < b.path ? -1 : 1))
			.map((f) => `${f.path} ${f.hash}`)
			.join('\n');
		expect(await manifestRev(FILES)).not.toBe(await sha256(spaced));
	});

	it('does not depend on the order the tree was walked in', async () => {
		expect(await manifestRev(FILES)).toBe(await manifestRev([...FILES].reverse()));
	});
});

/**
 * The drift check, against the sibling rather than against drangler's own copy.
 *
 * The site computes the revision id and drangler recomputes it locally, which is the whole reason
 * `modify status` can answer `clean` without asking the site to hash anything. Two implementations
 * of one formula is exactly the shape that drifts silently: the gate lane compares this function
 * against itself and agrees forever, and it did, on a separator that was wrong.
 *
 * Skips when the sibling is absent and FAILS under `REQUIRE_SIBLINGS=1`, the same asymmetry as
 * `tests/modify-detect.spec.ts`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_REV = resolve(HERE, '..', '..', 'worker', 'src', 'ops', 'module-rev.ts');
const revSource = existsSync(MODULE_REV) ? readFileSync(MODULE_REV, 'utf8') : null;
if (revSource === null && process.env.REQUIRE_SIBLINGS) {
	throw new Error(
		`no worker checkout at ${MODULE_REV}, and REQUIRE_SIBLINGS says this lane has one.`
	);
}

describe.skipIf(revSource === null)('the revision id tracks the worker', () => {
	const body = (): string => {
		const source = revSource as string;
		const start = source.indexOf('export async function hashManifest');
		return source.slice(start, source.indexOf('\n}', start));
	};

	it('separates the two fields with the same byte', () => {
		// read out of the sibling's template literal rather than named here, so a change to it
		// fails this rather than being mirrored by hand into an assertion that agrees with itself
		const literal = /`\$\{path\}(.*?)\$\{manifest\[path\]\}`/s.exec(body())?.[1];
		expect(literal, 'the sibling no longer maps path and hash into one template').toBeDefined();
		expect(literal).toBe('\0');
	});

	it('joins the lines with the same byte and sorts by path', () => {
		expect(body()).toContain(".join('\\n')");
		expect(body()).toContain('.sort()');
	});
});
