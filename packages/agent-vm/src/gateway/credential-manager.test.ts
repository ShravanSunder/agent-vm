import {
	createCompositeSecretResolver,
	type SecretRef,
	type SecretResolver,
} from '@agent-vm/secret-management';
import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { resolveZoneSecrets } from './credential-manager.js';

const systemConfig = {
	schemaVersion: 1,
	cacheDir: './cache',
	runtimeDir: './runtime',
	host: {
		controllerPort: 18800,
		projectNamespace: 'claw-tests-a1b2c3d4',
		secretsProvider: {
			type: '1password',
			tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
		},
	},
	imageProfiles: {
		gateways: {
			openclaw: {
				type: 'openclaw',
				buildConfig: './vm-images/gateways/openclaw/build-config.json',
			},
			worker: {
				type: 'worker',
				buildConfig: './vm-images/gateways/worker/build-config.json',
			},
		},
		toolVms: {
			default: {
				type: 'toolVm',
				buildConfig: './vm-images/tool-vms/default/build-config.json',
			},
		},
	},
	zones: [
		{
			id: 'shravan',
			gateway: {
				type: 'openclaw',
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './config/shravan/openclaw.json',
				stateDir: './state/shravan',
				zoneFilesDir: './zone-files/shravan',
				controllerAuth: { secret: 'OPENCLAW_GATEWAY_TOKEN' },
			},
			secrets: {
				ANTHROPIC_API_KEY: {
					source: '1password',
					ref: 'op://AI/anthropic/api-key',
					injection: 'env',
					audience: 'gateway',
				},
				GITHUB_PAT: {
					source: '1password',
					ref: 'op://AI/github/pat',
					injection: 'env',
					audience: 'gateway',
				},
			},
			egressHosts: ['api.anthropic.com'].map((host) => ({ host, audience: 'gateway' as const })),
			defaultToolVmProfile: 'standard',
			websocketBypass: [],
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
	tcpPool: {
		basePort: 19000,
		size: 5,
	},
} satisfies SystemConfig;

describe('resolveZoneSecrets', () => {
	it('resolves the named zone secret references through one resolveAll call', async () => {
		const resolve = vi.fn(async () => {
			throw new Error('resolve should not be called for zone batch resolution');
		});
		const resolveAll = vi.fn(async (refs: Record<string, SecretRef>) =>
			Object.fromEntries(
				Object.entries(refs).map(([name, secretRef]) => [name, `resolved:${secretRef.ref}`]),
			),
		);
		const secretResolver: SecretResolver = {
			resolve,
			resolveAll,
		};

		await expect(
			resolveZoneSecrets({
				audience: 'gateway',
				systemConfig,
				zoneId: 'shravan',
				secretResolver,
			}),
		).resolves.toEqual({
			ANTHROPIC_API_KEY: 'resolved:op://AI/anthropic/api-key',
			GITHUB_PAT: 'resolved:op://AI/github/pat',
		});
		expect(resolve).not.toHaveBeenCalled();
		expect(resolveAll).toHaveBeenCalledTimes(1);
		expect(resolveAll).toHaveBeenCalledWith({
			ANTHROPIC_API_KEY: { source: '1password', ref: 'op://AI/anthropic/api-key' },
			GITHUB_PAT: { source: '1password', ref: 'op://AI/github/pat' },
		});
	});

	it('supports per-zone refs for the same secret name', async () => {
		const resolve = vi.fn(async () => {
			throw new Error('resolve should not be called for zone batch resolution');
		});
		const resolveAll = vi.fn(async (refs: Record<string, SecretRef>) =>
			Object.fromEntries(
				Object.entries(refs).map(([name, secretRef]) => [name, `resolved:${secretRef.ref}`]),
			),
		);
		const secretResolver: SecretResolver = {
			resolve,
			resolveAll,
		};

		const shravanZone = systemConfig.zones[0];
		if (!shravanZone) {
			throw new Error('Expected base test zone');
		}
		const multiZoneConfig = {
			...systemConfig,
			zones: [
				{
					...shravanZone,
					secrets: {
						OPENCLAW_GATEWAY_TOKEN: {
							source: '1password' as const,
							ref: 'op://agent-vm/shravan-gateway-auth/password',
							injection: 'env' as const,
							audience: 'gateway' as const,
						},
					},
				},
				{
					...shravanZone,
					id: 'copse',
					secrets: {
						OPENCLAW_GATEWAY_TOKEN: {
							source: '1password' as const,
							ref: 'op://agent-vm/copse-gateway-auth/password',
							injection: 'env' as const,
							audience: 'gateway' as const,
						},
					},
				},
			],
		} satisfies SystemConfig;

		await expect(
			resolveZoneSecrets({
				audience: 'gateway',
				secretResolver,
				systemConfig: multiZoneConfig,
				zoneId: 'copse',
			}),
		).resolves.toEqual({
			OPENCLAW_GATEWAY_TOKEN: 'resolved:op://agent-vm/copse-gateway-auth/password',
		});
		expect(resolve).not.toHaveBeenCalled();
		expect(resolveAll).toHaveBeenCalledWith({
			OPENCLAW_GATEWAY_TOKEN: {
				source: '1password',
				ref: 'op://agent-vm/copse-gateway-auth/password',
			},
		});
	});

	it('throws when the zone is unknown', async () => {
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => '',
			resolveAll: async () => ({}),
		};

		await expect(
			resolveZoneSecrets({
				audience: 'gateway',
				secretResolver,
				systemConfig,
				zoneId: 'missing-zone',
			}),
		).rejects.toThrow("Unknown zone 'missing-zone'.");
	});

	it('requires Tool VM secret resolution to use http mediation', async () => {
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => '',
			resolveAll: async () => ({}),
		};

		await expect(
			resolveZoneSecrets({
				audience: 'tool-vm',
				injection: 'env',
				secretResolver,
				systemConfig,
				zoneId: 'shravan',
			} as never),
		).rejects.toThrow("Tool VM secret resolution requires injection 'http-mediation'.");
	});

	it('rejects targeted Tool VM secrets that bypass the schema with env injection', async () => {
		const baseZone = systemConfig.zones[0];
		if (!baseZone) {
			throw new Error('Expected base test zone');
		}
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => {
				throw new Error('secret should not be resolved');
			},
			resolveAll: async () => ({}),
		};
		const unsafeConfig = {
			...systemConfig,
			zones: [
				{
					...baseZone,
					secrets: {
						LINEAR_API_KEY: {
							source: 'environment',
							envVar: 'LINEAR_API_KEY',
							injection: 'env',
							audience: 'tool-vm',
						},
					},
				},
			],
		} as never;

		await expect(
			resolveZoneSecrets({
				audience: 'tool-vm',
				injection: 'http-mediation',
				secretResolver,
				systemConfig: unsafeConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(
			"Tool VM secret 'LINEAR_API_KEY' in zone 'shravan' must use injection 'http-mediation'.",
		);
	});

	it('throws when a zone secret is missing an explicit ref', async () => {
		const baseZone = systemConfig.zones[0];
		if (!baseZone) {
			throw new Error('Expected base test zone');
		}
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => '',
			resolveAll: async () => ({}),
		};
		const envBackedConfig = {
			...systemConfig,
			zones: [
				{
					egressHosts: baseZone.egressHosts,
					gateway: baseZone.gateway,
					id: baseZone.id,
					secrets: {
						OPENCLAW_GATEWAY_TOKEN: {
							source: '1password' as const,
							injection: 'env' as const,
							audience: 'gateway' as const,
						},
					},
					defaultToolVmProfile: baseZone.defaultToolVmProfile,
					agentToolVmProfiles: baseZone.agentToolVmProfiles,
					websocketBypass: baseZone.websocketBypass,
				},
			],
		};

		await expect(
			resolveZoneSecrets({
				audience: 'gateway',
				secretResolver,
				// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
				systemConfig: envBackedConfig as unknown as SystemConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(
			"Zone 'shravan' secret 'OPENCLAW_GATEWAY_TOKEN' is missing 'ref'. Add an explicit 1Password reference such as 'op://agent-vm/shravan-gateway-auth/password'.",
		);
	});

	it('suggests a secret-specific ref example when discord token ref is missing', async () => {
		const baseZone = systemConfig.zones[0];
		if (!baseZone) {
			throw new Error('Expected base test zone');
		}
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => '',
			resolveAll: async () => ({}),
		};
		const missingDiscordRefConfig = {
			...systemConfig,
			zones: [
				{
					egressHosts: baseZone.egressHosts,
					gateway: baseZone.gateway,
					id: baseZone.id,
					secrets: {
						DISCORD_BOT_TOKEN: {
							source: '1password' as const,
							injection: 'env' as const,
							audience: 'gateway' as const,
						},
					},
					defaultToolVmProfile: baseZone.defaultToolVmProfile,
					agentToolVmProfiles: baseZone.agentToolVmProfiles,
					websocketBypass: baseZone.websocketBypass,
				},
			],
		};

		await expect(
			resolveZoneSecrets({
				audience: 'gateway',
				secretResolver,
				// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
				systemConfig: missingDiscordRefConfig as unknown as SystemConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(
			"Zone 'shravan' secret 'DISCORD_BOT_TOKEN' is missing 'ref'. Add an explicit 1Password reference such as 'op://agent-vm/shravan-discord/bot-token'.",
		);
	});

	it('adds secret-specific context when secret resolution fails', async () => {
		const baseZone = systemConfig.zones[0];
		if (!baseZone) {
			throw new Error('Expected base test zone');
		}
		const failingConfig = {
			...systemConfig,
			zones: [
				{
					...baseZone,
					secrets: {
						PERPLEXITY_API_KEY: {
							source: '1password' as const,
							ref: 'op://agent-vm/shravan-perplexity/credential',
							injection: 'http-mediation' as const,
							audience: 'gateway' as const,
							hosts: ['api.perplexity.ai'],
						},
					},
				},
			],
		} satisfies SystemConfig;
		const secretResolver: SecretResolver = {
			resolve: async () => {
				throw new Error('resolve should not be called');
			},
			resolveAll: async () => {
				throw new AggregateError(
					[
						new Error(
							"Failed to resolve secret 'PERPLEXITY_API_KEY' for zone 'shravan' from 'op://agent-vm/shravan-perplexity/credential': 1Password lookup failed",
						),
					],
					'Failed to resolve 1 secret(s) via op read.',
				);
			},
		};

		await expect(
			resolveZoneSecrets({
				audience: 'gateway',
				secretResolver,
				systemConfig: failingConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(
			"Failed to resolve zone secrets for zone 'shravan': Failed to resolve 1 secret(s) via op read. Details: Failed to resolve secret 'PERPLEXITY_API_KEY' for zone 'shravan' from 'op://agent-vm/shravan-perplexity/credential': 1Password lookup failed",
		);
	});

	it('keeps secret-specific context when an environment-backed batch secret is missing', async () => {
		const baseZone = systemConfig.zones[0];
		if (!baseZone) {
			throw new Error('Expected base test zone');
		}
		const envConfig = {
			...systemConfig,
			zones: [
				{
					...baseZone,
					secrets: {
						OPENAI_API_KEY: {
							source: 'environment' as const,
							envVar: 'MISSING_OPENAI_API_KEY',
							injection: 'env' as const,
							audience: 'gateway' as const,
						},
					},
				},
			],
		} satisfies SystemConfig;

		await expect(
			resolveZoneSecrets({
				audience: 'gateway',
				secretResolver: createCompositeSecretResolver(null, {}),
				systemConfig: envConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(
			"Failed to resolve zone secrets for zone 'shravan': Failed to resolve 1 secret(s). Details: Failed to resolve secret 'OPENAI_API_KEY' from 'MISSING_OPENAI_API_KEY': Environment variable 'MISSING_OPENAI_API_KEY' is not set.",
		);
	});

	it('keeps secret-specific context when 1Password refs lack a configured provider', async () => {
		await expect(
			resolveZoneSecrets({
				audience: 'gateway',
				secretResolver: createCompositeSecretResolver(null, {}),
				systemConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(
			"Failed to resolve zone secrets for zone 'shravan': Failed to resolve 2 secret(s). Details: Failed to resolve secret 'ANTHROPIC_API_KEY' from 'op://AI/anthropic/api-key': Secret with source '1password' requires host.secretsProvider to be configured.; Failed to resolve secret 'GITHUB_PAT' from 'op://AI/github/pat': Secret with source '1password' requires host.secretsProvider to be configured.",
		);
	});
});
