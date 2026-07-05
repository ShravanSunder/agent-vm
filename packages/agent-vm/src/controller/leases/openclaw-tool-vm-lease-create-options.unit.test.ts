import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import { OpenClawRuntimeStatusStore } from '../openclaw-runtime-status.js';
import { createOpenClawToolVmLeaseCreateOptionsResolver } from './openclaw-tool-vm-lease-create-options.js';

let testRoot: string;

beforeEach(async () => {
	testRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-lease-create-options-'));
});

afterEach(async () => {
	await rm(testRoot, { force: true, recursive: true });
});

async function createSystemConfigFixture(
	leaseIdleTtl?: LoadedSystemConfig['leaseIdleTtl'],
): Promise<LoadedSystemConfig> {
	const stateDir = path.join(testRoot, 'state', 'zone-a');
	const zoneFilesDir = path.join(testRoot, 'zone-files', 'zone-a');
	await mkdir(path.join(stateDir, 'sandboxes', 'main', 'work'), { recursive: true });
	await mkdir(zoneFilesDir, { recursive: true });
	return {
		schemaVersion: 1,
		cacheDir: path.join(testRoot, 'cache'),
		...(leaseIdleTtl === undefined ? {} : { leaseIdleTtl }),
		runtimeDir: path.join(testRoot, 'runtime'),
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

function recordFreshRuntimeStatus(store: OpenClawRuntimeStatusStore): void {
	store.record({
		findings: [{ hint: 'ok', id: 'tool-vm-runtime-config', ok: true }],
		pluginId: 'gondolin',
		zoneId: 'zone-a',
	});
}

describe('createOpenClawToolVmLeaseCreateOptionsResolver', () => {
	it('uses the system leaseIdleTtl policy for gateway-control lease creation', async () => {
		const systemConfig = await createSystemConfigFixture({
			defaultMs: 42_000,
			maxRequestedMs: 60_000,
			minRequestedMs: 5_000,
		});
		const openClawRuntimeStatusStore = new OpenClawRuntimeStatusStore();
		recordFreshRuntimeStatus(openClawRuntimeStatusStore);
		const resolveLeaseCreateOptions = createOpenClawToolVmLeaseCreateOptionsResolver({
			openClawRuntimeStatusStore,
			systemConfig,
		});

		const options = await resolveLeaseCreateOptions({
			authorityContext: {
				agentId: 'main',
				agentWorkspaceDir: '/zone/agents/main',
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
				zoneId: 'zone-a',
			},
		});

		expect(options.effectiveIdleTtlMs).toBe(42_000);
		await expect(
			resolveLeaseCreateOptions({
				authorityContext: {
					agentId: 'main',
					agentWorkspaceDir: '/zone/agents/main',
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
					zoneId: 'zone-a',
				},
				requestedIdleTtlMs: 90_000,
			}),
		).rejects.toThrow(/at most 60000ms/u);
	});

	it('resolves agent-specific Tool VM profiles for declared same-zone OpenClaw agents', async () => {
		const systemConfig = await createSystemConfigFixture();
		const zone = systemConfig.zones[0];
		if (zone === undefined) {
			throw new Error('Expected OpenClaw fixture zone');
		}
		await mkdir(path.join(testRoot, 'state', 'zone-a', 'sandboxes', 'second', 'work'), {
			recursive: true,
		});
		zone.agents = [{ id: 'main' }, { id: 'second' }];
		zone.agentToolVmProfiles = { second: 'larger' };
		systemConfig.toolVmProfiles.larger = {
			cpus: 4,
			imageProfile: 'default',
			memory: '4G',
		};
		const openClawRuntimeStatusStore = new OpenClawRuntimeStatusStore();
		recordFreshRuntimeStatus(openClawRuntimeStatusStore);
		const resolveLeaseCreateOptions = createOpenClawToolVmLeaseCreateOptionsResolver({
			openClawRuntimeStatusStore,
			systemConfig,
		});

		const options = await resolveLeaseCreateOptions({
			authorityContext: {
				agentId: 'second',
				agentWorkspaceDir: '/zone/agents/second',
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/second/work',
				zoneId: 'zone-a',
			},
		});

		expect(options.agentId).toBe('second');
		expect(options.profileId).toBe('larger');
		expect(options.profile).toEqual({
			cpus: 4,
			imageProfile: 'default',
			memory: '4G',
		});
		await expect(
			realpath(path.join(testRoot, 'state', 'zone-a', 'sandboxes', 'second', 'work')),
		).resolves.toBe(options.hostWorkMountDir);
	});

	it('rejects noncanonical caller context workspaces before lease ownership is stored', async () => {
		const systemConfig = await createSystemConfigFixture();
		const zone = systemConfig.zones[0];
		if (zone === undefined) {
			throw new Error('Expected OpenClaw fixture zone');
		}
		await mkdir(path.join(testRoot, 'state', 'zone-a', 'sandboxes', 'second', 'work'), {
			recursive: true,
		});
		zone.agents = [{ id: 'main' }, { id: 'second' }];
		const openClawRuntimeStatusStore = new OpenClawRuntimeStatusStore();
		recordFreshRuntimeStatus(openClawRuntimeStatusStore);
		const resolveLeaseCreateOptions = createOpenClawToolVmLeaseCreateOptionsResolver({
			openClawRuntimeStatusStore,
			systemConfig,
		});

		await expect(
			resolveLeaseCreateOptions({
				authorityContext: {
					agentId: 'second',
					agentWorkspaceDir: '/home/openclaw/workspace-second',
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/second/work',
					zoneId: 'zone-a',
				},
			}),
		).rejects.toThrow(/agentWorkspaceDir/u);
	});

	it('does not trust a gateway-supplied profileId when zone policy has no profile mapping', async () => {
		const systemConfig = await createSystemConfigFixture();
		const zoneWithoutProfilePolicy = systemConfig.zones[0];
		if (zoneWithoutProfilePolicy === undefined) {
			throw new Error('Expected OpenClaw fixture zone');
		}
		delete zoneWithoutProfilePolicy.agentToolVmProfiles;
		delete zoneWithoutProfilePolicy.defaultToolVmProfile;
		const openClawRuntimeStatusStore = new OpenClawRuntimeStatusStore();
		recordFreshRuntimeStatus(openClawRuntimeStatusStore);
		const resolveLeaseCreateOptions = createOpenClawToolVmLeaseCreateOptionsResolver({
			openClawRuntimeStatusStore,
			systemConfig,
		});

		await expect(
			resolveLeaseCreateOptions({
				authorityContext: {
					agentId: 'main',
					agentWorkspaceDir: '/zone/agents/main',
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
					zoneId: 'zone-a',
				},
			}),
		).rejects.toThrow(/does not have a tool VM profile configured/u);
	});

	it('rejects caller context for an undeclared OpenClaw zone agent', async () => {
		const systemConfig = await createSystemConfigFixture();
		const zone = systemConfig.zones[0];
		if (zone === undefined) {
			throw new Error('Expected OpenClaw fixture zone');
		}
		const openClawRuntimeStatusStore = new OpenClawRuntimeStatusStore();
		recordFreshRuntimeStatus(openClawRuntimeStatusStore);
		const resolveLeaseCreateOptions = createOpenClawToolVmLeaseCreateOptionsResolver({
			openClawRuntimeStatusStore,
			systemConfig,
		});

		await expect(
			resolveLeaseCreateOptions({
				authorityContext: {
					agentId: 'victim',
					agentWorkspaceDir: '/home/openclaw/workspace',
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
					zoneId: 'zone-a',
				},
			}),
		).rejects.toThrow(/does not declare OpenClaw agent 'victim'/u);
	});
});
