import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

function repoPath(relativePath: string): string {
	return path.resolve(repositoryRoot, relativePath);
}

function loadDotEnvLocal(): void {
	const envLocalPath = repoPath('.env.local');
	if (!fs.existsSync(envLocalPath)) {
		return;
	}

	for (const line of fs.readFileSync(envLocalPath, 'utf8').split('\n')) {
		const trimmedLine = line.trim();
		if (trimmedLine.length === 0 || trimmedLine.startsWith('#') || !trimmedLine.includes('=')) {
			continue;
		}

		const delimiterIndex = trimmedLine.indexOf('=');
		const key = trimmedLine.slice(0, delimiterIndex).trim();
		const value = trimmedLine.slice(delimiterIndex + 1).trim();
		if (key.length > 0 && process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}

loadDotEnvLocal();

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
		exclude: ['**/node_modules/**'],
		globalSetup: [
			repoPath('packages/agent-vm/src/integration-tests/e2e-workspace-build-global-setup.ts'),
		],
		setupFiles: [repoPath('vitest.setup.ts')],
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					include: [
						'packages/**/*.unit.test.ts',
						'packages/**/*.unit.spec.ts',
						'scripts/**/*.unit.test.ts',
					],
					exclude: [
						'**/node_modules/**',
						'**/*.integration.test.ts',
						'**/*.e2e.test.ts',
						'**/tests/integration/**',
						'**/tests/e2e/**',
					],
					maxWorkers: '75%',
				},
			},
			{
				extends: true,
				test: {
					name: 'integration',
					include: ['packages/**/*.integration.test.ts'],
					exclude: ['**/node_modules/**', '**/*.e2e.test.ts'],
					maxWorkers: '50%',
				},
			},
			{
				extends: true,
				test: {
					name: 'e2e-inventory',
					include: ['packages/**/*.e2e.test.ts'],
					testTimeout: 900_000,
					hookTimeout: 300_000,
					maxWorkers: 2,
				},
			},
			{
				extends: true,
				test: {
					name: 'e2e-vm',
					include: ['packages/**/*.vm.e2e.test.ts'],
					exclude: [
						'**/node_modules/**',
						'**/live-gondolin-http-mediation.vm.e2e.test.ts',
						'**/live-http-mediation.vm.e2e.test.ts',
					],
					testTimeout: 900_000,
					hookTimeout: 300_000,
					maxWorkers: 1,
				},
			},
			{
				extends: true,
				test: {
					name: 'e2e-vm-mediation',
					include: [
						'packages/**/live-gondolin-http-mediation.vm.e2e.test.ts',
						'packages/**/live-http-mediation.vm.e2e.test.ts',
					],
					testTimeout: 900_000,
					hookTimeout: 300_000,
					maxWorkers: 1,
				},
			},
			{
				extends: true,
				test: {
					name: 'e2e-openclaw',
					include: ['packages/**/*.openclaw.e2e.test.ts'],
					testTimeout: 900_000,
					hookTimeout: 300_000,
					maxWorkers: 1,
				},
			},
			{
				extends: true,
				test: {
					name: 'e2e-worker',
					include: ['packages/**/*.worker.e2e.test.ts'],
					testTimeout: 900_000,
					hookTimeout: 300_000,
					maxWorkers: 2,
				},
			},
			{
				extends: true,
				test: {
					name: 'e2e-secrets',
					include: ['packages/**/*.secrets.e2e.test.ts'],
					testTimeout: 900_000,
					hookTimeout: 300_000,
					maxWorkers: 2,
				},
			},
			{
				extends: true,
				test: {
					name: 'e2e-llm',
					include: ['packages/**/*.llm.e2e.test.ts'],
					testTimeout: 900_000,
					hookTimeout: 300_000,
					maxWorkers: 2,
				},
			},
		],
	},
});
