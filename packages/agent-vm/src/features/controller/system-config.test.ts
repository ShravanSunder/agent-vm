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
	test('loads a valid plan-1 controller config', () => {
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
				images: {
					gateway: {
						buildConfig: './images/gateway/build-config.json',
						postBuild: ['npm install -g openclaw@2026.4.2'],
					},
					tool: {
						buildConfig: './images/tool/build-config.json',
						postBuild: ['npm install -g @anthropic-ai/claude-code @openai/codex'],
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
			}),
			'utf8',
		);

		expect(loadSystemConfig(configPath)).toMatchObject({
			host: {
				controllerPort: 18800,
			},
			zones: [
				{
					id: 'shravan',
				},
			],
		});
	});

	test('rejects configs without zones', () => {
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

		expect(() => loadSystemConfig(configPath)).toThrow(/zones/i);
	});
});
