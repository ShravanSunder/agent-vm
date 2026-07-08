import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import {
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../../testing/managed-vm-test-helpers.js';
import { createLeaseManager } from '../leases/lease-manager.js';
import { createTcpPool } from '../leases/tcp-pool.js';
import { OpenClawRuntimeStatusUnavailableError } from '../openclaw-runtime-status.js';
import type { GatewayControlTrustedCallerContext } from './gateway-control-caller-context.js';
import { createGatewayControlLeaseRpcOperations } from './gateway-control-lease-rpc.js';

const callerContext = {
	agentId: 'main',
	agentWorkspaceDir: '/home/openclaw/workspace',
	bootId: 'gateway-boot-a',
	callerContextId: '44444444-4444-4444-8444-444444444444',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'epoch-a',
	peerId: 'gateway-zone-a',
	purpose: 'tool_vm_lease',
	sessionId: '33333333-3333-4333-8333-333333333333',
	sessionKeyDigest: '0123456789abcdef0123456789abcdef',
	workMountDir: '/host/sandbox-work',
	zoneId: 'zone-a',
} satisfies GatewayControlTrustedCallerContext;

const otherCallerContext = {
	...callerContext,
	agentId: 'other',
	callerContextId: '55555555-5555-4555-8555-555555555555',
	sessionKeyDigest: 'fedcba9876543210fedcba9876543210',
} satisfies GatewayControlTrustedCallerContext;

const refreshedCallerContext = {
	...callerContext,
	callerContextId: '66666666-6666-4666-8666-666666666666',
	connectionId: '77777777-7777-4777-8777-777777777777',
	sessionId: '88888888-8888-4888-8888-888888888888',
} satisfies GatewayControlTrustedCallerContext;

const refreshedCallerContextIdOnly = {
	...callerContext,
	callerContextId: refreshedCallerContext.callerContextId,
} satisfies GatewayControlTrustedCallerContext;

const sameAgentDifferentSessionCallerContext = {
	...callerContext,
	callerContextId: '99999999-9999-4999-8999-999999999999',
	connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
	sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
	sessionKeyDigest: '11111111111111112222222222222222',
} satisfies GatewayControlTrustedCallerContext;

const callerContextPayload = {
	callerContext: {
		callerContextId: callerContext.callerContextId,
	},
};

function withCallerContextPayload<TPayload>(
	payload: TPayload,
	context: GatewayControlTrustedCallerContext = callerContext,
): {
	readonly callerContext: GatewayControlTrustedCallerContext;
	readonly payload: TPayload;
} {
	return {
		callerContext: context,
		payload,
	};
}

function createManagedVmStub(
	options: {
		readonly closeError?: Error;
		readonly isLive?: () => boolean;
	} = {},
): Parameters<typeof createLeaseManager>[0]['createManagedVm'] {
	return vi.fn(async () => {
		const vm = {
			close: vi.fn(async () => {
				if (options.closeError !== undefined) {
					throw options.closeError;
				}
			}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({
				host: '127.0.0.1',
				identityFile: '/tmp/tool-vm-key',
				port: 19000,
				user: 'sandbox',
			})),
			exec: vi.fn(() =>
				options.isLive?.() === false
					? createManagedExecProcessStub({ exitCode: 1, stderr: 'dead', stdout: '' })
					: createManagedExecProcessStub(),
			),
			fs: createManagedVmFsStub(),
			getHostPid: () => 12345,
			getVmInstance: () => vm,
			id: 'tool-vm-1',
			setIngressRoutes: vi.fn(),
		};
		return vm;
	});
}

function createTestLeaseManager(
	options: {
		readonly closeError?: Error;
		readonly isLive?: () => boolean;
		readonly leaseIds?: readonly string[];
		readonly now?: () => number;
	} = {},
): ReturnType<typeof createLeaseManager> {
	let leaseIdIndex = 0;
	return createLeaseManager({
		controllerPort: 18800,
		createLeaseId: () => {
			const leaseId = options.leaseIds?.[leaseIdIndex] ?? 'lease-main';
			leaseIdIndex += 1;
			return leaseId;
		},
		createManagedVm: createManagedVmStub({
			...(options.closeError === undefined ? {} : { closeError: options.closeError }),
			...(options.isLive === undefined ? {} : { isLive: options.isLive }),
		}),
		deleteToolVmRuntimeRecord: vi.fn(async () => {}),
		now: options.now ?? (() => 1_000),
		projectNamespace: 'gateway-control-lease-rpc-tests',
		readProcessIdentity: async () => ({
			command: 'qemu-system-x86_64 -m 1G',
			lstart: 'Fri May 22 10:00:00 2026',
		}),
		stateDirFor: (zoneId) => `/tmp/gateway-control-lease-rpc-tests/${zoneId}`,
		systemConfigPath: '/etc/agent-vm/system.json',
		tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		toolVmUsePolicy: {
			endedUseTombstoneTtlMs: 10_000,
			heartbeatAfterMs: 1_000,
			heartbeatStaleMs: 4_000,
		},
		writeToolVmRuntimeRecord: vi.fn(async () => {}),
	});
}

describe('createGatewayControlLeaseRpcOperations', () => {
	it('creates and serializes leases through controller-owned create options', async () => {
		const resolveLeaseCreateOptions = vi.fn(async () => ({
			agentId: callerContext.agentId,
			agentWorkspaceDir: callerContext.agentWorkspaceDir,
			effectiveIdleTtlMs: 60_000,
			guestWorkdir: '/workspace',
			hostWorkMountDir: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: callerContext.zoneId,
		}));
		const observedLeaseCreateRequests: unknown[] = [];
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			onLeaseCreateRequest: (request) => {
				observedLeaseCreateRequests.push(request);
			},
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});

		const lease = await leaseRpc.createLease({
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});
		const peeked = await leaseRpc.getLease(
			withCallerContextPayload({ ...callerContextPayload, leaseId: lease.leaseId }),
			{ includeSsh: 'public' },
		);
		const renewed = await leaseRpc.renewLease(
			withCallerContextPayload({ ...callerContextPayload, leaseId: lease.leaseId }),
		);
		const released = await leaseRpc.releaseLease(
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: lease.leaseId,
			}),
		);

		expect(resolveLeaseCreateOptions).toHaveBeenCalledWith({
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});
		expect(observedLeaseCreateRequests).toEqual([
			{
				agentId: 'main',
				agentWorkspaceDir: '/home/openclaw/workspace',
				idleTtlMs: 60_000,
				profileId: 'standard',
				sessionKeyDigest: '0123456789abcdef0123456789abcdef',
				workMountDir: '/host/sandbox-work',
				zoneId: 'zone-a',
			},
		]);
		expect(lease).toEqual({
			agentId: 'main',
			idleTtlMs: 60_000,
			leaseId: 'lease-main',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'identity-pem',
				knownHostsLine: '',
				port: 22,
				user: 'sandbox',
			},
			state: 'idle',
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/workspace',
			zoneId: 'zone-a',
		});
		expect(peeked).toEqual({
			agentId: 'main',
			idleTtlMs: 60_000,
			leaseId: 'lease-main',
			ssh: {
				host: 'tool-0.vm.host',
				port: 22,
				user: 'sandbox',
			},
			state: 'idle',
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/workspace',
			zoneId: 'zone-a',
		});
		expect(renewed).toEqual(lease);
		expect(released).toEqual({
			agentId: 'main',
			idleTtlMs: 60_000,
			leaseId: 'lease-main',
			state: 'released',
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/workspace',
			zoneId: 'zone-a',
		});
	});

	it('maps active-use lifecycle through the lease manager with sanitized correlation', async () => {
		const leaseManager = createTestLeaseManager();
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
				guestWorkdir: '/workspace',
				hostWorkMountDir: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const lease = await leaseRpc.createLease({
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});

		const started = await leaseRpc.startLeaseUse(
			withCallerContextPayload({
				...callerContextPayload,
				correlation: {
					runId: 'run-a',
					sessionKeyDigest: callerContext.sessionKeyDigest,
					toolCallId: 'tool-call-a',
					traceId: 'fedcba9876543210fedcba9876543210',
				},
				leaseId: lease.leaseId,
				useId: '01890f00-0000-7000-8000-000000000000',
			}),
		);
		const heartbeat = await leaseRpc.heartbeatLeaseUse(
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: lease.leaseId,
				useId: '01890f00-0000-7000-8000-000000000000',
			}),
		);
		const ended = await leaseRpc.endLeaseUse(
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: lease.leaseId,
				reason: 'completed',
				useId: '01890f00-0000-7000-8000-000000000000',
			}),
		);

		expect(started).toEqual({
			expiresAt: 5_000,
			heartbeatAfterMs: 1_000,
			leaseId: 'lease-main',
			state: 'active',
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		expect(heartbeat).toEqual({
			expiresAt: 5_000,
			heartbeatAfterMs: 1_000,
			leaseId: 'lease-main',
			state: 'active',
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		expect(ended).toEqual({
			leaseId: 'lease-main',
			state: 'ended',
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		expect(leaseManager.getActiveUses(lease.leaseId)).toEqual([]);
	});

	it('rejects post-create lease reads and mutations from a different caller context', async () => {
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
				guestWorkdir: '/workspace',
				hostWorkMountDir: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const lease = await leaseRpc.createLease({
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});
		const crossCallerLeasePayload = {
			callerContext: {
				callerContextId: otherCallerContext.callerContextId,
			},
			leaseId: lease.leaseId,
		};

		await expect(
			leaseRpc.getLease(withCallerContextPayload(crossCallerLeasePayload, otherCallerContext), {
				includeSsh: 'private',
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
		await expect(
			leaseRpc.renewLease(withCallerContextPayload(crossCallerLeasePayload, otherCallerContext)),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
		await expect(
			leaseRpc.releaseLease(withCallerContextPayload(crossCallerLeasePayload, otherCallerContext)),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
	});

	it('keeps leases reachable after reconnect refreshes the caller context id', async () => {
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
				guestWorkdir: '/workspace',
				hostWorkMountDir: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const refreshedCallerContextPayload = {
			callerContext: {
				callerContextId: refreshedCallerContext.callerContextId,
			},
		};
		const lease = await leaseRpc.createLease({
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});

		const peeked = await leaseRpc.getLease(
			withCallerContextPayload(
				{ ...refreshedCallerContextPayload, leaseId: lease.leaseId },
				refreshedCallerContextIdOnly,
			),
			{ includeSsh: 'public' },
		);
		const renewed = await leaseRpc.renewLease(
			withCallerContextPayload(
				{ ...refreshedCallerContextPayload, leaseId: lease.leaseId },
				refreshedCallerContextIdOnly,
			),
		);
		const released = await leaseRpc.releaseLease(
			withCallerContextPayload(
				{ ...refreshedCallerContextPayload, leaseId: lease.leaseId },
				refreshedCallerContextIdOnly,
			),
		);

		expect(peeked).toEqual(
			expect.objectContaining({
				leaseId: lease.leaseId,
				state: 'idle',
			}),
		);
		expect(renewed).toEqual(
			expect.objectContaining({
				leaseId: lease.leaseId,
				state: 'idle',
			}),
		);
		expect(released).toEqual(
			expect.objectContaining({
				leaseId: lease.leaseId,
				state: 'released',
			}),
		);
	});

	it('rejects current lease work when the same-gateway fence changes after caller-context resolution', async () => {
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
				guestWorkdir: '/workspace',
				hostWorkMountDir: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const lease = await leaseRpc.createLease({
			callerContext,
			payload: callerContextPayload,
		});
		const sameOwnerDifferentGatewayContext = {
			...refreshedCallerContextIdOnly,
			bootId: 'gateway-boot-b',
			controllerEpoch: 'epoch-b',
			peerId: 'gateway-zone-b',
		} satisfies GatewayControlTrustedCallerContext;
		const driftedCallerContextPayload = {
			callerContext: {
				callerContextId: sameOwnerDifferentGatewayContext.callerContextId,
			},
			leaseId: lease.leaseId,
		};

		await expect(
			leaseRpc.renewLease(
				withCallerContextPayload(driftedCallerContextPayload, sameOwnerDifferentGatewayContext),
			),
		).resolves.toEqual({
			leaseRejectionReason: 'caller_context_session_mismatch',
			result: 'rejected',
		});
		await expect(
			leaseRpc.releaseLease(
				withCallerContextPayload(driftedCallerContextPayload, sameOwnerDifferentGatewayContext),
			),
		).resolves.toEqual({
			leaseRejectionReason: 'caller_context_session_mismatch',
			result: 'rejected',
		});
		await expect(
			leaseRpc.startLeaseUse(
				withCallerContextPayload(
					{
						...driftedCallerContextPayload,
						useId: '01890f00-0000-7000-8000-000000000001',
					},
					sameOwnerDifferentGatewayContext,
				),
			),
		).resolves.toEqual({
			leaseRejectionReason: 'caller_context_session_mismatch',
			result: 'rejected',
		});
	});

	it('rejects current lease work when only the session attachment changes', async () => {
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
				guestWorkdir: '/workspace',
				hostWorkMountDir: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const lease = await leaseRpc.createLease({
			callerContext,
			payload: callerContextPayload,
		});
		const sameOwnerDifferentSessionAttachment = {
			...callerContext,
			callerContextId: '12121212-1212-4212-8212-121212121212',
			connectionId: '23232323-2323-4232-8232-232323232323',
			sessionId: '34343434-3434-4343-8343-343434343434',
		} satisfies GatewayControlTrustedCallerContext;
		const driftedCallerContextPayload = {
			callerContext: {
				callerContextId: sameOwnerDifferentSessionAttachment.callerContextId,
			},
			leaseId: lease.leaseId,
		};

		await expect(
			leaseRpc.renewLease(
				withCallerContextPayload(driftedCallerContextPayload, sameOwnerDifferentSessionAttachment),
			),
		).resolves.toEqual({
			leaseRejectionReason: 'caller_context_session_mismatch',
			result: 'rejected',
		});
		await expect(
			leaseRpc.startLeaseUse(
				withCallerContextPayload(
					{
						...driftedCallerContextPayload,
						useId: '01890f00-0000-7000-8000-000000000001',
					},
					sameOwnerDifferentSessionAttachment,
				),
			),
		).resolves.toEqual({
			leaseRejectionReason: 'caller_context_session_mismatch',
			result: 'rejected',
		});
	});

	it('reacquires a replacement lease after the old lease was released', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(2_000);
		try {
			const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
			const recordedHealthEvents: AgentVmHealthEvent[] = [];
			const leaseRpc = createGatewayControlLeaseRpcOperations({
				leaseManager,
				readIdentityPem: async () => 'identity-pem',
				recordHealthEvent: (event) => {
					recordedHealthEvents.push(event);
				},
				resolveLeaseCreateOptions: async () => ({
					agentId: callerContext.agentId,
					agentWorkspaceDir: callerContext.agentWorkspaceDir,
					guestWorkdir: '/workspace',
					hostWorkMountDir: '/host/validated-work',
					profile: {
						cpus: 2,
						imageProfile: 'tool-default',
						memory: '2G',
					},
					profileId: 'standard',
					zoneId: callerContext.zoneId,
				}),
			});
			const oldLease = await leaseRpc.createLease({
				callerContext,
				payload: callerContextPayload,
			});
			await leaseRpc.releaseLease(
				withCallerContextPayload({
					...callerContextPayload,
					leaseId: oldLease.leaseId,
				}),
			);

			const replacementLease = await leaseRpc.reacquireLease({
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_100,
						reason: 'released',
					},
				},
			});

			expect(replacementLease).toEqual(
				expect.objectContaining({
					leaseId: 'lease-new',
					state: 'idle',
				}),
			);
			expect(replacementLease).not.toEqual(expect.objectContaining({ leaseId: oldLease.leaseId }));
			expect(recordedHealthEvents).toEqual([
				expect.objectContaining({
					lifecycleEventRole: 'controller_final',
					observedAtMs: 2_000,
					oldLeaseId: oldLease.leaseId,
					replacementLeaseId: 'lease-new',
				}),
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects first reacquire when current resolver compatibility drifts from old authority', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		let profileId = 'standard';
		const resolveLeaseCreateOptions = vi.fn(async () => ({
			agentId: callerContext.agentId,
			agentWorkspaceDir: callerContext.agentWorkspaceDir,
			guestWorkdir: '/workspace',
			hostWorkMountDir: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId,
			zoneId: callerContext.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		const oldLease = await leaseRpc.createLease({
			callerContext,
			payload: callerContextPayload,
		});
		await leaseRpc.releaseLease(
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: oldLease.leaseId,
			}),
		);

		profileId = 'larger';

		await expect(
			leaseRpc.reacquireLease({
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_100,
						reason: 'released',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
		expect(resolveLeaseCreateOptions).toHaveBeenCalledTimes(2);
		expect(leaseManager.peekLease('lease-new')).toBeUndefined();
	});

	it('revalidates current compatibility before returning a recorded replacement lease', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		let hostWorkMountDir = '/host/validated-work';
		const resolveLeaseCreateOptions = vi.fn(async () => ({
			agentId: callerContext.agentId,
			agentWorkspaceDir: callerContext.agentWorkspaceDir,
			guestWorkdir: '/workspace',
			hostWorkMountDir,
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: callerContext.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		const oldLease = await leaseRpc.createLease({
			callerContext,
			payload: callerContextPayload,
		});
		await leaseRpc.releaseLease(
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: oldLease.leaseId,
			}),
		);
		await expect(
			leaseRpc.reacquireLease({
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_100,
						reason: 'released',
					},
				},
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: 'lease-new' }));

		hostWorkMountDir = '/host/other-work';

		await expect(
			leaseRpc.reacquireLease({
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_200,
						reason: 'released',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
		expect(resolveLeaseCreateOptions).toHaveBeenCalledTimes(3);
	});

	it('allows reacquire after refreshable caller-context id rotates inside the same session attachment', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		const resolveLeaseCreateOptions = vi.fn(async ({ callerContext: context }) => ({
			agentId: context.agentId,
			agentWorkspaceDir: context.agentWorkspaceDir,
			guestWorkdir: '/workspace',
			hostWorkMountDir: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: context.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		const oldLease = await leaseRpc.createLease({
			callerContext,
			payload: callerContextPayload,
		});
		await leaseRpc.releaseLease(
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: oldLease.leaseId,
			}),
		);

		await expect(
			leaseRpc.reacquireLease({
				callerContext: {
					...callerContext,
					callerContextId: refreshedCallerContext.callerContextId,
				},
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'caller-context',
						observedAtMs: 1_100,
						reason: 'session_mismatch',
					},
				},
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: 'lease-new' }));
	});

	it('rejects reacquire when only the session attachment changes', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		const recordedHealthEvents: AgentVmHealthEvent[] = [];
		const resolveLeaseCreateOptions = vi.fn(async ({ callerContext: context }) => ({
			agentId: context.agentId,
			agentWorkspaceDir: context.agentWorkspaceDir,
			guestWorkdir: '/workspace',
			hostWorkMountDir: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: context.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			recordHealthEvent: (event) => {
				recordedHealthEvents.push(event);
			},
			resolveLeaseCreateOptions,
		});
		const oldLease = await leaseRpc.createLease({
			callerContext,
			payload: callerContextPayload,
		});
		await leaseRpc.releaseLease(
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: oldLease.leaseId,
			}),
		);
		const sameOwnerDifferentSessionAttachment = {
			...callerContext,
			callerContextId: refreshedCallerContext.callerContextId,
			connectionId: refreshedCallerContext.connectionId,
			sessionId: refreshedCallerContext.sessionId,
		} satisfies GatewayControlTrustedCallerContext;

		await expect(
			leaseRpc.reacquireLease({
				callerContext: sameOwnerDifferentSessionAttachment,
				payload: {
					callerContext: {
						callerContextId: sameOwnerDifferentSessionAttachment.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'caller-context',
						observedAtMs: 1_100,
						reason: 'session_mismatch',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'caller_context_session_mismatch',
			result: 'rejected',
		});
		expect(recordedHealthEvents).toEqual([
			expect.objectContaining({
				callerContextState: 'session_mismatch',
				leaseRejectionReason: 'caller_context_session_mismatch',
				lifecycleEventRole: 'controller_final',
				lifecycleTransition: 'retired_rejected',
				oldLeaseId: oldLease.leaseId,
				result: 'failed',
				transitionId: `lease_reacquire:${oldLease.leaseId}`,
			}),
		]);
		expect(resolveLeaseCreateOptions).toHaveBeenCalledTimes(1);
	});

	it('rejects reacquire when the same-gateway fence changes after caller-context resolution', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		const resolveLeaseCreateOptions = vi.fn(async ({ callerContext: context }) => ({
			agentId: context.agentId,
			agentWorkspaceDir: context.agentWorkspaceDir,
			guestWorkdir: '/workspace',
			hostWorkMountDir: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: context.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		const oldLease = await leaseRpc.createLease({
			callerContext,
			payload: callerContextPayload,
		});
		await leaseRpc.releaseLease(
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: oldLease.leaseId,
			}),
		);
		const sameOwnerDifferentGatewayContext = {
			...refreshedCallerContextIdOnly,
			bootId: 'gateway-boot-b',
			controllerEpoch: 'epoch-b',
			peerId: 'gateway-zone-b',
		} satisfies GatewayControlTrustedCallerContext;

		await expect(
			leaseRpc.reacquireLease({
				callerContext: sameOwnerDifferentGatewayContext,
				payload: {
					callerContext: {
						callerContextId: sameOwnerDifferentGatewayContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'caller-context',
						observedAtMs: 1_100,
						reason: 'session_mismatch',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'caller_context_session_mismatch',
			result: 'rejected',
		});
		expect(resolveLeaseCreateOptions).toHaveBeenCalledTimes(1);
	});

	it('rejects old-lease reacquire when replacement ownership moved to another same-agent session', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		const resolveLeaseCreateOptions = vi.fn(async ({ callerContext: context }) => ({
			agentId: context.agentId,
			agentWorkspaceDir: context.agentWorkspaceDir,
			guestWorkdir: '/workspace',
			hostWorkMountDir: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: context.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		const oldLease = await leaseRpc.createLease({
			callerContext,
			payload: callerContextPayload,
		});
		await leaseRpc.releaseLease(
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: oldLease.leaseId,
			}),
		);
		const firstReplacement = await leaseRpc.reacquireLease({
			callerContext: refreshedCallerContextIdOnly,
			payload: {
				callerContext: {
					callerContextId: refreshedCallerContext.callerContextId,
				},
				oldLeaseId: oldLease.leaseId,
				staleEvidence: {
					kind: 'lease-manager',
					observedAtMs: 1_100,
					reason: 'released',
				},
			},
		});
		expect(firstReplacement).toEqual(expect.objectContaining({ leaseId: 'lease-new' }));
		const sameAgentDifferentSessionPayload = {
			callerContext: {
				callerContextId: sameAgentDifferentSessionCallerContext.callerContextId,
			},
		};
		await expect(
			leaseRpc.createLease({
				callerContext: sameAgentDifferentSessionCallerContext,
				payload: sameAgentDifferentSessionPayload,
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: 'lease-new' }));

		await expect(
			leaseRpc.reacquireLease({
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_200,
						reason: 'released',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
	});

	it('rejects reacquire when a concurrent same-agent session creates the replacement lease', async () => {
		const baseLeaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-race'] });
		let injectedSameAgentCreate = false;
		const leaseRpcRef: {
			current?: ReturnType<typeof createGatewayControlLeaseRpcOperations>;
		} = {};
		const leaseManager = {
			...baseLeaseManager,
			releaseLease: async (
				leaseId: string,
				options?: Parameters<typeof baseLeaseManager.releaseLease>[1],
			): Promise<void> => {
				await baseLeaseManager.releaseLease(leaseId, options);
				if (!injectedSameAgentCreate && leaseId === 'lease-old') {
					injectedSameAgentCreate = true;
					const currentLeaseRpc = leaseRpcRef.current;
					if (currentLeaseRpc === undefined) {
						throw new Error('test lease RPC was not initialized');
					}
					await currentLeaseRpc.createLease({
						callerContext: sameAgentDifferentSessionCallerContext,
						payload: {
							callerContext: {
								callerContextId: sameAgentDifferentSessionCallerContext.callerContextId,
							},
						},
					});
				}
			},
		};
		const resolveLeaseCreateOptions = vi.fn(async ({ callerContext: context }) => ({
			agentId: context.agentId,
			agentWorkspaceDir: context.agentWorkspaceDir,
			guestWorkdir: '/workspace',
			hostWorkMountDir: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: context.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		leaseRpcRef.current = leaseRpc;
		const oldLease = await leaseRpc.createLease({
			callerContext,
			payload: callerContextPayload,
		});

		await expect(
			leaseRpc.reacquireLease({
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'tool-vm-ssh',
						observedAtMs: 1_100,
						operation: 'command',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
		expect(injectedSameAgentCreate).toBe(true);
	});

	it('continues reacquire when force release already retired the old lease before teardown failed', async () => {
		const leaseManager = createTestLeaseManager({
			closeError: new Error('close failed after logical retirement'),
			leaseIds: ['lease-old', 'lease-new'],
		});
		const resolveLeaseCreateOptions = vi.fn(async ({ callerContext: context }) => ({
			agentId: context.agentId,
			agentWorkspaceDir: context.agentWorkspaceDir,
			guestWorkdir: '/workspace',
			hostWorkMountDir: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: context.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		const oldLease = await leaseRpc.createLease({
			callerContext,
			payload: callerContextPayload,
		});

		await expect(
			leaseRpc.reacquireLease({
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'tool-vm-ssh',
						observedAtMs: 1_100,
						operation: 'command',
					},
				},
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: 'lease-new' }));
	});

	it('maps runtime-status unavailability during reacquire compatibility resolution to runtime_not_ready without finalizing the transition', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		const recordedHealthEvents: AgentVmHealthEvent[] = [];
		let resolveCallCount = 0;
		const resolveLeaseCreateOptions = vi.fn(async ({ callerContext: context }) => {
			resolveCallCount += 1;
			if (resolveCallCount > 1) {
				throw new OpenClawRuntimeStatusUnavailableError(context.zoneId, 'runtime status missing');
			}
			return {
				agentId: context.agentId,
				agentWorkspaceDir: context.agentWorkspaceDir,
				guestWorkdir: '/workspace',
				hostWorkMountDir: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: context.zoneId,
			};
		});
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			recordHealthEvent: (event) => {
				recordedHealthEvents.push(event);
			},
			resolveLeaseCreateOptions,
		});
		const oldLease = await leaseRpc.createLease({
			callerContext,
			payload: callerContextPayload,
		});

		await expect(
			leaseRpc.reacquireLease({
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'tool-vm-ssh',
						observedAtMs: 1_100,
						operation: 'command',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'runtime_not_ready',
			result: 'rejected',
		});
		expect(recordedHealthEvents).toEqual([]);
	});

	it('expires old-lease authority after dead idle lease disappearance', async () => {
		let nowMs = 1_000;
		let vmLive = true;
		const leaseManager = createTestLeaseManager({
			isLive: () => vmLive,
			leaseIds: ['lease-old', 'lease-new'],
			now: () => nowMs,
		});
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			now: () => nowMs,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
				guestWorkdir: '/workspace',
				hostWorkMountDir: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const oldLease = await leaseRpc.createLease({
			callerContext,
			payload: callerContextPayload,
		});

		vmLive = false;
		await leaseManager.reapDeadIdleLeases();
		nowMs = 1_000 + 10 * 60 * 1000 + 1;

		await expect(
			leaseRpc.reacquireLease({
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_100,
						reason: 'expired',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'lease_authority_absent',
			result: 'rejected',
		});
	});

	it('records controller-final reacquire success only after replacement SSH serialization succeeds', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		const recordedHealthEvents: AgentVmHealthEvent[] = [];
		let identityReadCount = 0;
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => {
				identityReadCount += 1;
				if (identityReadCount > 1) {
					throw new Error('identity read failed');
				}
				return 'identity-pem';
			},
			recordHealthEvent: (event) => {
				recordedHealthEvents.push(event);
			},
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
				guestWorkdir: '/workspace',
				hostWorkMountDir: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const oldLease = await leaseRpc.createLease({
			callerContext,
			payload: callerContextPayload,
		});
		await leaseRpc.releaseLease(
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: oldLease.leaseId,
			}),
		);

		await expect(
			leaseRpc.reacquireLease({
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_100,
						reason: 'released',
					},
				},
			}),
		).rejects.toThrow('identity read failed');
		expect(recordedHealthEvents).toEqual([]);
	});

	it('rejects reacquire when old lease authority is unavailable', async () => {
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
				guestWorkdir: '/workspace',
				hostWorkMountDir: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});

		await expect(
			leaseRpc.reacquireLease({
				callerContext,
				payload: {
					callerContext: {
						callerContextId: callerContext.callerContextId,
					},
					oldLeaseId: 'lease-missing-authority',
					staleEvidence: {
						kind: 'caller-context',
						observedAtMs: 1_100,
						reason: 'absent',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'lease_authority_absent',
			result: 'rejected',
		});
	});

	it('rejects active-use lifecycle from a different caller context', async () => {
		const leaseManager = createTestLeaseManager();
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
				guestWorkdir: '/workspace',
				hostWorkMountDir: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const lease = await leaseRpc.createLease({
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});
		const useId = '01890f00-0000-7000-8000-000000000000';
		await expect(
			leaseRpc.startLeaseUse(
				withCallerContextPayload({
					callerContext: {
						callerContextId: callerContext.callerContextId,
					},
					leaseId: lease.leaseId,
					useId,
				}),
			),
		).resolves.toEqual(
			expect.objectContaining({
				state: 'active',
				useId,
			}),
		);
		const crossCallerUsePayload = {
			callerContext: {
				callerContextId: otherCallerContext.callerContextId,
			},
			leaseId: lease.leaseId,
			useId,
		};

		await expect(
			leaseRpc.heartbeatLeaseUse(
				withCallerContextPayload(crossCallerUsePayload, otherCallerContext),
			),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
		await expect(
			leaseRpc.endLeaseUse(
				withCallerContextPayload(
					{
						...crossCallerUsePayload,
						reason: 'completed',
					},
					otherCallerContext,
				),
			),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
		expect(leaseManager.getActiveUses(lease.leaseId)).toEqual([expect.objectContaining({ useId })]);
	});
});
