import type { SecretResolver } from '@shravansunder/gondolin-core';
import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { createSecretResolver } from './controller-runtime-support.js';

const baseConfig = {
	cacheDir: './cache',
	host: {
		controllerPort: 18800,
	},
	images: {
		gateway: { buildConfig: './images/gateway/build-config.json' },
		tool: { buildConfig: './images/tool/build-config.json' },
	},
	zones: [
		{
			id: 'shravan',
			gateway: {
				type: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				gatewayConfig: './config/shravan/openclaw.json',
				stateDir: './state/shravan',
				workspaceDir: './workspaces/shravan',
			},
			secrets: {
				OPENAI_API_KEY: {
					source: 'environment' as const,
					envVar: 'OPENAI_API_KEY',
					injection: 'http-mediation' as const,
					hosts: ['api.openai.com'],
				},
			},
			allowedHosts: ['api.openai.com'],
			websocketBypass: [],
			toolProfile: 'standard',
		},
	],
	toolProfiles: {
		standard: {
			memory: '1G',
			cpus: 1,
			workspaceRoot: './workspaces/tools',
		},
	},
	tcpPool: { basePort: 19000, size: 5 },
} satisfies SystemConfig;

describe('createSecretResolver', () => {
	it('returns an env-capable resolver when no host secretsProvider is configured', async () => {
		const resolver = await createSecretResolver(baseConfig, async () => {
			throw new Error('1password resolver should not be created');
		});

		await expect(
			resolver.resolve({ source: 'environment', ref: 'OPENAI_API_KEY' }),
		).rejects.toThrow("Environment variable 'OPENAI_API_KEY' is not set.");
	});

	it('creates a onepassword-backed composite resolver when secretsProvider is configured', async () => {
		const resolveToken = vi.fn(async () => 'service-token');
		const onePasswordResolver: SecretResolver = {
			resolve: vi.fn(async (ref) => `resolved:${ref.ref}`),
			resolveAll: vi.fn(async () => ({})),
		};
		const createOnePasswordResolver = vi.fn(async () => onePasswordResolver);
		const systemConfig = {
			...baseConfig,
			host: {
				...baseConfig.host,
				secretsProvider: {
					type: '1password' as const,
					tokenSource: { type: 'env' as const, envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
				},
			},
		} satisfies SystemConfig;

		const resolver = await createSecretResolver(
			systemConfig,
			createOnePasswordResolver,
			resolveToken,
		);

		await expect(
			resolver.resolve({ source: '1password', ref: 'op://vault/item/field' }),
		).resolves.toBe('resolved:op://vault/item/field');
		expect(resolveToken).toHaveBeenCalledWith(systemConfig.host.secretsProvider.tokenSource);
		expect(createOnePasswordResolver).toHaveBeenCalledWith({
			serviceAccountToken: 'service-token',
		});
	});
});
