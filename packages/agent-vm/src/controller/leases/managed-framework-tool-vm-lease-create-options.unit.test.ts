import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import { resolveToolVmLeaseCompatibility } from './lease-manager.js';
import {
	createManagedFrameworkToolVmLeaseCreateOptionsResolver,
	type ManagedFrameworkToolVmLeaseAuthorityContext,
	type ResolveManagedFrameworkToolVmLeaseCreateOptionsInput,
} from './managed-framework-tool-vm-lease-create-options.js';

let testRoot: string;

const resolvedGatewayEpoch = {
	bootId: 'gateway-boot-a',
	controllerEpoch: 'controller-epoch-a',
	gatewayEpochId: 'gateway-epoch-a',
	gatewayVmId: 'gateway-vm-a',
	generationId: 'gateway-generation-a',
	zoneId: 'zone-a',
} satisfies GatewayEpochIdentity;

beforeEach(async () => {
	testRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-lease-create-options-'));
});

afterEach(async () => {
	await rm(testRoot, { force: true, recursive: true });
});

async function createSystemConfigFixture(
	leaseIdleTtl?: LoadedSystemConfig['leaseIdleTtl'],
): Promise<LoadedSystemConfig> {
	const stateDir = path.join(testRoot, 'zone-a', 'state');
	const zoneFilesDir = path.join(testRoot, 'zone-a', 'zone-files');
	const zoneRuntimeDir = path.join(testRoot, 'zone-a', 'runtime');
	await mkdir(path.join(zoneRuntimeDir, 'gitdirs', 'agents', 'main'), {
		recursive: true,
	});
	await mkdir(path.join(zoneFilesDir, 'agents', 'main'), { recursive: true });
	return {
		schemaVersion: 2,
		storageRootDir: testRoot,
		cacheDir: path.join(testRoot, 'cache'),
		controllerStateDir: path.join(testRoot, 'controller-state'),
		controllerRuntimeDir: path.join(testRoot, 'controller-runtime'),
		...(leaseIdleTtl === undefined ? {} : { leaseIdleTtl }),
		systemConfigPath: path.join(testRoot, 'config', 'system.json'),
		host: {
			controllerPort: 18_800,
			projectNamespace: 'lease-create-options-test',
			secretsProvider: {
				tokenSource: { envVar: 'OP_SERVICE_ACCOUNT_TOKEN', type: 'env' },
				type: '1password',
			},
		},
		controller: {
			health: {
				controlSessionDeathGraceMs: 600_000,
				enabled: true,
				eventHistoryLimit: 500,
				gatewayServiceAutoRestart: {
					channelProviderHealth: {
						consecutiveFailureThreshold: 3,
						enabled: true,
						restartGatewayOnRecoverable: true,
						restartGatewayOnUnrecoverable: false,
						transitioningTimeoutMs: 120_000,
					},
					cooldownMs: 3_660_000,
					consecutiveFailureThreshold: 10,
					enabled: true,
					failedRecoveryResetMs: 86_400_000,
					maxConsecutiveFailedRecoveries: 3,
					restartTimeoutMs: 600_000,
				},
				gatewayServiceIntervalMs: 10_000,
				staleAfterMs: 30_000,
			},
		},
		imageProfiles: {
			gateways: {
				openclaw: {
					buildConfig: './vm-images/gateways/openclaw/build-config.json',
					type: 'openclaw',
				},
			},
			toolVms: {
				default: {
					buildConfig: './vm-images/tool-vms/default/build-config.json',
					type: 'toolVm',
				},
			},
		},
		tcpPool: { basePort: 19_000, size: 5 },
		toolVmProfiles: {
			standard: {
				cpus: 1,
				imageProfile: 'default',
				memory: '1G',
			},
		},
		zones: [
			{
				agents: [{ id: 'main' }],
				agentToolVmProfiles: {},
				defaultToolVmProfile: 'standard',
				egressHosts: [],
				gateway: {
					config: path.join(testRoot, 'config', 'zone-a', 'openclaw.json'),
					controlAuth: {
						mode: 'token',
						secret: 'OPENCLAW_GATEWAY_TOKEN',
					},
					cpus: 2,
					imageProfile: 'openclaw',
					memory: '2G',
					port: 18_791,
					stateDir,
					type: 'openclaw',
					zoneFilesDir,
					zoneRuntimeDir,
				},
				id: 'zone-a',
				secrets: {
					OPENCLAW_GATEWAY_TOKEN: {
						audience: 'gateway',
						envVar: 'OPENCLAW_GATEWAY_TOKEN',
						injection: 'env',
						source: 'environment',
					},
				},
			},
		],
	} satisfies LoadedSystemConfig;
}

function configureFixtureAsHermes(systemConfig: LoadedSystemConfig): void {
	const zone = systemConfig.zones[0];
	if (zone === undefined) {
		throw new Error('Expected managed framework fixture zone');
	}
	const gateway = zone.gateway;
	systemConfig.zones[0] = {
		...zone,
		gateway: {
			config: gateway.config,
			cpus: gateway.cpus,
			imageProfile: 'hermes',
			memory: gateway.memory,
			port: gateway.port,
			profilesByAgent: { main: 'researcher' },
			profileSecretProjectionsByAgent: {
				main: {
					API_SERVER_KEY: 'API_SERVER_KEY_MAIN',
					DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN',
				},
			},
			stateDir: gateway.stateDir,
			type: 'hermes',
			zoneFilesDir:
				gateway.type === 'worker'
					? path.join(testRoot, 'zone-a', 'zone-files')
					: gateway.zoneFilesDir,
			zoneRuntimeDir: gateway.zoneRuntimeDir,
		},
		secrets: {
			...zone.secrets,
			API_SERVER_KEY_MAIN: {
				audience: 'gateway',
				envVar: 'API_SERVER_KEY_MAIN',
				injection: 'env',
				source: 'environment',
			},
		},
	};
}

const acceptedRuntimeSession = {
	bootId: 'gateway-boot-a',
	connectionId: '55555555-5555-4555-8555-555555555555',
	controllerEpoch: 'controller-epoch-a',
	peerId: 'gateway-zone-a',
	sessionId: '33333333-3333-4333-8333-333333333333',
	zoneId: 'zone-a',
} satisfies Omit<ManagedFrameworkToolVmLeaseAuthorityContext, 'agentId' | 'principal'>;

function authorityContextFor(options?: {
	readonly agentId?: string;
	readonly sessionId?: string;
	readonly zoneId?: string;
}): ManagedFrameworkToolVmLeaseAuthorityContext {
	const agentId = options?.agentId ?? 'main';
	return {
		...acceptedRuntimeSession,
		agentId,
		principal: {
			agentId,
			frameworkIdentity: { agentId, kind: 'openclaw' },
			profileAssignmentRevision: `assignment-${agentId}`,
			toolPortalProfileId: 'standard',
		},
		...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
		...(options?.zoneId === undefined ? {} : { zoneId: options.zoneId }),
	};
}

function leaseResolutionInput(options?: {
	readonly authorityContext?: ManagedFrameworkToolVmLeaseAuthorityContext;
	readonly expectedGateway?: GatewayEpochIdentity;
	readonly requestedIdleTtlMs?: number;
}): ResolveManagedFrameworkToolVmLeaseCreateOptionsInput {
	return {
		authorityContext: options?.authorityContext ?? authorityContextFor(),
		expectedGateway: options?.expectedGateway ?? resolvedGatewayEpoch,
		...(options?.requestedIdleTtlMs === undefined
			? {}
			: { requestedIdleTtlMs: options.requestedIdleTtlMs }),
	};
}

describe('createManagedFrameworkToolVmLeaseCreateOptionsResolver', () => {
	it('does not resolve or return a Git root when workspaceGit is absent', async () => {
		const systemConfig = await createSystemConfigFixture();
		await rm(path.join(testRoot, 'zone-a', 'runtime', 'gitdirs'), {
			force: true,
			recursive: true,
		});
		const resolveLeaseCreateOptions = createManagedFrameworkToolVmLeaseCreateOptionsResolver({
			systemConfig,
		});

		const options = await resolveLeaseCreateOptions(leaseResolutionInput());

		expect(options).not.toHaveProperty('hostGitDirectoryRoot');
		await expect(
			realpath(path.join(testRoot, 'zone-a', 'runtime', 'gitdirs')),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('uses the system leaseIdleTtl policy for gateway-control lease creation', async () => {
		const systemConfig = await createSystemConfigFixture({
			defaultMs: 42_000,
			maxRequestedMs: 60_000,
			minRequestedMs: 5_000,
		});
		const resolveLeaseCreateOptions = createManagedFrameworkToolVmLeaseCreateOptionsResolver({
			systemConfig,
		});

		const options = await resolveLeaseCreateOptions(leaseResolutionInput());
		const requestedPolicyOptions = await resolveLeaseCreateOptions(
			leaseResolutionInput({ requestedIdleTtlMs: 50_000 }),
		);

		expect(options.effectiveIdleTtlMs).toBe(42_000);
		expect(requestedPolicyOptions.effectiveIdleTtlMs).toBe(50_000);
		expect(resolveToolVmLeaseCompatibility(requestedPolicyOptions).policyFingerprint).not.toBe(
			resolveToolVmLeaseCompatibility(options).policyFingerprint,
		);
		await expect(
			resolveLeaseCreateOptions(leaseResolutionInput({ requestedIdleTtlMs: 90_000 })),
		).rejects.toThrow(/at most 60000ms/u);
	});

	it('resolves agent-specific Tool VM profiles for declared same-zone managed agents', async () => {
		const systemConfig = await createSystemConfigFixture();
		const zone = systemConfig.zones[0];
		if (zone === undefined) {
			throw new Error('Expected OpenClaw fixture zone');
		}
		await mkdir(path.join(testRoot, 'zone-a', 'zone-files', 'agents', 'second'), {
			recursive: true,
		});
		await mkdir(path.join(testRoot, 'zone-a', 'runtime', 'gitdirs', 'agents', 'second'), {
			recursive: true,
		});
		zone.agents = [{ id: 'main' }, { id: 'second', workspaceGit: { mode: 'local' } }];
		zone.agentToolVmProfiles = { second: 'larger' };
		systemConfig.toolVmProfiles.larger = {
			cpus: 4,
			imageProfile: 'default',
			memory: '4G',
		};
		const resolveLeaseCreateOptions = createManagedFrameworkToolVmLeaseCreateOptionsResolver({
			systemConfig,
		});

		const options = await resolveLeaseCreateOptions(
			leaseResolutionInput({
				authorityContext: authorityContextFor({ agentId: 'second' }),
			}),
		);

		expect(options.agentId).toBe('second');
		expect(options.profileId).toBe('larger');
		expect(options.profile).toEqual({
			cpus: 4,
			imageProfile: 'default',
			memory: '4G',
		});
		expect(options.guestWorkdir).toBe('/work');
		await expect(
			realpath(path.join(testRoot, 'zone-a', 'runtime', 'gitdirs', 'agents', 'second')),
		).resolves.toBe(options.hostGitDirectoryRoot);
		expect(options).not.toHaveProperty('zoneGitMount');
		expect(options).not.toHaveProperty('gatewaySelfRoot');
		expect(options).not.toHaveProperty('gatewayWorkMountDir');
		expect(resolveToolVmLeaseCompatibility(options)).toMatchObject({
			profileId: 'larger',
			profileAssignmentRevision: 'assignment-second',
			purpose: 'tool_vm_lease',
		});
		await expect(
			realpath(path.join(testRoot, 'zone-a', 'zone-files', 'agents', 'second')),
		).resolves.toBe(options.hostWorkspaceRoot);
	});

	it('resolves the same per-agent workspace, Gitdir, profile, and TTL for Hermes', async () => {
		const systemConfig = await createSystemConfigFixture({
			defaultMs: 42_000,
			maxRequestedMs: 60_000,
			minRequestedMs: 5_000,
		});
		configureFixtureAsHermes(systemConfig);
		const hermesZone = systemConfig.zones[0];
		if (hermesZone === undefined) {
			throw new Error('Expected Hermes fixture zone');
		}
		hermesZone.agents = [{ id: 'main', workspaceGit: { mode: 'local' } }];
		const resolveLeaseCreateOptions = createManagedFrameworkToolVmLeaseCreateOptionsResolver({
			systemConfig,
		});
		const hermesAuthorityContext = {
			...authorityContextFor(),
			principal: {
				agentId: 'main',
				frameworkIdentity: { kind: 'hermes', profileName: 'researcher' },
				profileAssignmentRevision: 'assignment-main',
				toolPortalProfileId: 'standard',
			},
		} satisfies ManagedFrameworkToolVmLeaseAuthorityContext;

		const options = await resolveLeaseCreateOptions(
			leaseResolutionInput({
				authorityContext: hermesAuthorityContext,
				requestedIdleTtlMs: 50_000,
			}),
		);

		expect(options).toMatchObject({
			agentId: 'main',
			effectiveIdleTtlMs: 50_000,
			guestWorkdir: '/work',
			profileId: 'standard',
			principal: hermesAuthorityContext.principal,
			zoneId: 'zone-a',
		});
		await expect(
			realpath(path.join(testRoot, 'zone-a', 'zone-files', 'agents', 'main')),
		).resolves.toBe(options.hostWorkspaceRoot);
		await expect(
			realpath(path.join(testRoot, 'zone-a', 'runtime', 'gitdirs', 'agents', 'main')),
		).resolves.toBe(options.hostGitDirectoryRoot);
	});

	it('ignores retired caller path fields and derives workspace authority from zone policy', async () => {
		const systemConfig = await createSystemConfigFixture();
		const zone = systemConfig.zones[0];
		if (zone === undefined) {
			throw new Error('Expected OpenClaw fixture zone');
		}
		await mkdir(path.join(testRoot, 'zone-a', 'zone-files', 'agents', 'second'), {
			recursive: true,
		});
		await mkdir(path.join(testRoot, 'zone-a', 'runtime', 'gitdirs', 'agents', 'second'), {
			recursive: true,
		});
		zone.agents = [{ id: 'main' }, { id: 'second' }];
		const resolveLeaseCreateOptions = createManagedFrameworkToolVmLeaseCreateOptionsResolver({
			systemConfig,
		});

		const callerContextWithRetiredPaths = {
			...authorityContextFor({ agentId: 'second' }),
			agentWorkspaceDir: '/host/caller-selected-self',
			workMountDir: '/host/caller-selected-work',
		} as unknown as ManagedFrameworkToolVmLeaseAuthorityContext;

		const options = await resolveLeaseCreateOptions(
			leaseResolutionInput({ authorityContext: callerContextWithRetiredPaths }),
		);

		await expect(
			realpath(path.join(testRoot, 'zone-a', 'zone-files', 'agents', 'second')),
		).resolves.toBe(options.hostWorkspaceRoot);
		expect(options.hostWorkspaceRoot).not.toContain('caller-selected');
	});

	it('does not treat stale runtime status as lease authority', async () => {
		const systemConfig = await createSystemConfigFixture();
		const resolveLeaseCreateOptions = createManagedFrameworkToolVmLeaseCreateOptionsResolver({
			systemConfig,
		});

		await expect(
			resolveLeaseCreateOptions(
				leaseResolutionInput({
					authorityContext: authorityContextFor({
						sessionId: '99999999-9999-4999-8999-999999999999',
					}),
				}),
			),
		).resolves.toEqual(expect.objectContaining({ expectedGateway: resolvedGatewayEpoch }));
	});

	it('does not trust a gateway-supplied profileId when zone policy has no profile mapping', async () => {
		const systemConfig = await createSystemConfigFixture();
		const zoneWithoutProfilePolicy = systemConfig.zones[0];
		if (zoneWithoutProfilePolicy === undefined) {
			throw new Error('Expected OpenClaw fixture zone');
		}
		delete zoneWithoutProfilePolicy.agentToolVmProfiles;
		delete zoneWithoutProfilePolicy.defaultToolVmProfile;
		const resolveLeaseCreateOptions = createManagedFrameworkToolVmLeaseCreateOptionsResolver({
			systemConfig,
		});

		await expect(resolveLeaseCreateOptions(leaseResolutionInput())).rejects.toThrow(
			/does not have a tool VM profile configured/u,
		);
	});

	it('rejects caller context for an undeclared managed zone agent', async () => {
		const systemConfig = await createSystemConfigFixture();
		const zone = systemConfig.zones[0];
		if (zone === undefined) {
			throw new Error('Expected OpenClaw fixture zone');
		}
		const resolveLeaseCreateOptions = createManagedFrameworkToolVmLeaseCreateOptionsResolver({
			systemConfig,
		});

		await expect(
			resolveLeaseCreateOptions(
				leaseResolutionInput({
					authorityContext: authorityContextFor({ agentId: 'victim' }),
				}),
			),
		).rejects.toThrow(/does not declare managed agent 'victim'/u);
	});

	it('rejects Worker zones without managed framework lease semantics', async () => {
		const systemConfig = await createSystemConfigFixture();
		const zone = systemConfig.zones[0];
		if (zone === undefined) {
			throw new Error('Expected managed framework fixture zone');
		}
		systemConfig.zones[0] = {
			...zone,
			gateway: {
				config: './config/worker.json',
				cpus: 2,
				imageProfile: 'worker',
				memory: '2G',
				port: 18_792,
				stateDir: path.join(testRoot, 'zone-a', 'state'),
				type: 'worker',
				zoneRuntimeDir: path.join(testRoot, 'zone-a', 'runtime'),
			},
		};
		const resolveLeaseCreateOptions = createManagedFrameworkToolVmLeaseCreateOptionsResolver({
			systemConfig,
		});

		await expect(resolveLeaseCreateOptions(leaseResolutionInput())).rejects.toThrow(
			/does not support managed framework Tool VM leases/u,
		);
	});

	it('uses runtime status only for health and preserves controller-resolved Gateway authority', async () => {
		const systemConfig = await createSystemConfigFixture();
		const controllerResolvedGateway = {
			...resolvedGatewayEpoch,
			gatewayEpochId: 'gateway-epoch-controller-resolved',
			gatewayVmId: 'gateway-vm-controller-resolved',
			generationId: 'gateway-generation-controller-resolved',
		} satisfies GatewayEpochIdentity;
		const resolveLeaseCreateOptions = createManagedFrameworkToolVmLeaseCreateOptionsResolver({
			systemConfig,
		});

		const options = await resolveLeaseCreateOptions(
			leaseResolutionInput({ expectedGateway: controllerResolvedGateway }),
		);

		expect(options.expectedGateway).toEqual(controllerResolvedGateway);
	});
});
