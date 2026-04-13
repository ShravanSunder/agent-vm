import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'@shravansunder/agent-vm-gateway-interface': path.resolve(
				'./packages/gateway-interface/src/index.ts',
			),
			'@shravansunder/agent-vm-gondolin-core': path.resolve(
				'./packages/gondolin-core/src/index.ts',
			),
			'@shravansunder/agent-vm-openclaw-gateway': path.resolve(
				'./packages/openclaw-gateway/src/index.ts',
			),
			'@shravansunder/agent-vm-worker-gateway': path.resolve(
				'./packages/worker-gateway/src/index.ts',
			),
			'@shravansunder/openclaw-agent-vm-plugin': path.resolve(
				'./packages/openclaw-agent-vm-plugin/src/index.ts',
			),
		},
	},
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
