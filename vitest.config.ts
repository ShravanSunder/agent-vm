import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

function repoPath(relativePath: string): string {
	return path.resolve(repositoryRoot, relativePath);
}

export default defineConfig({
	resolve: {
		alias: {
			'@agent-vm/agent-vm': repoPath('packages/agent-vm/src/index.ts'),
			'@agent-vm/config-contracts': repoPath('packages/config-contracts/src/index.ts'),
			'@agent-vm/gondolin-adapter': repoPath('packages/gondolin-adapter/src/index.ts'),
			'@agent-vm/agent-vm-worker': repoPath('packages/agent-vm-worker/src/index.ts'),
			'@agent-vm/gateway-interface': repoPath('packages/gateway-interface/src/index.ts'),
			'@agent-vm/openclaw-agent-vm-plugin': repoPath(
				'packages/openclaw-agent-vm-plugin/src/index.ts',
			),
			'@agent-vm/secrets': repoPath('packages/secrets/src/index.ts'),
			'@agent-vm/mcp-portal/testing/fake-upstream-mcp-server': repoPath(
				'packages/mcp-portal/src/testing/fake-upstream-mcp-server.ts',
			),
			'@agent-vm/mcp-portal/core': repoPath('packages/mcp-portal/src/core/index.ts'),
			'@agent-vm/mcp-portal/mcp-proxy': repoPath('packages/mcp-portal/src/mcp-proxy/index.ts'),
			'@agent-vm/mcp-portal/cli': repoPath('packages/mcp-portal/src/cli/index.ts'),
			'@agent-vm/mcp-portal': repoPath('packages/mcp-portal/src/index.ts'),
			'@agent-vm/openclaw-mcp-portal-plugin': repoPath(
				'packages/openclaw-mcp-portal-plugin/src/index.ts',
			),
			'@agent-vm/openclaw-gateway': repoPath('packages/openclaw-gateway/src/index.ts'),
			'@agent-vm/worker-gateway': repoPath('packages/worker-gateway/src/index.ts'),
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
			'**/*.smoke.test.ts',
			'**/*.integration.test.ts',
			'**/*.llm.integration.test.ts',
			'**/tests/integration/**',
			'**/tests/e2e/**',
		],
		setupFiles: [repoPath('vitest.setup.ts')],
	},
});
