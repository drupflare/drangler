import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					environment: 'node',
					include: ['tests/*.spec.ts']
				}
			},
			{
				test: {
					name: 'e2e',
					environment: 'node',
					include: ['tests/e2e/*.spec.ts'],
					// a Drupal install, an image pull and a wrangler boot; nothing here is fast
					testTimeout: 600_000,
					hookTimeout: 900_000,
					// one Drupal and one Durable Object, shared; parallel files would race the corpus
					fileParallelism: false,
					maxWorkers: 1
				}
			}
		],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'lcov', 'clover'],
			reportsDirectory: './coverage',
			include: ['src/**'],
			exclude: ['tests/**', '**/*.d.ts']
		}
	}
});
