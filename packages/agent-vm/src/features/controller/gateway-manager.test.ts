import type { BuildImageResult, ManagedVm, SecretResolver } from 'gondolin-core';
import { describe, expect, it, vi } from 'vitest';

import { startGatewayZone } from './gateway-manager.js';
import type { SystemConfig } from './system-config.js';

const systemConfig = {
	host: {
		controllerPort: 18800,
		secretsProvider: {
			type: '1password',
			serviceAccountTokenEnv: 'OP_SERVICE_ACCOUNT_TOKEN',
		},
	},
	images: {
		gateway: {
			buildConfig: './images/gateway/build-config.json',
			postBuild: ['npm install -g openclaw@2026.4.2'],
		},
		tool: {
			buildConfig: './images/tool/build-config.json',
			postBuild: [],
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
				},
			},
			allowedHosts: ['api.anthropic.com', 'api.openai.com'],
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

describe('startGatewayZone', () => {
	it('builds the image, resolves secrets, creates the vm, and enables ingress', async () => {
		const closeMock = vi.fn(async () => {});
		const enableIngressMock = vi.fn(async () => ({ host: '127.0.0.1', port: 18791 }));
		const enableSshMock = vi.fn(async () => ({ host: '127.0.0.1', port: 2222 }));
		const execMock = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
		const setIngressRoutesMock = vi.fn();
		const managedVm: ManagedVm = {
			id: 'vm-123',
			close: closeMock,
			enableIngress: enableIngressMock,
			enableSsh: enableSshMock,
			exec: execMock,
			setIngressRoutes: setIngressRoutesMock,
		};
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => {
				throw new Error('resolve is not used by this test');
			},
			resolveAll: async () => ({
				ANTHROPIC_API_KEY: 'resolved-key',
			}),
		};
		const buildImage = vi.fn(
			async (_options: unknown): Promise<BuildImageResult> => ({
				built: true,
				fingerprint: 'fingerprint-123',
				imagePath: '/tmp/gateway-image',
			}),
		);
		const createManagedVm = vi.fn(async (): Promise<ManagedVm> => managedVm);
		const buildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
			rootfs: {
				label: 'gateway-root',
			},
		};
		const loadBuildConfig = vi.fn(async (): Promise<unknown> => buildConfig);

		const result = await startGatewayZone(
			{
				pluginSourceDir: '/plugins/openclaw-gondolin-plugin',
				secretResolver,
				systemConfig,
				zoneId: 'shravan',
			},
			{
				buildImage,
				createManagedVm,
				loadBuildConfig,
			},
		);

		expect(loadBuildConfig).toHaveBeenCalledWith('./images/gateway/build-config.json');
		expect(buildImage).toHaveBeenCalled();
		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: ['api.anthropic.com', 'api.openai.com'],
				cpus: 2,
				env: expect.objectContaining({
					HOME: '/home/openclaw',
					NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
					OPENCLAW_CONFIG_PATH: '/home/openclaw/.openclaw/openclaw.json',
					OPENCLAW_STATE_DIR: '/home/openclaw/.openclaw/state',
				}),
				imagePath: '/tmp/gateway-image',
				memory: '2G',
				rootfsMode: 'cow',
				secrets: {
					ANTHROPIC_API_KEY: {
						hosts: ['api.anthropic.com'],
						value: 'resolved-key',
					},
				},
				vfsMounts: expect.objectContaining({
					'/home/openclaw/.openclaw/extensions/gondolin': {
						hostPath: '/plugins/openclaw-gondolin-plugin',
						kind: 'realfs-readonly',
					},
				}),
			}),
		);
		expect(execMock).toHaveBeenCalledWith('openclaw gateway --port 18789 &');
		expect(setIngressRoutesMock).toHaveBeenCalledWith([
			{
				port: 18789,
				prefix: '/',
				stripPrefix: true,
			},
		]);
		expect(enableIngressMock).toHaveBeenCalledWith({
			listenPort: 18791,
		});
		expect(result).toMatchObject({
			image: {
				fingerprint: 'fingerprint-123',
				imagePath: '/tmp/gateway-image',
			},
			ingress: {
				host: '127.0.0.1',
				port: 18791,
			},
		});
	});
});
