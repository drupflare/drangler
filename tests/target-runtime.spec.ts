import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripJsonComments } from '../src/cloudflare/config';
import {
	assumedTarget,
	FALLBACK_TARGET_PHP,
	isOlderThan,
	probedTarget,
	probeTargetPhp,
	statedTarget,
	versionParts
} from '../src/migrate/target-runtime';
import { fakeFetch } from './helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_CONFIG = resolve(HERE, '..', '..', 'worker', 'wrangler.jsonc');

/**
 * Reads which interpreter the worker's own config selects.
 *
 * The alias in `wrangler.jsonc` is the authority: `"./runtime/php-binary.js"` points at
 * `./src/runtime/php-binary-85.ts`, and the `85` in that filename is the shipping version. Reading
 * the alias rather than a version string means this tracks the thing that actually decides which
 * wasm binary is bundled.
 */
function shippingPhpFromWorkerConfig(): string | null {
	if (!existsSync(WORKER_CONFIG)) return null;
	const config = JSON.parse(stripJsonComments(readFileSync(WORKER_CONFIG, 'utf8'))) as {
		alias?: Record<string, string>;
	};
	const target = config.alias?.['./runtime/php-binary.js'];
	if (typeof target !== 'string') return null;
	const digits = /php-binary-(\d)(\d+)\.ts$/.exec(target);
	if (digits === null) return null;
	return `${digits[1]}.${digits[2]}`;
}

/**
 * The drift check, against the sibling checkout rather than against drangler's own constant.
 *
 * **Skip when the worker is not checked out, FAIL when the lane declares it.** Same asymmetry as
 * the docker lane's `REQUIRE_DOCKER` and the worker's own `artifact-gate.ts`. On drangler-only CI
 * the sibling is absent and this skips, so it is honestly worth nothing there -- it earns its place
 * on the machine where the two repositories sit side by side, which is where a version bump is made
 * and therefore where the drift would be introduced.
 *
 * A test that compared `FALLBACK_TARGET_PHP` to a literal would pass forever and catch nothing;
 * that is exactly the shape that let the drupal.org metadata path rot twice.
 */
const shipping = shippingPhpFromWorkerConfig();
if (shipping === null && process.env.REQUIRE_SIBLINGS) {
	throw new Error(
		`no worker checkout at ${WORKER_CONFIG}, and REQUIRE_SIBLINGS says this lane has one. ` +
			'Check out drupflare/worker beside drangler, or unset REQUIRE_SIBLINGS.'
	);
}

describe.skipIf(shipping === null)('the fallback tracks what the worker actually ships', () => {
	it('matches the interpreter the worker config aliases', () => {
		expect(shipping).not.toBeNull();
		expect(
			FALLBACK_TARGET_PHP,
			`drangler assumes PHP ${FALLBACK_TARGET_PHP}; ${WORKER_CONFIG} aliases php-binary to ${shipping}`
		).toBe(shipping);
	});

	it('reads the alias rather than a version string, so a binary swap is what moves it', () => {
		const raw = readFileSync(WORKER_CONFIG, 'utf8');
		expect(raw).toContain('./runtime/php-binary.js');
	});
});

describe('versionParts', () => {
	it('reads major and minor, ignoring the patch', () => {
		expect(versionParts('8.5.2')).toEqual({ major: 8, minor: 5 });
		expect(versionParts('8.5')).toEqual({ major: 8, minor: 5 });
	});

	it('treats a missing or unparseable part as zero rather than guessing', () => {
		expect(versionParts('9')).toEqual({ major: 9, minor: 0 });
		expect(versionParts('')).toEqual({ major: 0, minor: 0 });
		expect(versionParts('next')).toEqual({ major: 0, minor: 0 });
	});
});

describe('isOlderThan', () => {
	it('compares at major.minor and ignores the patch', () => {
		expect(isOlderThan('8.4.9', '8.5')).toBe(true);
		expect(isOlderThan('8.5.1', '8.5.2')).toBe(false);
		expect(isOlderThan('8.5', '8.5')).toBe(false);
	});

	it('is the assertion that was wrong: 8.4 against a worker on 8.5', () => {
		// the old rule hardcoded `minor >= 3` and passed this silently
		expect(isOlderThan('8.4.0', '8.5')).toBe(true);
	});

	it('does not warn when the source is newer', () => {
		expect(isOlderThan('8.6', '8.5')).toBe(false);
		expect(isOlderThan('9.0', '8.5')).toBe(false);
	});
});

describe('provenance', () => {
	it('labels the fallback as assumed and says why it could not be read', () => {
		const target = assumedTarget();
		expect(target).toMatchObject({ php: FALLBACK_TARGET_PHP, source: 'assumed' });
		expect(target.note).toContain('diagnostic-gated');
	});

	it('labels a stated and a probed figure differently', () => {
		expect(statedTarget('8.4').source).toBe('stated');
		expect(probedTarget('8.5.2', 'https://x.dev').note).toContain('https://x.dev/php');
	});
});

describe('probeTargetPhp', () => {
	it('reads the version off /php', async () => {
		const fetch = fakeFetch(
			() => new Response(JSON.stringify({ version: '8.5.2', bootMs: 180 }))
		);
		const target = await probeTargetPhp(fetch, 'x.dev');
		expect(target).toMatchObject({ php: '8.5.2', source: 'probed' });
		expect(fetch.urls[0]).toBe('https://x.dev/php?site=site');
	});

	it('returns null on the gated 404, because that is the correct posture', async () => {
		const fetch = fakeFetch(() => new Response('not found', { status: 404 }));
		expect(await probeTargetPhp(fetch, 'x.dev')).toBeNull();
	});

	it('returns null on an unreachable host rather than throwing', async () => {
		const fetch = fakeFetch(() => {
			throw new Error('ENOTFOUND');
		});
		expect(await probeTargetPhp(fetch, 'x.dev')).toBeNull();
	});

	it('returns null on a body with no version', async () => {
		expect(
			await probeTargetPhp(
				fakeFetch(() => new Response('{}')),
				'x.dev'
			)
		).toBeNull();
		expect(
			await probeTargetPhp(
				fakeFetch(() => new Response('not json')),
				'x.dev'
			)
		).toBeNull();
	});

	it('returns null for a target that is not a URL', async () => {
		expect(
			await probeTargetPhp(
				fakeFetch(() => new Response('{}')),
				'http://'
			)
		).toBeNull();
	});
});
