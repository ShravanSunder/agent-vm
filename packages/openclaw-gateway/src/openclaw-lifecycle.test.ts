import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GatewayZoneConfig } from '@shravansunder/agent-vm-gateway-interface';
import type { SecretResolver } from '@shravansunder/agent-vm-gondolin-core';
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
			OPENCLAW_GATEWAY_TOKEN: {
				injection: 'env',
				ref: 'op://vault/item/openclaw-gateway-token',
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
	describe('authConfig', () => {
		it('provides a list-providers command', () => {
			expect(openclawLifecycle.authConfig).toBeDefined();
			expect(openclawLifecycle.authConfig?.listProvidersCommand).toBe(
				'openclaw models auth list --format plain 2>/dev/null || echo ""',
			);
		});

		it('builds a login command for a given provider', () => {
			expect(openclawLifecycle.authConfig?.buildLoginCommand('codex')).toBe(
				"openclaw models auth login --provider 'codex'",
			);
			expect(openclawLifecycle.authConfig?.buildLoginCommand('openai-codex')).toBe(
				"openclaw models auth login --provider 'openai-codex'",
			);
		});

		it('shell-quotes provider values safely', () => {
			expect(
				openclawLifecycle.authConfig?.buildLoginCommand("codex'; touch /tmp/pwned; echo '"),
			).toBe("openclaw models auth login --provider 'codex'\\''; touch /tmp/pwned; echo '\\'''");
		});
	});

	describe('buildVmSpec', () => {
		it('splits environment and mediated secrets', () => {
			const vmSpec = openclawLifecycle.buildVmSpec({
				controllerPort: 18800,
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				tcpPool: {
					basePort: 19000,
					size: 3,
				},
				zone: createZone(),
			});

			expect(vmSpec.environment.DISCORD_BOT_TOKEN).toBe('discord-token');
			expect(vmSpec.environment.PERPLEXITY_API_KEY).toBeUndefined();
			expect(vmSpec.mediatedSecrets.PERPLEXITY_API_KEY).toEqual({
				hosts: ['api.perplexity.ai'],
				value: 'perplexity-token',
			});
		});

		it('builds the expected OpenClaw environment, mounts, and tcp hosts', () => {
			const vmSpec = openclawLifecycle.buildVmSpec({
				controllerPort: 18800,
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				tcpPool: {
					basePort: 19000,
					size: 2,
				},
				zone: createZone(),
			});

			expect(vmSpec.environment.OPENCLAW_HOME).toBe('/home/openclaw');
			expect(vmSpec.environment.OPENCLAW_CONFIG_PATH).toBe(
				'/home/openclaw/.openclaw/state/effective-openclaw.json',
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
			expect(vmSpec.sessionLabel).toBe('claw-tests-a1b2c3d4:shravan:gateway');
		});
	});

	describe('buildProcessSpec', () => {
		it('builds bootstrap and start commands with escaped gateway token', () => {
			const processSpec = openclawLifecycle.buildProcessSpec(createZone(), resolvedSecrets);

			expect(processSpec.bootstrapCommand).toContain('/etc/profile.d/openclaw-env.sh');
			expect(processSpec.bootstrapCommand).not.toContain('OPENCLAW_GATEWAY_TOKEN=');
			expect(processSpec.bootstrapCommand).toContain(
				'OPENCLAW_CONFIG_PATH=/home/openclaw/.openclaw/state/effective-openclaw.json',
			);
			expect(processSpec.bootstrapCommand).toContain('/etc/profile.d/openclaw-env.sh');
			expect(processSpec.bootstrapCommand).toContain('source /root/.bashrc');
			expect(processSpec.startCommand).toContain('nohup openclaw gateway --port 18789');
			expect(processSpec.healthCheck).toEqual({ type: 'http', port: 18789, path: '/' });
			expect(processSpec.logPath).toBe('/tmp/openclaw.log');
		});
	});

	describe('prepareHostState', () => {
		it('writes auth-profiles.json and effective-openclaw.json when auth is configured', async () => {
			const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-lifecycle-'));
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			fs.mkdirSync(configDirectory, { recursive: true });
			fs.writeFileSync(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify(
					{
						agents: { defaults: { workspace: '/home/openclaw/workspace' } },
						gateway: {
							auth: { mode: 'token' },
							bind: 'loopback',
							controlUi: {
								allowedOrigins: ['http://127.0.0.1:18791', 'http://localhost:18791'],
							},
						},
					},
					null,
					2,
				),
				'utf8',
			);
			const zone = createZone({
				gateway: {
					gatewayConfig: path.join(configDirectory, 'openclaw.json'),
					stateDir: path.join(tempDirectory, 'state'),
					workspaceDir: path.join(tempDirectory, 'workspace'),
				},
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) => {
					if (secretRef.ref === 'op://vault/item/auth-profiles') {
						return '{"profiles":[]}';
					}

					if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
						return 'resolved-gateway-token';
					}

					throw new Error(`Unexpected ref: ${secretRef.ref}`);
				},
				resolveAll: async () => ({}),
			};

			await openclawLifecycle.prepareHostState?.(zone, secretResolver);

			expect(
				fs.readFileSync(
					path.join(zone.gateway.stateDir, 'agents', 'main', 'agent', 'auth-profiles.json'),
					'utf8',
				),
			).toBe('{"profiles":[]}');
			expect(
				JSON.parse(
					fs.readFileSync(path.join(zone.gateway.stateDir, 'effective-openclaw.json'), 'utf8'),
				),
			).toMatchObject({
				agents: { defaults: { workspace: '/home/openclaw/workspace' } },
				gateway: {
					auth: { mode: 'token', token: 'resolved-gateway-token' },
					bind: 'loopback',
					controlUi: {
						allowedOrigins: ['http://127.0.0.1:18791', 'http://localhost:18791'],
					},
				},
			});
			expect(
				fs.statSync(path.join(zone.gateway.stateDir, 'effective-openclaw.json')).mode & 0o777,
			).toBe(0o600);
			expect(fs.statSync(zone.gateway.stateDir).mode & 0o777).toBe(0o700);
			expect(fs.existsSync(path.join(zone.gateway.stateDir, 'agents', 'main', 'agent'))).toBe(true);
		});

		it('still writes effective-openclaw.json when authProfilesRef is absent', async () => {
			const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-lifecycle-no-auth-'));
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			fs.mkdirSync(configDirectory, { recursive: true });
			fs.writeFileSync(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify(
					{
						gateway: {
							auth: { mode: 'token' },
							bind: 'loopback',
						},
					},
					null,
					2,
				),
				'utf8',
			);
			const zone = createZone({
				gateway: {
					gatewayConfig: path.join(configDirectory, 'openclaw.json'),
					stateDir: path.join(tempDirectory, 'state'),
					workspaceDir: path.join(tempDirectory, 'workspace'),
				},
				withoutAuthProfilesRef: true,
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) => {
					if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
						return 'resolved-gateway-token';
					}

					throw new Error(`Unexpected ref: ${secretRef.ref}`);
				},
				resolveAll: async () => ({}),
			};

			await openclawLifecycle.prepareHostState?.(zone, secretResolver);

			expect(fs.existsSync(zone.gateway.stateDir)).toBe(true);
			expect(fs.statSync(zone.gateway.stateDir).mode & 0o777).toBe(0o700);
			expect(fs.existsSync(path.join(zone.gateway.stateDir, 'agents'))).toBe(false);
			expect(fs.existsSync(path.join(zone.gateway.stateDir, 'effective-openclaw.json'))).toBe(true);
		});

		it('throws when OPENCLAW_GATEWAY_TOKEN ref is absent', async () => {
			const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-lifecycle-no-token-'));
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			fs.mkdirSync(configDirectory, { recursive: true });
			fs.writeFileSync(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify({ gateway: { auth: { mode: 'token' }, bind: 'loopback' } }, null, 2),
				'utf8',
			);
			const zoneWithoutGatewayToken = createZone({
				gateway: {
					gatewayConfig: path.join(configDirectory, 'openclaw.json'),
					stateDir: path.join(tempDirectory, 'state'),
					workspaceDir: path.join(tempDirectory, 'workspace'),
				},
			});
			delete zoneWithoutGatewayToken.secrets.OPENCLAW_GATEWAY_TOKEN;
			const secretResolver: SecretResolver = {
				resolve: async () => {
					throw new Error('resolve should not be called');
				},
				resolveAll: async () => ({}),
			};

			await expect(
				openclawLifecycle.prepareHostState?.(zoneWithoutGatewayToken, secretResolver),
			).rejects.toThrow(
				/Failed to write effective OpenClaw config for zone 'shravan'.*OPENCLAW_GATEWAY_TOKEN/u,
			);
		});

		it('throws when base config is not a JSON object', async () => {
			const tempDirectory = fs.mkdtempSync(
				path.join(os.tmpdir(), 'openclaw-lifecycle-bad-config-'),
			);
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			fs.mkdirSync(configDirectory, { recursive: true });
			fs.writeFileSync(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify(['not-an-object'], null, 2),
				'utf8',
			);
			const zone = createZone({
				gateway: {
					gatewayConfig: path.join(configDirectory, 'openclaw.json'),
					stateDir: path.join(tempDirectory, 'state'),
					workspaceDir: path.join(tempDirectory, 'workspace'),
				},
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) => {
					if (secretRef.ref === 'op://vault/item/auth-profiles') {
						return '{"profiles":[]}';
					}
					if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
						return 'resolved-gateway-token';
					}
					throw new Error(`Unexpected ref: ${secretRef.ref}`);
				},
				resolveAll: async () => ({}),
			};

			await expect(openclawLifecycle.prepareHostState?.(zone, secretResolver)).rejects.toThrow(
				/Failed to write effective OpenClaw config for zone 'shravan'.*must be a JSON object/u,
			);
		});
	});
});
