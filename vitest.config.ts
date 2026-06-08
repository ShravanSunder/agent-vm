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
			'@agent-vm/secret-management': repoPath('packages/secret-management/src/index.ts'),
			'@agent-vm/mcp-portal/testing/fake-upstream-mcp-server': repoPath(
				'packages/mcp-portal/src/testing/fake-upstream-mcp-server.ts',
			),
			'@agent-vm/mcp-portal/core': repoPath('packages/mcp-portal/src/core/index.ts'),
			'@agent-vm/mcp-portal/mcp-proxy': repoPath('packages/mcp-portal/src/mcp-proxy/index.ts'),
			'@agent-vm/mcp-portal/cli': repoPath('packages/mcp-portal/src/cli/index.ts'),
			'@agent-vm/mcp-portal/portal-config': repoPath(
				'packages/mcp-portal/src/portal-config/index.ts',
			),
			'@agent-vm/mcp-portal/portal-auth/agent-bearer-token': repoPath(
				'packages/mcp-portal/src/portal-auth/agent-bearer-token.ts',
			),
			'@agent-vm/mcp-portal/portal-auth/hmac-env': repoPath(
				'packages/mcp-portal/src/portal-auth/hmac-env.ts',
			),
			'@agent-vm/mcp-portal/portal-auth/hmac-token': repoPath(
				'packages/mcp-portal/src/portal-auth/hmac-token.ts',
			),
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
		fileParallelism: true,
		maxWorkers: '75%',
		include: [
			'packages/**/*.unit.test.ts',
			'packages/**/*.unit.spec.ts',
			'scripts/**/*.unit.test.ts',
		],
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
