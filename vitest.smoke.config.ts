import fs from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

function loadDotEnvLocal(): void {
	const envLocalPath = path.resolve('.env.local');
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
			'@agent-vm/agent-vm': path.resolve('./packages/agent-vm/src/index.ts'),
			'@agent-vm/config-contracts': path.resolve('./packages/config-contracts/src/index.ts'),
			'@agent-vm/gondolin-adapter': path.resolve('./packages/gondolin-adapter/src/index.ts'),
			'@agent-vm/agent-vm-worker': path.resolve('./packages/agent-vm-worker/src/index.ts'),
			'@agent-vm/gateway-interface': path.resolve('./packages/gateway-interface/src/index.ts'),
			'@agent-vm/openclaw-agent-vm-plugin': path.resolve(
				'./packages/openclaw-agent-vm-plugin/src/index.ts',
			),
			'@agent-vm/secrets': path.resolve('./packages/secrets/src/index.ts'),
			'@agent-vm/mcp-portal/testing/fake-upstream-mcp-server': path.resolve(
				'./packages/mcp-portal/src/testing/fake-upstream-mcp-server.ts',
			),
			'@agent-vm/mcp-portal/core': path.resolve('./packages/mcp-portal/src/core/index.ts'),
			'@agent-vm/mcp-portal/mcp-proxy': path.resolve(
				'./packages/mcp-portal/src/mcp-proxy/index.ts',
			),
			'@agent-vm/mcp-portal/cli': path.resolve('./packages/mcp-portal/src/cli/index.ts'),
			'@agent-vm/mcp-portal': path.resolve('./packages/mcp-portal/src/index.ts'),
			'@agent-vm/openclaw-mcp-portal-plugin': path.resolve(
				'./packages/openclaw-mcp-portal-plugin/src/index.ts',
			),
			'@agent-vm/openclaw-gateway': path.resolve('./packages/openclaw-gateway/src/index.ts'),
			'@agent-vm/worker-gateway': path.resolve('./packages/worker-gateway/src/index.ts'),
		},
	},
	test: {
		globals: true,
		environment: 'node',
		testTimeout: 900_000,
		hookTimeout: 300_000,
		pool: 'forks',
		fileParallelism: false,
		include: ['packages/**/*.smoke.test.ts'],
		exclude: ['**/node_modules/**'],
		setupFiles: ['./vitest.setup.ts'],
	},
});
