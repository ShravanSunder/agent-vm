import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import { writeMcpPortalEffectiveConfig } from '../../gateway/mcp-portal-effective-config.js';
import type {
	GatewayControlAcceptedSessionRef,
	GatewayControlTrustedCallerContext,
} from './gateway-control-caller-context.js';
import { authorizeGatewayControlControllerHostAction } from './gateway-control-controller-host-action-authorization.js';

let testRoot: string;
let previousControllerHostProbeGate: string | undefined;

beforeEach(async () => {
	testRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-controller-host-action-auth-'));
	previousControllerHostProbeGate = process.env.AGENT_VM_E2E_CONTROLLER_HOST_PROBE;
	delete process.env.AGENT_VM_E2E_CONTROLLER_HOST_PROBE;
});

afterEach(async () => {
	if (previousControllerHostProbeGate === undefined) {
		delete process.env.AGENT_VM_E2E_CONTROLLER_HOST_PROBE;
	} else {
		process.env.AGENT_VM_E2E_CONTROLLER_HOST_PROBE = previousControllerHostProbeGate;
	}
	await rm(testRoot, { force: true, recursive: true });
});

const acceptedSession = {
	bootId: 'gateway-boot-a',
	controllerEpoch: 'epoch-a',
	peerId: 'gateway-zone-a',
	zoneId: 'zone-a',
} satisfies GatewayControlAcceptedSessionRef;

const trustedCallerContext = {
	agentId: 'main',
	agentWorkspaceDir: '/home/openclaw/workspace',
	bootId: acceptedSession.bootId,
	callerContextId: '44444444-4444-4444-8444-444444444444',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: acceptedSession.controllerEpoch,
	peerId: acceptedSession.peerId,
	purpose: 'tool_portal_controller_host_action',
	sessionId: '33333333-3333-4333-8333-333333333333',
	sessionKeyDigest: 'digestdigestdigestdigestdigestdigestdigestdigest',
	stablePrincipal: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
	zoneId: acceptedSession.zoneId,
} satisfies GatewayControlTrustedCallerContext;

const noSecretResolutionDuringTest = {
	resolve: async () => {
		throw new Error('test authorization fixture must not resolve secrets');
	},
	resolveAll: async () => ({}),
};

async function writeToolPortalAuthoredConfig(
	props: {
		readonly agentId?: string;
		readonly controllerHostActionTools?: readonly ('controller_host_probe' | 'zone_git_push')[];
		readonly controllerHostActionPolicy?: boolean;
		readonly profileId?: string;
	} = {},
): Promise<string> {
	const configDir = path.join(testRoot, 'gateway-config');
	const agentId = props.agentId ?? 'main';
	const controllerHostActionTools = props.controllerHostActionTools ?? ['zone_git_push'];
	const controllerHostActionPolicy = props.controllerHostActionPolicy ?? true;
	const profileId = props.profileId ?? 'default';
	const namespaces = controllerHostActionPolicy
		? {
				controller_host_action: {
					calls: {
						requiresApproval: { allow: [] },
						withoutApproval: { allow: controllerHostActionTools },
					},
					tools: { allow: controllerHostActionTools },
				},
			}
		: {};
	await mkdir(configDir, { recursive: true });
	await writeFile(
		path.join(configDir, 'mcp.config.jsonc'),
		`${JSON.stringify({ providers: {}, schemaVersion: 1 }, null, '\t')}\n`,
		'utf8',
	);
	await writeFile(
		path.join(configDir, 'mcp-portal.config.jsonc'),
		`${JSON.stringify(
			{
				agents: { [agentId]: { profile: profileId } },
				profiles: {
					[profileId]: {
						namespaces,
					},
				},
				schemaVersion: 1,
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	return configDir;
}

async function createSystemConfigFixture(
	options: {
		readonly configDir?: string;
		readonly zoneGit?: boolean;
		readonly toolPortal?: boolean;
	} = {},
): Promise<LoadedSystemConfig> {
	const configDir = options.configDir ?? (await writeToolPortalAuthoredConfig());
	return {
		cacheDir: path.join(testRoot, 'cache'),
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
		host: {
			controllerPort: 18_800,
			projectNamespace: 'controller-host-action-auth-test',
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
		runtimeDir: path.join(testRoot, 'runtime'),
		schemaVersion: 1,
		systemConfigPath: path.join(testRoot, 'config', 'system.jsonc'),
		tcpPool: { basePort: 19_000, size: 5 },
		toolVmProfiles: {},
		zones: [
			{
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
					stateDir: path.join(testRoot, 'state', 'zone-a'),
					type: 'openclaw',
					zoneFilesDir: path.join(testRoot, 'zone-files', 'zone-a'),
					...(options.zoneGit === false
						? {}
						: {
								zoneGit: {
									remote: {
										branch: 'agent/zone-files',
										defaultBranch: 'main',
										protectedBranches: ['main'],
										protectedBranchPatterns: ['release/*'],
										repoUrl: 'git@example.com:repo.git',
									},
								},
							}),
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
				...(options.toolPortal === false ? {} : { toolPortal: { configDir } }),
			},
		],
	} satisfies LoadedSystemConfig;
}

async function writeEffectiveToolPortalSnapshot(systemConfig: LoadedSystemConfig): Promise<void> {
	const zone = systemConfig.zones.find(
		(configuredZone) => configuredZone.id === acceptedSession.zoneId,
	);
	if (zone === undefined || zone.toolPortal === undefined) {
		throw new Error('test fixture expected a Tool Portal zone');
	}
	await writeMcpPortalEffectiveConfig({
		allowedRawEnvSecretNames: ['OPENCLAW_GATEWAY_TOKEN'],
		authoredConfigDir: zone.toolPortal.configDir,
		effectiveHostConfigDir: path.join(
			systemConfig.cacheDir,
			'gateways',
			acceptedSession.zoneId,
			'tool-portal-effective',
		),
		effectiveVmConfigDir: '/home/openclaw/.openclaw/cache/tool-portal-effective',
		includeZoneGitControllerHostAction: true,
		secretResolver: noSecretResolutionDuringTest,
		zoneId: acceptedSession.zoneId,
	});
}

function createZoneGitPushPayload(
	overrides: {
		readonly capabilityName?: string;
		readonly capabilityNamespace?: string;
	} = {},
): {
	readonly actionId: 'zone_git_push';
	readonly callerContext: {
		readonly callerContextId: string;
	};
	readonly correlation: {
		readonly capability: {
			readonly name: string;
			readonly namespace: string;
		};
	};
	readonly expectedHead: string;
} {
	return {
		actionId: 'zone_git_push' as const,
		callerContext: {
			callerContextId: trustedCallerContext.callerContextId,
		},
		correlation: {
			capability: {
				name: overrides.capabilityName ?? 'zone_git_push',
				namespace: overrides.capabilityNamespace ?? 'controller_host_action',
			},
		},
		expectedHead: 'abc123',
	};
}

function createControllerHostProbePayload(
	overrides: {
		readonly capabilityName?: string;
		readonly capabilityNamespace?: string;
	} = {},
): {
	readonly actionId: 'controller_host_probe';
	readonly callerContext: {
		readonly callerContextId: string;
	};
	readonly correlation: {
		readonly capability: {
			readonly name: string;
			readonly namespace: string;
		};
	};
} {
	return {
		actionId: 'controller_host_probe' as const,
		callerContext: {
			callerContextId: trustedCallerContext.callerContextId,
		},
		correlation: {
			capability: {
				name: overrides.capabilityName ?? 'controller_host_probe',
				namespace: overrides.capabilityNamespace ?? 'controller_host_action',
			},
		},
	};
}

describe('authorizeGatewayControlControllerHostAction', () => {
	it('authorizes zone_git_push from the controller-derived Tool Portal projection', async () => {
		const systemConfig = await createSystemConfigFixture();
		await writeEffectiveToolPortalSnapshot(systemConfig);

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createZoneGitPushPayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({ authorized: true });
	});

	it('authorizes controller_host_probe from explicit policy when the e2e probe gate is enabled', async () => {
		process.env.AGENT_VM_E2E_CONTROLLER_HOST_PROBE = '1';
		const systemConfig = await createSystemConfigFixture({
			configDir: await writeToolPortalAuthoredConfig({
				controllerHostActionTools: ['zone_git_push', 'controller_host_probe'],
			}),
			zoneGit: false,
		});
		await writeEffectiveToolPortalSnapshot(systemConfig);

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createControllerHostProbePayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({ authorized: true });
	});

	it('rejects controller_host_probe when the e2e probe gate is disabled', async () => {
		const systemConfig = await createSystemConfigFixture({
			configDir: await writeToolPortalAuthoredConfig({
				controllerHostActionTools: ['zone_git_push', 'controller_host_probe'],
			}),
			zoneGit: false,
		});
		await writeEffectiveToolPortalSnapshot(systemConfig);

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createControllerHostProbePayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({
			authorized: false,
			errorClass: 'controller_host_action_not_configured',
			safeMessage: 'controller host probe is not enabled',
		});
	});

	it('rejects controller_host_probe when capability name does not match the payload action', async () => {
		process.env.AGENT_VM_E2E_CONTROLLER_HOST_PROBE = '1';
		const systemConfig = await createSystemConfigFixture();

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createControllerHostProbePayload({ capabilityName: 'zone_git_push' }),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({
			authorized: false,
			errorClass: 'controller_host_action_capability_mismatch',
			safeMessage: 'controller host action capability is not authorized',
		});
	});

	it('authorizes from the controller-owned effective Tool Portal snapshot instead of mutable authored files', async () => {
		const configDir = await writeToolPortalAuthoredConfig({ controllerHostActionPolicy: false });
		const systemConfig = await createSystemConfigFixture({ configDir });
		await writeEffectiveToolPortalSnapshot(systemConfig);
		await writeToolPortalAuthoredConfig({ controllerHostActionPolicy: true });

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createZoneGitPushPayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({
			authorized: false,
			errorClass: 'controller_host_action_policy_denied',
			safeMessage: 'controller host action policy denied the requested capability',
		});
	});

	it('rejects forged capability selectors before controller execution', async () => {
		const systemConfig = await createSystemConfigFixture();

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createZoneGitPushPayload({ capabilityNamespace: 'mcp_provider' }),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({
			authorized: false,
			errorClass: 'controller_host_action_capability_mismatch',
			safeMessage: 'controller host action capability is not authorized',
		});
	});

	it('rejects missing capability correlation before controller execution', async () => {
		const systemConfig = await createSystemConfigFixture();

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: {
					...createZoneGitPushPayload(),
					correlation: {
						toolCallId: 'tool-call-without-capability',
					},
				},
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({
			authorized: false,
			errorClass: 'controller_host_action_capability_mismatch',
			safeMessage: 'controller host action capability is not authorized',
		});
	});

	it('rejects undeclared trusted caller-context agents from controller config', async () => {
		const systemConfig = await createSystemConfigFixture();
		await writeEffectiveToolPortalSnapshot(systemConfig);

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: {
					...trustedCallerContext,
					agentId: 'forged-agent',
					callerContextId: '55555555-5555-4555-8555-555555555555',
				},
				payload: createZoneGitPushPayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({
			authorized: false,
			errorClass: 'controller_host_action_policy_denied',
			safeMessage: 'controller host action policy denied the requested capability',
		});
	});

	it('rejects with policy unavailable when the effective Tool Portal snapshot cannot be loaded', async () => {
		const systemConfig = await createSystemConfigFixture();

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createZoneGitPushPayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({
			authorized: false,
			errorClass: 'controller_host_action_policy_unavailable',
			safeMessage: 'controller host action policy is unavailable',
		});
	});

	it('rejects zones without Tool Portal controller host action configuration', async () => {
		const systemConfig = await createSystemConfigFixture({ toolPortal: false });

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createZoneGitPushPayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({
			authorized: false,
			errorClass: 'controller_host_action_not_configured',
			safeMessage: 'controller host action is not configured for this zone',
		});
	});

	it('rejects zones without effective Tool Portal controller host action policy', async () => {
		const systemConfig = await createSystemConfigFixture({
			configDir: await writeToolPortalAuthoredConfig({ controllerHostActionPolicy: false }),
		});
		await writeEffectiveToolPortalSnapshot(systemConfig);

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createZoneGitPushPayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({
			authorized: false,
			errorClass: 'controller_host_action_policy_denied',
			safeMessage: 'controller host action policy denied the requested capability',
		});
	});
});
