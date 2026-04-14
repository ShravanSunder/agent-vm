import type { SecretResolver } from '@shravansunder/gondolin-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { resolveZoneSecrets } from './credential-manager.js';

const systemConfig = {
	cacheDir: './cache',
	host: {
		controllerPort: 18800,
		secretsProvider: {
			type: '1password',
			tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
		},
	},
	images: {
		gateway: {
			buildConfig: './images/gateway/build-config.json',
		},
		tool: {
			buildConfig: './images/tool/build-config.json',
		},
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
		},
	},
	tcpPool: {
		basePort: 19000,
		size: 5,
	},
} satisfies SystemConfig;

describe('resolveZoneSecrets', () => {
	const originalDiscordToken = process.env.DISCORD_BOT_TOKEN;

	afterEach(() => {
		if (originalDiscordToken === undefined) {
			delete process.env.DISCORD_BOT_TOKEN;
			return;
		}

		process.env.DISCORD_BOT_TOKEN = originalDiscordToken;
	});

	it('resolves the named zone secret references through the shared resolver', async () => {
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => {
				throw new Error('resolve is not used by this test');
			},
			resolveAll: async (secretRefs) =>
				Object.fromEntries(
					Object.entries(secretRefs).map(([secretName, secretRef]) => [
						secretName,
						`resolved:${secretRef.ref}`,
					]),
				),
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

	it('resolves an environment secret using envVar', async () => {
		process.env.DISCORD_BOT_TOKEN = 'discord-token';
		const resolveAllSecrets = vi.fn(async (secretRefs: Record<string, { readonly ref: string }>) =>
			Object.fromEntries(
				Object.entries(secretRefs).map(([secretName, secretRef]) => [
					secretName,
					`resolved:${secretRef.ref}`,
				]),
			),
		);
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => {
				throw new Error('resolve is not used by this test');
			},
			resolveAll: resolveAllSecrets,
		};

		const baseZone = systemConfig.zones[0];
		if (!baseZone) {
			throw new Error('Expected base test zone');
		}
		const envBackedConfig = {
			...systemConfig,
			zones: [
				{
					allowedHosts: baseZone.allowedHosts,
					gateway: baseZone.gateway,
					id: baseZone.id,
					secrets: {
						DISCORD_BOT_TOKEN: {
							source: 'environment' as const,
							envVar: 'DISCORD_BOT_TOKEN',
							injection: 'env' as const,
						},
					},
					toolProfile: baseZone.toolProfile,
					websocketBypass: baseZone.websocketBypass,
				},
			],
		} satisfies SystemConfig;

		await expect(
			resolveZoneSecrets({
				secretResolver,
				systemConfig: envBackedConfig,
				zoneId: 'shravan',
			}),
		).resolves.toEqual({
			DISCORD_BOT_TOKEN: 'resolved:DISCORD_BOT_TOKEN',
		});
		expect(resolveAllSecrets).toHaveBeenCalledWith({
			DISCORD_BOT_TOKEN: {
				source: 'environment',
				ref: 'DISCORD_BOT_TOKEN',
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
				secretResolver,
				systemConfig,
				zoneId: 'missing-zone',
			}),
		).rejects.toThrow("Unknown zone 'missing-zone'.");
	});

	it('throws when an environment secret env var is missing', async () => {
		delete process.env.DISCORD_BOT_TOKEN;
		const baseZone = systemConfig.zones[0];
		if (!baseZone) {
			throw new Error('Expected base test zone');
		}
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => {
				throw new Error('resolve is not used by this test');
			},
			resolveAll: async (secretRefs) => {
				const resolved: Record<string, string> = {};
				for (const [secretName, secretRef] of Object.entries(secretRefs)) {
					const value = process.env[secretRef.ref];
					if (!value) {
						throw new Error(`Environment variable '${secretRef.ref}' is not set.`);
					}
					resolved[secretName] = value;
				}
				return resolved;
			},
		};
		const envBackedConfig = {
			...systemConfig,
			zones: [
				{
					allowedHosts: baseZone.allowedHosts,
					gateway: baseZone.gateway,
					id: baseZone.id,
					secrets: {
						DISCORD_BOT_TOKEN: {
							source: 'environment' as const,
							envVar: 'DISCORD_BOT_TOKEN',
							injection: 'env' as const,
						},
					},
					toolProfile: baseZone.toolProfile,
					websocketBypass: baseZone.websocketBypass,
				},
			],
		} satisfies SystemConfig;

		await expect(
			resolveZoneSecrets({
				secretResolver,
				systemConfig: envBackedConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow("Environment variable 'DISCORD_BOT_TOKEN' is not set.");
	});

	it('treats whitespace-only environment values as missing', async () => {
		process.env.DISCORD_BOT_TOKEN = '   ';
		const baseZone = systemConfig.zones[0];
		if (!baseZone) {
			throw new Error('Expected base test zone');
		}
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => {
				throw new Error('resolve is not used by this test');
			},
			resolveAll: async (secretRefs) => {
				const resolved: Record<string, string> = {};
				for (const [secretName, secretRef] of Object.entries(secretRefs)) {
					const value = process.env[secretRef.ref]?.trim();
					if (!value) {
						throw new Error(`Environment variable '${secretRef.ref}' is not set.`);
					}
					resolved[secretName] = value;
				}
				return resolved;
			},
		};
		const envBackedConfig = {
			...systemConfig,
			zones: [
				{
					allowedHosts: baseZone.allowedHosts,
					gateway: baseZone.gateway,
					id: baseZone.id,
					secrets: {
						DISCORD_BOT_TOKEN: {
							source: 'environment' as const,
							envVar: 'DISCORD_BOT_TOKEN',
							injection: 'env' as const,
						},
					},
					toolProfile: baseZone.toolProfile,
					websocketBypass: baseZone.websocketBypass,
				},
			],
		} satisfies SystemConfig;

		await expect(
			resolveZoneSecrets({
				secretResolver,
				systemConfig: envBackedConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow("Environment variable 'DISCORD_BOT_TOKEN' is not set.");
	});

	it('resolves mixed onepassword and environment secrets in one zone', async () => {
		process.env.GITHUB_TOKEN = 'gh-token';
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => {
				throw new Error('resolve is not used by this test');
			},
			resolveAll: vi.fn(async (secretRefs: Record<string, { readonly ref: string }>) =>
				Object.fromEntries(
					Object.entries(secretRefs).map(([secretName, secretRef]) => [
						secretName,
						secretRef.ref === 'GITHUB_TOKEN' ? 'resolved:GITHUB_TOKEN' : `resolved:${secretRef.ref}`,
					]),
				),
			),
		};
		const baseZone = systemConfig.zones[0];
		if (!baseZone) {
			throw new Error('Expected base test zone');
		}
		const mixedConfig = {
			...systemConfig,
			zones: [
				{
					...baseZone,
					secrets: {
						OPENAI_API_KEY: {
							source: '1password' as const,
							ref: 'op://AI/openai/api-key',
							injection: 'env' as const,
						},
						GITHUB_TOKEN: {
							source: 'environment' as const,
							envVar: 'GITHUB_TOKEN',
							injection: 'env' as const,
						},
					},
				},
			],
		} satisfies SystemConfig;

		await expect(
			resolveZoneSecrets({
				secretResolver,
				systemConfig: mixedConfig,
				zoneId: 'shravan',
			}),
		).resolves.toEqual({
			OPENAI_API_KEY: 'resolved:op://AI/openai/api-key',
			GITHUB_TOKEN: 'resolved:GITHUB_TOKEN',
		});
	});
});
