import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	GatewayControlWorkspaceGitPushControllerHostActionPayloadSchema,
	type GatewayRuntimeControllerHostActionDispatchReservation,
} from '@agent-vm/gateway-control-contracts';
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

const trustedPrincipal = {
	agentId: 'main',
	frameworkIdentity: { agentId: 'main', kind: 'openclaw' },
	profileAssignmentRevision: 'assignment-main',
	toolPortalProfileId: 'default',
} as const;

const trustedCallerContext = {
	agentId: 'main',
	bootId: acceptedSession.bootId,
	callerContextId: '44444444-4444-4444-8444-444444444444',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: acceptedSession.controllerEpoch,
	peerId: acceptedSession.peerId,
	principal: trustedPrincipal,
	purpose: 'tool_portal_controller_host_action',
	sessionId: '33333333-3333-4333-8333-333333333333',
	stablePrincipal: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
		readonly controllerHostActionTools?: readonly (
			| 'controller_host_probe'
			| 'workspace_git_push'
		)[];
		readonly controllerHostActionPolicy?: boolean;
		readonly profileId?: string;
		readonly requiresApproval?: boolean;
	} = {},
): Promise<string> {
	const configDir = path.join(testRoot, 'gateway-config');
	const agentId = props.agentId ?? 'main';
	const controllerHostActionTools = props.controllerHostActionTools ?? ['workspace_git_push'];
	const controllerHostActionPolicy = props.controllerHostActionPolicy ?? true;
	const profileId = props.profileId ?? 'default';
	const requiresApproval = props.requiresApproval ?? false;
	const namespaces = controllerHostActionPolicy
		? {
				controller_host_action: {
					backend: { kind: 'controller_host_action' },
					calls: {
						requiresApproval: {
							allow: requiresApproval ? controllerHostActionTools : [],
						},
						withoutApproval: {
							allow: requiresApproval ? [] : controllerHostActionTools,
						},
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
		path.join(configDir, 'tool-portal.config.jsonc'),
		`${JSON.stringify(
			{
				agents: { [agentId]: { profile: profileId } },
				mode: 'managed',
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
		readonly workspaceGit?: boolean;
		readonly toolPortal?: boolean;
	} = {},
): Promise<LoadedSystemConfig> {
	const configDir = options.configDir ?? (await writeToolPortalAuthoredConfig());
	return {
		storageRootDir: testRoot,
		cacheDir: path.join(testRoot, 'cache'),
		controllerStateDir: path.join(testRoot, 'controller-state'),
		controllerRuntimeDir: path.join(testRoot, 'controller-runtime'),
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
		schemaVersion: 2,
		systemConfigPath: path.join(testRoot, 'config', 'system.jsonc'),
		tcpPool: { basePort: 19_000, size: 5 },
		toolVmProfiles: {},
		zones: [
			{
				agents: [
					{
						id: trustedCallerContext.agentId,
						...(options.workspaceGit === false
							? {}
							: {
									workspaceGit: {
										mode: 'remote' as const,
										remote: {
											branch: 'agent/workspace',
											defaultBranch: 'main',
											repoUrl: 'example/repo',
										},
									},
								}),
					},
				],
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
					stateDir: path.join(testRoot, 'zone-a', 'state'),
					type: 'openclaw',
					zoneFilesDir: path.join(testRoot, 'zone-a', 'zone-files'),
					zoneRuntimeDir: path.join(testRoot, 'zone-a', 'runtime'),
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
				...(options.toolPortal === false
					? {}
					: {
							toolPortal: {
								configDir,
								surfaceEligibilityByProfile: {
									default: { controller_host_action: ['protected_uds'] },
								},
							},
						}),
			},
		],
	} satisfies LoadedSystemConfig;
}

function configureFixtureAsHermes(systemConfig: LoadedSystemConfig): void {
	const zone = systemConfig.zones[0];
	if (zone === undefined || zone.gateway.type !== 'openclaw') {
		throw new Error('Expected OpenClaw fixture zone');
	}
	systemConfig.zones[0] = {
		...zone,
		gateway: {
			config: path.join(testRoot, 'config', 'zone-a', 'hermes.yaml'),
			cpus: zone.gateway.cpus,
			imageProfile: 'hermes',
			memory: zone.gateway.memory,
			port: zone.gateway.port,
			profilesByAgent: { main: 'researcher' },
			profileSecretProjectionsByAgent: {
				main: { DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN' },
			},
			stateDir: zone.gateway.stateDir,
			type: 'hermes',
			zoneFilesDir: zone.gateway.zoneFilesDir,
			zoneRuntimeDir: zone.gateway.zoneRuntimeDir,
		},
	};
}

async function writeEffectiveToolPortalSnapshot(
	systemConfig: LoadedSystemConfig,
	options: {
		readonly approvalAccessConfigured?: boolean;
		readonly eligibleAgentIds?: readonly string[];
	} = {},
): Promise<void> {
	const zone = systemConfig.zones.find(
		(configuredZone) => configuredZone.id === acceptedSession.zoneId,
	);
	if (zone === undefined || zone.toolPortal === undefined) {
		throw new Error('test fixture expected a Tool Portal zone');
	}
	await writeMcpPortalEffectiveConfig({
		approvalAccessConfigured: options.approvalAccessConfigured ?? false,
		allowedRawEnvSecretNames: ['OPENCLAW_GATEWAY_TOKEN'],
		authoredConfigDir: zone.toolPortal.configDir,
		declaredAgentIds: (zone.agents ?? []).map((agent) => agent.id),
		effectiveHostConfigDir: path.join(
			systemConfig.cacheDir,
			'gateways',
			acceptedSession.zoneId,
			'tool-portal-effective',
		),
		secretResolver: noSecretResolutionDuringTest,
		workspaceGitPushAgentEligibility: {
			eligibleAgentIds:
				options.eligibleAgentIds ??
				(zone.agents ?? []).flatMap((agent) =>
					agent.workspaceGit?.mode === 'remote' ? [agent.id] : [],
				),
		},
		zoneId: acceptedSession.zoneId,
	});
}

function createWorkspaceGitPushPayload(
	overrides: {
		readonly approvalReservation?: GatewayRuntimeControllerHostActionDispatchReservation;
		readonly capabilityName?: string;
		readonly capabilityNamespace?: string;
	} = {},
): {
	readonly actionId: 'workspace_git_push';
	readonly approvalReservation?: GatewayRuntimeControllerHostActionDispatchReservation;
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
		actionId: 'workspace_git_push' as const,
		...(overrides.approvalReservation === undefined
			? {}
			: { approvalReservation: overrides.approvalReservation }),
		callerContext: {
			callerContextId: trustedCallerContext.callerContextId,
		},
		correlation: {
			capability: {
				name: overrides.capabilityName ?? 'workspace_git_push',
				namespace: overrides.capabilityNamespace ?? 'controller_host_action',
			},
		},
		expectedHead: '0123456789abcdef0123456789abcdef01234567',
	};
}

const approvalReservation = {
	approvalId: '55555555-5555-4555-8555-555555555555',
	authorityContext: {
		controllerEpoch: acceptedSession.controllerEpoch,
		frameworkEpoch: acceptedSession.bootId,
		gatewayEpoch: 'gateway-epoch-a',
		runtimeEpoch: 'runtime-epoch-a',
		zoneId: acceptedSession.zoneId,
	},
	backendKind: 'controller_host_action',
	expiresAt: '2026-07-20T16:05:00.000Z',
	fingerprint: `sha256:${'c'.repeat(64)}`,
	operationId: '66666666-6666-4666-8666-666666666666',
	reservationId: '77777777-7777-4777-8777-777777777777',
	stablePrincipal: trustedCallerContext.stablePrincipal,
} as const satisfies GatewayRuntimeControllerHostActionDispatchReservation;

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
	it('authorizes workspace_git_push from the controller-derived Tool Portal projection', async () => {
		const systemConfig = await createSystemConfigFixture();
		await writeEffectiveToolPortalSnapshot(systemConfig);

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createWorkspaceGitPushPayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({ authorized: true });
	});

	it('uses direct projection authorization only when no approval reservation is present', async () => {
		const configDir = await writeToolPortalAuthoredConfig({ requiresApproval: true });
		const systemConfig = await createSystemConfigFixture({ configDir });
		await writeEffectiveToolPortalSnapshot(systemConfig, { approvalAccessConfigured: true });

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createWorkspaceGitPushPayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({
			authorized: false,
			errorClass: 'controller_host_action_policy_denied',
			safeMessage: 'controller host action policy denied the requested capability',
		});
		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createWorkspaceGitPushPayload({ approvalReservation }),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({ authorized: true });
	});

	it('authorizes the same controller-owned workspace_git_push for Hermes profiles', async () => {
		const systemConfig = await createSystemConfigFixture();
		configureFixtureAsHermes(systemConfig);
		await writeEffectiveToolPortalSnapshot(systemConfig);
		const hermesCallerContext = {
			...trustedCallerContext,
			principal: {
				...trustedCallerContext.principal,
				frameworkIdentity: { kind: 'hermes', profileName: 'researcher' },
			},
		} satisfies GatewayControlTrustedCallerContext;

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: hermesCallerContext,
				payload: createWorkspaceGitPushPayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({ authorized: true });
	});

	it('rejects controller host actions from Worker zones', async () => {
		const systemConfig = await createSystemConfigFixture();
		const zone = systemConfig.zones[0];
		if (zone === undefined) {
			throw new Error('Expected managed framework fixture zone');
		}
		systemConfig.zones[0] = {
			...zone,
			gateway: {
				config: path.join(testRoot, 'config', 'zone-a', 'worker.json'),
				cpus: 2,
				imageProfile: 'worker',
				memory: '2G',
				port: 18_792,
				stateDir: path.join(testRoot, 'zone-a', 'state'),
				type: 'worker',
				zoneRuntimeDir: path.join(testRoot, 'zone-a', 'runtime'),
			},
		};

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createWorkspaceGitPushPayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({
			authorized: false,
			errorClass: 'controller_host_action_zone_unsupported',
			safeMessage: 'controller host action zone is not supported',
		});
	});

	it('authorizes controller_host_probe from explicit policy when the e2e probe gate is enabled', async () => {
		process.env.AGENT_VM_E2E_CONTROLLER_HOST_PROBE = '1';
		const systemConfig = await createSystemConfigFixture({
			configDir: await writeToolPortalAuthoredConfig({
				controllerHostActionTools: ['controller_host_probe'],
			}),
			workspaceGit: false,
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
				controllerHostActionTools: ['controller_host_probe'],
			}),
			workspaceGit: false,
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
				payload: createControllerHostProbePayload({ capabilityName: 'workspace_git_push' }),
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
				payload: createWorkspaceGitPushPayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({
			authorized: false,
			errorClass: 'controller_host_action_policy_denied',
			safeMessage: 'controller host action policy denied the requested capability',
		});
	});

	it('rejects workspace_git_push for an agent without remote workspace Git', async () => {
		const systemConfig = await createSystemConfigFixture({ workspaceGit: false });
		await writeEffectiveToolPortalSnapshot(systemConfig, {
			eligibleAgentIds: [trustedCallerContext.agentId],
		});

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createWorkspaceGitPushPayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({
			authorized: false,
			errorClass: 'controller_host_action_not_configured',
			safeMessage: 'controller host action is not configured for this agent',
		});
	});

	it.each([
		['agentId', 'forged-agent'],
		['branch', 'forged/branch'],
		['path', '/forged/path'],
		['remote', { repoUrl: 'forged/repository' }],
		['zoneId', 'forged-zone'],
	] as const)(
		'rejects workspace_git_push wire payload identity or routing field %s',
		(forbiddenFieldName, forbiddenFieldValue) => {
			const payloadWithForbiddenAuthority = {
				...createWorkspaceGitPushPayload(),
				[forbiddenFieldName]: forbiddenFieldValue,
			};

			expect(
				GatewayControlWorkspaceGitPushControllerHostActionPayloadSchema.safeParse(
					payloadWithForbiddenAuthority,
				).success,
			).toBe(false);
		},
	);

	it('limits workspace_git_push action arguments to expectedHead', () => {
		expect(Object.keys(createWorkspaceGitPushPayload()).toSorted()).toEqual([
			'actionId',
			'callerContext',
			'correlation',
			'expectedHead',
		]);
	});

	it('rejects forged capability selectors before controller execution', async () => {
		const systemConfig = await createSystemConfigFixture();

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createWorkspaceGitPushPayload({ capabilityNamespace: 'mcp_provider' }),
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
					...createWorkspaceGitPushPayload(),
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
					principal: {
						...trustedPrincipal,
						agentId: 'forged-agent',
					},
				},
				payload: createWorkspaceGitPushPayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({
			authorized: false,
			errorClass: 'controller_host_action_not_configured',
			safeMessage: 'controller host action is not configured for this agent',
		});
	});

	it('rejects with policy unavailable when the effective Tool Portal snapshot cannot be loaded', async () => {
		const systemConfig = await createSystemConfigFixture();

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createWorkspaceGitPushPayload(),
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
				payload: createWorkspaceGitPushPayload(),
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
				payload: createWorkspaceGitPushPayload(),
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
