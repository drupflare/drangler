/**
 * Config the platform decides for the duplicate, whatever the source host had.
 *
 * `$config` in the source's `settings.php` outranks every config override the worker registers, so
 * a value the platform cannot run with has to be corrected where it is carried, in `DRUPAL_CONFIG`.
 */

/** the config object that holds the two aggregation switches */
export const PERFORMANCE_CONFIG = 'system.performance';

function objectOf(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {};
}

/**
 * Turns Drupal's CSS and JS aggregation off in the carried overrides.
 *
 * Aggregation reads the source stylesheets and scripts with the interpreter's file functions, and
 * those files are served by the asset layer rather than held in the interpreter's filesystem, so the
 * aggregate route answers a licence header alone and a page loses its whole theme (the
 * administration theme's aggregate was 3,327 bytes on a migrated production site, 2026-10-16). A
 * production site has aggregation on, and often says so in `settings.php`, which is how it arrived.
 * The worker aggregates at the edge from files it publishes, and wants the individual tags.
 *
 * @param config - the carried `$config` overrides, changed in place
 * @returns whether the source asked for aggregation, so the report can say what was changed
 */
export function forceAggregationOff(config: Record<string, unknown>): boolean {
	const performance = objectOf(config[PERFORMANCE_CONFIG]);
	const css = objectOf(performance['css']);
	const js = objectOf(performance['js']);
	const wasOn = css['preprocess'] === true || js['preprocess'] === true;
	config[PERFORMANCE_CONFIG] = {
		...performance,
		css: { ...css, preprocess: false },
		js: { ...js, preprocess: false }
	};
	return wasOn;
}
