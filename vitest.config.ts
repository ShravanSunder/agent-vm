import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		testTimeout: 300_000,
		hookTimeout: 120_000,
		pool: 'forks',
		fileParallelism: false,
		// Default suite runs unit-style tests. Live integration coverage uses
		// the explicit .integration.test.ts suffix and runs separately.
		include: ['packages/**/*.test.ts', 'packages/**/*.spec.ts'],
		exclude: [
			'**/node_modules/**',
			'**/*.integration.test.ts',
			'**/tests/integration/**',
			'**/tests/e2e/**',
		],
		setupFiles: ['./vitest.setup.ts'],
	},
});
