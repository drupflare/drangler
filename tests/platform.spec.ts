import { describe, expect, it } from 'vitest';
import { forceAggregationOff } from '../src/migrate/platform';

describe('forceAggregationOff', () => {
	it('turns both switches off and reports that the source had them on', () => {
		const config: Record<string, unknown> = {
			'system.performance': {
				cache: { page: { max_age: 3600 } },
				css: { preprocess: true },
				js: { preprocess: true }
			}
		};
		expect(forceAggregationOff(config)).toBe(true);
		expect(config['system.performance']).toEqual({
			cache: { page: { max_age: 3600 } },
			css: { preprocess: false },
			js: { preprocess: false }
		});
	});

	it('reports true when only one of the two was on', () => {
		const config: Record<string, unknown> = {
			'system.performance': { css: { preprocess: false }, js: { preprocess: true } }
		};
		expect(forceAggregationOff(config)).toBe(true);
	});

	it('sets the switches when the source carried no performance override at all', () => {
		const config: Record<string, unknown> = { 'system.site': { name: 'Old' } };
		expect(forceAggregationOff(config)).toBe(false);
		expect(config).toEqual({
			'system.site': { name: 'Old' },
			'system.performance': { css: { preprocess: false }, js: { preprocess: false } }
		});
	});

	it('replaces a malformed value rather than throwing on it', () => {
		const config: Record<string, unknown> = { 'system.performance': 'on' };
		expect(forceAggregationOff(config)).toBe(false);
		expect(config['system.performance']).toEqual({
			css: { preprocess: false },
			js: { preprocess: false }
		});
	});
});
