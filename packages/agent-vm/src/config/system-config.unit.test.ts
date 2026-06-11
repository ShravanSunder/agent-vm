import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
	createLoadedSystemConfig,
	createSystemConfigSchemaArtifact,
	loadSystemConfig,
	resolveControllerHealthConfig,
	type LoadedSystemConfig,
	type SystemConfigInput,
} from './system-config.js';

const createdDirectories: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ValidSystemConfigZoneInput {
	id: string;
	agents?: readonly { readonly id: string; readonly toolVmProfile?: string }[];
	gateway: Record<string, unknown>;
	mcp?: { readonly configDir: string };
	secrets: Record<string, unknown>;
	runtimeAuthHints?: unknown;
	egressHosts?: readonly { readonly host: string; readonly audience: string }[];
	allowedHosts?: unknown;
	defaultToolVmProfile?: string;
	agentToolVmProfiles?: Record<string, string>;
	agentSandboxSeeds?: Record<string, unknown>;
	[key: string]: unknown;
}

interface ValidSystemConfigInput {
	host: Record<string, unknown>;
	controller?: unknown;
	cacheDir: string;
	runtimeDir: string;
	imageProfiles: Record<string, unknown>;
	zones: [ValidSystemConfigZoneInput, ...ValidSystemConfigZoneInput[]];
	toolVmProfiles?: Record<string, unknown>;
	tcpPool: Record<string, unknown>;
	leaseIdleTtl?: unknown;
	[key: string]: unknown;
}

function configureFirstZoneAsWorker(config: ValidSystemConfigInput): ValidSystemConfigZoneInput {
	const zone = config.zones[0];
	zone.gateway = {
		type: 'worker',
		imageProfile: 'worker',
		memory: '2G',
		cpus: 2,
		port: 18791,
		config: './shravan/worker.json',
		stateDir: '../state/shravan',
	};
	delete zone.defaultToolVmProfile;
	delete zone.agentToolVmProfiles;
	delete zone.agentSandboxSeeds;
	delete zone.runtimeAuthHints;
	zone.egressHosts = [];
	zone.secrets = {};
	return zone;
}

afterEach(async () => {
	await Promise.all(
		createdDirectories
			.splice(0)
			.map((directoryPath) => rm(directoryPath, { recursive: true, force: true })),
	);
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
					controlAuth: {
						mode: 'token',
						secret: 'OPENCLAW_GATEWAY_TOKEN',
					},
					imageProfile: 'openclaw',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: './shravan/openclaw.json',
					stateDir: '../state/shravan',
					zoneFilesDir: '../zone-files/shravan',
				},
				secrets: {
					OPENCLAW_GATEWAY_TOKEN: {
						source: 'environment',
						envVar: 'OPENCLAW_GATEWAY_TOKEN',
						injection: 'env',
						audience: 'gateway',
					},
				},
				egressHosts: [{ host: 'discord.com', audience: 'gateway' }],
				defaultToolVmProfile: 'standard',
				agentToolVmProfiles: {},
			},
		],
		toolVmProfiles: {
			standard: {
				memory: '1G',
				cpus: 1,
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
	const workingDirectoryPath = await mkdtemp(path.join(os.tmpdir(), prefix));
	createdDirectories.push(workingDirectoryPath);
	const configPath = path.join(workingDirectoryPath, 'config', 'system.json');
	await mkdir(path.dirname(configPath), { recursive: true });
	await writeFile(configPath, JSON.stringify(config), 'utf8');
	return configPath;
}

function parseSystemConfigInputForTest(config: ValidSystemConfigInput): LoadedSystemConfig {
	return createLoadedSystemConfig(config as unknown as SystemConfigInput, {
		systemConfigPath: path.join(os.tmpdir(), 'agent-vm-test', 'config', 'system.json'),
	});
}

function extractFirstJsonCodeBlock(markdown: string): string {
	const codeBlockMatch = /```json\n(?<jsonText>[\s\S]*?)\n```/u.exec(markdown);
	const jsonText = codeBlockMatch?.groups?.jsonText;
	if (!jsonText) {
		throw new Error('Expected markdown to contain a JSON code block.');
	}
	return jsonText;
}

describe('loadSystemConfig', () => {
	test('loads system.jsonc with comments and trailing commas', async () => {
		const workingDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-system-config-'));
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'config', 'system.jsonc');
		await mkdir(path.dirname(configPath), { recursive: true });
		const config = createValidSystemConfigInput();
		await writeFile(
			configPath,
			[
				'{',
				'  // Controller host settings',
				`  "host": ${JSON.stringify(config.host)},`,
				'  "cacheDir": "../cache",',
				'  "runtimeDir": "../runtime",',
				`  "imageProfiles": ${JSON.stringify(config.imageProfiles)},`,
				`  "zones": ${JSON.stringify(config.zones)},`,
				`  "toolVmProfiles": ${JSON.stringify(config.toolVmProfiles)},`,
				`  "tcpPool": ${JSON.stringify(config.tcpPool)},`,
				'}',
			].join('\n'),
			'utf8',
		);

		const loadedConfig = await loadSystemConfig(configPath);

		expect(loadedConfig.systemConfigPath).toBe(configPath);
		expect(loadedConfig.host.controllerPort).toBe(18800);
		expect(loadedConfig.zones[0]?.id).toBe('shravan');
	});

	test('rejects op-cli 1Password token source because it is not headless', async () => {
		const config = createValidSystemConfigInput();
		config.host.secretsProvider = {
			type: '1password',
			tokenSource: {
				type: 'op-cli',
				ref: 'op://agent-vm/agent-1p-service-account/password',
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-op-cli-token-source-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/tokenSource/u);
	});

	test('loads optional gateway and Tool VM runtime rootfs sizes', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].gateway.runtimeRootfsSize = '12G';
		const standardToolVmProfile = config.toolVmProfiles?.standard;
		if (!isRecord(standardToolVmProfile)) {
			throw new Error('Expected standard Tool VM profile fixture.');
		}
		standardToolVmProfile.runtimeRootfsSize = '16G';

		const configPath = await writeSystemConfigForTest('agent-vm-runtime-rootfs-', config);

		const loaded = await loadSystemConfig(configPath);

		expect(loaded.zones[0]?.gateway.runtimeRootfsSize).toBe('12G');
		expect(loaded.toolVmProfiles.standard?.runtimeRootfsSize).toBe('16G');
	});

	test('loads gateway ingress timeout settings', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].gateway.ingress = {
			upstreamHeaderTimeoutMs: 5_000,
			upstreamResponseTimeoutMs: 120_000,
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-ingress-timeouts-',
			config,
		);

		const loadedConfig = await loadSystemConfig(configPath);

		expect(loadedConfig.zones[0]?.gateway.ingress).toEqual({
			upstreamHeaderTimeoutMs: 5_000,
			upstreamResponseTimeoutMs: 120_000,
		});
	});

	test('loads controller health defaults', async () => {
		const config = createValidSystemConfigInput();
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-controller-health-defaults-',
			config,
		);

		const loadedConfig = await loadSystemConfig(configPath);

		expect(resolveControllerHealthConfig(loadedConfig)).toEqual({
			enabled: true,
			eventHistoryLimit: 500,
			gatewayControlLinkBackoffCeilingMs: 120_000,
			gatewayControlLinkIntervalMs: 10_000,
			gatewayServiceAutoRestart: {
				channelProviderHealth: {
					consecutiveFailureThreshold: 3,
					enabled: true,
					restartGatewayOnRecoverable: false,
					restartGatewayOnUnrecoverable: false,
					transitioningTimeoutMs: 120_000,
				},
				cooldownMs: 61 * 60 * 1000,
				consecutiveFailureThreshold: 10,
				enabled: true,
				failedRecoveryResetMs: 24 * 60 * 60 * 1000,
				maxConsecutiveFailedRecoveries: 3,
				restartTimeoutMs: 10 * 60 * 1000,
			},
			gatewayServiceIntervalMs: 10_000,
			staleAfterMs: 30_000,
		});
	});

	test('loads controller health overrides', () => {
		const config = createValidSystemConfigInput();
		config.controller = {
			health: {
				enabled: false,
				eventHistoryLimit: 25,
				gatewayControlLinkBackoffCeilingMs: 90_000,
				gatewayControlLinkIntervalMs: 15_000,
				gatewayServiceAutoRestart: {
					channelProviderHealth: {
						consecutiveFailureThreshold: 2,
						enabled: true,
						restartGatewayOnRecoverable: false,
						restartGatewayOnUnrecoverable: true,
						transitioningTimeoutMs: 180_000,
					},
					cooldownMs: 7_200_000,
					consecutiveFailureThreshold: 8,
					enabled: false,
					failedRecoveryResetMs: 43_200_000,
					maxConsecutiveFailedRecoveries: 5,
					restartTimeoutMs: 480_000,
				},
				gatewayServiceIntervalMs: 20_000,
				staleAfterMs: 45_000,
			},
		};

		const loadedConfig = parseSystemConfigInputForTest(config);

		expect(resolveControllerHealthConfig(loadedConfig)).toEqual({
			enabled: false,
			eventHistoryLimit: 25,
			gatewayControlLinkBackoffCeilingMs: 90_000,
			gatewayControlLinkIntervalMs: 15_000,
			gatewayServiceAutoRestart: {
				channelProviderHealth: {
					consecutiveFailureThreshold: 2,
					enabled: true,
					restartGatewayOnRecoverable: false,
					restartGatewayOnUnrecoverable: true,
					transitioningTimeoutMs: 180_000,
				},
				cooldownMs: 7_200_000,
				consecutiveFailureThreshold: 8,
				enabled: false,
				failedRecoveryResetMs: 43_200_000,
				maxConsecutiveFailedRecoveries: 5,
				restartTimeoutMs: 480_000,
			},
			gatewayServiceIntervalMs: 20_000,
			staleAfterMs: 45_000,
		});
	});

	test('rejects non-positive controller health settings', () => {
		const config = createValidSystemConfigInput();
		config.controller = {
			health: {
				gatewayServiceIntervalMs: 0,
			},
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/gatewayServiceIntervalMs/u);
	});

	test('rejects non-positive gateway service auto restart settings', () => {
		const config = createValidSystemConfigInput();
		config.controller = {
			health: {
				gatewayServiceAutoRestart: {
					cooldownMs: 0,
					consecutiveFailureThreshold: 10,
					enabled: true,
					failedRecoveryResetMs: 24 * 60 * 60 * 1000,
					maxConsecutiveFailedRecoveries: 3,
					restartTimeoutMs: 10 * 60 * 1000,
				},
			},
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/cooldownMs/u);
	});

	test('rejects controller health backoff ceilings below the base interval', () => {
		const config = createValidSystemConfigInput();
		config.controller = {
			health: {
				gatewayControlLinkBackoffCeilingMs: 9_999,
				gatewayControlLinkIntervalMs: 10_000,
			},
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(
			/gatewayControlLinkBackoffCeilingMs/u,
		);
	});

	test('rejects unknown gateway ingress timeout keys', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].gateway.ingress = {
			idleTimeoutMs: 30_000,
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-ingress-unknown-key-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/Unrecognized key.*idleTimeoutMs/u);
	});

	test('rejects non-positive gateway ingress timeout settings', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].gateway.ingress = {
			upstreamResponseTimeoutMs: 0,
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-ingress-non-positive-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/upstreamResponseTimeoutMs/u);
	});

	test('loads managed base image profiles', async () => {
		const config = createValidSystemConfigInput();
		config.imageProfiles = {
			gateways: {
				openclaw: {
					type: 'openclaw',
					buildConfig: '../vm-images/gateways/openclaw/build-config.jsonc',
					source: {
						kind: 'managedBase',
						base: 'openclaw-gateway',
						overlay: '../vm-images/gateways/openclaw/overlay.jsonc',
					},
				},
			},
			toolVms: {
				default: {
					type: 'toolVm',
					buildConfig: '../vm-images/tool-vms/default/build-config.jsonc',
					source: {
						kind: 'managedBase',
						base: 'tool-vm',
						overlay: '../vm-images/tool-vms/default/overlay.jsonc',
					},
				},
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-managed-base-',
			config,
		);

		const loadedConfig = await loadSystemConfig(configPath);

		expect(loadedConfig.imageProfiles.gateways.openclaw?.source).toMatchObject({
			kind: 'managedBase',
			base: 'openclaw-gateway',
		});
		expect(loadedConfig.imageProfiles.gateways.openclaw?.source?.overlay).toContain(
			path.join('vm-images', 'gateways', 'openclaw', 'overlay.jsonc'),
		);
		expect(loadedConfig.imageProfiles.toolVms.default?.source).toMatchObject({
			kind: 'managedBase',
			base: 'tool-vm',
		});
		expect(loadedConfig.imageProfiles.toolVms.default?.source?.overlay).toContain(
			path.join('vm-images', 'tool-vms', 'default', 'overlay.jsonc'),
		);
	});

	test('rejects implicit always-on gateway SSH secret environments', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].gateway.ssh = { secretEnv: 'always' };
		const configPath = await writeSystemConfigForTest('agent-vm-system-ssh-secret-env-', config);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/secretEnv/u);
	});

	test('rejects a managed base that does not match the image profile family', async () => {
		const config = createValidSystemConfigInput();
		config.imageProfiles = {
			gateways: {
				openclaw: {
					type: 'openclaw',
					buildConfig: '../vm-images/gateways/openclaw/build-config.jsonc',
					source: {
						kind: 'managedBase',
						base: 'tool-vm',
					},
				},
			},
			toolVms: {
				default: {
					type: 'toolVm',
					buildConfig: '../vm-images/tool-vms/default/build-config.jsonc',
					source: {
						kind: 'managedBase',
						base: 'tool-vm',
					},
				},
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-managed-base-mismatch-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(
			"Gateway image profile 'openclaw' type 'openclaw' must use managed base 'openclaw-gateway'.",
		);
	});

	test('falls back to sibling system.jsonc when default system.json is absent', async () => {
		const workingDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-system-config-'));
		createdDirectories.push(workingDirectoryPath);
		const requestedConfigPath = path.join(workingDirectoryPath, 'config', 'system.json');
		const jsoncConfigPath = path.join(workingDirectoryPath, 'config', 'system.jsonc');
		await mkdir(path.dirname(jsoncConfigPath), { recursive: true });
		await writeFile(jsoncConfigPath, JSON.stringify(createValidSystemConfigInput()), 'utf8');

		const loadedConfig = await loadSystemConfig(requestedConfigPath);

		expect(loadedConfig.systemConfigPath).toBe(jsoncConfigPath);
		expect(loadedConfig.zones[0]?.id).toBe('shravan');
	});

	test('loads the OpenClaw guide system.jsonc example when embedded in a full config', async () => {
		const guideText = await readFile('docs/getting-started/openclaw-guide.md', 'utf8');
		const guideConfig: unknown = JSON.parse(extractFirstJsonCodeBlock(guideText));
		if (!isRecord(guideConfig)) {
			throw new Error('Expected OpenClaw guide config example to be a JSON object.');
		}
		const configPath = await writeSystemConfigForTest('agent-vm-openclaw-guide-config-', {
			...createValidSystemConfigInput(),
			...guideConfig,
		});

		const loadedConfig = await loadSystemConfig(configPath);

		const loadedZone = loadedConfig.zones[0];
		expect(loadedZone?.gateway.type).toBe('openclaw');
		if (loadedZone?.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw guide example to load an OpenClaw zone.');
		}
		expect(loadedZone.gateway.authProfilesByAgent).toEqual({
			shravan: {
				source: 'environment',
				envVar: 'SHRAVAN_AUTH_PROFILES',
			},
		});
		expect(loadedZone.defaultToolVmProfile).toBe('standard');
	});

	test('loads OpenClaw zone agent records and MCP config directory references', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].agents = [{ id: 'shravan', toolVmProfile: 'standard' }, { id: 'sun' }];
		config.zones[0].mcpPortal = { configDir: './shravan' };
		const configPath = await writeSystemConfigForTest('agent-vm-system-zone-agents-', config);

		const loadedConfig = await loadSystemConfig(configPath);
		const loadedZone = loadedConfig.zones.at(0);
		if (loadedZone === undefined) {
			throw new Error('Expected first loaded zone.');
		}

		expect(loadedZone.agents).toEqual([
			{ id: 'shravan', toolVmProfile: 'standard' },
			{ id: 'sun' },
		]);
		expect(loadedZone.mcpPortal).toEqual({
			configDir: path.join(path.dirname(configPath), 'shravan'),
		});
	});

	test('rejects legacy OpenClaw zone mcp config keys', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].mcp = { configDir: './shravan' };
		const configPath = await writeSystemConfigForTest('agent-vm-system-legacy-zone-mcp-', config);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/Unrecognized key.*mcp/u);
	});

	test('rejects duplicate OpenClaw zone agent records', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].agents = [{ id: 'shravan' }, { id: 'shravan' }];
		const configPath = await writeSystemConfigForTest('agent-vm-system-duplicate-agents-', config);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/duplicate agent id 'shravan'/u);
	});

	test('rejects worker zones declaring agents or MCP Portal references', async () => {
		const config = createValidSystemConfigInput();
		const {
			controlAuth: _controlAuth,
			zoneFilesDir: _zoneFilesDir,
			...workerGateway
		} = config.zones[0].gateway;
		config.zones[0] = {
			...config.zones[0],
			agents: [{ id: 'worker-agent' }],
			gateway: {
				...workerGateway,
				type: 'worker',
				imageProfile: 'worker',
			},
			mcpPortal: { configDir: './worker' },
		};
		delete config.zones[0].defaultToolVmProfile;
		delete config.zones[0].agentToolVmProfiles;
		const configPath = await writeSystemConfigForTest('agent-vm-system-worker-agents-', config);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(
			/must not declare agents or mcpPortal/u,
		);
	});

	test('loads a valid plan-1 controller config', async () => {
		const workingDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-system-config-'));
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'config', 'system.json');
		await mkdir(path.dirname(configPath), { recursive: true });

		await writeFile(
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
						tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
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
								injection: 'http-mediation',
								audience: 'gateway',
								hosts: ['api.anthropic.com'],
							},
						},
						egressHosts: ['api.anthropic.com', 'api.openai.com'].map((host) => ({
							host,
							audience: 'gateway' as const,
						})),
					},
				],
				toolVmProfiles: {
					standard: {
						memory: '1G',
						cpus: 1,
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

	test('adds only the runtime system config path', async () => {
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-cache-id-',
			createValidSystemConfigInput(),
		);

		const config = await loadSystemConfig(configPath);

		expect(config.systemConfigPath).toBe(configPath);
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
			egressHosts: existingZone.egressHosts ?? [],
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

	test('loads OpenClaw zone Git config', async () => {
		const input = createValidSystemConfigInput();
		input.host.githubToken = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
		};
		input.zones[0].gateway.zoneGit = {
			remote: {
				repoUrl: 'ShravanSunder/sunfam-zone-files',
				branch: 'main',
			},
		};
		const configPath = await writeSystemConfigForTest('agent-vm-system-zone-git-', input);

		const config = await loadSystemConfig(configPath);
		const zone = config.zones[0];
		if (zone?.gateway.type !== 'openclaw') {
			throw new Error('Expected fixture zone to be OpenClaw.');
		}

		expect(zone.gateway.zoneGit).toEqual({
			remote: {
				repoUrl: 'ShravanSunder/sunfam-zone-files',
				branch: 'main',
			},
		});
	});

	test('defaults OpenClaw zone Git branch to main', async () => {
		const input = createValidSystemConfigInput();
		input.zones[0].gateway.zoneGit = {
			remote: {
				repoUrl: 'ShravanSunder/sunfam-zone-files',
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-zone-git-default-branch-',
			input,
		);

		const config = await loadSystemConfig(configPath);
		const zone = config.zones[0];
		if (zone?.gateway.type !== 'openclaw') {
			throw new Error('Expected fixture zone to be OpenClaw.');
		}

		expect(zone.gateway.zoneGit?.remote.branch).toBe('main');
	});

	test('loads config-backed zone secrets', async () => {
		const input = createValidSystemConfigInput();
		configureFirstZoneAsWorker(input);
		input.zones[0].secrets = {
			GITHUB_TOKEN: {
				source: 'config',
				value: 'gh-inline-token',
				injection: 'http-mediation',
				audience: 'gateway',
				hosts: ['api.github.com'],
			},
		};
		input.zones[0].egressHosts = [{ host: 'api.github.com', audience: 'gateway' }];
		const configPath = await writeSystemConfigForTest('agent-vm-system-config-secret-', input);

		const config = await loadSystemConfig(configPath);

		expect(config.zones[0]?.secrets.GITHUB_TOKEN).toEqual({
			source: 'config',
			value: 'gh-inline-token',
			injection: 'http-mediation',
			audience: 'gateway',
			hosts: ['api.github.com'],
		});
	});

	test('rejects config-backed zone secrets without a value', async () => {
		const input = createValidSystemConfigInput();
		configureFirstZoneAsWorker(input);
		input.zones[0].secrets = {
			GITHUB_TOKEN: {
				source: 'config',
				injection: 'http-mediation',
				audience: 'gateway',
				hosts: ['api.github.com'],
			},
		};
		input.zones[0].egressHosts = [{ host: 'api.github.com', audience: 'gateway' }];
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-secret-missing-value-',
			input,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/value/u);
	});

	test('rejects config-backed zone secrets with an empty value', async () => {
		const input = createValidSystemConfigInput();
		configureFirstZoneAsWorker(input);
		input.zones[0].secrets = {
			GITHUB_TOKEN: {
				source: 'config',
				value: '',
				injection: 'http-mediation',
				audience: 'gateway',
				hosts: ['api.github.com'],
			},
		};
		input.zones[0].egressHosts = [{ host: 'api.github.com', audience: 'gateway' }];
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-secret-empty-value-',
			input,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/value/u);
	});

	test('rejects unsafe OpenClaw zone Git branch names', async () => {
		const input = createValidSystemConfigInput();
		input.zones[0].gateway.zoneGit = {
			remote: {
				repoUrl: 'ShravanSunder/sunfam-zone-files',
				branch: 'main:refs/heads/pwn',
			},
		};

		expect(() => parseSystemConfigInputForTest(input)).toThrow(/git branch must/u);
	});

	test('rejects worker gateway configs with zoneGit', async () => {
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
				zoneGit: {
					remote: {
						repoUrl: 'ShravanSunder/sunfam-zone-files',
						branch: 'main',
					},
				},
			},
		};

		expect(() => parseSystemConfigInputForTest(input)).toThrow(/zoneGit/u);
	});

	test('rejects gateway configs without an explicit gateway type', async () => {
		const input = createValidSystemConfigInput();
		const { type: _type, ...gatewayWithoutType } = input.zones[0].gateway;
		input.zones[0] = {
			...input.zones[0],
			gateway: gatewayWithoutType,
		};

		expect(() => parseSystemConfigInputForTest(input)).toThrow(/type/u);
	});

	test('rejects legacy gateway workspaceDir', async () => {
		const input = createValidSystemConfigInput();
		input.zones[0] = {
			...input.zones[0],
			gateway: {
				type: 'openclaw',
				controlAuth: {
					mode: 'token',
					secret: 'OPENCLAW_GATEWAY_TOKEN',
				},
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

	test('rejects legacy tool VM profile workspaceRoot', async () => {
		const input = createValidSystemConfigInput();
		input.toolVmProfiles = {
			standard: {
				memory: '1G',
				cpus: 1,
				imageProfile: 'default',
				workspaceRoot: '../workspaces/tools',
			},
		};

		expect(() => parseSystemConfigInputForTest(input)).toThrow(/workspaceRoot/u);
	});

	test('accepts zones without an explicit backupDir (legacy fallback applies elsewhere)', async () => {
		const config = parseSystemConfigInputForTest(createValidSystemConfigInput());

		expect(config.zones[0]?.gateway.backupDir).toBeUndefined();
	});

	test('omits zone resource policy when not present', async () => {
		const config = parseSystemConfigInputForTest(createValidSystemConfigInput());

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

		const loadedConfig = parseSystemConfigInputForTest(config);

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

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/allowedKinds/u);
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
		const workingDirectoryPath = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-system-config-invalid-'),
		);
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'config', 'system.json');
		await mkdir(path.dirname(configPath), { recursive: true });

		await writeFile(
			configPath,
			JSON.stringify({
				host: {
					controllerPort: 18800,
					projectNamespace: 'claw-tests-a1b2c3d4',
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
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
				toolVmProfiles: {
					standard: {
						memory: '1G',
						cpus: 1,
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
		const workingDirectoryPath = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-system-config-missing-ref-'),
		);
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'config', 'system.json');
		await mkdir(path.dirname(configPath), { recursive: true });

		await writeFile(
			configPath,
			JSON.stringify({
				host: {
					controllerPort: 18800,
					projectNamespace: 'claw-tests-a1b2c3d4',
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
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
							controlAuth: {
								mode: 'token',
								secret: 'OPENCLAW_GATEWAY_TOKEN',
							},
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
						egressHosts: ['discord.com'].map((host) => ({ host, audience: 'gateway' as const })),
						defaultToolVmProfile: 'standard',
						agentToolVmProfiles: {},
					},
				],
				toolVmProfiles: {
					standard: {
						memory: '1G',
						cpus: 1,
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
		const workingDirectoryPath = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-system-config-invalid-namespace-'),
		);
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'config', 'system.json');
		await mkdir(path.dirname(configPath), { recursive: true });

		await writeFile(
			configPath,
			JSON.stringify({
				host: {
					controllerPort: 18800,
					projectNamespace: 'bad:namespace',
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
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
							controlAuth: {
								mode: 'token',
								secret: 'OPENCLAW_GATEWAY_TOKEN',
							},
							imageProfile: 'openclaw',
							memory: '2G',
							cpus: 2,
							port: 18791,
							config: './shravan/openclaw.json',
							stateDir: '../state/shravan',
							zoneFilesDir: '../zone-files/shravan',
						},
						secrets: {
							OPENCLAW_GATEWAY_TOKEN: {
								source: 'environment',
								envVar: 'OPENCLAW_GATEWAY_TOKEN',
								injection: 'env',
								audience: 'gateway',
							},
						},
						egressHosts: ['discord.com'].map((host) => ({ host, audience: 'gateway' as const })),
						defaultToolVmProfile: 'standard',
						agentToolVmProfiles: {},
					},
				],
				toolVmProfiles: {
					standard: {
						memory: '1G',
						cpus: 1,
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
		const zone = configureFirstZoneAsWorker(config);
		zone.egressHosts = [
			{ host: 'api.github.com', audience: 'gateway' },
			{ host: 'api.linear.app', audience: 'both' },
		];
		zone.secrets = {
			GITHUB_TOKEN: {
				source: 'environment',
				envVar: 'GITHUB_TOKEN',
				injection: 'http-mediation',
				audience: 'gateway',
				hosts: ['api.github.com'],
			},
			LINEAR_API_KEY: {
				source: 'environment',
				envVar: 'LINEAR_API_KEY',
				injection: 'http-mediation',
				audience: 'both',
				hosts: ['api.linear.app'],
			},
		};
		zone.runtimeAuthHints = [
			{
				kind: 'service-token',
				secret: 'GITHUB_TOKEN',
				service: 'github',
				hosts: ['api.github.com'],
				tools: ['gh'],
			},
			{
				kind: 'service-token',
				secret: 'LINEAR_API_KEY',
				service: 'linear',
				hosts: ['api.linear.app'],
				tools: ['linear'],
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
						{
							kind: 'service-token',
							secret: 'LINEAR_API_KEY',
							service: 'linear',
							hosts: ['api.linear.app'],
							tools: ['linear'],
						},
					],
				},
			],
		});
	});

	test('loads explicit egress host and secret audiences', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		delete zone.allowedHosts;
		zone.egressHosts = [
			{ host: 'api.github.com', audience: 'both' },
			{ host: 'api.linear.app', audience: 'tool-vm' },
			{ host: 'discord.com', audience: 'gateway' },
		];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'both',
			hosts: ['api.github.com'],
		};

		expect(parseSystemConfigInputForTest(config)).toMatchObject({
			zones: [
				{
					egressHosts: [
						{ host: 'api.github.com', audience: 'both' },
						{ host: 'api.linear.app', audience: 'tool-vm' },
						{ host: 'discord.com', audience: 'gateway' },
					],
					secrets: {
						GITHUB_TOKEN: {
							audience: 'both',
							hosts: ['api.github.com'],
							injection: 'http-mediation',
						},
					},
				},
			],
		});
	});

	test('allows mediated secret hosts covered by egress host wildcard patterns', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.egressHosts = [
			{ host: '*.github.com', audience: 'both' },
			{ host: 'discord.com', audience: 'gateway' },
		];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'both',
			hosts: ['api.github.com'],
		};
		const configPath = await writeSystemConfigForTest('agent-vm-system-egress-wildcard-', config);

		await expect(loadSystemConfig(configPath)).resolves.toMatchObject({
			zones: [
				expect.objectContaining({
					egressHosts: expect.arrayContaining([{ host: '*.github.com', audience: 'both' }]),
					secrets: expect.objectContaining({
						GITHUB_TOKEN: expect.objectContaining({
							hosts: ['api.github.com'],
						}),
					}),
				}),
			],
		});
	});

	test('does not treat subdomain wildcards as suffix contains checks', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.egressHosts = [
			{ host: '*.github.com', audience: 'gateway' },
			{ host: 'discord.com', audience: 'gateway' },
		];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'gateway',
			hosts: ['evilgithub.com'],
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-egress-wildcard-no-suffix-contains-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/egressHosts/u);
	});

	test('rejects legacy allowedHosts without explicit egress host audiences', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		delete zone.egressHosts;
		zone.allowedHosts = ['discord.com'];
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-legacy-allowed-hosts-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/egressHosts/u);
	});

	test('rejects egress host entries without audience', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.egressHosts = [
			{ host: 'api.github.com' } as unknown as { host: string; audience: string },
		];

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/audience/u);
	});

	test('rejects zone secrets without audience', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			hosts: ['api.github.com'],
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/audience/u);
	});

	test('rejects zone secret names that collide with JavaScript prototype properties', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		Object.defineProperty(zone.secrets, 'constructor', {
			configurable: true,
			enumerable: true,
			value: {
				source: 'environment',
				envVar: 'POLLUTED_SECRET',
				injection: 'env',
				audience: 'gateway',
			},
		});
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-secret-prototype-name-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/prototype property names/u);
	});

	test('rejects http-mediated secrets without hosts', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'gateway',
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-secret-mediation-hosts-missing-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/hosts/u);
	});

	test('rejects http-mediated secrets with empty hosts', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'gateway',
			hosts: [],
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-secret-mediation-hosts-empty-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toMatchObject({
			issues: expect.arrayContaining([
				expect.objectContaining({
					path: ['zones', 0, 'secrets', 'GITHUB_TOKEN', 'hosts'],
				}),
			]),
		});
	});

	test('rejects env secrets outside the gateway audience', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.secrets.DISCORD_BOT_TOKEN = {
			source: 'environment',
			envVar: 'DISCORD_BOT_TOKEN',
			injection: 'env',
			audience: 'tool-vm',
		};
		const configPath = await writeSystemConfigForTest('agent-vm-system-env-tool-vm-', config);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/gateway/u);
	});

	test('rejects env secrets shared with both audiences', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.secrets.DISCORD_BOT_TOKEN = {
			source: 'environment',
			envVar: 'DISCORD_BOT_TOKEN',
			injection: 'env',
			audience: 'both',
		};
		const configPath = await writeSystemConfigForTest('agent-vm-system-env-both-', config);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/audience/u);
	});

	test('rejects env secrets that declare hosts', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.secrets.DISCORD_BOT_TOKEN = {
			source: 'environment',
			envVar: 'DISCORD_BOT_TOKEN',
			injection: 'env',
			audience: 'gateway',
			hosts: ['discord.com'],
		};
		const configPath = await writeSystemConfigForTest('agent-vm-system-env-hosts-', config);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/hosts/u);
	});

	test('rejects OpenClaw env secrets not listed in rawEnvSecrets', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.secrets.DISCORD_BOT_TOKEN = {
			source: 'environment',
			envVar: 'DISCORD_BOT_TOKEN',
			injection: 'env',
			audience: 'gateway',
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-openclaw-unlisted-env-secret-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/rawEnvSecrets/u);
	});

	test('allows OpenClaw env secrets explicitly listed in rawEnvSecrets', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.gateway.rawEnvSecrets = ['DISCORD_BOT_TOKEN'];
		zone.secrets.DISCORD_BOT_TOKEN = {
			source: 'environment',
			envVar: 'DISCORD_BOT_TOKEN',
			injection: 'env',
			audience: 'gateway',
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-openclaw-listed-env-secret-',
			config,
		);

		await expect(loadSystemConfig(configPath)).resolves.toMatchObject({
			zones: [
				{
					gateway: {
						rawEnvSecrets: ['DISCORD_BOT_TOKEN'],
					},
				},
			],
		});
	});

	test('rejects secret names that cannot be exported safely', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.secrets['BAD-NAME'] = {
			source: 'environment',
			envVar: 'BAD_NAME',
			injection: 'env',
			audience: 'gateway',
		};
		const configPath = await writeSystemConfigForTest('agent-vm-system-secret-name-', config);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/environment variable names/u);
	});

	test('allows environment-sourced Tool VM secrets only through http mediation', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.egressHosts = [
			...(zone.egressHosts ?? []),
			{ host: 'api.linear.app', audience: 'tool-vm' },
		];
		zone.secrets.LINEAR_API_KEY = {
			source: 'environment',
			envVar: 'LINEAR_API_KEY',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.linear.app'],
		};

		expect(parseSystemConfigInputForTest(config)).toMatchObject({
			zones: [
				expect.objectContaining({
					secrets: expect.objectContaining({
						LINEAR_API_KEY: expect.objectContaining({
							source: 'environment',
							injection: 'http-mediation',
							audience: 'tool-vm',
						}),
					}),
				}),
			],
		});
	});

	test('rejects mediated secret hosts that are not declared for the same audience', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.egressHosts = [{ host: 'api.linear.app', audience: 'gateway' }];
		zone.secrets.LINEAR_API_KEY = {
			source: 'environment',
			envVar: 'LINEAR_API_KEY',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.linear.app'],
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-mediated-egress-audience-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/egressHosts/u);
	});

	test('rejects shared mediated secret hosts that are not declared for both audiences', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.egressHosts = [{ host: 'api.github.com', audience: 'gateway' }];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'both',
			hosts: ['api.github.com'],
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/egressHosts/u);
	});

	test('rejects legacy OpenClaw controller auth configuration', async () => {
		const config = createValidSystemConfigInput();
		Object.assign(config.zones[0].gateway, {
			controllerAuth: { secret: 'OPENCLAW_GATEWAY_TOKEN' },
		});

		expect(() => parseSystemConfigInputForTest(config)).toThrow(
			/Unrecognized key.*controllerAuth/u,
		);
	});

	test('loads OpenClaw control auth from a configured zone secret pointer', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].gateway.controlAuth = {
			mode: 'token',
			secret: 'CUSTOM_GATEWAY_TOKEN',
		};
		delete config.zones[0].secrets.OPENCLAW_GATEWAY_TOKEN;
		config.zones[0].secrets.CUSTOM_GATEWAY_TOKEN = {
			source: 'environment',
			envVar: 'CUSTOM_GATEWAY_TOKEN',
			injection: 'env',
			audience: 'gateway',
		};

		expect(parseSystemConfigInputForTest(config)).toMatchObject({
			zones: [
				{
					gateway: {
						controlAuth: {
							mode: 'token',
							secret: 'CUSTOM_GATEWAY_TOKEN',
						},
					},
				},
			],
		});
	});

	test('rejects OpenClaw zones without a control auth pointer', async () => {
		const config = createValidSystemConfigInput();
		delete config.zones[0].gateway.controlAuth;

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/controlAuth/u);
	});

	test('rejects OpenClaw zones without the configured control auth secret', async () => {
		const config = createValidSystemConfigInput();
		delete config.zones[0].secrets.OPENCLAW_GATEWAY_TOKEN;

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/OPENCLAW_GATEWAY_TOKEN/u);
	});

	test('rejects OpenClaw gateway token outside gateway env injection', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].secrets.OPENCLAW_GATEWAY_TOKEN = {
			source: 'environment',
			envVar: 'OPENCLAW_GATEWAY_TOKEN',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['openclaw.local'],
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/OPENCLAW_GATEWAY_TOKEN/u);
	});

	test('rejects OpenClaw gateway token with shared audience', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].secrets.OPENCLAW_GATEWAY_TOKEN = {
			source: 'environment',
			envVar: 'OPENCLAW_GATEWAY_TOKEN',
			injection: 'http-mediation',
			audience: 'both',
			hosts: ['openclaw.local'],
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/OPENCLAW_GATEWAY_TOKEN/u);
	});

	test('rejects runtime auth hints on OpenClaw zones', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.egressHosts = [
			...(zone.egressHosts ?? []),
			{ host: 'api.github.com', audience: 'gateway' },
		];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'gateway',
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
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-runtime-auth-gateway-secret-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/worker gateway runtime/u);
	});

	test('rejects empty runtime auth hints on OpenClaw zones', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.runtimeAuthHints = [];
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-runtime-auth-openclaw-empty-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/worker gateway runtime/u);
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
		const zone = configureFirstZoneAsWorker(config);
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
		const zone = configureFirstZoneAsWorker(config);
		zone.egressHosts = [{ host: 'registry.npmjs.org', audience: 'gateway' }];
		zone.secrets.NPM_AUTH_TOKEN = {
			source: 'environment',
			envVar: 'NPM_AUTH_TOKEN',
			injection: 'http-mediation',
			audience: 'gateway',
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
		const zone = configureFirstZoneAsWorker(config);
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'env',
			audience: 'gateway',
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

	test('rejects worker runtime auth hints that reference Tool VM-only secrets', async () => {
		const config = createValidSystemConfigInput();
		const zone = configureFirstZoneAsWorker(config);
		zone.egressHosts = [{ host: 'api.linear.app', audience: 'tool-vm' }];
		zone.secrets.LINEAR_API_KEY = {
			source: 'environment',
			envVar: 'LINEAR_API_KEY',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.linear.app'],
		};
		zone.runtimeAuthHints = [
			{
				kind: 'service-token',
				secret: 'LINEAR_API_KEY',
				service: 'linear',
				hosts: ['api.linear.app'],
				tools: ['linear'],
			},
		];
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-runtime-auth-tool-vm-secret-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toMatchObject({
			issues: expect.arrayContaining([
				expect.objectContaining({
					path: ['zones', 0, 'runtimeAuthHints', 0, 'secret'],
				}),
			]),
		});
	});

	test('rejects zones that reference unknown tool VM profiles', async () => {
		const workingDirectoryPath = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-system-config-missing-tool-vm-profile-'),
		);
		createdDirectories.push(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'config', 'system.json');
		await mkdir(path.dirname(configPath), { recursive: true });

		await writeFile(
			configPath,
			JSON.stringify({
				host: {
					controllerPort: 18800,
					projectNamespace: 'claw-tests-a1b2c3d4',
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
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
							controlAuth: {
								mode: 'token',
								secret: 'OPENCLAW_GATEWAY_TOKEN',
							},
							imageProfile: 'openclaw',
							memory: '2G',
							cpus: 2,
							port: 18791,
							config: './shravan/openclaw.json',
							stateDir: '../state/shravan',
							zoneFilesDir: '../zone-files/shravan',
						},
						secrets: {
							OPENCLAW_GATEWAY_TOKEN: {
								source: 'environment',
								envVar: 'OPENCLAW_GATEWAY_TOKEN',
								injection: 'env',
								audience: 'gateway',
							},
						},
						egressHosts: ['discord.com'].map((host) => ({ host, audience: 'gateway' as const })),
						defaultToolVmProfile: 'missing-profile',
						agentToolVmProfiles: {},
					},
				],
				toolVmProfiles: {
					standard: {
						memory: '1G',
						cpus: 1,
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

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/unknown defaultToolVmProfile/u);
	});

	test('requires OpenClaw zones to declare agentToolVmProfiles explicitly', async () => {
		const config = createValidSystemConfigInput();
		delete config.zones[0].agentToolVmProfiles;

		expect(() => parseSystemConfigInputForTest(config)).toThrow(
			/must declare agentToolVmProfiles/u,
		);
	});

	test('rejects legacy tool VM profile field names', async () => {
		const config = createValidSystemConfigInput();
		const legacyConfig = {
			...config,
			toolProfiles: config.toolVmProfiles,
			zones: [
				{
					...config.zones[0],
					toolProfile: config.zones[0].defaultToolVmProfile,
					agentToolProfiles: { shravan: 'standard' },
				},
			],
		};
		delete (legacyConfig as { toolVmProfiles?: unknown }).toolVmProfiles;
		delete (legacyConfig.zones[0] as { defaultToolVmProfile?: unknown }).defaultToolVmProfile;
		delete (legacyConfig.zones[0] as { agentToolVmProfiles?: unknown }).agentToolVmProfiles;

		expect(() =>
			parseSystemConfigInputForTest(legacyConfig as unknown as ValidSystemConfigInput),
		).toThrow(/Unrecognized key/u);
	});

	test('loads the single lease idle TTL policy', async () => {
		const config = createValidSystemConfigInput();
		config.leaseIdleTtl = {
			defaultMs: 30 * 60 * 1000,
			maxRequestedMs: 2 * 60 * 60 * 1000,
			minRequestedMs: 5_000,
		};

		expect(parseSystemConfigInputForTest(config)).toMatchObject({
			leaseIdleTtl: {
				defaultMs: 1_800_000,
				maxRequestedMs: 7_200_000,
				minRequestedMs: 5_000,
			},
		});
	});

	test('defaults partial lease idle TTL policy to 100 minutes', async () => {
		const config = createValidSystemConfigInput();
		config.leaseIdleTtl = {};

		expect(parseSystemConfigInputForTest(config)).toMatchObject({
			leaseIdleTtl: {
				defaultMs: 6_000_000,
				maxRequestedMs: 86_400_000,
				minRequestedMs: 1_000,
			},
		});
	});

	test('rejects non-positive lease idle TTL values', async () => {
		const config = createValidSystemConfigInput();
		config.leaseIdleTtl = { defaultMs: 0 };

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/leaseIdleTtl/u);
	});

	test('rejects legacy scope-specific lease idle TTL policy fields', async () => {
		const config = createValidSystemConfigInput();
		config.leaseIdleTtl = {
			byScopeKind: {
				agent: 5 * 60 * 1000,
			},
			byScopePrefix: {
				'agent:shravan': 10 * 60 * 1000,
			},
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/leaseIdleTtl/u);
	});

	test('loads per-agent auth profiles and sandbox seed configuration for OpenClaw zones', async () => {
		const config = createValidSystemConfigInput();
		if (config.zones[0].gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw fixture zone');
		}
		config.zones[0].gateway.authProfilesByAgent = {
			shravan: {
				source: 'environment',
				envVar: 'SHRAVAN_AUTH_PROFILES',
			},
		};
		config.zones[0].agentSandboxSeeds = {
			shravan: [
				{
					source: { source: 'environment', envVar: 'SHRAVAN_GCLOUD_CONFIG' },
					target: '.config/gcloud/configurations/config_default',
					mode: 0o600,
				},
			],
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-agent-auth-and-seeds-',
			config,
		);

		await expect(loadSystemConfig(configPath)).resolves.toMatchObject({
			zones: [
				{
					gateway: {
						authProfilesByAgent: {
							shravan: {
								source: 'environment',
								envVar: 'SHRAVAN_AUTH_PROFILES',
							},
						},
					},
					agentSandboxSeeds: {
						shravan: [
							{
								target: '.config/gcloud/configurations/config_default',
								mode: 0o600,
							},
						],
					},
				},
			],
		});
	});

	test('rejects path-unsafe agent identifiers in per-agent maps', async () => {
		const config = createValidSystemConfigInput();
		if (config.zones[0].gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw fixture zone');
		}
		config.zones[0].gateway.authProfilesByAgent = {
			'../shravan': {
				source: 'environment',
				envVar: 'SHRAVAN_AUTH_PROFILES',
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-path-unsafe-agent-id-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/agent id must/u);
	});

	test('rejects path-unsafe zone identifiers', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0] = {
			...config.zones[0],
			id: '../sunfam',
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-path-unsafe-zone-id-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/zone id must/u);
	});

	test('rejects sandbox seed targets that escape the agent workspace', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].agentSandboxSeeds = {
			shravan: [
				{
					source: { source: '1password', ref: 'op://vault/gcloud-config' },
					target: '../outside',
				},
			],
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-bad-agent-sandbox-seed-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/agent sandbox seed target/u);
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
				egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
			},
		];
		delete config.toolVmProfiles;
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-worker-no-tools-',
			config,
		);

		const systemConfig = await loadSystemConfig(configPath);

		expect(systemConfig).toMatchObject({
			imageProfiles: { toolVms: {} },
			toolVmProfiles: {},
			zones: [
				{
					id: 'worker-zone',
				},
			],
		});
		expect(systemConfig.zones[0]).not.toHaveProperty('defaultToolVmProfile');
	});

	test('does not apply OpenClaw gateway token constraints to worker zones', async () => {
		const config = createValidSystemConfigInput();
		const zone = configureFirstZoneAsWorker(config);
		zone.egressHosts = [{ host: 'api.openai.com', audience: 'gateway' }];
		zone.secrets.OPENCLAW_GATEWAY_TOKEN = {
			source: 'environment',
			envVar: 'OPENCLAW_GATEWAY_TOKEN',
			injection: 'http-mediation',
			audience: 'gateway',
			hosts: ['api.openai.com'],
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-worker-openclaw-token-name-',
			config,
		);

		await expect(loadSystemConfig(configPath)).resolves.toMatchObject({
			zones: [{ id: zone.id }],
		});
	});

	test('rejects openclaw zones without a tool VM profile', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		delete zone.defaultToolVmProfile;
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-openclaw-missing-tool-vm-profile-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(
			/must declare a defaultToolVmProfile/u,
		);
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
			'agent-vm-system-config-empty-tool-vm-profiles-',
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
					controlAuth: {
						mode: 'token',
						secret: 'OPENCLAW_GATEWAY_TOKEN',
					},
					imageProfile: 'missing-openclaw',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: './shravan/openclaw.json',
					stateDir: '../state/shravan',
					zoneFilesDir: '../zone-files/shravan',
				},
				secrets: {
					OPENCLAW_GATEWAY_TOKEN: {
						source: 'environment',
						envVar: 'OPENCLAW_GATEWAY_TOKEN',
						injection: 'env',
						audience: 'gateway',
					},
				},
				egressHosts: ['discord.com'].map((host) => ({ host, audience: 'gateway' as const })),
				defaultToolVmProfile: 'standard',
				agentToolVmProfiles: {},
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
				egressHosts: ['discord.com'].map((host) => ({ host, audience: 'gateway' as const })),
				defaultToolVmProfile: 'standard',
				agentToolVmProfiles: {},
			},
		];
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-profile-type-mismatch-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/does not match imageProfile/u);
	});

	test('rejects tool VM profiles that reference unknown tool VM image profiles', async () => {
		const config = createValidSystemConfigInput();
		config.toolVmProfiles = {
			standard: {
				memory: '1G',
				cpus: 1,
				imageProfile: 'missing-tool-vm',
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-missing-tool-vm-profile-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/unknown tool VM imageProfile/u);
	});

	test('rejects empty tool VM profile ids', async () => {
		const config = createValidSystemConfigInput();
		config.toolVmProfiles = {
			'': {
				memory: '1G',
				cpus: 1,
				imageProfile: 'default',
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-empty-tool-vm-profile-id-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/Too small|Invalid key/u);
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

	test('rejects runtimeDir overlap with cacheDir after resolving paths', async () => {
		const config = createValidSystemConfigInput();
		config.cacheDir = '../cache';
		config.runtimeDir = '../cache/runtime';
		const configPath = await writeSystemConfigForTest('agent-vm-system-overlap-cache-', config);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(
			/runtimeDir must not overlap cacheDir/u,
		);
	});

	test('rejects runtimeDir overlap with zone stateDir after resolving paths', async () => {
		const config = createValidSystemConfigInput();
		config.runtimeDir = '../state/shravan/runtime';
		const configPath = await writeSystemConfigForTest('agent-vm-system-overlap-state-', config);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(
			/runtimeDir must not overlap stateDir/u,
		);
	});

	test('rejects runtimeDir overlap with OpenClaw zoneFilesDir after resolving paths', async () => {
		const config = createValidSystemConfigInput();
		config.runtimeDir = '../zone-files/shravan/runtime';
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-overlap-zone-files-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(
			/runtimeDir must not overlap zoneFilesDir/u,
		);
	});

	test('parses host and OpenClaw zone observability defaults', async () => {
		const config = createValidSystemConfigInput();
		config.host.observability = {
			enabled: true,
			runner: 'docker-compose',
			mode: 'collector',
			dataDir: '../observability',
			retention: {
				metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
				logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
				traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
			},
		};
		config.zones[0].observability = {
			enabled: true,
			openclaw: {
				serviceName: 'agent-vm-openclaw-shravan',
				traces: true,
				metrics: true,
				logs: true,
			},
		};
		const configPath = await writeSystemConfigForTest('agent-vm-system-observability-', config);

		const loadedConfig = await loadSystemConfig(configPath);

		const loadedHostObservability = loadedConfig.host.observability;
		if (
			loadedHostObservability?.enabled !== true ||
			loadedHostObservability.stack.mode !== 'managed' ||
			!('dataDir' in loadedHostObservability)
		) {
			throw new Error('Expected host observability to be enabled.');
		}
		const loadedZone = loadedConfig.zones[0];
		if (loadedZone?.observability?.enabled !== true) {
			throw new Error('Expected zone observability to be enabled.');
		}
		expect(loadedConfig.host.observability).toMatchObject({
			enabled: true,
			stack: { mode: 'managed', scrubbing: { responsibility: 'agent-vm-managed-collector' } },
			runner: 'docker-compose',
			mode: 'collector',
			bindAddress: '127.0.0.1',
			prepareOnBuild: true,
			waitOnBuild: true,
			startupCheckTimeoutMs: 500,
		});
		expect(loadedHostObservability.dataDir).toBe(
			path.join(path.dirname(configPath), '..', 'observability'),
		);
		expect(loadedZone.observability).toMatchObject({
			enabled: true,
			openclaw: {
				serviceName: 'agent-vm-openclaw-shravan',
				traces: true,
				metrics: true,
				logs: true,
				sampleRate: 1,
				flushIntervalMs: 10_000,
				captureContent: { enabled: false },
				diagnosticsFlags: [],
			},
		});
	});

	test('parses external host observability without managed Compose storage fields', async () => {
		const config = createValidSystemConfigInput();
		config.host.observability = {
			enabled: true,
			stack: {
				mode: 'external',
				scrubbing: { responsibility: 'external-collector' },
			},
			mode: 'collector',
		};
		config.zones[0].observability = {
			enabled: true,
			openclaw: {
				serviceName: 'agent-vm-openclaw-shravan',
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-observability-external-',
			config,
		);

		const loadedConfig = await loadSystemConfig(configPath);

		if (loadedConfig.host.observability?.enabled !== true) {
			throw new Error('Expected host observability to be enabled.');
		}
		expect(loadedConfig.host.observability).toMatchObject({
			enabled: true,
			stack: {
				mode: 'external',
				scrubbing: { responsibility: 'external-collector' },
			},
			mode: 'collector',
			bindAddress: '127.0.0.1',
			controllerStartPolicy: 'degraded',
		});
		expect('dataDir' in loadedConfig.host.observability).toBe(false);
		expect('retention' in loadedConfig.host.observability).toBe(false);
	});

	test('rejects external host observability without an explicit scrubber contract', async () => {
		const config = createValidSystemConfigInput();
		config.host.observability = {
			enabled: true,
			stack: { mode: 'external' },
			mode: 'collector',
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-observability-external-missing-scrubbing-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/scrubbing/u);
	});

	test('emits author-facing JSON Schema for managed and external observability variants', () => {
		const artifact = createSystemConfigSchemaArtifact();
		const hostSchema = isRecord(artifact.properties) ? artifact.properties.host : undefined;
		if (!isRecord(hostSchema) || !isRecord(hostSchema.properties)) {
			throw new Error('Expected host schema properties.');
		}
		const observabilitySchema = hostSchema.properties.observability;
		if (!isRecord(observabilitySchema) || !Array.isArray(observabilitySchema.anyOf)) {
			throw new Error('Expected host observability schema variants.');
		}
		const variantSchemas = observabilitySchema.anyOf.filter(isRecord);
		const managedVariant = variantSchemas.find(
			(variant) =>
				isRecord(variant.properties) &&
				isRecord(variant.properties.stack) &&
				JSON.stringify(variant.properties.stack).includes('agent-vm-managed-collector'),
		);
		const externalVariant = variantSchemas.find(
			(variant) =>
				isRecord(variant.properties) &&
				isRecord(variant.properties.stack) &&
				JSON.stringify(variant.properties.stack).includes('external-collector'),
		);

		if (!isRecord(managedVariant) || !isRecord(managedVariant.properties)) {
			throw new Error('Expected managed observability schema variant.');
		}
		if (!isRecord(externalVariant) || !isRecord(externalVariant.properties)) {
			throw new Error('Expected external observability schema variant.');
		}
		expect(managedVariant.required).toEqual(['enabled', 'dataDir', 'retention']);
		expect(managedVariant.properties.stack).toMatchObject({
			default: {
				mode: 'managed',
				scrubbing: { responsibility: 'agent-vm-managed-collector' },
			},
		});
		expect(externalVariant.required).toEqual(['enabled', 'stack']);
		expect(externalVariant.properties).not.toHaveProperty('dataDir');
		expect(externalVariant.properties).not.toHaveProperty('retention');
		expect(externalVariant.properties.stack).toMatchObject({
			properties: {
				scrubbing: {
					properties: {
						responsibility: { const: 'external-collector' },
					},
					required: ['responsibility'],
				},
			},
			required: ['mode', 'scrubbing'],
		});
	});

	test('rejects enabled host observability without dataDir', async () => {
		const config = createValidSystemConfigInput();
		config.host.observability = {
			enabled: true,
			stack: { mode: 'managed', scrubbing: { responsibility: 'agent-vm-managed-collector' } },
			runner: 'docker-compose',
			mode: 'collector',
			retention: {
				metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
				logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
				traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-observability-missing-data-dir-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/dataDir/u);
	});

	test.each(['Bad Name', 'bad:name', 'bad\nname', '-bad-name', 'BadName'])(
		'rejects invalid observability projectName %s',
		async (projectName) => {
			const config = createValidSystemConfigInput();
			config.host.observability = {
				enabled: true,
				stack: { mode: 'managed', scrubbing: { responsibility: 'agent-vm-managed-collector' } },
				runner: 'docker-compose',
				mode: 'collector',
				dataDir: '../observability',
				projectName,
				retention: {
					metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
					logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
					traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
				},
			};
			const configPath = await writeSystemConfigForTest(
				'agent-vm-system-observability-project-name-',
				config,
			);

			await expect(loadSystemConfig(configPath)).rejects.toThrow(/projectName/u);
		},
	);

	test.each([
		['collectorHttp too high', { collectorHttp: 70_000 }, /collectorHttp/u],
		['duplicate logs and traces', { logs: 9428, traces: 9428 }, /ports must be unique/u],
	])('rejects invalid observability ports for %s', async (_label, portPatch, messagePattern) => {
		const config = createValidSystemConfigInput();
		config.host.observability = {
			enabled: true,
			stack: { mode: 'managed', scrubbing: { responsibility: 'agent-vm-managed-collector' } },
			runner: 'docker-compose',
			mode: 'collector',
			dataDir: '../observability',
			ports: {
				collectorGrpc: 4317,
				collectorHttp: 4318,
				collectorHealth: 13_133,
				metrics: 8428,
				logs: 9428,
				traces: 10_428,
				...portPatch,
			},
			retention: {
				metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
				logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
				traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-observability-ports-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(messagePattern);
	});

	test.each(['0.0.0.0', '::', '192.168.1.50'])(
		'rejects non-loopback observability bindAddress %s',
		async (bindAddress) => {
			const config = createValidSystemConfigInput();
			config.host.observability = {
				enabled: true,
				stack: { mode: 'managed', scrubbing: { responsibility: 'agent-vm-managed-collector' } },
				runner: 'docker-compose',
				mode: 'collector',
				dataDir: '../observability',
				bindAddress,
				retention: {
					metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
					logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
					traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
				},
			};
			const configPath = await writeSystemConfigForTest(
				'agent-vm-system-observability-bind-address-',
				config,
			);

			await expect(loadSystemConfig(configPath)).rejects.toThrow(/bindAddress/u);
		},
	);

	test('rejects zone observability when host observability is disabled', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].observability = {
			enabled: true,
			openclaw: {
				serviceName: 'agent-vm-openclaw-shravan',
				traces: true,
				metrics: true,
				logs: true,
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-zone-observability-no-host-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/host.observability/u);
	});

	test('rejects worker zone observability in v1', async () => {
		const config = createValidSystemConfigInput();
		config.host.observability = {
			enabled: true,
			stack: { mode: 'managed', scrubbing: { responsibility: 'agent-vm-managed-collector' } },
			runner: 'docker-compose',
			mode: 'collector',
			dataDir: '../observability',
			retention: {
				metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
				logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
				traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
			},
		};
		const zone = configureFirstZoneAsWorker(config);
		zone.egressHosts = [{ host: 'example.com', audience: 'gateway' }];
		zone.observability = {
			enabled: true,
			openclaw: {
				serviceName: 'agent-vm-worker-shravan',
				traces: true,
				metrics: true,
				logs: true,
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-worker-zone-observability-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/OpenClaw/u);
	});

	test('rejects OpenClaw observability on custom image profiles without managed diagnostics package installation', async () => {
		const config = createValidSystemConfigInput();
		config.host.observability = {
			enabled: true,
			stack: { mode: 'managed', scrubbing: { responsibility: 'agent-vm-managed-collector' } },
			runner: 'docker-compose',
			mode: 'collector',
			dataDir: '../observability',
			retention: {
				metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
				logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
				traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
			},
		};
		const zone = config.zones[0];
		if (zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		config.imageProfiles = {
			gateways: {
				openclaw: {
					type: 'openclaw',
					buildConfig: '../vm-images/gateways/openclaw/custom-build-config.json',
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
		};
		zone.observability = {
			enabled: true,
			openclaw: {
				serviceName: 'agent-vm-openclaw-shravan',
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-observability-custom-openclaw-image-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/diagnostics-otel/u);
	});

	test.each([
		'*',
		'all',
		'payload-dump',
		'request.body',
		'prompt-transcript',
		'token-debug',
		'1',
		'telegram.*',
		'gateway.http.query',
		'query.capture',
		'http.request.header.authorization',
		'OPENCLAW_DIAGNOSTICS=*',
	])('rejects sensitive observability diagnostics flag %s', async (diagnosticsFlag) => {
		const config = createValidSystemConfigInput();
		config.host.observability = {
			enabled: true,
			stack: { mode: 'managed', scrubbing: { responsibility: 'agent-vm-managed-collector' } },
			runner: 'docker-compose',
			mode: 'collector',
			dataDir: '../observability',
			retention: {
				metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
				logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
				traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
			},
		};
		config.zones[0].observability = {
			enabled: true,
			openclaw: {
				serviceName: 'agent-vm-openclaw-shravan',
				diagnosticsFlags: [diagnosticsFlag],
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-observability-sensitive-flags-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(
			/too broad or can capture sensitive content/u,
		);
	});

	test('rejects OPENCLAW_DIAGNOSTICS raw env override for observability zones', async () => {
		const config = createValidSystemConfigInput();
		config.host.observability = {
			enabled: true,
			stack: { mode: 'managed', scrubbing: { responsibility: 'agent-vm-managed-collector' } },
			runner: 'docker-compose',
			mode: 'collector',
			dataDir: '../observability',
			retention: {
				metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
				logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
				traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
			},
		};
		const zone = config.zones[0];
		if (zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		zone.gateway.rawEnvSecrets = ['OPENCLAW_DIAGNOSTICS'];
		zone.secrets.OPENCLAW_DIAGNOSTICS = {
			source: 'environment',
			envVar: 'OPENCLAW_DIAGNOSTICS',
			injection: 'env',
			audience: 'gateway',
		};
		zone.observability = {
			enabled: true,
			openclaw: {
				serviceName: 'agent-vm-openclaw-shravan',
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-observability-raw-diagnostics-env-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/OPENCLAW_DIAGNOSTICS/u);
	});

	test.each([
		['metrics max bytes', { metrics: { period: '30d', maxDiskSpaceUsageBytes: '50GiB' } }],
		['metrics max percent', { metrics: { period: '30d', maxDiskUsagePercent: 80 } }],
		['logs max percent', { logs: { period: '14d', maxDiskUsagePercent: 80 } }],
		[
			'traces max bytes and percent',
			{ traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB', maxDiskUsagePercent: 80 } },
		],
	])('rejects unsupported observability retention field for %s', async (_label, retentionPatch) => {
		const config = createValidSystemConfigInput();
		config.host.observability = {
			enabled: true,
			stack: { mode: 'managed', scrubbing: { responsibility: 'agent-vm-managed-collector' } },
			runner: 'docker-compose',
			mode: 'collector',
			dataDir: '../observability',
			retention: {
				metrics: { period: '30d' },
				logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
				traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
				...retentionPatch,
			},
		};
		config.zones[0].observability = {
			enabled: true,
			openclaw: {
				serviceName: 'agent-vm-openclaw-shravan',
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-observability-retention-unsupported-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow();
	});

	test.each([
		['metrics period', { metrics: { period: 'forever' } }, /retention period/u],
		[
			'metrics min free disk',
			{ metrics: { period: '30d', minFreeDiskSpaceBytes: 'lots' } },
			/retention byte size/u,
		],
		[
			'logs max bytes',
			{ logs: { period: '14d', maxDiskSpaceUsageBytes: '50gib' } },
			/retention byte size/u,
		],
		['traces period', { traces: { period: 'one-week' } }, /retention period/u],
		[
			'traces max bytes',
			{ traces: { period: '7d', maxDiskSpaceUsageBytes: '20 gib' } },
			/retention byte size/u,
		],
	])(
		'rejects invalid observability retention value for %s',
		async (_label, retentionPatch, messagePattern) => {
			const config = createValidSystemConfigInput();
			config.host.observability = {
				enabled: true,
				stack: { mode: 'managed', scrubbing: { responsibility: 'agent-vm-managed-collector' } },
				runner: 'docker-compose',
				mode: 'collector',
				dataDir: '../observability',
				retention: {
					metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
					logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
					traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
					...retentionPatch,
				},
			};
			config.zones[0].observability = {
				enabled: true,
				openclaw: {
					serviceName: 'agent-vm-openclaw-shravan',
				},
			};
			const configPath = await writeSystemConfigForTest(
				'agent-vm-system-observability-retention-invalid-value-',
				config,
			);

			await expect(loadSystemConfig(configPath)).rejects.toThrow(messagePattern);
		},
	);

	test.each([
		['cacheDir', '../cache/observability', /dataDir must not overlap cacheDir/u],
		['runtimeDir', '../runtime/observability', /dataDir must not overlap runtimeDir/u],
		['stateDir', '../state/shravan/observability', /dataDir must not overlap stateDir/u],
		[
			'zoneFilesDir',
			'../zone-files/shravan/observability',
			/dataDir must not overlap zoneFilesDir/u,
		],
	])(
		'rejects observability dataDir overlap with %s after resolving paths',
		async (_fieldName, dataDir, messagePattern) => {
			const config = createValidSystemConfigInput();
			config.host.observability = {
				enabled: true,
				stack: { mode: 'managed', scrubbing: { responsibility: 'agent-vm-managed-collector' } },
				runner: 'docker-compose',
				mode: 'collector',
				dataDir,
				retention: {
					metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
					logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
					traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
				},
			};
			const configPath = await writeSystemConfigForTest(
				'agent-vm-system-observability-data-overlap-',
				config,
			);

			await expect(loadSystemConfig(configPath)).rejects.toThrow(messagePattern);
		},
	);
});
