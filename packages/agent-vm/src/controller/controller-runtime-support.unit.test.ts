import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';
import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import {
	createSecretResolver,
	resolveControllerGithubToken,
} from './controller-runtime-support.js';

const baseConfig = {
	schemaVersion: 2,
	storageRootDir: '/storage-root-test',
	cacheDir: './cache',
	controllerStateDir: '/controller-state-test',
	controllerRuntimeDir: './controller-runtime',
	host: {
		controllerPort: 18800,
		projectNamespace: 'claw-tests-a1b2c3d4',
	},
	imageProfiles: {
		gateways: {
			openclaw: {
				type: 'openclaw',
				buildConfig: './vm-images/gateways/openclaw/build-config.json',
			},
			worker: { type: 'worker', buildConfig: './vm-images/gateways/worker/build-config.json' },
		},
		toolVms: {
			default: { type: 'toolVm', buildConfig: './vm-images/tool-vms/default/build-config.json' },
		},
	},
	zones: [
		{
			id: 'shravan',
			gateway: {
				type: 'openclaw',
				controlAuth: {
					mode: 'token',
					secret: 'OPENCLAW_GATEWAY_TOKEN',
				},
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './config/shravan/openclaw.json',
				stateDir: './state/shravan',
				zoneFilesDir: './zone-files/shravan',
				zoneRuntimeDir: './shravan/runtime',
			},
			secrets: {
				OPENAI_API_KEY: {
					source: 'environment' as const,
					envVar: 'OPENAI_API_KEY',
					injection: 'http-mediation' as const,
					audience: 'gateway' as const,
					hosts: ['api.openai.com'],
				},
			},
			egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
	],
	toolVmProfiles: {
		standard: {
			memory: '1G',
			cpus: 1,
			imageProfile: 'default',
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

	it('resolves config-backed host github tokens through the composite resolver', async () => {
		const resolveSecret = vi.fn(async (ref: SecretRef): Promise<string> => {
			if (ref.source === 'config') {
				return ref.value;
			}
			return 'unexpected';
		});
		const resolver: SecretResolver = {
			resolve: resolveSecret,
			resolveAll: vi.fn(async () => ({})),
		};
		const systemConfig = {
			...baseConfig,
			host: {
				...baseConfig.host,
				githubToken: {
					source: 'config' as const,
					value: 'github-token',
				},
			},
		} satisfies SystemConfig;

		await expect(resolveControllerGithubToken(systemConfig, resolver)).resolves.toBe(
			'github-token',
		);
		expect(resolveSecret).toHaveBeenCalledWith({
			source: 'config',
			value: 'github-token',
		});
	});
});
