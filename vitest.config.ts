import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		testTimeout: 300_000,
		hookTimeout: 120_000,
		pool: 'forks',
		poolOptions: {
			forks: { singleFork: true },
		},
		// Unit tests: colocated with source files across all packages
		include: ['packages/**/*.test.ts', 'packages/**/*.spec.ts'],
		// Integration/E2E tests: separate directories (run with --project)
		exclude: ['**/node_modules/**', '**/tests/integration/**', '**/tests/e2e/**'],
		setupFiles: ['./vitest.setup.ts'],
	},
});
