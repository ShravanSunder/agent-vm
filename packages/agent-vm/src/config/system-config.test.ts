import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { loadSystemConfig } from './system-config.js';

const createdDirectories: string[] = [];

interface ValidSystemConfigZoneInput {
	id: string;
	gateway: Record<string, unknown>;
	secrets: Record<string, unknown>;
	runtimeAuthHints?: unknown;
	allowedHosts: readonly string[];
	toolProfile?: string;
	readonly [key: string]: unknown;
}

interface ValidSystemConfigInput {
	host: Record<string, unknown>;
	cacheDir: string;
	runtimeDir: string;
	imageProfiles: Record<string, unknown>;
	zones: [ValidSystemConfigZoneInput, ...ValidSystemConfigZoneInput[]];
	toolProfiles?: Record<string, unknown>;
	tcpPool: Record<string, unknown>;
	readonly [key: string]: unknown;
}

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { recursive: true, force: true });
	}
});

function createValidSystemConfigInput(): ValidSystemConfigInput {
	return {
		host: {
			controllerPort: 18800,
			projectNamespace: 'claw-tests-a1b2c3d4',
		},
		cacheDir: '../cache',
		runtimeDir: '../runtime',
		imageProfiles: {
			gateways: {
				openclaw: {
					type: 'openclaw',
					buildConfig: '../vm-images/gateways/openclaw/build-config.json',
				},
				worker: {
					type: 'worker',
					buildConfig: '../vm-images/gateways/worker/build-config.json',
				},
			},
			toolVms: {
				default: {
					type: 'toolVm',
					buildConfig: '../vm-images/tool-vms/default/build-config.json',
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
					config: './shravan/openclaw.json',
					stateDir: '../state/shravan',
					zoneFilesDir: '../zone-files/shravan',
				},
				secrets: {},
				runtimeAuthHints: [],
				allowedHosts: ['discord.com'],
				toolProfile: 'standard',
			},
		],
		toolProfiles: {
			standard: {
				memory: '1G',
				cpus: 1,
				workspaceRoot: '../workspaces/tools',
				imageProfile: 'default',
			},
		},
		tcpPool: {
			basePort: 19000,
			size: 5,
		},
	};
}

async function writeSystemConfigForTest(prefix: string, config: unknown): Promise<string> {
	const workingDirectoryPath = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
	createdDirectories.push(workingDirectoryPath);
	const configPath = path.join(workingDirectoryPath, 'config', 'system.json');
	await fsp.mkdir(path.dirname(configPath), { recursive: true });
	await fsp.writeFile(configPath, JSON.stringify(config), 'utf8');
	return configPath;
}

describe('loadSystemConfig', () => {
	test('loads a valid plan-1 controller config', async () => {
		const workingDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-system-config-'));
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'config', 'system.json');
		fs.mkdirSync(path.dirname(configPath), { recursive: true });

		fs.writeFileSync(
			configPath,
			JSON.stringify({
				host: {
					controllerPort: 18800,
					projectNamespace: 'claw-tests-a1b2c3d4',
					githubToken: {
						source: '1password',
						ref: 'op://agent-vm/github-token/credential',
					},
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'op-cli', ref: 'op://agent-vm/agent-1p-service-account/password' },
					},
				},
				cacheDir: '../cache',
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'openclaw',
							buildConfig: '../vm-images/gateways/openclaw/build-config.json',
							dockerfile: '../vm-images/gateways/openclaw/Dockerfile',
						},
						worker: {
							type: 'worker',
							buildConfig: '../vm-images/gateways/openclaw/build-config.json',
							dockerfile: '../vm-images/gateways/openclaw/Dockerfile',
						},
					},
					toolVms: {
						default: {
							type: 'toolVm',
							buildConfig: '../vm-images/tool-vms/default/build-config.json',
							dockerfile: '../vm-images/tool-vms/default/Dockerfile',
						},
					},
				},
				zones: [
					{
						id: 'shravan',
						gateway: {
							type: 'worker',
							imageProfile: 'worker',
							memory: '2G',
							cpus: 2,
							port: 18791,
							config: './shravan/openclaw.json',
							stateDir: '../state/shravan',
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
						workspaceRoot: '../workspaces/tools',
						imageProfile: 'default',
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
			systemConfigPath: configPath,
			systemCacheIdentifierPath: path.join(
				workingDirectoryPath,
				'config',
				'systemCacheIdentifier.json',
			),
			host: {
				controllerPort: 18800,
				githubToken: {
					source: '1password',
					ref: 'op://agent-vm/github-token/credential',
				},
				projectNamespace: 'claw-tests-a1b2c3d4',
			},
			cacheDir: path.join(workingDirectoryPath, 'cache'),
			imageProfiles: {
				gateways: {
					openclaw: {
						type: 'openclaw',
						buildConfig: path.join(
							workingDirectoryPath,
							'vm-images/gateways/openclaw/build-config.json',
						),
						dockerfile: path.join(workingDirectoryPath, 'vm-images/gateways/openclaw/Dockerfile'),
					},
					worker: {
						type: 'worker',
						buildConfig: path.join(
							workingDirectoryPath,
							'vm-images/gateways/openclaw/build-config.json',
						),
						dockerfile: path.join(workingDirectoryPath, 'vm-images/gateways/openclaw/Dockerfile'),
					},
				},
				toolVms: {
					default: {
						type: 'toolVm',
						buildConfig: path.join(
							workingDirectoryPath,
							'vm-images/tool-vms/default/build-config.json',
						),
						dockerfile: path.join(workingDirectoryPath, 'vm-images/tool-vms/default/Dockerfile'),
					},
				},
			},
			zones: [
				{
					id: 'shravan',
					gateway: {
						config: path.join(workingDirectoryPath, 'config', 'shravan', 'openclaw.json'),
						type: 'worker',
						imageProfile: 'worker',
					},
				},
			],
		});
	});

	test('adds runtime-only system config and cache identifier paths', async () => {
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-cache-id-',
			createValidSystemConfigInput(),
		);

		const config = await loadSystemConfig(configPath);

		expect(config.systemConfigPath).toBe(configPath);
		expect(config.systemCacheIdentifierPath).toBe(
			path.join(path.dirname(configPath), 'systemCacheIdentifier.json'),
		);
		expect(config.runtimeDir).toBe(path.join(path.dirname(configPath), '..', 'runtime'));
	});

	test('expands ~/ paths to the current user home directory', async () => {
		const input = createValidSystemConfigInput();
		input.cacheDir = '~/.agent-vm/cache';
		input.runtimeDir = '~/.agent-vm/runtime';
		const firstZone = input.zones[0];
		firstZone.gateway = {
			...firstZone.gateway,
			stateDir: '~/.agent-vm/state/shravan',
			zoneFilesDir: '~/.agent-vm/zone-files/shravan',
			backupDir: '~/.agent-vm-backups/shravan',
		};
		const configPath = await writeSystemConfigForTest('agent-vm-system-config-tilde-', input);

		const config = await loadSystemConfig(configPath);

		expect(config.cacheDir).toBe(path.join(os.homedir(), '.agent-vm', 'cache'));
		expect(config.runtimeDir).toBe(path.join(os.homedir(), '.agent-vm', 'runtime'));
		expect(config.zones[0]?.gateway.stateDir).toBe(
			path.join(os.homedir(), '.agent-vm', 'state', 'shravan'),
		);
		if (config.zones[0]?.gateway.type !== 'openclaw') {
			throw new Error('Expected fixture zone to be OpenClaw.');
		}
		expect(config.zones[0].gateway.zoneFilesDir).toBe(
			path.join(os.homedir(), '.agent-vm', 'zone-files', 'shravan'),
		);
		expect(config.zones[0]?.gateway.backupDir).toBe(
			path.join(os.homedir(), '.agent-vm-backups', 'shravan'),
		);
	});

	test('rejects worker gateway configs with zoneFilesDir', async () => {
		const input = createValidSystemConfigInput();
		const existingZone = input.zones[0];
		input.zones[0] = {
			id: existingZone.id,
			secrets: existingZone.secrets,
			runtimeAuthHints: existingZone.runtimeAuthHints,
			allowedHosts: existingZone.allowedHosts,
			gateway: {
				type: 'worker',
				imageProfile: 'worker',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './shravan/worker.json',
				stateDir: '../state/shravan',
				zoneFilesDir: '../zone-files/shravan',
			},
		};
		const configPath = await writeSystemConfigForTest('agent-vm-system-worker-zone-files-', input);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/zoneFilesDir/u);
	});

	test('rejects legacy gateway workspaceDir', async () => {
		const input = createValidSystemConfigInput();
		input.zones[0] = {
			...input.zones[0],
			gateway: {
				type: 'openclaw',
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './shravan/openclaw.json',
				stateDir: '../state/shravan',
				workspaceDir: '../workspaces/shravan',
			},
		};
		const configPath = await writeSystemConfigForTest('agent-vm-system-legacy-workspace-', input);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/workspaceDir/u);
	});

	test('accepts zones without an explicit backupDir (legacy fallback applies elsewhere)', async () => {
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-no-backup-',
			createValidSystemConfigInput(),
		);

		const config = await loadSystemConfig(configPath);

		expect(config.zones[0]?.gateway.backupDir).toBeUndefined();
	});

	test('omits zone resource policy when not present', async () => {
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-resources-defaults-',
			createValidSystemConfigInput(),
		);

		const config = await loadSystemConfig(configPath);

		expect(config.zones[0]?.resources).toBeUndefined();
	});

	test('accepts explicit zone repo resource policy', async () => {
		const config = createValidSystemConfigInput();
		const zones = config.zones as Array<Record<string, unknown>>;
		zones[0] = {
			...zones[0],
			resources: {
				allowRepoResources: ['https://github.com/example/app.git'],
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-resources-explicit-',
			config,
		);

		const loadedConfig = await loadSystemConfig(configPath);

		expect(loadedConfig.zones[0]?.resources).toEqual({
			allowRepoResources: ['https://github.com/example/app.git'],
		});
	});

	test('rejects legacy zone resource allowedKinds', async () => {
		const config = createValidSystemConfigInput();
		const zones = config.zones as Array<Record<string, unknown>>;
		zones[0] = {
			...zones[0],
			resources: {
				allowRepoResources: true,
				allowedKinds: ['compose', 'postgres', 'redis'],
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-resources-legacy-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/allowedKinds/u);
	});

	test('rejects per-profile legacy cache fields', async () => {
		const config = createValidSystemConfigInput();
		const legacyFieldName = ['cache', 'Inputs'].join('');
		const legacyFileName = ['cache', 'inputs'].join('-');
		const imageProfiles = config.imageProfiles as {
			readonly gateways: { readonly worker: Record<string, unknown> };
		};
		imageProfiles.gateways.worker[legacyFieldName] = `../${legacyFileName}.json`;
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-legacy-cache-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(new RegExp(legacyFieldName, 'u'));
	});

	test('rejects configs without zones', async () => {
		const workingDirectoryPath = fs.mkdtempSync(
			path.join(os.tmpdir(), 'agent-vm-system-config-invalid-'),
		);
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'config', 'system.json');
		fs.mkdirSync(path.dirname(configPath), { recursive: true });

		fs.writeFileSync(
			configPath,
			JSON.stringify({
				host: {
					controllerPort: 18800,
					projectNamespace: 'claw-tests-a1b2c3d4',
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'op-cli', ref: 'op://agent-vm/agent-1p-service-account/password' },
					},
				},
				cacheDir: '../cache',
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'openclaw',
							buildConfig: '../vm-images/gateways/openclaw/build-config.json',
							dockerfile: '../vm-images/gateways/openclaw/Dockerfile',
						},
						worker: {
							type: 'worker',
							buildConfig: '../vm-images/gateways/openclaw/build-config.json',
							dockerfile: '../vm-images/gateways/openclaw/Dockerfile',
						},
					},
					toolVms: {
						default: {
							type: 'toolVm',
							buildConfig: '../vm-images/tool-vms/default/build-config.json',
							dockerfile: '../vm-images/tool-vms/default/Dockerfile',
						},
					},
				},
				zones: [],
				toolProfiles: {
					standard: {
						memory: '1G',
						cpus: 1,
						workspaceRoot: '../workspaces/tools',
						imageProfile: 'default',
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

	test('rejects configs with zone secrets missing ref', async () => {
		const workingDirectoryPath = fs.mkdtempSync(
			path.join(os.tmpdir(), 'agent-vm-system-config-missing-ref-'),
		);
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'config', 'system.json');
		fs.mkdirSync(path.dirname(configPath), { recursive: true });

		fs.writeFileSync(
			configPath,
			JSON.stringify({
				host: {
					controllerPort: 18800,
					projectNamespace: 'claw-tests-a1b2c3d4',
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'op-cli', ref: 'op://agent-vm/agent-1p-service-account/password' },
					},
				},
				cacheDir: '../cache',
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'openclaw',
							buildConfig: '../vm-images/gateways/openclaw/build-config.json',
						},
						worker: {
							type: 'worker',
							buildConfig: '../vm-images/gateways/openclaw/build-config.json',
						},
					},
					toolVms: {
						default: {
							type: 'toolVm',
							buildConfig: '../vm-images/tool-vms/default/build-config.json',
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
							config: './shravan/openclaw.json',
							stateDir: '../state/shravan',
							zoneFilesDir: '../zone-files/shravan',
						},
						secrets: {
							DISCORD_BOT_TOKEN: {
								source: '1password',
								injection: 'env',
							},
						},
						allowedHosts: ['discord.com'],
						toolProfile: 'standard',
					},
				],
				toolProfiles: {
					standard: {
						memory: '1G',
						cpus: 1,
						workspaceRoot: '../workspaces/tools',
						imageProfile: 'default',
					},
				},
				tcpPool: {
					basePort: 19000,
					size: 5,
				},
			}),
			'utf8',
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/ref/i);
	});

	test('rejects project namespaces that contain label separators', async () => {
		const workingDirectoryPath = fs.mkdtempSync(
			path.join(os.tmpdir(), 'agent-vm-system-config-invalid-namespace-'),
		);
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'config', 'system.json');
		fs.mkdirSync(path.dirname(configPath), { recursive: true });

		fs.writeFileSync(
			configPath,
			JSON.stringify({
				host: {
					controllerPort: 18800,
					projectNamespace: 'bad:namespace',
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'op-cli', ref: 'op://agent-vm/agent-1p-service-account/password' },
					},
				},
				cacheDir: '../cache',
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'openclaw',
							buildConfig: '../vm-images/gateways/openclaw/build-config.json',
						},
						worker: {
							type: 'worker',
							buildConfig: '../vm-images/gateways/openclaw/build-config.json',
						},
					},
					toolVms: {
						default: {
							type: 'toolVm',
							buildConfig: '../vm-images/tool-vms/default/build-config.json',
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
							config: './shravan/openclaw.json',
							stateDir: '../state/shravan',
							zoneFilesDir: '../zone-files/shravan',
						},
						secrets: {},
						runtimeAuthHints: [],
						allowedHosts: ['discord.com'],
						toolProfile: 'standard',
					},
				],
				toolProfiles: {
					standard: {
						memory: '1G',
						cpus: 1,
						workspaceRoot: '../workspaces/tools',
						imageProfile: 'default',
					},
				},
				tcpPool: {
					basePort: 19000,
					size: 5,
				},
			}),
			'utf8',
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/projectNamespace/u);
	});

	test('loads service token runtime auth hints from zone config', async () => {
		const config = createValidSystemConfigInput();
		const zones = config.zones as Array<{
			runtimeAuthHints?: unknown;
			secrets: Record<string, unknown>;
		}>;
		const zone = zones[0];
		if (!zone) {
			throw new Error('Expected valid config fixture to include a zone.');
		}
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			hosts: ['api.github.com'],
		};
		zone.runtimeAuthHints = [
			{
				kind: 'service-token',
				secret: 'GITHUB_TOKEN',
				service: 'github',
				hosts: ['api.github.com'],
				tools: ['gh'],
			},
		];
		const configPath = await writeSystemConfigForTest('agent-vm-system-runtime-auth-', config);

		await expect(loadSystemConfig(configPath)).resolves.toMatchObject({
			zones: [
				{
					runtimeAuthHints: [
						{
							kind: 'service-token',
							secret: 'GITHUB_TOKEN',
							service: 'github',
							hosts: ['api.github.com'],
							tools: ['gh'],
						},
					],
				},
			],
		});
	});

	test('allows omitted runtime auth hints', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		delete zone.runtimeAuthHints;
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-runtime-auth-default-',
			config,
		);

		const loadedConfig = await loadSystemConfig(configPath);

		expect(loadedConfig.zones[0]?.runtimeAuthHints).toBeUndefined();
	});

	test('rejects runtime auth hints that reference missing secrets', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.runtimeAuthHints = [
			{
				kind: 'service-token',
				secret: 'NPM_AUTH_TOKEN',
				service: 'npm',
				hosts: ['registry.npmjs.org'],
				tools: ['npm', 'pnpm', 'yarn'],
			},
		];
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-runtime-auth-missing-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/NPM_AUTH_TOKEN/u);
	});

	test('rejects runtime auth hints that reference hosts outside the mediated secret', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.secrets.NPM_AUTH_TOKEN = {
			source: 'environment',
			envVar: 'NPM_AUTH_TOKEN',
			injection: 'http-mediation',
			hosts: ['registry.npmjs.org'],
		};
		zone.runtimeAuthHints = [
			{
				kind: 'service-token',
				secret: 'NPM_AUTH_TOKEN',
				service: 'npm',
				hosts: ['npm.pkg.github.com'],
				tools: ['npm'],
			},
		];
		const configPath = await writeSystemConfigForTest('agent-vm-system-runtime-auth-host-', config);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/npm\.pkg\.github\.com/u);
	});

	test('rejects runtime auth hints that reference env-injected secrets', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'env',
		};
		zone.runtimeAuthHints = [
			{
				kind: 'service-token',
				secret: 'GITHUB_TOKEN',
				service: 'github',
				hosts: ['api.github.com'],
				tools: ['gh'],
			},
		];
		const configPath = await writeSystemConfigForTest('agent-vm-system-runtime-auth-env-', config);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/http-mediation/u);
	});

	test('rejects zones that reference unknown tool profiles', async () => {
		const workingDirectoryPath = fs.mkdtempSync(
			path.join(os.tmpdir(), 'agent-vm-system-config-missing-tool-profile-'),
		);
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'config', 'system.json');
		fs.mkdirSync(path.dirname(configPath), { recursive: true });

		fs.writeFileSync(
			configPath,
			JSON.stringify({
				host: {
					controllerPort: 18800,
					projectNamespace: 'claw-tests-a1b2c3d4',
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'op-cli', ref: 'op://agent-vm/agent-1p-service-account/password' },
					},
				},
				cacheDir: '../cache',
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'openclaw',
							buildConfig: '../vm-images/gateways/openclaw/build-config.json',
						},
						worker: {
							type: 'worker',
							buildConfig: '../vm-images/gateways/openclaw/build-config.json',
						},
					},
					toolVms: {
						default: {
							type: 'toolVm',
							buildConfig: '../vm-images/tool-vms/default/build-config.json',
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
							config: './shravan/openclaw.json',
							stateDir: '../state/shravan',
							zoneFilesDir: '../zone-files/shravan',
						},
						secrets: {},
						runtimeAuthHints: [],
						allowedHosts: ['discord.com'],
						toolProfile: 'missing-profile',
					},
				],
				toolProfiles: {
					standard: {
						memory: '1G',
						cpus: 1,
						workspaceRoot: '../workspaces/tools',
						imageProfile: 'default',
					},
				},
				tcpPool: {
					basePort: 19000,
					size: 5,
				},
			}),
			'utf8',
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/unknown toolProfile/u);
	});

	test('rejects configs with no gateway image profiles', async () => {
		const config = createValidSystemConfigInput();
		config.imageProfiles = {
			gateways: {},
			toolVms: {
				default: {
					type: 'toolVm',
					buildConfig: '../vm-images/tool-vms/default/build-config.json',
				},
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-empty-gateway-profiles-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(
			/at least one gateway image profile/u,
		);
	});

	test('accepts worker-only configs without tool VM support', async () => {
		const config = createValidSystemConfigInput();
		config.imageProfiles = {
			gateways: {
				worker: {
					type: 'worker',
					buildConfig: '../vm-images/gateways/worker/build-config.json',
				},
			},
		};
		config.zones = [
			{
				id: 'worker-zone',
				gateway: {
					type: 'worker',
					imageProfile: 'worker',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: './worker-zone/worker.json',
					stateDir: '../state/worker-zone',
				},
				secrets: {},
				runtimeAuthHints: [],
				allowedHosts: ['api.openai.com'],
			},
		];
		delete config.toolProfiles;
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-worker-no-tools-',
			config,
		);

		const systemConfig = await loadSystemConfig(configPath);

		expect(systemConfig).toMatchObject({
			imageProfiles: { toolVms: {} },
			toolProfiles: {},
			zones: [
				{
					id: 'worker-zone',
				},
			],
		});
		expect(systemConfig.zones[0]).not.toHaveProperty('toolProfile');
	});

	test('rejects openclaw zones without a tool profile', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		delete zone.toolProfile;
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-openclaw-missing-tool-profile-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/must declare a toolProfile/u);
	});

	test('rejects openclaw configs with no matching tool VM image profiles', async () => {
		const config = createValidSystemConfigInput();
		config.imageProfiles = {
			gateways: {
				openclaw: {
					type: 'openclaw',
					buildConfig: '../vm-images/gateways/openclaw/build-config.json',
				},
			},
			toolVms: {},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-empty-tool-profiles-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/unknown tool VM imageProfile/u);
	});

	test('rejects zones that reference unknown gateway image profiles', async () => {
		const config = createValidSystemConfigInput();
		config.zones = [
			{
				id: 'shravan',
				gateway: {
					type: 'openclaw',
					imageProfile: 'missing-openclaw',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: './shravan/openclaw.json',
					stateDir: '../state/shravan',
					zoneFilesDir: '../zone-files/shravan',
				},
				secrets: {},
				runtimeAuthHints: [],
				allowedHosts: ['discord.com'],
				toolProfile: 'standard',
			},
		];
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-missing-gateway-profile-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/unknown gateway imageProfile/u);
	});

	test('rejects gateway image profiles whose type differs from the zone gateway type', async () => {
		const config = createValidSystemConfigInput();
		config.zones = [
			{
				id: 'shravan',
				gateway: {
					type: 'worker',
					imageProfile: 'openclaw',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: './shravan/worker.json',
					stateDir: '../state/shravan',
				},
				secrets: {},
				runtimeAuthHints: [],
				allowedHosts: ['discord.com'],
				toolProfile: 'standard',
			},
		];
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-profile-type-mismatch-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/does not match imageProfile/u);
	});

	test('rejects tool profiles that reference unknown tool VM image profiles', async () => {
		const config = createValidSystemConfigInput();
		config.toolProfiles = {
			standard: {
				memory: '1G',
				cpus: 1,
				workspaceRoot: '../workspaces/tools',
				imageProfile: 'missing-tool-vm',
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-missing-tool-vm-profile-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/unknown tool VM imageProfile/u);
	});

	test('rejects empty image profile names', async () => {
		const config = createValidSystemConfigInput();
		config.imageProfiles = {
			gateways: {
				'': {
					type: 'openclaw',
					buildConfig: '../vm-images/gateways/openclaw/build-config.json',
				},
			},
			toolVms: {
				default: {
					type: 'toolVm',
					buildConfig: '../vm-images/tool-vms/default/build-config.json',
				},
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-empty-profile-name-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/Too small|Invalid key/u);
	});
});
