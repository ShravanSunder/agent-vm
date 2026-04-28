import type { SecretResolver } from '@agent-vm/gondolin-adapter';
import { describe, expect, it } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { resolveZoneSecrets } from './credential-manager.js';

const systemConfig = {
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
			},
			secrets: {
				ANTHROPIC_API_KEY: {
					source: '1password',
					ref: 'op://AI/anthropic/api-key',
					injection: 'env',
				},
				GITHUB_PAT: {
					source: '1password',
					ref: 'op://AI/github/pat',
					injection: 'env',
				},
			},
			allowedHosts: ['api.anthropic.com'],
			websocketBypass: [],
			toolProfile: 'standard',
		},
	],
	toolProfiles: {
		standard: {
			memory: '1G',
			cpus: 1,
			workspaceRoot: './workspaces/tools',
			imageProfile: 'default',
		},
	},
	tcpPool: {
		basePort: 19000,
		size: 5,
	},
} satisfies SystemConfig;

describe('resolveZoneSecrets', () => {
	it('resolves the named zone secret references through the shared resolver', async () => {
		const secretResolver: SecretResolver = {
			resolve: async (secretRef) => `resolved:${secretRef.ref}`,
			resolveAll: async () => {
				throw new Error('resolveAll is not used by this test');
			},
		};

		await expect(
			resolveZoneSecrets({
				systemConfig,
				zoneId: 'shravan',
				secretResolver,
			}),
		).resolves.toEqual({
			ANTHROPIC_API_KEY: 'resolved:op://AI/anthropic/api-key',
			GITHUB_PAT: 'resolved:op://AI/github/pat',
		});
	});

	it('supports per-zone refs for the same secret name', async () => {
		const secretResolver: SecretResolver = {
			resolve: async (secretRef) => `resolved:${secretRef.ref}`,
			resolveAll: async () => {
				throw new Error('resolveAll is not used by this test');
			},
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
						},
					},
				},
			],
		} satisfies SystemConfig;

		await expect(
			resolveZoneSecrets({
				secretResolver,
				systemConfig: multiZoneConfig,
				zoneId: 'copse',
			}),
		).resolves.toEqual({
			OPENCLAW_GATEWAY_TOKEN: 'resolved:op://agent-vm/copse-gateway-auth/password',
		});
	});

	it('throws when the zone is unknown', async () => {
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => '',
			resolveAll: async () => ({}),
		};

		await expect(
			resolveZoneSecrets({
				secretResolver,
				systemConfig,
				zoneId: 'missing-zone',
			}),
		).rejects.toThrow("Unknown zone 'missing-zone'.");
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
					allowedHosts: baseZone.allowedHosts,
					gateway: baseZone.gateway,
					id: baseZone.id,
					secrets: {
						OPENCLAW_GATEWAY_TOKEN: {
							source: '1password' as const,
							injection: 'env' as const,
						},
					},
					toolProfile: baseZone.toolProfile,
					websocketBypass: baseZone.websocketBypass,
				},
			],
		};

		await expect(
			resolveZoneSecrets({
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
					allowedHosts: baseZone.allowedHosts,
					gateway: baseZone.gateway,
					id: baseZone.id,
					secrets: {
						DISCORD_BOT_TOKEN: {
							source: '1password' as const,
							injection: 'env' as const,
						},
					},
					toolProfile: baseZone.toolProfile,
					websocketBypass: baseZone.websocketBypass,
				},
			],
		};

		await expect(
			resolveZoneSecrets({
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
							hosts: ['api.perplexity.ai'],
						},
					},
				},
			],
		} satisfies SystemConfig;
		const secretResolver: SecretResolver = {
			resolve: async () => {
				throw new Error('1Password lookup failed');
			},
			resolveAll: async () => ({}),
		};

		await expect(
			resolveZoneSecrets({
				secretResolver,
				systemConfig: failingConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(
			"Failed to resolve secret 'PERPLEXITY_API_KEY' for zone 'shravan' from 'op://agent-vm/shravan-perplexity/credential': 1Password lookup failed",
		);
	});
});
