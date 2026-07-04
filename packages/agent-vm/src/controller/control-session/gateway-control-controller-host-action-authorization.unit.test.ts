import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import type {
	GatewayControlAcceptedSessionRef,
	GatewayControlTrustedCallerContext,
} from './gateway-control-caller-context.js';
import { authorizeGatewayControlControllerHostAction } from './gateway-control-controller-host-action-authorization.js';

let testRoot: string;

beforeEach(async () => {
	testRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-controller-host-action-auth-'));
});

afterEach(async () => {
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
	workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
	zoneId: acceptedSession.zoneId,
} satisfies GatewayControlTrustedCallerContext;

async function writeToolPortalAuthoredConfig(
	props: {
		readonly agentId?: string;
		readonly controllerHostActionPolicy?: boolean;
		readonly profileId?: string;
	} = {},
): Promise<string> {
	const configDir = path.join(testRoot, 'gateway-config');
	const agentId = props.agentId ?? 'main';
	const controllerHostActionPolicy = props.controllerHostActionPolicy ?? true;
	const profileId = props.profileId ?? 'default';
	const namespaces = controllerHostActionPolicy
		? {
				controller_host_action: {
					calls: {
						requiresApproval: { allow: [] },
						withoutApproval: { allow: ['zone_git_push'] },
					},
					tools: { allow: ['zone_git_push'] },
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

describe('authorizeGatewayControlControllerHostAction', () => {
	it('authorizes zone_git_push from the controller-derived Tool Portal projection', async () => {
		const systemConfig = await createSystemConfigFixture();

		await expect(
			authorizeGatewayControlControllerHostAction({
				callerContext: trustedCallerContext,
				payload: createZoneGitPushPayload(),
				session: acceptedSession,
				systemConfig,
			}),
		).resolves.toEqual({ authorized: true });
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

	it('rejects zones without authored Tool Portal controller host action policy', async () => {
		const systemConfig = await createSystemConfigFixture({
			configDir: await writeToolPortalAuthoredConfig({ controllerHostActionPolicy: false }),
		});

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
