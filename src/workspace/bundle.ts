/**
 * The Worker size ceiling, and how to read the only figure that counts against it.
 *
 * MOVED HERE FROM `worker/scripts/release-payload.ts` and `worker/scripts/measure/bundle-size.ts`,
 * which is why the numbers carry their provenance: this is the check a user needs before their
 * first deploy, not something only a release cuts.
 */

/**
 * Free-plan Worker size after gzip, and it is MiB rather than MB: 3 * 1024 * 1024.
 *
 * Confirmed twice over in `drupflare/worker` -- by the API's own `code: 10027` rejection, and by
 * wrangler's reported figure for bundles measured either side of the boundary.
 */
export const FREE_CEILING = 3_145_728;

/** paid, for the second verdict */
export const PAID_CEILING = 10_485_760;

/**
 * Reads the gzipped bundle size out of wrangler's own output.
 *
 * Wrangler prints KiB (`gzip: 2818.80 KiB`) and the ceiling is in bytes, so the conversion is the
 * whole point of this function. `drupflare/worker`'s report has already quoted one such figure as
 * bytes, which overstated the headroom by 67,406.
 *
 * @returns bytes, or `undefined` when the line is absent, which means the run failed rather than
 *   that the bundle is small.
 */
export function parseWranglerGzipBytes(stdout: string): number | undefined {
	const kib = /gzip:\s*([\d.]+)\s*KiB/.exec(stdout)?.[1];
	if (kib !== undefined) return Math.round(Number.parseFloat(kib) * 1024);
	const mib = /gzip:\s*([\d.]+)\s*MiB/.exec(stdout)?.[1];
	if (mib !== undefined) return Math.round(Number.parseFloat(mib) * 1024 * 1024);
	const b = /gzip:\s*(\d+)\s*B\b/.exec(stdout)?.[1];
	return b === undefined ? undefined : Number.parseInt(b, 10);
}

export interface CeilingVerdict {
	bytes: number;
	fitsFree: boolean;
	fitsPaid: boolean;
	freeHeadroom: number;
	paidHeadroom: number;
}

/** How a measured bundle sits against both ceilings. Negative headroom is the overshoot. */
export function ceilingVerdict(bytes: number): CeilingVerdict {
	return {
		bytes,
		fitsFree: bytes <= FREE_CEILING,
		fitsPaid: bytes <= PAID_CEILING,
		freeHeadroom: FREE_CEILING - bytes,
		paidHeadroom: PAID_CEILING - bytes
	};
}
