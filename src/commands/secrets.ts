import type { Context } from '../context';
import { FindingError, UsageError } from '../errors';
import { emit, kv } from '../format';
import { scanPaths } from '../secrets/scan';

export interface SecretsScanOptions {
	json?: boolean;
}

/**
 * Scans migration artifacts for credentials.
 *
 * Aimed at what a migration produces rather than at a repository: a `drush sql:dump` carries every
 * user's password hash, a `settings.php` carries the database password and the hash salt, and both
 * routinely end up in a directory that becomes a publicly served asset. Values are never printed --
 * a report that quoted the match would move the credential into a terminal and a CI log.
 */
export async function runSecretsScan(
	ctx: Context,
	paths: readonly string[],
	opts: SecretsScanOptions
): Promise<void> {
	if (paths.length === 0) throw new UsageError('at least one path to scan is required');
	const report = scanPaths(ctx.files, paths);

	emit(ctx.io, opts.json === true, report, () => {
		const lines = kv([
			['scanned', String(report.scanned.length)],
			['skipped', String(report.skipped.length)],
			['hits', String(report.hits.length)]
		]);
		if (report.skipped.length > 0) {
			lines.push('', 'skipped');
			for (const skip of report.skipped) lines.push(`  ${skip.path}: ${skip.reason}`);
		}
		if (report.hits.length > 0) {
			lines.push('', 'findings');
			for (const hit of report.hits) {
				lines.push(`  ${hit.path}:${hit.line}  ${hit.kind}`);
				lines.push(`    ${hit.risk}`);
				lines.push(`    ${hit.redacted}`);
			}
		}
		return lines;
	});

	if (report.hits.length > 0) {
		throw new FindingError('secrets', `${report.hits.length} credential(s) found`);
	}
}
