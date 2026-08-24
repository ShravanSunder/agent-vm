import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
	agents?: readonly {
		readonly id: string;
		readonly toolVmProfile?: string;
		readonly workspaceGit?: unknown;
	}[];
	gateway: Record<string, unknown>;
	mcp?: { readonly configDir: string };
	secrets: Record<string, unknown>;
	runtimeAuthHints?: unknown;
	egressHosts?: readonly { readonly host: string; readonly audience: string }[];
	websocketUpgrades?: readonly Record<string, unknown>[];
	allowedHosts?: unknown;
	defaultToolVmProfile?: string;
	agentToolVmProfiles?: Record<string, string>;
	[key: string]: unknown;
}

interface ValidZoneToolPortalConfigInput {
	readonly configDir: string;
	readonly surfaceEligibilityByProfile: Readonly<
		Record<string, Readonly<Record<string, readonly ('mcp' | 'protected_uds')[]>>>
	>;
}

interface ValidApprovalApproverInput {
	readonly approverId: string;
	readonly kind: 'managed_gateway';
}

interface ValidSystemConfigInput {
	schemaVersion: 2;
	host: Record<string, unknown>;
	controller?: unknown;
	storageRootDir: string;
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
	};
	delete zone.agents;
	delete zone.defaultToolVmProfile;
	delete zone.agentToolVmProfiles;
	delete zone.runtimeAuthHints;
	delete zone.toolPortal;
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
		schemaVersion: 2,
		host: {
			controllerPort: 18800,
			projectNamespace: 'claw-tests-a1b2c3d4',
		},
		storageRootDir: '../storage',
		imageProfiles: {
			gateways: {
				hermes: {
					type: 'hermes',
					buildConfig: '../vm-images/gateways/hermes/build-config.json',
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
					type: 'hermes',
					imageProfile: 'hermes',
					memory: '4G',
					cpus: 2,
					port: 8642,
					config: './hermes/config.yaml',
					profilesByAgent: { shravan: 'researcher' },
					profileSecretProjectionsByAgent: {
						shravan: {
							API_SERVER_KEY: 'API_SERVER_KEY_SHRAVAN',
							DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_SHRAVAN',
						},
					},
				},
				secrets: {
					API_SERVER_KEY_SHRAVAN: {
						source: 'environment',
						envVar: 'API_SERVER_KEY_SHRAVAN',
						injection: 'env',
						audience: 'gateway',
					},
					DISCORD_BOT_TOKEN_SHRAVAN: {
						source: 'environment',
						envVar: 'DISCORD_BOT_TOKEN_SHRAVAN',
						injection: 'env',
						audience: 'gateway',
					},
				},
				agents: [{ id: 'shravan' }],
				egressHosts: [{ host: 'api.openai.com', audience: 'gateway' }],
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

function configureFirstZoneAsHermes(config: ValidSystemConfigInput): ValidSystemConfigZoneInput {
	const zone = config.zones[0];
	zone.gateway = {
		type: 'hermes',
		imageProfile: 'hermes',
		memory: '4G',
		cpus: 2,
		port: 8642,
		config: './hermes/config.yaml',
		profilesByAgent: { shravan: 'researcher' },
		profileSecretProjectionsByAgent: {
			shravan: {
				API_SERVER_KEY: 'API_SERVER_KEY_SHRAVAN',
				DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_SHRAVAN',
			},
		},
	};
	zone.secrets = {
		API_SERVER_KEY_SHRAVAN: {
			source: 'environment',
			envVar: 'API_SERVER_KEY_SHRAVAN',
			injection: 'env',
			audience: 'gateway',
		},
		DISCORD_BOT_TOKEN_SHRAVAN: {
			source: 'environment',
			envVar: 'DISCORD_BOT_TOKEN_SHRAVAN',
			injection: 'env',
			audience: 'gateway',
		},
	};
	zone.egressHosts = [{ host: 'api.openai.com', audience: 'gateway' }];
	return zone;
}

function createZoneObservabilityInput(options?: {
	readonly diagnosticsFlags?: readonly string[];
}): Record<string, unknown> {
	return {
		enabled: true,
		...(options?.diagnosticsFlags === undefined
			? {}
			: { openclaw: { diagnosticsFlags: options.diagnosticsFlags } }),
		services: {
			framework: {},
			toolPortal: {},
		},
	};
}

function createValidZoneToolPortalConfigInput(): ValidZoneToolPortalConfigInput {
	return {
		configDir: './shravan',
		surfaceEligibilityByProfile: {
			'code-builder': {
				github: ['mcp', 'protected_uds'],
				local: ['protected_uds'],
			},
		},
	};
}

function createApprovalApproverInput(): ValidApprovalApproverInput {
	return {
		approverId: 'hermes-native',
		kind: 'managed_gateway',
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

function requireRecordProperty(
	record: Record<string, unknown>,
	propertyName: string,
): Record<string, unknown> {
	const value = record[propertyName];
	if (!isRecord(value)) {
		throw new Error(`Expected JSON schema property '${propertyName}' to be an object.`);
	}
	return value;
}

function requireArrayProperty(
	record: Record<string, unknown>,
	propertyName: string,
): readonly unknown[] {
	const value = record[propertyName];
	if (!Array.isArray(value)) {
		throw new Error(`Expected JSON schema property '${propertyName}' to be an array.`);
	}
	return value;
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function readJsonSchemaStringConst(schema: Record<string, unknown>): string | undefined {
	return typeof schema.const === 'string' ? schema.const : undefined;
}

function readJsonSchemaStringEnum(schema: Record<string, unknown>): readonly string[] {
	return isStringArray(schema.enum) ? schema.enum : [];
}

describe('loadSystemConfig', () => {
	test('derives global and per-zone storage paths from the schema-v2 storage root', async () => {
		// Arrange
		const config = createValidSystemConfigInput();
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-root-derived-',
			config,
		);
		const canonicalConfigDirectory = await realpath(path.dirname(configPath));
		const expectedStorageRoot = path.resolve(canonicalConfigDirectory, '../storage');

		// Act
		const loadedConfig = await loadSystemConfig(configPath);

		// Assert
		expect(loadedConfig.storageRootDir).toBe(expectedStorageRoot);
		expect(loadedConfig.cacheDir).toBe(path.join(expectedStorageRoot, 'cache'));
		expect(loadedConfig.controllerStateDir).toBe(
			path.join(expectedStorageRoot, 'controller-state'),
		);
		expect(loadedConfig.controllerRuntimeDir).toBe(
			path.join(expectedStorageRoot, 'controller-runtime'),
		);
		expect(loadedConfig.zones[0]?.gateway).toMatchObject({
			stateDir: path.join(expectedStorageRoot, 'shravan', 'state'),
			zoneFilesDir: path.join(expectedStorageRoot, 'shravan', 'zone-files'),
			zoneRuntimeDir: path.join(expectedStorageRoot, 'shravan', 'runtime'),
		});
	});

	test('rejects a missing storageRootDir', async () => {
		// Arrange
		const { storageRootDir: _storageRootDir, ...input } = createValidSystemConfigInput();
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-default-storage-root-',
			input,
		);

		// Act / Assert
		await expect(loadSystemConfig(configPath)).rejects.toThrow(/storageRootDir/u);
	});

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
				'  "schemaVersion": 2,',
				'  // Controller host settings',
				`  "host": ${JSON.stringify(config.host)},`,
				'  "storageRootDir": "../storage",',
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

	test('loads exactly one managed Gateway approval authority', () => {
		const config = createValidSystemConfigInput();
		configureFirstZoneAsHermes(config);
		config.zones[0].approvalAccess = {
			approvers: [createApprovalApproverInput()],
			audience: 'agent-vm-controller-approval',
		};

		const loadedConfig = parseSystemConfigInputForTest(config);

		expect(loadedConfig.zones[0]?.approvalAccess).toEqual({
			approvers: [createApprovalApproverInput()],
			audience: 'agent-vm-controller-approval',
		});
	});

	test.each([
		['missing audience', { approvers: [createApprovalApproverInput()] }],
		[
			'wrong audience',
			{
				approvers: [createApprovalApproverInput()],
				audience: 'agent-vm-controller-admin',
			},
		],
	] as const)('rejects approval access with %s', (_caseName, approvalAccess) => {
		// Arrange
		const config = createValidSystemConfigInput();
		config.zones[0].approvalAccess = approvalAccess;

		// Act / Assert
		expect(() => parseSystemConfigInputForTest(config)).toThrow();
	});

	test('requires approval access to declare at least one approver', () => {
		// Arrange
		const config = createValidSystemConfigInput();
		config.zones[0].approvalAccess = {
			approvers: [],
			audience: 'agent-vm-controller-approval',
		};

		// Act / Assert
		expect(() => parseSystemConfigInputForTest(config)).toThrow(/approvers/u);
	});

	test.each([
		['missing', { kind: 'managed_gateway' }],
		['empty', { approverId: '', kind: 'managed_gateway' }],
	] as const)('rejects an approval access approver with a %s approverId', (_caseName, approver) => {
		// Arrange
		const config = createValidSystemConfigInput();
		config.zones[0].approvalAccess = {
			approvers: [approver],
			audience: 'agent-vm-controller-approval',
		};

		// Act / Assert
		expect(() => parseSystemConfigInputForTest(config)).toThrow(/approverId/u);
	});

	test('rejects more than one managed Gateway approval authority', () => {
		// Arrange
		const config = createValidSystemConfigInput();
		config.zones[0].approvalAccess = {
			approvers: [
				{ approverId: 'primary-hermes-operator', kind: 'managed_gateway' },
				{ approverId: 'secondary-hermes-operator', kind: 'managed_gateway' },
			],
			audience: 'agent-vm-controller-approval',
		};

		// Act / Assert
		expect(() => parseSystemConfigInputForTest(config)).toThrow(/approvers/u);
	});

	test.each([
		['removed bearer authority', { approverId: 'primary-operator', kind: 'bearer' }],
		[
			'managed Gateway authority with a secret',
			{
				approverId: 'hermes-operator',
				kind: 'managed_gateway',
				secret: { source: 'environment', envVar: 'REMOVED_APPROVAL_SECRET' },
			},
		],
		[
			'authority without an explicit kind',
			{
				approverId: 'primary-operator',
			},
		],
	] as const)('rejects %s', (_caseName, approver) => {
		// Arrange
		const config = createValidSystemConfigInput();
		config.zones[0].approvalAccess = {
			approvers: [approver],
			audience: 'agent-vm-controller-approval',
		};

		// Act / Assert
		expect(() => parseSystemConfigInputForTest(config)).toThrow();
	});

	test.each([
		[
			'top-level body token',
			{
				approvers: [createApprovalApproverInput()],
				audience: 'agent-vm-controller-approval',
				token: 'body-token-must-not-authorize',
			},
		],
		[
			'approver body token',
			{
				approvers: [
					{
						...createApprovalApproverInput(),
						token: 'body-token-must-not-authorize',
					},
				],
				audience: 'agent-vm-controller-approval',
			},
		],
	] as const)('rejects approval access with an unknown %s field', (_caseName, approvalAccess) => {
		// Arrange
		const config = createValidSystemConfigInput();
		config.zones[0].approvalAccess = approvalAccess;

		// Act / Assert
		expect(() => parseSystemConfigInputForTest(config)).toThrow(/token/u);
	});

	test('does not treat adminAccess mode none as approval access', () => {
		// Arrange
		const config = createValidSystemConfigInput();
		config.zones[0].adminAccess = { mode: 'none' };

		// Act
		const loadedConfig = parseSystemConfigInputForTest(config);

		// Assert
		expect(loadedConfig.zones[0]?.adminAccess).toEqual({ mode: 'none' });
		expect(loadedConfig.zones[0]?.approvalAccess).toBeUndefined();
	});

	test('rejects admin-style mode none as an approval access contract', () => {
		// Arrange
		const config = createValidSystemConfigInput();
		config.zones[0].approvalAccess = { mode: 'none' };

		// Act / Assert
		expect(() => parseSystemConfigInputForTest(config)).toThrow();
	});

	test('requires host secretsProvider for a 1Password backup identity', () => {
		const config = createValidSystemConfigInput();
		const firstZone = config.zones[0];
		if (firstZone === undefined) {
			throw new Error('Expected the valid system config fixture to contain a zone.');
		}
		firstZone.gateway.backupIdentity = {
			source: '1password',
			ref: 'op://test-vault/backup-identity/password',
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(
			/host\.secretsProvider is required/u,
		);
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
			controlSessionDeathGraceMs: 600_000,
			enabled: true,
			eventHistoryLimit: 500,
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
				controlSessionDeathGraceMs: 30_000,
				gatewayServiceIntervalMs: 20_000,
				staleAfterMs: 45_000,
			},
		};

		const loadedConfig = parseSystemConfigInputForTest(config);

		expect(resolveControllerHealthConfig(loadedConfig)).toEqual({
			controlSessionDeathGraceMs: 30_000,
			enabled: false,
			eventHistoryLimit: 25,
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

	test('rejects legacy controller health control-link settings', () => {
		const config = createValidSystemConfigInput();
		config.controller = {
			health: {
				gatewayControlLinkIntervalMs: 10_000,
			},
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/gatewayControlLinkIntervalMs/u);
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
				hermes: {
					type: 'hermes',
					buildConfig: '../vm-images/gateways/hermes/build-config.jsonc',
				},
				worker: {
					type: 'worker',
					buildConfig: '../vm-images/gateways/worker/build-config.jsonc',
					source: {
						kind: 'managedBase',
						base: 'worker-gateway',
						overlay: '../vm-images/gateways/worker/overlay.jsonc',
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

		expect(loadedConfig.imageProfiles.gateways.worker?.source).toMatchObject({
			kind: 'managedBase',
			base: 'worker-gateway',
		});
		expect(loadedConfig.imageProfiles.gateways.worker?.source?.overlay).toContain(
			path.join('vm-images', 'gateways', 'worker', 'overlay.jsonc'),
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

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/ssh/u);
	});

	test('rejects a managed base that does not match the image profile family', async () => {
		const config = createValidSystemConfigInput();
		config.imageProfiles = {
			gateways: {
				hermes: {
					type: 'hermes',
					buildConfig: '../vm-images/gateways/hermes/build-config.jsonc',
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
			"Gateway image profile 'hermes' type 'hermes' must not declare a managed base.",
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

	test('keeps the Tool Portal disabled when the zone omits its configuration', async () => {
		// Arrange
		const config = createValidSystemConfigInput();
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-zone-without-tool-portal-',
			config,
		);

		// Act
		const loadedConfig = await loadSystemConfig(configPath);

		// Assert
		expect(loadedConfig.zones.at(0)?.toolPortal).toBeUndefined();
	});

	test('loads the strict Tool Portal controller configuration and resolves only configDir', async () => {
		// Arrange
		const config = createValidSystemConfigInput();
		config.zones[0].agents = [{ id: 'shravan', toolVmProfile: 'standard' }];
		config.zones[0].toolPortal = createValidZoneToolPortalConfigInput();
		const configPath = await writeSystemConfigForTest('agent-vm-system-zone-agents-', config);

		// Act
		const loadedConfig = await loadSystemConfig(configPath);
		const loadedZone = loadedConfig.zones.at(0);
		if (loadedZone === undefined) {
			throw new Error('Expected first loaded zone.');
		}

		expect(loadedZone.agents).toEqual([{ id: 'shravan', toolVmProfile: 'standard' }]);
		expect(loadedZone.toolPortal).toEqual({
			configDir: path.join(path.dirname(configPath), 'shravan'),
			surfaceEligibilityByProfile: {
				'code-builder': {
					github: ['mcp', 'protected_uds'],
					local: ['protected_uds'],
				},
			},
		});
	});

	test('rejects a partial Tool Portal controller configuration', async () => {
		// Arrange
		const config = createValidSystemConfigInput();
		config.zones[0].toolPortal = { configDir: './shravan' };
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-zone-partial-tool-portal-',
			config,
		);

		// Act / Assert
		await expect(loadSystemConfig(configPath)).rejects.toThrow(/surfaceEligibilityByProfile/u);
	});

	test('rejects retired managed MCP listener coordinates at the strict Tool Portal boundary', async () => {
		// Arrange
		const config = createValidSystemConfigInput();
		config.zones[0].toolPortal = {
			...createValidZoneToolPortalConfigInput(),
			managedMcp: {
				audience: 'zone-a-tool-portal',
				guestPort: 31_847,
			},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-zone-with-retired-managed-mcp-',
			config,
		);

		// Act / Assert
		await expect(loadSystemConfig(configPath)).rejects.toThrow(/Unrecognized key.*managedMcp/u);
	});

	test.each([
		[
			'missing surface eligibility configuration',
			{ configDir: './shravan' },
			/surfaceEligibilityByProfile/u,
		],
		[
			'empty profile key',
			{
				...createValidZoneToolPortalConfigInput(),
				surfaceEligibilityByProfile: {
					'': { github: ['mcp'] },
				},
			},
			/Too small/u,
		],
		[
			'empty capability key',
			{
				...createValidZoneToolPortalConfigInput(),
				surfaceEligibilityByProfile: {
					'code-builder': { '': ['mcp'] },
				},
			},
			/Too small/u,
		],
		[
			'empty surface eligibility',
			{
				...createValidZoneToolPortalConfigInput(),
				surfaceEligibilityByProfile: {
					'code-builder': { github: [] },
				},
			},
			/Too small/u,
		],
		[
			'unknown surface class',
			{
				...createValidZoneToolPortalConfigInput(),
				surfaceEligibilityByProfile: {
					'code-builder': { github: ['public_http'] },
				},
			},
			/Invalid option/u,
		],
	] as const)(
		'rejects Tool Portal controller configuration with %s',
		async (_caseName, toolPortal, expectedError) => {
			// Arrange
			const config = createValidSystemConfigInput();
			config.zones[0].toolPortal = toolPortal;
			const configPath = await writeSystemConfigForTest(
				'agent-vm-system-zone-invalid-tool-portal-',
				config,
			);

			// Act / Assert
			await expect(loadSystemConfig(configPath)).rejects.toThrow(expectedError);
		},
	);

	test('rejects worker zones declaring agents or Tool Portal references', async () => {
		const config = createValidSystemConfigInput();
		const {
			controlAuth: _controlAuth,
			profileSecretProjectionsByAgent: _profileSecretProjectionsByAgent,
			profilesByAgent: _profilesByAgent,
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
			toolPortal: createValidZoneToolPortalConfigInput(),
		};
		delete config.zones[0].defaultToolVmProfile;
		delete config.zones[0].agentToolVmProfiles;
		const configPath = await writeSystemConfigForTest('agent-vm-system-worker-agents-', config);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(
			/must not declare agents or toolPortal/u,
		);
	});

	test('loads a valid plan-1 controller config', async () => {
		const workingDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-system-config-'));
		createdDirectories.push(workingDirectoryPath);
		const canonicalWorkingDirectoryPath = await realpath(workingDirectoryPath);
		const configPath = path.join(workingDirectoryPath, 'config', 'system.json');
		await mkdir(path.dirname(configPath), { recursive: true });

		await writeFile(
			configPath,
			JSON.stringify({
				schemaVersion: 2,
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
				storageRootDir: '../storage',
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'hermes',
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
			cacheDir: path.join(canonicalWorkingDirectoryPath, 'storage', 'cache'),
			imageProfiles: {
				gateways: {
					openclaw: {
						type: 'hermes',
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

	test('adds only resolved storage paths and the runtime system config path', async () => {
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-cache-id-',
			createValidSystemConfigInput(),
		);

		const config = await loadSystemConfig(configPath);
		const canonicalConfigDirectory = await realpath(path.dirname(configPath));
		const expectedStorageRoot = path.resolve(canonicalConfigDirectory, '../storage');

		expect(config.systemConfigPath).toBe(configPath);
		expect(config.storageRootDir).toBe(expectedStorageRoot);
		expect(config.controllerRuntimeDir).toBe(path.join(expectedStorageRoot, 'controller-runtime'));
	});

	test('resolves an absolute storageRootDir without rebasing it to the system config', async () => {
		// Arrange
		const input = createValidSystemConfigInput();
		const absoluteStorageRoot = path.join(
			await realpath(os.tmpdir()),
			'agent-vm-absolute-storage-root',
		);
		input.storageRootDir = absoluteStorageRoot;
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-storage-root-absolute-',
			input,
		);

		// Act
		const config = await loadSystemConfig(configPath);

		// Assert
		expect(config.storageRootDir).toBe(absoluteStorageRoot);
		expect(config.controllerStateDir).toBe(path.join(absoluteStorageRoot, 'controller-state'));
	});

	test('expands a ~/ storageRootDir and derives the complete tree', async () => {
		const input = createValidSystemConfigInput();
		input.storageRootDir = '~/.agent-vm/custom';
		const firstZone = input.zones[0];
		firstZone.gateway = {
			...firstZone.gateway,
			backupDir: '~/.agent-vm-backups/shravan',
		};
		const configPath = await writeSystemConfigForTest('agent-vm-system-config-tilde-', input);

		const config = await loadSystemConfig(configPath);

		const expectedRoot = path.join(os.homedir(), '.agent-vm', 'custom');
		expect(config.storageRootDir).toBe(expectedRoot);
		expect(config.cacheDir).toBe(path.join(expectedRoot, 'cache'));
		expect(config.controllerStateDir).toBe(path.join(expectedRoot, 'controller-state'));
		expect(config.controllerRuntimeDir).toBe(path.join(expectedRoot, 'controller-runtime'));
		expect(config.zones[0]?.gateway.stateDir).toBe(path.join(expectedRoot, 'shravan', 'state'));
		if (config.zones[0]?.gateway.type !== 'hermes') {
			throw new Error('Expected fixture zone to be Hermes.');
		}
		expect(config.zones[0].gateway.zoneFilesDir).toBe(
			path.join(expectedRoot, 'shravan', 'zone-files'),
		);
		expect(config.zones[0].gateway.zoneRuntimeDir).toBe(
			path.join(expectedRoot, 'shravan', 'runtime'),
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
				zoneFilesDir: '../zone-files/shravan',
			},
		};
		const configPath = await writeSystemConfigForTest('agent-vm-system-worker-zone-files-', input);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/zoneFilesDir/u);
	});

	test('derives Worker state and runtime without a zone-files directory', async () => {
		// Arrange
		const input = createValidSystemConfigInput();
		configureFirstZoneAsWorker(input);
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-worker-derived-storage-',
			input,
		);
		const canonicalConfigDirectory = await realpath(path.dirname(configPath));
		const expectedStorageRoot = path.resolve(canonicalConfigDirectory, '../storage');

		// Act
		const config = await loadSystemConfig(configPath);

		// Assert
		expect(config.zones[0]?.gateway).toMatchObject({
			stateDir: path.join(expectedStorageRoot, 'shravan', 'state'),
			zoneRuntimeDir: path.join(expectedStorageRoot, 'shravan', 'runtime'),
		});
		expect(config.zones[0]?.gateway).not.toHaveProperty('zoneFilesDir');
	});

	test('loads strict local and remote per-agent workspace Git policies', async () => {
		const input = createValidSystemConfigInput();
		input.zones[0].agents = [
			{ id: 'local-agent', workspaceGit: { mode: 'local' } },
			{
				id: 'remote-agent',
				workspaceGit: {
					mode: 'remote',
					remote: {
						repoUrl: 'Example/Remote-Agent',
					},
				},
			},
		];
		input.zones[0].agentToolVmProfiles = {};
		input.zones[0].gateway.profilesByAgent = {
			'local-agent': 'local-agent',
			'remote-agent': 'remote-agent',
		};
		input.zones[0].gateway.profileSecretProjectionsByAgent = {
			'local-agent': {
				API_SERVER_KEY: 'API_SERVER_KEY_LOCAL',
				DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_LOCAL',
			},
			'remote-agent': {
				API_SERVER_KEY: 'API_SERVER_KEY_REMOTE',
				DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_REMOTE',
			},
		};
		delete input.zones[0].secrets.API_SERVER_KEY_SHRAVAN;
		delete input.zones[0].secrets.DISCORD_BOT_TOKEN_SHRAVAN;
		input.zones[0].secrets.API_SERVER_KEY_LOCAL = {
			source: 'environment',
			envVar: 'API_SERVER_KEY_LOCAL',
			injection: 'env',
			audience: 'gateway',
		};
		input.zones[0].secrets.API_SERVER_KEY_REMOTE = {
			source: 'environment',
			envVar: 'API_SERVER_KEY_REMOTE',
			injection: 'env',
			audience: 'gateway',
		};
		input.zones[0].secrets.DISCORD_BOT_TOKEN_LOCAL = {
			source: 'environment',
			envVar: 'DISCORD_BOT_TOKEN_LOCAL',
			injection: 'env',
			audience: 'gateway',
		};
		input.zones[0].secrets.DISCORD_BOT_TOKEN_REMOTE = {
			source: 'environment',
			envVar: 'DISCORD_BOT_TOKEN_REMOTE',
			injection: 'env',
			audience: 'gateway',
		};

		const parsed = parseSystemConfigInputForTest(input);

		expect(parsed.zones[0]?.agents).toEqual([
			{ id: 'local-agent', workspaceGit: { mode: 'local' } },
			{
				id: 'remote-agent',
				workspaceGit: {
					mode: 'remote',
					remote: {
						branch: 'agent/workspace',
						defaultBranch: 'main',
						repoUrl: 'Example/Remote-Agent',
					},
				},
			},
		]);
	});

	test('rejects invalid per-agent workspace Git discriminants and strict variants', () => {
		const invalidPolicies = [
			{ mode: 'disabled' },
			{ mode: 'local', unexpected: true },
			{ mode: 'local', remote: { repoUrl: 'Example/Agent' } },
			{ mode: 'remote' },
			{ mode: 'remote', remote: { repoUrl: 'Example/Agent', unexpected: true } },
			{
				mode: 'remote',
				remote: {
					repoUrl: 'https://token@github.com/example/agent.git',
				},
			},
		] as const;
		for (const workspaceGit of invalidPolicies) {
			const input = createValidSystemConfigInput();
			input.zones[0].agents = [{ id: 'shravan', workspaceGit }];
			expect(() => parseSystemConfigInputForTest(input)).toThrow();
		}
	});

	test('rejects the configured default branch for remote workspace Git', () => {
		const invalidRemotePolicies = [
			{
				branch: 'main',
				repoUrl: 'Example/Agent',
			},
			{
				branch: 'develop',
				defaultBranch: 'develop',
				repoUrl: 'Example/Agent',
			},
		] as const;
		for (const remote of invalidRemotePolicies) {
			const input = createValidSystemConfigInput();
			input.zones[0].agents = [{ id: 'shravan', workspaceGit: { mode: 'remote', remote } }];
			expect(() => parseSystemConfigInputForTest(input)).toThrow(
				/workspaceGit\.remote\.branch must differ from defaultBranch/u,
			);
		}
	});

	test('allows main when the configured default branch is different', () => {
		const input = createValidSystemConfigInput();
		input.zones[0].agents = [
			{
				id: 'shravan',
				workspaceGit: {
					mode: 'remote',
					remote: {
						branch: 'main',
						defaultBranch: 'trunk',
						repoUrl: 'Example/Agent',
					},
				},
			},
		];

		expect(() => parseSystemConfigInputForTest(input)).not.toThrow();
	});

	test('rejects duplicate per-agent remote workspace Git authority', () => {
		const duplicateInput = createValidSystemConfigInput();
		duplicateInput.zones[0].agents = [
			{
				id: 'alpha',
				workspaceGit: {
					mode: 'remote',
					remote: {
						branch: 'agent/alpha',
						repoUrl: 'Example/Shared.git',
					},
				},
			},
			{
				id: 'beta',
				workspaceGit: {
					mode: 'remote',
					remote: {
						branch: 'agent/alpha',
						repoUrl: 'https://github.com/example/shared',
					},
				},
			},
		];
		expect(() => parseSystemConfigInputForTest(duplicateInput)).toThrow(/duplicates normalized/u);
	});

	test('rejects workspace Git on Worker zones', () => {
		const input = createValidSystemConfigInput();
		const zone = configureFirstZoneAsWorker(input);
		zone.agents = [{ id: 'worker-agent', workspaceGit: { mode: 'local' } }];

		expect(() => parseSystemConfigInputForTest(input)).toThrow(/workspaceGit/u);
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

	test('rejects unsafe per-agent remote workspace Git branch names', () => {
		const input = createValidSystemConfigInput();
		input.zones[0].agents = [
			{
				id: 'shravan',
				workspaceGit: {
					mode: 'remote',
					remote: {
						branch: 'main:refs/heads/pwn',
						repoUrl: 'ShravanSunder/sunfam-zone-files',
					},
				},
			},
		];

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
				type: 'hermes',
				profileSecretProjectionsByAgent: { main: {} },
				profilesByAgent: { main: 'main' },
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './shravan/openclaw.json',
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

	test('accepts zones without explicit backup configuration', async () => {
		const config = parseSystemConfigInputForTest(createValidSystemConfigInput());

		expect(config.zones[0]?.gateway.backupDir).toBeUndefined();
		expect(config.zones[0]?.gateway.backupIdentity).toBeUndefined();
	});

	test('loads a per-zone backup identity without resolving it', async () => {
		const config = createValidSystemConfigInput();
		const firstZone = config.zones[0];
		if (firstZone === undefined) {
			throw new Error('Expected the valid system config fixture to contain a zone.');
		}
		firstZone.gateway.backupIdentity = {
			source: 'environment',
			envVar: 'AGE_BACKUP_IDENTITY',
		};

		const loadedConfig = parseSystemConfigInputForTest(config);

		expect(loadedConfig.zones[0]?.gateway.backupIdentity).toEqual({
			source: 'environment',
			envVar: 'AGE_BACKUP_IDENTITY',
		});
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
				schemaVersion: 2,
				host: {
					controllerPort: 18800,
					projectNamespace: 'claw-tests-a1b2c3d4',
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
					},
				},
				storageRootDir: '../storage',
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'hermes',
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
				schemaVersion: 2,
				host: {
					controllerPort: 18800,
					projectNamespace: 'claw-tests-a1b2c3d4',
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
					},
				},
				storageRootDir: '../storage',
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'hermes',
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
							type: 'hermes',
							profileSecretProjectionsByAgent: { main: {} },
							profilesByAgent: { main: 'main' },
							imageProfile: 'openclaw',
							memory: '2G',
							cpus: 2,
							port: 18791,
							config: './shravan/openclaw.json',
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
				schemaVersion: 2,
				host: {
					controllerPort: 18800,
					projectNamespace: 'bad:namespace',
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
					},
				},
				storageRootDir: '../storage',
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'hermes',
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
							type: 'hermes',
							profileSecretProjectionsByAgent: { main: {} },
							profilesByAgent: { main: 'main' },
							imageProfile: 'openclaw',
							memory: '2G',
							cpus: 2,
							port: 18791,
							config: './shravan/openclaw.json',
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
			{ host: 'api.linear.app', audience: 'gateway' },
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
				audience: 'gateway',
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
		zone.agents = [{ id: 'shravan' }];
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
			agentAccess: 'all',
		};
		const shravanProjection = (
			zone.gateway.profileSecretProjectionsByAgent as Record<string, Record<string, string>>
		).shravan;
		if (shravanProjection === undefined) {
			throw new Error('Expected shravan profile secret projection.');
		}
		shravanProjection.GITHUB_TOKEN = 'GITHUB_TOKEN';

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
							agentAccess: 'all',
						},
					},
				},
			],
		});
	});

	test('allows mediated secret hosts covered by egress host wildcard patterns', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.agents = [{ id: 'shravan' }];
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
			agentAccess: 'all',
		};
		const shravanProjection = (
			zone.gateway.profileSecretProjectionsByAgent as Record<string, Record<string, string>>
		).shravan;
		if (shravanProjection === undefined) {
			throw new Error('Expected shravan profile secret projection.');
		}
		shravanProjection.GITHUB_TOKEN = 'GITHUB_TOKEN';
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

	test('loads websocket upgrade URL policy from zone config', () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.egressHosts = [
			{ host: 'discord.gg', audience: 'both' },
			{ host: '*.discord.gg', audience: 'both' },
		];
		zone.websocketUpgrades = [
			{
				audience: 'gateway',
				scheme: 'wss',
				host: 'gateway.discord.gg',
				port: 443,
				path: '/',
			},
			{
				audience: 'gateway',
				scheme: 'wss',
				host: 'gateway-*.discord.gg',
				port: 443,
				path: '/',
			},
		];

		expect(parseSystemConfigInputForTest(config).zones[0]?.websocketUpgrades).toEqual(
			zone.websocketUpgrades,
		);
	});

	test('rejects websocket upgrade hosts missing from egress hosts', () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.egressHosts = [
			{ host: 'api.github.com', audience: 'gateway' },
			{ host: 'openrouter.ai', audience: 'gateway' },
		];
		zone.websocketUpgrades = [
			{
				audience: 'gateway',
				scheme: 'wss',
				host: 'gateway.discord.gg',
			},
		];

		expect(() => parseSystemConfigInputForTest(config)).toThrow(
			/websocket upgrade host 'gateway\.discord\.gg' must be declared in egressHosts/u,
		);
	});

	test('rejects websocket upgrade hosts declared for the wrong egress audience', () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.egressHosts = [{ host: 'gateway.discord.gg', audience: 'tool-vm' }];
		zone.websocketUpgrades = [
			{
				audience: 'gateway',
				scheme: 'wss',
				host: 'gateway.discord.gg',
			},
		];

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/audience 'gateway'/u);
	});

	test('rejects websocket upgrade hosts with audience both unless both runtime audiences have egress', () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.egressHosts = [{ host: 'shared-websocket.example.com', audience: 'gateway' }];
		zone.websocketUpgrades = [
			{
				audience: 'both',
				scheme: 'wss',
				host: 'shared-websocket.example.com',
			},
		];

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/audience 'both'/u);
	});

	test('rejects removed websocketBypass zone config', () => {
		const config = createValidSystemConfigInput();
		config.zones[0].websocketBypass = ['gateway.discord.gg:443'];

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/websocketBypass/u);
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
		zone.agents = [{ id: 'shravan' }];
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
			agentAccess: 'all',
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

	test('accepts all-agent access on Tool VM mediated secrets', () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.agents = [{ id: 'sun' }];
		zone.gateway.profilesByAgent = { sun: 'sun' };
		zone.gateway.profileSecretProjectionsByAgent = {
			sun: {
				API_SERVER_KEY: 'API_SERVER_KEY_SHRAVAN',
				DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_SHRAVAN',
			},
		};
		zone.egressHosts = [{ host: 'api.github.com', audience: 'tool-vm' }];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.github.com'],
			agentAccess: 'all',
		};

		expect(parseSystemConfigInputForTest(config)).toMatchObject({
			zones: [
				expect.objectContaining({
					secrets: expect.objectContaining({
						GITHUB_TOKEN: expect.objectContaining({
							agentAccess: 'all',
						}),
					}),
				}),
			],
		});
	});

	test('rejects all-agent access on Tool VM mediated secrets without declared zone agents', () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		delete zone.agents;
		zone.egressHosts = [{ host: 'api.github.com', audience: 'tool-vm' }];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.github.com'],
			agentAccess: 'all',
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/zones\[\]\.agents is empty/u);
	});

	test('accepts per-agent access on Tool VM mediated secrets', () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.agents = [{ id: 'sun' }];
		zone.gateway.profilesByAgent = { sun: 'sun' };
		zone.gateway.profileSecretProjectionsByAgent = {
			sun: {
				API_SERVER_KEY: 'API_SERVER_KEY_SHRAVAN',
				DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_SHRAVAN',
			},
		};
		zone.egressHosts = [{ host: 'api.github.com', audience: 'tool-vm' }];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.github.com'],
			agentAccess: ['sun'],
		};

		expect(parseSystemConfigInputForTest(config)).toMatchObject({
			zones: [
				expect.objectContaining({
					secrets: expect.objectContaining({
						GITHUB_TOKEN: expect.objectContaining({
							agentAccess: ['sun'],
						}),
					}),
				}),
			],
		});
	});

	test('accepts agent access on shared mediated secrets and scopes the Tool VM side', () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.agents = [{ id: 'sun' }];
		zone.gateway.profilesByAgent = { sun: 'sun' };
		zone.gateway.profileSecretProjectionsByAgent = {
			sun: {
				API_SERVER_KEY: 'API_SERVER_KEY_SHRAVAN',
				DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_SHRAVAN',
				GITHUB_TOKEN: 'GITHUB_TOKEN',
			},
		};
		zone.egressHosts = [{ host: 'api.github.com', audience: 'both' }];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'both',
			hosts: ['api.github.com'],
			agentAccess: ['sun'],
		};

		expect(parseSystemConfigInputForTest(config)).toMatchObject({
			zones: [
				expect.objectContaining({
					secrets: expect.objectContaining({
						GITHUB_TOKEN: expect.objectContaining({
							audience: 'both',
							agentAccess: ['sun'],
						}),
					}),
				}),
			],
		});
	});

	test('rejects Tool VM mediated secrets without agentAccess', () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.egressHosts = [{ host: 'api.github.com', audience: 'tool-vm' }];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.github.com'],
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/agentAccess/u);
	});

	test('rejects empty per-agent access arrays on Tool VM mediated secrets', () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.egressHosts = [{ host: 'api.github.com', audience: 'tool-vm' }];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.github.com'],
			agentAccess: [],
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/agentAccess/u);
	});

	test('rejects per-agent secret access for unknown agents', () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.agents = [{ id: 'sun' }];
		zone.egressHosts = [{ host: 'api.github.com', audience: 'tool-vm' }];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.github.com'],
			agentAccess: ['ember'],
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(
			/secret 'GITHUB_TOKEN' agentAccess references unknown agent 'ember'/u,
		);
	});

	test('rejects agentAccess on gateway-only mediated secrets', () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.egressHosts = [
			{ host: 'api.github.com', audience: 'gateway' },
			{ host: 'openrouter.ai', audience: 'gateway' },
		];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'gateway',
			hosts: ['api.github.com'],
			agentAccess: 'all',
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/agentAccess/u);
	});

	test('rejects worker-zone Tool VM agent access', () => {
		const config = createValidSystemConfigInput();
		const zone = configureFirstZoneAsWorker(config);
		zone.egressHosts = [{ host: 'api.github.com', audience: 'tool-vm' }];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.github.com'],
			agentAccess: 'all',
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(
			/worker zones do not boot managed-agent Tool VMs/u,
		);
	});

	test('rejects mediated secret hosts that are not declared for the same audience', async () => {
		const config = createValidSystemConfigInput();
		const zone = config.zones[0];
		zone.agents = [{ id: 'shravan' }];
		zone.egressHosts = [{ host: 'api.linear.app', audience: 'gateway' }];
		zone.secrets.LINEAR_API_KEY = {
			source: 'environment',
			envVar: 'LINEAR_API_KEY',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.linear.app'],
			agentAccess: 'all',
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
		zone.agents = [{ id: 'shravan' }];
		zone.egressHosts = [
			{ host: 'api.github.com', audience: 'gateway' },
			{ host: 'openrouter.ai', audience: 'gateway' },
		];
		zone.secrets.GITHUB_TOKEN = {
			source: 'environment',
			envVar: 'GITHUB_TOKEN',
			injection: 'http-mediation',
			audience: 'both',
			hosts: ['api.github.com'],
			agentAccess: 'all',
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/egressHosts/u);
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

	test('rejects worker zone Tool VM-only mediated secrets before runtime auth hints', async () => {
		const config = createValidSystemConfigInput();
		const zone = configureFirstZoneAsWorker(config);
		zone.egressHosts = [{ host: 'api.linear.app', audience: 'tool-vm' }];
		zone.secrets.LINEAR_API_KEY = {
			source: 'environment',
			envVar: 'LINEAR_API_KEY',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.linear.app'],
			agentAccess: 'all',
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

		await expect(loadSystemConfig(configPath)).rejects.toThrow(
			/worker zones do not boot managed-agent Tool VMs/u,
		);
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
				schemaVersion: 2,
				host: {
					controllerPort: 18800,
					projectNamespace: 'claw-tests-a1b2c3d4',
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
					},
				},
				storageRootDir: '../storage',
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'hermes',
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
							type: 'hermes',
							profileSecretProjectionsByAgent: { main: {} },
							profilesByAgent: { main: 'main' },
							imageProfile: 'openclaw',
							memory: '2G',
							cpus: 2,
							port: 18791,
							config: './shravan/openclaw.json',
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

	test('loads a strict two-agent Hermes gateway with common managed-agent configuration', () => {
		const config = createValidSystemConfigInput();
		const zone = configureFirstZoneAsHermes(config);
		zone.agents = [
			{ id: 'research-agent', workspaceGit: { mode: 'local' } },
			{ id: 'review-agent', toolVmProfile: 'standard' },
		];
		zone.gateway.profilesByAgent = {
			'research-agent': 'researcher',
			'review-agent': 'code-reviewer',
		};
		Object.assign(zone.gateway, {
			profileSecretProjectionsByAgent: {
				'research-agent': {
					API_SERVER_KEY: 'API_SERVER_KEY_RESEARCH',
					DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_RESEARCH',
					OPENROUTER_API_KEY: 'OPENROUTER_API_KEY_SHARED',
				},
				'review-agent': {
					API_SERVER_KEY: 'API_SERVER_KEY_REVIEW',
					DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_REVIEW',
					OPENROUTER_API_KEY: 'OPENROUTER_API_KEY_SHARED',
				},
			},
		});
		zone.secrets = {
			API_SERVER_KEY: {
				source: 'environment',
				envVar: 'API_SERVER_KEY',
				injection: 'env',
				audience: 'gateway',
			},
			API_SERVER_KEY_RESEARCH: {
				source: 'environment',
				envVar: 'API_SERVER_KEY_RESEARCH',
				injection: 'env',
				audience: 'gateway',
			},
			API_SERVER_KEY_REVIEW: {
				source: 'environment',
				envVar: 'API_SERVER_KEY_REVIEW',
				injection: 'env',
				audience: 'gateway',
			},
			DISCORD_BOT_TOKEN_RESEARCH: {
				source: 'environment',
				envVar: 'DISCORD_BOT_TOKEN_RESEARCH',
				injection: 'env',
				audience: 'gateway',
			},
			DISCORD_BOT_TOKEN_REVIEW: {
				source: 'environment',
				envVar: 'DISCORD_BOT_TOKEN_REVIEW',
				injection: 'env',
				audience: 'gateway',
			},
			OPENROUTER_API_KEY_SHARED: {
				source: 'environment',
				envVar: 'OPENROUTER_API_KEY_SHARED',
				injection: 'http-mediation',
				audience: 'gateway',
				hosts: ['openrouter.ai'],
			},
		};
		zone.defaultToolVmProfile = 'standard';
		zone.agentToolVmProfiles = { 'review-agent': 'standard' };
		zone.toolPortal = createValidZoneToolPortalConfigInput();
		zone.egressHosts = [
			{ host: 'api.github.com', audience: 'gateway' },
			{ host: 'openrouter.ai', audience: 'gateway' },
		];

		const parsed = parseSystemConfigInputForTest(config);

		expect(parsed.zones[0]).toMatchObject({
			agents: [
				{ id: 'research-agent', workspaceGit: { mode: 'local' } },
				{ id: 'review-agent', toolVmProfile: 'standard' },
			],
			gateway: {
				type: 'hermes',
				profileSecretProjectionsByAgent: {
					'research-agent': {
						API_SERVER_KEY: 'API_SERVER_KEY_RESEARCH',
						DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_RESEARCH',
						OPENROUTER_API_KEY: 'OPENROUTER_API_KEY_SHARED',
					},
					'review-agent': {
						API_SERVER_KEY: 'API_SERVER_KEY_REVIEW',
						DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_REVIEW',
						OPENROUTER_API_KEY: 'OPENROUTER_API_KEY_SHARED',
					},
				},
				profilesByAgent: {
					'research-agent': 'researcher',
					'review-agent': 'code-reviewer',
				},
			},
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: { 'review-agent': 'standard' },
		});
	});

	test('allows bounded Discord bot-routing settings in Hermes profile projections', () => {
		const config = createValidSystemConfigInput();
		const zone = configureFirstZoneAsHermes(config);
		const projections = zone.gateway.profileSecretProjectionsByAgent as Record<
			string,
			Record<string, string>
		>;
		projections.shravan = {
			...projections.shravan,
			DISCORD_ALLOW_BOTS: 'DISCORD_ALLOW_BOTS',
			DISCORD_BOTS_REQUIRE_INLINE_MENTION: 'DISCORD_BOTS_REQUIRE_INLINE_MENTION',
		};
		Object.assign(zone.secrets, {
			DISCORD_ALLOW_BOTS: {
				source: 'environment',
				envVar: 'AGENT_VM_HERMES_DISCORD_ALLOW_BOTS',
				injection: 'env',
				audience: 'gateway',
			},
			DISCORD_BOTS_REQUIRE_INLINE_MENTION: {
				source: 'environment',
				envVar: 'AGENT_VM_HERMES_DISCORD_BOTS_REQUIRE_INLINE_MENTION',
				injection: 'env',
				audience: 'gateway',
			},
		});

		expect(() => parseSystemConfigInputForTest(config)).not.toThrow();
	});

	test('requires one distinct profile API server key source per Hermes agent', () => {
		const missingConfig = createValidSystemConfigInput();
		const missingZone = configureFirstZoneAsHermes(missingConfig);
		const missingProjections = missingZone.gateway.profileSecretProjectionsByAgent;
		if (!isRecord(missingProjections) || !isRecord(missingProjections.shravan)) {
			throw new Error('Expected valid Hermes profile projections.');
		}
		delete missingProjections.shravan.API_SERVER_KEY;
		expect(() => parseSystemConfigInputForTest(missingConfig)).toThrow(
			/must project exactly one API_SERVER_KEY target/u,
		);

		const reusedConfig = createValidSystemConfigInput();
		const reusedZone = configureFirstZoneAsHermes(reusedConfig);
		reusedZone.agents = [{ id: 'research-agent' }, { id: 'review-agent' }];
		reusedZone.gateway.profilesByAgent = {
			'research-agent': 'researcher',
			'review-agent': 'reviewer',
		};
		reusedZone.gateway.profileSecretProjectionsByAgent = {
			'research-agent': {
				API_SERVER_KEY: 'API_SERVER_KEY_SHARED',
				DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_RESEARCH',
			},
			'review-agent': {
				API_SERVER_KEY: 'API_SERVER_KEY_SHARED',
				DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_REVIEW',
			},
		};
		reusedZone.secrets = {
			API_SERVER_KEY_SHARED: {
				source: 'environment',
				envVar: 'API_SERVER_KEY_SHARED',
				injection: 'env',
				audience: 'gateway',
			},
			DISCORD_BOT_TOKEN_RESEARCH: {
				source: 'environment',
				envVar: 'DISCORD_BOT_TOKEN_RESEARCH',
				injection: 'env',
				audience: 'gateway',
			},
			DISCORD_BOT_TOKEN_REVIEW: {
				source: 'environment',
				envVar: 'DISCORD_BOT_TOKEN_REVIEW',
				injection: 'env',
				audience: 'gateway',
			},
		};

		expect(() => parseSystemConfigInputForTest(reusedConfig)).toThrow(
			/API_SERVER_KEY.*distinct source/u,
		);
	});

	test('rejects incomplete or unsafe Hermes profile secret projections', () => {
		const invalidCases = [
			{
				mapping: {},
				secrets: {
					DISCORD_BOT_TOKEN_SHRAVAN: {
						source: 'environment',
						envVar: 'DISCORD_BOT_TOKEN_SHRAVAN',
						injection: 'env',
						audience: 'gateway',
					},
				},
			},
			{
				mapping: {
					shravan: {
						API_SERVER_KEY: 'API_SERVER_KEY_SHRAVAN',
						DISCORD_BOT_TOKEN: 'DISCORD_TOKEN',
					},
					extra: {
						API_SERVER_KEY: 'API_SERVER_KEY_EXTRA',
						DISCORD_BOT_TOKEN: 'DISCORD_TOKEN_EXTRA',
					},
				},
				secrets: {
					API_SERVER_KEY_SHRAVAN: {
						source: 'environment',
						envVar: 'API_SERVER_KEY_SHRAVAN',
						injection: 'env',
						audience: 'gateway',
					},
					API_SERVER_KEY_EXTRA: {
						source: 'environment',
						envVar: 'API_SERVER_KEY_EXTRA',
						injection: 'env',
						audience: 'gateway',
					},
					DISCORD_TOKEN: {
						source: 'environment',
						envVar: 'DISCORD_TOKEN',
						injection: 'env',
						audience: 'gateway',
					},
					DISCORD_TOKEN_EXTRA: {
						source: 'environment',
						envVar: 'DISCORD_TOKEN_EXTRA',
						injection: 'env',
						audience: 'gateway',
					},
				},
			},
			{
				mapping: {
					shravan: {
						API_SERVER_KEY: 'API_SERVER_KEY_SHRAVAN',
						DISCORD_BOT_TOKEN: 'DISCORD_TOKEN',
					},
				},
				secrets: {
					API_SERVER_KEY_SHRAVAN: {
						source: 'environment',
						envVar: 'API_SERVER_KEY_SHRAVAN',
						injection: 'env',
						audience: 'gateway',
					},
					DISCORD_TOKEN: {
						source: 'environment',
						envVar: 'DISCORD_TOKEN',
						injection: 'http-mediation',
						audience: 'gateway',
						hosts: ['discord.com'],
					},
				},
			},
		] as const;

		for (const invalidCase of invalidCases) {
			const config = createValidSystemConfigInput();
			const zone = configureFirstZoneAsHermes(config);
			Object.assign(zone.gateway, {
				profileSecretProjectionsByAgent: invalidCase.mapping,
			});
			zone.secrets = invalidCase.secrets;

			expect(() => parseSystemConfigInputForTest(config)).toThrow(
				/profileSecretProjectionsByAgent|Discord bot token/u,
			);
		}
	});

	test('rejects Hermes Discord token mappings that reuse one secret', () => {
		const config = createValidSystemConfigInput();
		const zone = configureFirstZoneAsHermes(config);
		zone.agents = [{ id: 'research-agent' }, { id: 'review-agent' }];
		zone.gateway.profilesByAgent = {
			'research-agent': 'researcher',
			'review-agent': 'reviewer',
		};
		Object.assign(zone.gateway, {
			profileSecretProjectionsByAgent: {
				'research-agent': {
					API_SERVER_KEY: 'API_SERVER_KEY_RESEARCH',
					DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_SHARED',
				},
				'review-agent': {
					API_SERVER_KEY: 'API_SERVER_KEY_REVIEW',
					DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_SHARED',
				},
			},
		});
		zone.secrets = {
			API_SERVER_KEY_RESEARCH: {
				source: 'environment',
				envVar: 'API_SERVER_KEY_RESEARCH',
				injection: 'env',
				audience: 'gateway',
			},
			API_SERVER_KEY_REVIEW: {
				source: 'environment',
				envVar: 'API_SERVER_KEY_REVIEW',
				injection: 'env',
				audience: 'gateway',
			},
			DISCORD_BOT_TOKEN_SHARED: {
				source: 'environment',
				envVar: 'DISCORD_BOT_TOKEN_SHARED',
				injection: 'env',
				audience: 'gateway',
			},
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(
			/DISCORD_BOT_TOKEN.*distinct source/u,
		);
	});

	test('rejects non-Discord raw Hermes application secrets', () => {
		const config = createValidSystemConfigInput();
		const zone = configureFirstZoneAsHermes(config);
		zone.secrets = {
			API_SERVER_KEY_SHRAVAN: {
				source: 'environment',
				envVar: 'API_SERVER_KEY_SHRAVAN',
				injection: 'env',
				audience: 'gateway',
			},
			DISCORD_BOT_TOKEN_SHRAVAN: {
				source: 'environment',
				envVar: 'DISCORD_BOT_TOKEN_SHRAVAN',
				injection: 'env',
				audience: 'gateway',
			},
			UNMAPPED_APPLICATION_TOKEN: {
				source: 'environment',
				envVar: 'UNMAPPED_APPLICATION_TOKEN',
				injection: 'env',
				audience: 'gateway',
			},
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(
			/env secret 'UNMAPPED_APPLICATION_TOKEN'.*DISCORD_BOT_TOKEN/u,
		);
	});

	test('requires every authored Gateway-reaching mediated source to be assigned', () => {
		const config = createValidSystemConfigInput();
		const zone = configureFirstZoneAsHermes(config);
		zone.secrets.UNASSIGNED_PROVIDER_KEY = {
			source: 'environment',
			envVar: 'UNASSIGNED_PROVIDER_KEY',
			injection: 'http-mediation',
			audience: 'both',
			hosts: ['provider.example'],
			agentAccess: ['shravan'],
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(
			/UNASSIGNED_PROVIDER_KEY.*assigned to at least one Hermes profile/u,
		);
	});

	test('rejects config, reserved, raw non-Discord, and Tool-VM-only projection sources', () => {
		const invalidCases = [
			{
				sourceName: 'CONFIG_PROVIDER',
				targetName: 'OPENROUTER_API_KEY',
				secret: {
					source: 'config',
					value: 'not-admitted',
					injection: 'http-mediation',
					audience: 'gateway',
					hosts: ['openrouter.ai'],
				},
			},
			{
				sourceName: 'API_SERVER_KEY',
				targetName: 'OPENROUTER_API_KEY',
				secret: {
					source: 'environment',
					envVar: 'API_SERVER_KEY',
					injection: 'http-mediation',
					audience: 'gateway',
					hosts: ['openrouter.ai'],
				},
			},
			{
				sourceName: 'PYTHONWARNINGS',
				targetName: 'DISCORD_BOT_TOKEN',
				secret: {
					source: 'environment',
					envVar: 'PYTHONWARNINGS',
					injection: 'env',
					audience: 'gateway',
				},
			},
			{
				sourceName: 'LD_PRELOAD',
				targetName: 'OPENROUTER_API_KEY',
				secret: {
					source: 'environment',
					envVar: 'LD_PRELOAD',
					injection: 'http-mediation',
					audience: 'gateway',
					hosts: ['openrouter.ai'],
				},
			},
			{
				sourceName: 'PROFILE_PROVIDER_SOURCE_A',
				targetName: 'PYTHONIOENCODING',
				secret: {
					source: 'environment',
					envVar: 'PROFILE_PROVIDER_SOURCE_A',
					injection: 'http-mediation',
					audience: 'gateway',
					hosts: ['openrouter.ai'],
				},
			},
			{
				sourceName: 'PROFILE_PROVIDER_SOURCE_B',
				targetName: 'LD_AUDIT',
				secret: {
					source: 'environment',
					envVar: 'PROFILE_PROVIDER_SOURCE_B',
					injection: 'http-mediation',
					audience: 'gateway',
					hosts: ['openrouter.ai'],
				},
			},
			{
				sourceName: 'RAW_PROVIDER',
				targetName: 'OPENROUTER_API_KEY',
				secret: {
					source: 'environment',
					envVar: 'RAW_PROVIDER',
					injection: 'env',
					audience: 'gateway',
				},
			},
			{
				sourceName: 'TOOL_VM_PROVIDER',
				targetName: 'OPENROUTER_API_KEY',
				secret: {
					source: 'environment',
					envVar: 'TOOL_VM_PROVIDER',
					injection: 'http-mediation',
					audience: 'tool-vm',
					hosts: ['openrouter.ai'],
					agentAccess: ['shravan'],
				},
			},
		] as const;

		for (const invalidCase of invalidCases) {
			const config = createValidSystemConfigInput();
			const zone = configureFirstZoneAsHermes(config);
			zone.egressHosts = [
				...(zone.egressHosts ?? []),
				{ host: 'openrouter.ai', audience: 'gateway' },
			];
			zone.gateway.profileSecretProjectionsByAgent = {
				shravan: {
					API_SERVER_KEY: 'API_SERVER_KEY_SHRAVAN',
					DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_SHRAVAN',
					[invalidCase.targetName]: invalidCase.sourceName,
				},
			};
			zone.secrets[invalidCase.sourceName] = invalidCase.secret;

			expect(() => parseSystemConfigInputForTest(config)).toThrow(
				/config|reserved|http-mediation|Gateway-reaching|API_SERVER_KEY/u,
			);
		}
	});

	test('requires an explicit nonempty Hermes profile assignment for every configured agent', () => {
		const invalidAssignments = [
			undefined,
			{},
			{ shravan: 'researcher', extra: 'reviewer' },
			{ extra: 'reviewer' },
		] as const;

		for (const profilesByAgent of invalidAssignments) {
			const config = createValidSystemConfigInput();
			const zone = configureFirstZoneAsHermes(config);
			if (profilesByAgent === undefined) {
				delete zone.gateway.profilesByAgent;
			} else {
				zone.gateway.profilesByAgent = profilesByAgent;
			}

			expect(() => parseSystemConfigInputForTest(config)).toThrow(/profilesByAgent/u);
		}
	});

	test('rejects default, non-normalized, invalid, and colliding Hermes profile names', () => {
		const invalidAssignments = [
			{ shravan: 'default' },
			{ shravan: 'Researcher' },
			{ shravan: 'research.profile' },
			{ shravan: `r${'x'.repeat(64)}` },
			{ alpha: 'Builder', beta: 'builder' },
		] as const;

		for (const profilesByAgent of invalidAssignments) {
			const config = createValidSystemConfigInput();
			const zone = configureFirstZoneAsHermes(config);
			zone.agents = Object.keys(profilesByAgent).map((id) => ({ id }));
			zone.gateway.profilesByAgent = profilesByAgent;

			expect(() => parseSystemConfigInputForTest(config)).toThrow(
				/Hermes profile|profilesByAgent/u,
			);
		}
	});

	test('rejects duplicate Hermes profiles across distinct agents', () => {
		const config = createValidSystemConfigInput();
		const zone = configureFirstZoneAsHermes(config);
		zone.agents = [{ id: 'alpha' }, { id: 'beta' }];
		zone.gateway.profilesByAgent = { alpha: 'builder', beta: 'builder' };

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/assigned to multiple agents/u);
	});

	test('does not invent a managed base image for Hermes', () => {
		const config = createValidSystemConfigInput();
		configureFirstZoneAsHermes(config);
		const gatewayImageProfiles = config.imageProfiles.gateways;
		if (!isRecord(gatewayImageProfiles) || !isRecord(gatewayImageProfiles.hermes)) {
			throw new Error('Expected the Hermes image profile fixture.');
		}
		gatewayImageProfiles.hermes.source = {
			kind: 'managedBase',
			base: 'worker-gateway',
		};

		expect(() => parseSystemConfigInputForTest(config)).toThrow(/must not declare a managed base/u);
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

	test('rejects path-unsafe agent identifiers in per-agent maps', async () => {
		const config = createValidSystemConfigInput();
		if (config.zones[0].gateway.type !== 'hermes') {
			throw new Error('Expected OpenClaw fixture zone');
		}
		config.zones[0].gateway.profilesByAgent = { '../shravan': 'researcher' };
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

	test('rejects retired agentSandboxSeeds configuration', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0]['agentSandboxSeeds'] = {
			shravan: [
				{
					source: { source: 'environment', envVar: 'SHRAVAN_CONFIG' },
					target: '.config/example',
				},
			],
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-retired-agent-sandbox-seed-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/agentSandboxSeeds/u);
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

	test('rejects zones that reference unknown gateway image profiles', async () => {
		const config = createValidSystemConfigInput();
		config.zones = [
			{
				id: 'shravan',
				gateway: {
					type: 'hermes',
					profileSecretProjectionsByAgent: { main: {} },
					profilesByAgent: { main: 'main' },
					imageProfile: 'missing-openclaw',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: './shravan/openclaw.json',
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
					imageProfile: 'hermes',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: './shravan/worker.json',
				},
				secrets: {},
				runtimeAuthHints: [],
				egressHosts: ['discord.com'].map((host) => ({ host, audience: 'gateway' as const })),
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
					type: 'hermes',
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

	test.each(['cacheDir', 'controllerStateDir', 'runtimeDir'])(
		'rejects removed authored global storage field %s',
		async (removedField) => {
			// Arrange
			const config = createValidSystemConfigInput();
			config[removedField] = `../legacy-${removedField}`;
			const configPath = await writeSystemConfigForTest(
				'agent-vm-system-removed-global-storage-field-',
				config,
			);

			// Act / Assert
			await expect(loadSystemConfig(configPath)).rejects.toThrow(new RegExp(removedField, 'u'));
		},
	);

	test.each(['stateDir', 'zoneFilesDir'])(
		'rejects removed authored gateway storage field %s',
		async (removedField) => {
			// Arrange
			const config = createValidSystemConfigInput();
			config.zones[0].gateway[removedField] = `../legacy-${removedField}`;
			const configPath = await writeSystemConfigForTest(
				'agent-vm-system-removed-gateway-storage-field-',
				config,
			);

			// Act / Assert
			await expect(loadSystemConfig(configPath)).rejects.toThrow(new RegExp(removedField, 'u'));
		},
	);

	test.each(['cache', 'controller-state', 'controller-runtime'])(
		'rejects reserved global storage zone id %s',
		async (reservedZoneId) => {
			// Arrange
			const config = createValidSystemConfigInput();
			config.zones[0].id = reservedZoneId;
			const configPath = await writeSystemConfigForTest(
				'agent-vm-system-reserved-storage-zone-id-',
				config,
			);

			// Act / Assert
			await expect(loadSystemConfig(configPath)).rejects.toThrow(/reserved for global storage/u);
		},
	);

	test('rejects an explicit backupDir nested under stateDir', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].gateway.backupDir = '../storage/shravan/state/explicit-backups';
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-explicit-backup-state-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(
			/backupDir must not overlap stateDir/u,
		);
	});

	test('rejects an explicit backupDir that contains managed zoneFilesDir', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].gateway.backupDir = '../storage/shravan/zone-files/explicit-backups';
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-explicit-backup-zone-files-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(
			/backupDir must not overlap zoneFilesDir/u,
		);
	});

	test('preserves the implicit stateDir backups default', async () => {
		const config = createValidSystemConfigInput();
		delete config.zones[0].gateway.backupDir;
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-implicit-backup-state-',
			config,
		);

		const loadedConfig = await loadSystemConfig(configPath);

		expect(loadedConfig.zones[0]?.gateway.backupDir).toBeUndefined();
	});

	test('fails closed when storageRootDir traverses a broken symlink', async () => {
		// Arrange
		const testRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-storage-root-broken-'));
		createdDirectories.push(testRoot);
		const config = createValidSystemConfigInput();
		const brokenLinkPath = path.join(testRoot, 'broken-storage-root');
		config.storageRootDir = path.join(brokenLinkPath, 'deployment');
		await symlink(path.join(testRoot, 'missing-target'), brokenLinkPath);
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-config-broken-storage-root-',
			config,
		);

		// Act / Assert
		await expect(loadSystemConfig(configPath)).rejects.toThrow(/broken symlink/u);
	});

	test('parses host observability defaults without zone opt-in', async () => {
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
		expect(loadedConfig.host.observability).toMatchObject({
			enabled: true,
			stack: { mode: 'managed', scrubbing: { responsibility: 'agent-vm-managed-collector' } },
			runner: 'docker-compose',
			mode: 'collector',
			bindAddress: '127.0.0.1',
			prepareOnBuild: true,
			waitOnBuild: true,
			startupCheckTimeoutMs: 30_000,
		});
		expect(loadedHostObservability.dataDir).toBe(
			path.join(path.dirname(configPath), '..', 'observability'),
		);
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

	test.each(['framework', 'toolPortal'] as const)(
		'rejects an authored serviceName for the %s producer',
		async (producerName) => {
			const config = createValidSystemConfigInput();
			const observability = createZoneObservabilityInput();
			const services = observability.services as Record<string, Record<string, unknown>>;
			const producer = services[producerName];
			if (!producer) {
				throw new Error(`Expected ${producerName} producer config.`);
			}
			producer.serviceName = 'author-controlled-service-name';
			config.zones[0].observability = observability;
			const configPath = await writeSystemConfigForTest(
				'agent-vm-system-authored-observability-service-name-',
				config,
			);

			await expect(loadSystemConfig(configPath)).rejects.toThrow(/serviceName/u);
		},
	);

	test('rejects the pre-cutover flat producer keys', async () => {
		const config = createValidSystemConfigInput();
		config.zones[0].observability = {
			enabled: true,
			framework: {},
			services: { framework: {}, toolPortal: {} },
			toolPortal: {},
		};
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-flat-observability-producers-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/framework.*toolPortal/u);
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
		const artifactProperties = requireRecordProperty(artifact, 'properties');
		expect(artifactProperties).toMatchObject({
			storageRootDir: { minLength: 1, type: 'string' },
		});
		expect(artifactProperties.storageRootDir).not.toHaveProperty('default');
		expect(artifact.required).toEqual(expect.arrayContaining(['storageRootDir']));
		expect(artifactProperties).not.toHaveProperty('cacheDir');
		expect(artifactProperties).not.toHaveProperty('controllerStateDir');
		expect(artifactProperties).not.toHaveProperty('runtimeDir');
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

		const zonesSchema = requireRecordProperty(artifactProperties, 'zones');
		const zoneItemsSchema = requireRecordProperty(zonesSchema, 'items');
		const zoneProperties = requireRecordProperty(zoneItemsSchema, 'properties');
		const secretsSchema = requireRecordProperty(zoneProperties, 'secrets');
		const secretAdditionalProperties = requireRecordProperty(secretsSchema, 'additionalProperties');
		const secretVariants = requireArrayProperty(secretAdditionalProperties, 'anyOf');
		const mediatedSecretVariants = secretVariants.filter(
			(variant): variant is Record<string, unknown> => {
				if (!isRecord(variant)) {
					return false;
				}
				const variantProperties = requireRecordProperty(variant, 'properties');
				const injectionSchema = requireRecordProperty(variantProperties, 'injection');
				return readJsonSchemaStringConst(injectionSchema) === 'http-mediation';
			},
		);
		const toolVmMediatedSecretVariants = mediatedSecretVariants.filter((variant) => {
			const variantProperties = requireRecordProperty(variant, 'properties');
			const audienceSchema = requireRecordProperty(variantProperties, 'audience');
			return readJsonSchemaStringEnum(audienceSchema).join('|') === 'tool-vm|both';
		});
		const gatewayMediatedSecretVariants = mediatedSecretVariants.filter((variant) => {
			const variantProperties = requireRecordProperty(variant, 'properties');
			const audienceSchema = requireRecordProperty(variantProperties, 'audience');
			return readJsonSchemaStringConst(audienceSchema) === 'gateway';
		});
		expect(toolVmMediatedSecretVariants).toHaveLength(3);
		expect(gatewayMediatedSecretVariants).toHaveLength(3);
		for (const variant of toolVmMediatedSecretVariants) {
			const requiredProperties = requireArrayProperty(variant, 'required');
			const variantProperties = requireRecordProperty(variant, 'properties');
			expect(requiredProperties).toContain('agentAccess');
			expect(variantProperties.agentAccess).toBeDefined();
		}
		for (const variant of gatewayMediatedSecretVariants) {
			const requiredProperties = requireArrayProperty(variant, 'required');
			const variantProperties = requireRecordProperty(variant, 'properties');
			expect(requiredProperties).not.toContain('agentAccess');
			expect(variantProperties.agentAccess).toBeUndefined();
		}
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
		config.zones[0].observability = createZoneObservabilityInput();
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
		zone.observability = createZoneObservabilityInput();
		const configPath = await writeSystemConfigForTest(
			'agent-vm-system-worker-zone-observability-',
			config,
		);

		await expect(loadSystemConfig(configPath)).rejects.toThrow(/managed Hermes/u);
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
			const configPath = await writeSystemConfigForTest(
				'agent-vm-system-observability-retention-invalid-value-',
				config,
			);

			await expect(loadSystemConfig(configPath)).rejects.toThrow(messagePattern);
		},
	);

	test.each([
		['cacheDir', '../storage/cache/observability', /dataDir must not overlap cacheDir/u],
		[
			'controllerRuntimeDir',
			'../storage/controller-runtime/observability',
			/dataDir must not overlap controllerRuntimeDir/u,
		],
		['stateDir', '../storage/shravan/state/observability', /dataDir must not overlap stateDir/u],
		[
			'zoneFilesDir',
			'../storage/shravan/zone-files/observability',
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
