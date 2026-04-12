import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GatewayZoneConfig } from 'gateway-interface';
import type { SecretResolver } from 'gondolin-core';
import { afterEach, describe, expect, it } from 'vitest';

import { openclawLifecycle } from './openclaw-lifecycle.js';

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { recursive: true, force: true });
	}
});

const resolvedSecrets: Record<string, string> = {
	DISCORD_BOT_TOKEN: 'discord-token',
	OPENCLAW_GATEWAY_TOKEN: "gateway'token",
	PERPLEXITY_API_KEY: 'perplexity-token',
};

function createZone(overrides?: {
	readonly gateway?: Partial<GatewayZoneConfig['gateway']>;
	readonly withoutAuthProfilesRef?: boolean;
}): GatewayZoneConfig {
	const baseGateway: GatewayZoneConfig['gateway'] = {
		authProfilesRef: 'op://vault/item/auth-profiles',
		cpus: 2,
		gatewayConfig: '/host/config/shravan/openclaw.json',
		memory: '2G',
		port: 18791,
		stateDir: '/host/state/shravan',
		type: 'openclaw',
		workspaceDir: '/host/workspaces/shravan',
	};

	return {
		allowedHosts: ['api.openai.com', 'api.perplexity.ai'],
		gateway: overrides?.withoutAuthProfilesRef
			? {
					cpus: overrides.gateway?.cpus ?? baseGateway.cpus,
					gatewayConfig: overrides.gateway?.gatewayConfig ?? baseGateway.gatewayConfig,
					memory: overrides.gateway?.memory ?? baseGateway.memory,
					port: overrides.gateway?.port ?? baseGateway.port,
					stateDir: overrides.gateway?.stateDir ?? baseGateway.stateDir,
					type: overrides.gateway?.type ?? baseGateway.type,
					workspaceDir: overrides.gateway?.workspaceDir ?? baseGateway.workspaceDir,
				}
			: {
					...baseGateway,
					...overrides?.gateway,
				},
		id: 'shravan',
		secrets: {
			DISCORD_BOT_TOKEN: {
				injection: 'env',
				ref: 'op://vault/item/discord',
				source: '1password',
			},
			PERPLEXITY_API_KEY: {
				hosts: ['api.perplexity.ai'],
				injection: 'http-mediation',
				ref: 'op://vault/item/perplexity',
				source: '1password',
			},
		},
		toolProfile: 'standard',
		websocketBypass: ['gateway.discord.gg:443'],
	};
}

describe('openclawLifecycle', () => {
	describe('buildVmSpec', () => {
		it('splits environment and mediated secrets', () => {
			const vmSpec = openclawLifecycle.buildVmSpec(createZone(), resolvedSecrets, 18800, {
				basePort: 19000,
				size: 3,
			});

			expect(vmSpec.environment.DISCORD_BOT_TOKEN).toBe('discord-token');
			expect(vmSpec.environment.PERPLEXITY_API_KEY).toBeUndefined();
			expect(vmSpec.mediatedSecrets.PERPLEXITY_API_KEY).toEqual({
				hosts: ['api.perplexity.ai'],
				value: 'perplexity-token',
			});
		});

		it('builds the expected OpenClaw environment, mounts, and tcp hosts', () => {
			const vmSpec = openclawLifecycle.buildVmSpec(createZone(), resolvedSecrets, 18800, {
				basePort: 19000,
				size: 2,
			});

			expect(vmSpec.environment.OPENCLAW_HOME).toBe('/home/openclaw');
			expect(vmSpec.environment.OPENCLAW_CONFIG_PATH).toBe(
				'/home/openclaw/.openclaw/config/openclaw.json',
			);
			expect(vmSpec.vfsMounts['/home/openclaw/.openclaw/config']).toEqual({
				hostPath: '/host/config/shravan',
				kind: 'realfs',
			});
			expect(vmSpec.tcpHosts).toEqual({
				'controller.vm.host:18800': '127.0.0.1:18800',
				'gateway.discord.gg:443': 'gateway.discord.gg:443',
				'tool-0.vm.host:22': '127.0.0.1:19000',
				'tool-1.vm.host:22': '127.0.0.1:19001',
			});
		});
	});

	describe('buildProcessSpec', () => {
		it('builds bootstrap and start commands with escaped gateway token', () => {
			const processSpec = openclawLifecycle.buildProcessSpec(createZone(), resolvedSecrets);

			expect(processSpec.bootstrapCommand).toContain('.openclaw-env');
			expect(processSpec.bootstrapCommand).toContain("OPENCLAW_GATEWAY_TOKEN='gateway'\\''token'");
			expect(processSpec.startCommand).toContain('nohup openclaw gateway --port 18789');
			expect(processSpec.healthCheck).toEqual({ type: 'http', port: 18789, path: '/' });
			expect(processSpec.logPath).toBe('/tmp/openclaw.log');
		});
	});

	describe('prepareHostState', () => {
		it('writes auth-profiles.json when authProfilesRef is configured', async () => {
			const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-lifecycle-'));
			createdDirectories.push(tempDirectory);
			const zone = createZone({
				gateway: {
					gatewayConfig: path.join(tempDirectory, 'config', 'openclaw.json'),
					stateDir: path.join(tempDirectory, 'state'),
					workspaceDir: path.join(tempDirectory, 'workspace'),
				},
			});
			const secretResolver: SecretResolver = {
				resolve: async () => '{"profiles":[]}',
				resolveAll: async () => ({}),
			};

			await openclawLifecycle.prepareHostState?.(zone, secretResolver);

			expect(
				fs.readFileSync(
					path.join(zone.gateway.stateDir, 'agents', 'main', 'agent', 'auth-profiles.json'),
					'utf8',
				),
			).toBe('{"profiles":[]}');
			expect(fs.existsSync(path.join(zone.gateway.stateDir, 'agents', 'main', 'agent'))).toBe(true);
		});

		it('does nothing when authProfilesRef is absent', async () => {
			const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-lifecycle-no-auth-'));
			createdDirectories.push(tempDirectory);
			const zone = createZone({
				gateway: {
					gatewayConfig: path.join(tempDirectory, 'config', 'openclaw.json'),
					stateDir: path.join(tempDirectory, 'state'),
					workspaceDir: path.join(tempDirectory, 'workspace'),
				},
				withoutAuthProfilesRef: true,
			});
			const secretResolver: SecretResolver = {
				resolve: async () => {
					throw new Error('resolve should not be called');
				},
				resolveAll: async () => ({}),
			};

			await openclawLifecycle.prepareHostState?.(zone, secretResolver);

			expect(fs.existsSync(zone.gateway.stateDir)).toBe(false);
			expect(fs.existsSync(zone.gateway.workspaceDir)).toBe(false);
			expect(fs.existsSync(path.join(zone.gateway.stateDir, 'agents'))).toBe(false);
		});
	});
});
