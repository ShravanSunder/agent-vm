import { describe, expect, it, vi } from 'vitest';

import { runAgentVmCli } from './agent-vm.js';

describe('runAgentVmCli', () => {
	it('routes doctor and status subcommands to their handlers', async () => {
		const outputs: string[] = [];

		await runAgentVmCli(
			['controller', 'doctor'],
			{
				stderr: {
					write: () => true,
				},
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				buildControllerStatus: () => ({
					controllerPort: 18800,
					toolProfiles: ['standard'],
					zones: [],
				}),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				loadSystemConfig: () => ({
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
							postBuild: [],
						},
						tool: {
							buildConfig: './images/tool/build-config.json',
							postBuild: [],
						},
					},
					tcpPool: {
						basePort: 19000,
						size: 5,
					},
					toolProfiles: {
						standard: {
							cpus: 1,
							memory: '1G',
							workspaceRoot: './workspaces/tools',
						},
					},
					zones: [],
				}),
				runControllerDoctor: () => ({
					checks: [],
					ok: true,
				}),
				startControllerRuntime: vi.fn(
					async () =>
						({
							controllerPort: 18800,
							gateway: {
								ingress: {
									host: '127.0.0.1',
									port: 18791,
								},
								vm: {
									id: 'vm-123',
								},
							},
							close: async () => {},
						}) as never,
				),
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);
		await runAgentVmCli(
			['controller', 'status'],
			{
				stderr: {
					write: () => true,
				},
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				buildControllerStatus: () => ({
					controllerPort: 18800,
					toolProfiles: ['standard'],
					zones: [],
				}),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				loadSystemConfig: () => ({
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
							postBuild: [],
						},
						tool: {
							buildConfig: './images/tool/build-config.json',
							postBuild: [],
						},
					},
					tcpPool: {
						basePort: 19000,
						size: 5,
					},
					toolProfiles: {
						standard: {
							cpus: 1,
							memory: '1G',
							workspaceRoot: './workspaces/tools',
						},
					},
					zones: [],
				}),
				runControllerDoctor: () => ({
					checks: [],
					ok: true,
				}),
				startControllerRuntime: vi.fn(
					async () =>
						({
							controllerPort: 18800,
							gateway: {
								ingress: {
									host: '127.0.0.1',
									port: 18791,
								},
								vm: {
									id: 'vm-123',
								},
							},
							close: async () => {},
						}) as never,
				),
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);

		expect(outputs.join('\n')).toContain('"ok": true');
		expect(outputs.join('\n')).toContain('"controllerPort": 18800');
	});

	it('passes the bundled gondolin plugin source path into controller start', async () => {
		const startControllerRuntime = vi.fn(
			async () =>
				({
					controllerPort: 18800,
					gateway: {
						ingress: {
							host: '127.0.0.1',
							port: 18791,
						},
						vm: {
							id: 'vm-123',
						},
					},
					close: async () => {},
				}) as never,
		);

		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';

		await runAgentVmCli(
			['controller', 'start'],
			{
				stderr: {
					write: () => true,
				},
				stdout: {
					write: () => true,
				},
			},
			{
				buildControllerStatus: () => ({
					controllerPort: 18800,
					toolProfiles: ['standard'],
					zones: [],
				}),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				loadSystemConfig: () => ({
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
							postBuild: [],
						},
						tool: {
							buildConfig: './images/tool/build-config.json',
							postBuild: [],
						},
					},
					tcpPool: {
						basePort: 19000,
						size: 5,
					},
					toolProfiles: {
						standard: {
							cpus: 1,
							memory: '1G',
							workspaceRoot: './workspaces/tools',
						},
					},
					zones: [
						{
							allowedHosts: ['api.anthropic.com'],
							gateway: {
								cpus: 2,
								memory: '2G',
								openclawConfig: './config/shravan/openclaw.json',
								port: 18791,
								stateDir: './state/shravan',
								workspaceDir: './workspaces/shravan',
							},
							id: 'shravan',
							secrets: {},
							toolProfile: 'standard',
						},
					],
				}),
				runControllerDoctor: () => ({
					checks: [],
					ok: true,
				}),
				startControllerRuntime,
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);

		expect(startControllerRuntime).toHaveBeenCalledWith(
			expect.objectContaining({
				pluginSourceDir: expect.stringMatching(/openclaw-gondolin-plugin\/src\/?$/u),
				zoneId: 'shravan',
			}),
		);
	});
});
