import type { SecretResolver } from 'gondolin-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../controller/system-config.js';
import { resolveZoneSecrets } from './credential-manager.js';

const systemConfig = {
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
				memory: '2G',
				cpus: 2,
				port: 18791,
				openclawConfig: './config/shravan/openclaw.json',
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
	const originalDiscordRef = process.env.DISCORD_BOT_TOKEN_REF;

	afterEach(() => {
		if (originalDiscordRef === undefined) {
			delete process.env.DISCORD_BOT_TOKEN_REF;
			return;
		}

		process.env.DISCORD_BOT_TOKEN_REF = originalDiscordRef;
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

	it('resolves a secret ref from environment when it is omitted from config', async () => {
		process.env.DISCORD_BOT_TOKEN_REF = 'op://test-vault/test-item/token';
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => {
				throw new Error('resolve is not used by this test');
			},
			resolveAll: vi.fn(async (secretRefs: Record<string, { readonly ref: string }>) =>
				Object.fromEntries(
					Object.entries(secretRefs).map(([secretName, secretRef]) => [
						secretName,
						`resolved:${secretRef.ref}`,
					]),
				),
			),
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
							source: '1password' as const,
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
			DISCORD_BOT_TOKEN: 'resolved:op://test-vault/test-item/token',
		});
	});
});
