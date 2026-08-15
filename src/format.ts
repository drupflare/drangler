import type { Io } from './io';

/** Right-pads to a display width; ASCII only, which is the house rule for CLI output. */
function pad(text: string, width: number): string {
	return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** A two-column list, keys aligned. Empty input renders nothing rather than a blank line. */
export function kv(rows: readonly (readonly [string, string])[]): string[] {
	if (rows.length === 0) return [];
	const width = Math.max(...rows.map(([k]) => k.length));
	return rows.map(([k, v]) => `${pad(k, width)}  ${v}`);
}

/** A fixed-width table with a dashed rule under the header. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length), 0)
	);
	const line = (cells: readonly string[]) =>
		cells
			.map((c, i) => pad(c, widths[i] ?? 0))
			.join('  ')
			.trimEnd();
	return [
		line(headers),
		widths
			.map((w) => '-'.repeat(w))
			.join('  ')
			.trimEnd(),
		...rows.map(line)
	];
}

/**
 * Emits either the JSON document or the human render.
 *
 * The JSON is the same object the text is derived from, so `--json` can never report something the
 * text cannot; a second formatter that built its own object is how those two drift.
 */
export function emit(io: Io, json: boolean, value: unknown, lines: () => string[]): void {
	if (json) {
		io.out(JSON.stringify(value, null, 2));
		return;
	}
	for (const line of lines()) io.out(line);
}

/** `1234567` as `1.2 MB`, decimal units, because every Cloudflare limit is quoted decimal. */
export function bytes(n: number | null): string {
	if (n === null || !Number.isFinite(n)) return 'unknown';
	const units = ['B', 'kB', 'MB', 'GB', 'TB'];
	let value = n;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
