/**
 * The Worker size ceiling, and how to read the only figure that counts against it.
 *
 * MOVED HERE FROM `worker/scripts/release-payload.ts` and `worker/scripts/measure/bundle-size.ts`,
 * which is why the numbers carry their provenance: this is the check a user needs before their
 * first deploy, not something only a release cuts.
 */

/**
 * Worker size limit: 64 MiB UNCOMPRESSED, the same on Free and Paid since 2026-09-04.
 *
 * Cloudflare removed the compressed limit that day and their documentation says only the
 * uncompressed bundle size counts. `worker/scripts/measure/bundle-size.ts` carries the same
 * constant as `SIZE_CEILING`.
 *
 * THE OLD CEILINGS WERE 3,145,728 FREE AND 10,485,760 PAID, ON THE GZIPPED FIGURE. Checking against
 * them fails a bundle that uploads: the shipping worker measures 3,990.8 KiB gzipped and deploys.
 */
export const SIZE_CEILING = 67_108_864;

/**
 * Reads one of wrangler's own printed size figures.
 *
 * Wrangler prints KiB (`Total Upload: 11000.00 KiB / gzip: 2818.80 KiB`) and the ceiling is in
 * bytes, so the conversion is the whole point of this. `drupflare/worker`'s report has already
 * quoted one such figure as bytes, which overstated the headroom by 67,406.
 */
function parseWranglerBytes(stdout: string, label: string): number | undefined {
	const kib = new RegExp(`${label}:\\s*([\\d.]+)\\s*KiB`).exec(stdout)?.[1];
	if (kib !== undefined) return Math.round(Number.parseFloat(kib) * 1024);
	const mib = new RegExp(`${label}:\\s*([\\d.]+)\\s*MiB`).exec(stdout)?.[1];
	if (mib !== undefined) return Math.round(Number.parseFloat(mib) * 1024 * 1024);
	const b = new RegExp(`${label}:\\s*(\\d+)\\s*B\\b`).exec(stdout)?.[1];
	return b === undefined ? undefined : Number.parseInt(b, 10);
}

/**
 * The uncompressed upload, which is the figure {@link SIZE_CEILING} is checked on.
 *
 * @returns bytes, or `undefined` when the line is absent, which means the run failed rather than
 *   that the bundle is small.
 */
export function parseWranglerTotalBytes(stdout: string): number | undefined {
	return parseWranglerBytes(stdout, 'Total Upload');
}

/**
 * The gzipped figure, which is reported and no longer compared against anything.
 *
 * Kept because every historical measurement in `drupflare/worker`'s report is expressed in it, so a
 * user reading an old number needs the current one in the same unit.
 */
export function parseWranglerGzipBytes(stdout: string): number | undefined {
	return parseWranglerBytes(stdout, 'gzip');
}

export interface CeilingVerdict {
	bytes: number;
	fits: boolean;
	/** negative is the overshoot */
	headroom: number;
}

/** How a measured bundle sits against the one ceiling both plans now share. */
export function ceilingVerdict(bytes: number): CeilingVerdict {
	return { bytes, fits: bytes <= SIZE_CEILING, headroom: SIZE_CEILING - bytes };
}
