import type { FileHost } from '../host/files';
import { CREDENTIAL_PATTERNS, type CredentialPattern } from './patterns';

export interface SecretHit {
	path: string;
	line: number;
	id: string;
	kind: string;
	risk: string;
	/** the matching line with the value replaced; the value itself is never returned or printed */
	redacted: string;
}

export interface ScanReport {
	scanned: string[];
	skipped: { path: string; reason: string }[];
	hits: SecretHit[];
}

/** Directories a walk never descends into; all are build output or vendored trees. */
export const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'vendor',
	'coverage',
	'dist',
	'.wrangler',
	'typedoc'
]);

/** Files above this are not read; a dump larger than this is scanned by streaming it in chunks. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Replaces the matched run with `***`.
 *
 * The redaction is what makes the report shareable. A scanner that printed the line it matched would
 * put the credential into a terminal, a CI log and a screenshot, which is a wider audience than the
 * file had.
 */
export function redact(line: string, pattern: CredentialPattern): string {
	const trimmed = line.length > 200 ? `${line.slice(0, 200)}...` : line;
	return trimmed.replace(new RegExp(pattern.re.source, pattern.re.flags + 'g'), '***');
}

/** Applies every pattern to one body of text, reporting the first hit per pattern per line. */
export function scanText(path: string, body: string): SecretHit[] {
	const hits: SecretHit[] = [];
	const lines = body.split('\n');
	for (const pattern of CREDENTIAL_PATTERNS) {
		if (!pattern.re.test(body)) continue;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] as string;
			if (!pattern.re.test(line)) continue;
			hits.push({
				path,
				line: i + 1,
				id: pattern.id,
				kind: pattern.kind,
				risk: pattern.risk,
				redacted: redact(line, pattern)
			});
		}
	}
	return hits.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
}

/** Every file under `path`, depth first, skipping `SKIP_DIRS`. A file path returns itself. */
export function walk(files: FileHost, path: string): string[] {
	const out: string[] = [];
	const visit = (current: string) => {
		let entries;
		try {
			entries = files.readDir(current);
		} catch {
			out.push(current);
			return;
		}
		if (entries.length === 0) {
			out.push(current);
			return;
		}
		for (const entry of entries) {
			if (entry.directory) {
				if (SKIP_DIRS.has(entry.name)) continue;
				visit(`${current}/${entry.name}`);
				continue;
			}
			out.push(`${current}/${entry.name}`);
		}
	};
	visit(path.replace(/\/+$/, '') || '/');
	return out;
}

/** Walks every path given and scans what it finds. */
export function scanPaths(files: FileHost, paths: readonly string[]): ScanReport {
	const report: ScanReport = { scanned: [], skipped: [], hits: [] };
	for (const root of paths) {
		if (!files.exists(root)) {
			report.skipped.push({ path: root, reason: 'does not exist' });
			continue;
		}
		for (const path of walk(files, root)) {
			let size: number;
			try {
				size = files.size(path);
			} catch {
				report.skipped.push({ path, reason: 'unreadable' });
				continue;
			}
			if (size > MAX_FILE_BYTES) {
				report.skipped.push({ path, reason: `larger than ${MAX_FILE_BYTES} bytes` });
				continue;
			}
			let body: string;
			try {
				body = files.readText(path);
			} catch {
				report.skipped.push({ path, reason: 'unreadable' });
				continue;
			}
			report.scanned.push(path);
			report.hits.push(...scanText(path, body));
		}
	}
	return report;
}
