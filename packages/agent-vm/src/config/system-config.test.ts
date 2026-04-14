import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { loadSystemConfig } from './system-config.js';

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { recursive: true, force: true });
	}
});

describe('loadSystemConfig', () => {
	test('loads a valid plan-1 controller config', async () => {
		const workingDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-system-config-'));
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'system.json');

		fs.writeFileSync(
			configPath,
			JSON.stringify({
				host: {
					controllerPort: 18800,
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'op-cli', ref: 'op://agent-vm/agent-1p-service-account/password' },
					},
				},
				cacheDir: './cache',
				images: {
					gateway: {
						buildConfig: './images/gateway/build-config.json',
						dockerfile: './images/gateway/Dockerfile',
					},
					tool: {
						buildConfig: './images/tool/build-config.json',
						dockerfile: './images/tool/Dockerfile',
					},
				},
				zones: [
					{
						id: 'shravan',
						gateway: {
							type: 'coding',
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
								hosts: ['api.anthropic.com'],
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
			}),
			'utf8',
		);

		await expect(loadSystemConfig(configPath)).resolves.toMatchObject({
			host: {
				controllerPort: 18800,
			},
			cacheDir: path.join(workingDirectoryPath, 'cache'),
			images: {
				gateway: {
					dockerfile: path.join(workingDirectoryPath, 'images/gateway/Dockerfile'),
				},
				tool: {
					dockerfile: path.join(workingDirectoryPath, 'images/tool/Dockerfile'),
				},
			},
			zones: [
				{
					id: 'shravan',
					gateway: {
						gatewayConfig: path.join(workingDirectoryPath, 'config/shravan/openclaw.json'),
						type: 'coding',
					},
				},
			],
		});
	});

	test('rejects configs without zones', async () => {
		const workingDirectoryPath = fs.mkdtempSync(
			path.join(os.tmpdir(), 'agent-vm-system-config-invalid-'),
		);
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'system.json');

		fs.writeFileSync(
			configPath,
			JSON.stringify({
				host: {
					controllerPort: 18800,
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'op-cli', ref: 'op://agent-vm/agent-1p-service-account/password' },
					},
				},
				cacheDir: './cache',
				images: {
					gateway: {
						buildConfig: './images/gateway/build-config.json',
						dockerfile: './images/gateway/Dockerfile',
					},
					tool: {
						buildConfig: './images/tool/build-config.json',
						dockerfile: './images/tool/Dockerfile',
					},
				},
				zones: [],
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
			}),
			'utf8',
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/zones/i);
	});

	test('accepts environment-sourced secrets without host.secretsProvider', async () => {
		const workingDirectoryPath = fs.mkdtempSync(
			path.join(os.tmpdir(), 'agent-vm-system-config-env-'),
		);
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'system.json');

		fs.writeFileSync(
			configPath,
			JSON.stringify({
				host: {
					controllerPort: 18800,
				},
				cacheDir: './cache',
				images: {
					gateway: { buildConfig: './images/gateway/build-config.json' },
					tool: { buildConfig: './images/tool/build-config.json' },
				},
				zones: [
					{
						id: 'shravan',
						gateway: {
							type: 'coding',
							memory: '2G',
							cpus: 2,
							port: 18791,
							gatewayConfig: './config/shravan/openclaw.json',
							stateDir: './state/shravan',
							workspaceDir: './workspaces/shravan',
						},
						secrets: {
							OPENAI_API_KEY: {
								source: 'environment',
								envVar: 'OPENAI_API_KEY',
								hosts: ['api.openai.com'],
							},
						},
						allowedHosts: ['api.openai.com'],
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
				tcpPool: { basePort: 19000, size: 5 },
			}),
			'utf8',
		);

		await expect(loadSystemConfig(configPath)).resolves.toMatchObject({
			host: { controllerPort: 18800 },
		});
	});

	test('defaults secret injection to http-mediation', async () => {
		const workingDirectoryPath = fs.mkdtempSync(
			path.join(os.tmpdir(), 'agent-vm-system-config-default-injection-'),
		);
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'system.json');

		fs.writeFileSync(
			configPath,
			JSON.stringify({
				host: {
					controllerPort: 18800,
				},
				cacheDir: './cache',
				images: {
					gateway: { buildConfig: './images/gateway/build-config.json' },
					tool: { buildConfig: './images/tool/build-config.json' },
				},
				zones: [
					{
						id: 'shravan',
						gateway: {
							type: 'coding',
							memory: '2G',
							cpus: 2,
							port: 18791,
							gatewayConfig: './config/shravan/openclaw.json',
							stateDir: './state/shravan',
							workspaceDir: './workspaces/shravan',
						},
						secrets: {
							OPENAI_API_KEY: {
								source: 'environment',
								envVar: 'OPENAI_API_KEY',
								hosts: ['api.openai.com'],
							},
						},
						allowedHosts: ['api.openai.com'],
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
				tcpPool: { basePort: 19000, size: 5 },
			}),
			'utf8',
		);

		const config = await loadSystemConfig(configPath);
		expect(config.zones[0]?.secrets.OPENAI_API_KEY?.injection).toBe('http-mediation');
	});

	test('rejects onepassword secrets when host.secretsProvider is absent', async () => {
		const workingDirectoryPath = fs.mkdtempSync(
			path.join(os.tmpdir(), 'agent-vm-system-config-missing-provider-'),
		);
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'system.json');

		fs.writeFileSync(
			configPath,
			JSON.stringify({
				host: {
					controllerPort: 18800,
				},
				cacheDir: './cache',
				images: {
					gateway: { buildConfig: './images/gateway/build-config.json' },
					tool: { buildConfig: './images/tool/build-config.json' },
				},
				zones: [
					{
						id: 'shravan',
						gateway: {
							type: 'coding',
							memory: '2G',
							cpus: 2,
							port: 18791,
							gatewayConfig: './config/shravan/openclaw.json',
							stateDir: './state/shravan',
							workspaceDir: './workspaces/shravan',
						},
						secrets: {
							OPENAI_API_KEY: {
								source: '1password',
								ref: 'op://agent-vm/openai/token',
								hosts: ['api.openai.com'],
							},
						},
						allowedHosts: ['api.openai.com'],
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
				tcpPool: { basePort: 19000, size: 5 },
			}),
			'utf8',
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/host\.secretsProvider/i);
	});

	test('rejects http-mediation secrets without hosts', async () => {
		const workingDirectoryPath = fs.mkdtempSync(
			path.join(os.tmpdir(), 'agent-vm-system-config-missing-hosts-'),
		);
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'system.json');

		fs.writeFileSync(
			configPath,
			JSON.stringify({
				host: {
					controllerPort: 18800,
				},
				cacheDir: './cache',
				images: {
					gateway: { buildConfig: './images/gateway/build-config.json' },
					tool: { buildConfig: './images/tool/build-config.json' },
				},
				zones: [
					{
						id: 'shravan',
						gateway: {
							type: 'coding',
							memory: '2G',
							cpus: 2,
							port: 18791,
							gatewayConfig: './config/shravan/openclaw.json',
							stateDir: './state/shravan',
							workspaceDir: './workspaces/shravan',
						},
						secrets: {
							OPENAI_API_KEY: {
								source: 'environment',
								envVar: 'OPENAI_API_KEY',
							},
						},
						allowedHosts: ['api.openai.com'],
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
				tcpPool: { basePort: 19000, size: 5 },
			}),
			'utf8',
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/http-mediation/i);
	});
});
