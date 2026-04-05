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
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);

		expect(outputs.join('\n')).toContain('"ok": true');
		expect(outputs.join('\n')).toContain('"controllerPort": 18800');
	});
});
