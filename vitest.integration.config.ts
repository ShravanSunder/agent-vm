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
			'@shravansunder/gondolin-core': path.resolve('./packages/gondolin-core/src/index.ts'),
			'@shravansunder/agent-vm-worker': path.resolve('./packages/agent-vm-worker/src/index.ts'),
			'@shravansunder/gateway-interface': path.resolve('./packages/gateway-interface/src/index.ts'),
			'@shravansunder/openclaw-gateway': path.resolve('./packages/openclaw-gateway/src/index.ts'),
			'@shravansunder/worker-gateway': path.resolve('./packages/worker-gateway/src/index.ts'),
		},
	},
	test: {
		globals: true,
		environment: 'node',
		testTimeout: 300_000,
		hookTimeout: 120_000,
		pool: 'forks',
		fileParallelism: false,
		include: ['packages/**/*.integration.test.ts'],
		exclude: ['**/node_modules/**'],
		setupFiles: ['./vitest.setup.ts'],
	},
});
