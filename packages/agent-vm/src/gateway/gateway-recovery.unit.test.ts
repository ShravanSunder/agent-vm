import type { ManagedVmExactProcessTerminationCapability } from '@agent-vm/managed-vm';
import { configure, dispose, reset, type LogRecord } from '@logtape/logtape';
import { describe, expect, it, vi } from 'vitest';

import type { ControllerDiagnosticTelemetry } from '../controller/controller-diagnostic-logging.js';
import type { ControllerManagedGatewayRuntimeRecordTarget } from '../controller/durable-state/controller-state-record-paths.js';
import type { GatewayOwnershipUnsafeError } from './gateway-ownership-evidence.js';
import {
	checkMissingGatewayRuntimeRecordPortPreflight,
	cleanupRecordedGatewayRuntime,
} from './gateway-recovery.js';
import type {
	ManagedGatewayRuntimeRecord,
	ManagedGatewayRuntimeRecordLoadResult,
} from './gateway-runtime-record.js';
import { createManagedGatewayBootContract } from './managed-gateway-boot-contract.js';

const matchingProcessIdentity = {
	command: 'qemu-system-aarch64 -m 4G -smp 4 -kernel /vm-images/gateway/kernel',
	lstart: 'Mon Apr 13 12:34:56 2026',
};

const gatewayIdentity = {
	bootId: 'boot-a',
	controllerEpoch: 'controller-epoch-a',
	gatewayEpochId: 'gateway-epoch-a',
	gatewayVmId: 'gateway-vm-123',
	generationId: 'generation-a',
	zoneId: 'shravan',
} as const;

const gatewayRuntimeRecordTarget = {
	filePath: '/state/shravan/gateway-runtime.json',
	kind: 'controller-managed-gateway-runtime-record',
	zoneId: 'shravan',
} satisfies ControllerManagedGatewayRuntimeRecordTarget;

function createGatewayRuntimeRecordTarget(
	overrides: Partial<ControllerManagedGatewayRuntimeRecordTarget> = {},
): ControllerManagedGatewayRuntimeRecordTarget {
	return {
		...gatewayRuntimeRecordTarget,
		...overrides,
	};
}

const expectedCohort: ManagedGatewayRuntimeRecord['expectedCohort'] = {
	controlIdentity: {
		controllerEpoch: gatewayIdentity.controllerEpoch,
		generationId: gatewayIdentity.generationId,
		peerId: 'tool-portal-control',
		processEpoch: 'tool-portal-process-a',
	},
	fence: {
		controllerEpoch: gatewayIdentity.controllerEpoch,
		gatewayEpoch: gatewayIdentity.generationId,
		vmId: gatewayIdentity.gatewayVmId,
		zoneId: gatewayIdentity.zoneId,
	},
	frameworkIdentity: {
		attachmentGeneration: 1,
		clientKind: 'hermes-managed-plugin',
		configuredAgentIds: ['agent-a'],
		frameworkEpoch: 'framework-epoch-a',
		frameworkKind: 'hermes',
		projectionCohortDigest:
			'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	},
	ingressIntent: {
		controlRoute: {
			audience: 'gateway-control',
			guestPort: 18_790,
			kind: 'tool-portal-control',
			prefix: '/__agent-vm',
			stripPrefix: false,
		},
		frameworkRootRoute: {
			guestPort: 18_789,
			kind: 'framework-root',
			prefix: '/',
			stripPrefix: true,
		},
	},
	providerRevision: 'provider-revision-a',
	requiredBackendRevision: 'required-backends-a',
	semanticRevision: 'semantic-revision-a',
	toolPortalIdentity: {
		processEpoch: 'tool-portal-process-a',
		role: 'tool-portal',
		runtimeEpoch: 'runtime-epoch-a',
		serviceId: 'tool-portal-service-a',
	},
	udsIdentity: {
		frameworkEpoch: 'framework-epoch-a',
		gatewayEpoch: gatewayIdentity.generationId,
		runtimeEpoch: 'runtime-epoch-a',
		socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
	},
};

const bootContract = createManagedGatewayBootContract({
	bootEntry: 'hermes-gateway',
	configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
	environmentInputPath: '/run/agent-vm/managed-gateway/framework.environment.sh',
	framework: 'hermes',
	ingress: { guestPort: 18_789, kind: 'framework-http' },
	logIdentity: {
		guestPath: '/var/log/agent-vm/openclaw-service.log',
		serviceName: 'agent-vm-hermes-test',
	},
	readiness: { guestPort: 18_789, kind: 'framework-http', path: '/readyz' },
	role: 'framework-service',
});

const image = {
	built: false,
	fingerprint: 'gateway-recovery-test-image',
	imageReference: 'openclaw-gateway:test',
};

const processTarget = {
	hostPid: 48_282,
	processIdentity: matchingProcessIdentity,
	vmId: gatewayIdentity.gatewayVmId,
};

const appliedIngressRoutes: ManagedGatewayRuntimeRecord['appliedIngressRoutes'] = [
	{ ...expectedCohort.ingressIntent.controlRoute, guestPort: 18_790 },
	expectedCohort.ingressIntent.frameworkRootRoute,
];

function createGatewayRuntimeRecord(
	overrides: Partial<ManagedGatewayRuntimeRecord> = {},
): ManagedGatewayRuntimeRecord {
	return {
		appliedIngressRoutes,
		bootContract,
		configPath: '/deployments/shravan-claw/config/system.jsonc',
		controllerPort: 18_800,
		createdAt: '2026-04-13T12:34:56.000Z',
		expectedCohort,
		gateway: gatewayIdentity,
		image,
		ingressPort: 18_791,
		processIdentity: matchingProcessIdentity,
		processTarget,
		projectNamespace: 'claw-tests-a1b2c3d4',
		qemuPid: 48_282,
		runtimeKind: 'managed-gateway',
		schemaVersion: 4,
		sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
		vmId: 'gateway-vm-123',
		zoneId: 'shravan',
		...overrides,
	};
}

function loadedGatewayRuntimeRecord(
	record: ManagedGatewayRuntimeRecord,
): ManagedGatewayRuntimeRecordLoadResult {
	return {
		kind: 'loaded',
		path: `/state/${record.zoneId}/gateway-runtime.json`,
		record,
	};
}

function createGatewayRecoveryOptions(
	overrides: Partial<Parameters<typeof cleanupRecordedGatewayRuntime>[0]> = {},
): Parameters<typeof cleanupRecordedGatewayRuntime>[0] {
	return {
		expectedConfigPath: '/deployments/shravan-claw/config/system.jsonc',
		expectedControllerPort: 18_800,
		projectNamespace: 'claw-tests-a1b2c3d4',
		runtimeRecordTarget: gatewayRuntimeRecordTarget,
		zoneId: 'shravan',
		...overrides,
	};
}

function createTerminatingProcessIdentityFixture(): {
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly readProcessIdentity: (pid: number) => Promise<typeof matchingProcessIdentity | null>;
	readonly terminateRecordedHostProcess: ReturnType<typeof vi.fn>;
} {
	let currentIdentity: typeof matchingProcessIdentity | null = matchingProcessIdentity;
	const terminateRecordedHostProcess = vi.fn(async ({ identity }) => {
		if (currentIdentity === null) {
			return { hostProcessId: identity.hostProcessId, kind: 'already-absent' as const };
		}
		currentIdentity = null;
		return { hostProcessId: identity.hostProcessId, kind: 'terminated' as const };
	});
	return {
		exactProcessTermination: { terminateRecordedHostProcess },
		readProcessIdentity: async (_pid: number): Promise<typeof matchingProcessIdentity | null> =>
			currentIdentity,
		terminateRecordedHostProcess,
	};
}

function createExactProcessTerminationFixture(
	kind: 'already-absent' | 'terminated' = 'already-absent',
): {
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly terminateRecordedHostProcess: ReturnType<typeof vi.fn>;
} {
	const terminateRecordedHostProcess = vi.fn(async ({ identity }) => ({
		hostProcessId: identity.hostProcessId,
		kind,
	}));
	return {
		exactProcessTermination: { terminateRecordedHostProcess },
		terminateRecordedHostProcess,
	};
}

describe('cleanupRecordedGatewayRuntime', () => {
	it('returns no cleanup when no runtime record exists', async () => {
		const processTermination = createExactProcessTerminationFixture();
		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions(), {
				...processTermination,
				loadManagedGatewayRuntimeRecordResult: async () => ({
					kind: 'missing',
					path: '/state/shravan/gateway-runtime.json',
				}),
			}),
		).resolves.toEqual({ cleanedUp: false, killedPid: null });
	});

	it('reports clear missing-record ingress preflight when the configured port is free', async () => {
		await expect(
			checkMissingGatewayRuntimeRecordPortPreflight({
				gatewayIngressPort: 18_791,
				readTcpListenPortOwner: async () => null,
			}),
		).resolves.toEqual({ kind: 'clear' });
	});

	it('reports clear missing-record ingress preflight when the current controller owns the configured port', async () => {
		await expect(
			checkMissingGatewayRuntimeRecordPortPreflight({
				expectedControllerPid: process.pid,
				gatewayIngressPort: 18_791,
				readTcpListenPortOwner: async () => ({
					command: 'node agent-vm controller start',
					pid: process.pid,
				}),
			}),
		).resolves.toEqual({ kind: 'clear' });
	});

	it('reports owner-unsafe evidence when the runtime record is missing and configured ingress port is occupied', async () => {
		await expect(
			checkMissingGatewayRuntimeRecordPortPreflight({
				gatewayIngressPort: 18_791,
				readTcpListenPortOwner: async () => ({
					command: 'qemu-system-aarch64 -m 4G',
					pid: 98_765,
				}),
			}),
		).resolves.toEqual({
			evidence: {
				kind: 'missing-record-port-owned',
				ownerCommand: 'qemu-system-aarch64 -m 4G',
				ownerPid: 98_765,
				port: 18_791,
			},
			kind: 'blocked',
		});
	});

	it('blocks cold-start cleanup when the runtime record is missing and configured ingress port is occupied', async () => {
		const processTermination = createExactProcessTerminationFixture();

		await expect(
			cleanupRecordedGatewayRuntime(
				createGatewayRecoveryOptions({
					configuredIngressPort: 18_791,
					mode: 'in-process-recovery',
				}),
				{
					...processTermination,
					loadManagedGatewayRuntimeRecordResult: async () => ({
						kind: 'missing',
						path: '/state/shravan/gateway-runtime.json',
					}),
					readTcpListenPortOwner: async () => ({
						command: 'qemu-system-aarch64 -m 4G',
						pid: 98_765,
					}),
				},
			),
		).rejects.toMatchObject({
			evidence: {
				kind: 'missing-record-port-owned',
				ownerCommand: 'qemu-system-aarch64 -m 4G',
				ownerPid: 98_765,
				port: 18_791,
			},
		} satisfies Pick<GatewayOwnershipUnsafeError, 'evidence'>);
		expect(processTermination.terminateRecordedHostProcess).not.toHaveBeenCalled();
	});

	it('warns and skips malformed records during in-process recovery without mutating', async () => {
		const logRecords: Array<
			readonly [level: 'info' | 'warning', telemetry: ControllerDiagnosticTelemetry | undefined]
		> = [];
		const processTermination = createExactProcessTerminationFixture();

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions({ mode: 'in-process-recovery' }), {
				...processTermination,
				loadManagedGatewayRuntimeRecordResult: async () => ({
					error: new Error('expected schemaVersion'),
					kind: 'parse-error',
					path: '/state/shravan/gateway-runtime.json',
				}),
				log: (level, telemetry) => {
					logRecords.push([level, telemetry]);
				},
			}),
		).resolves.toEqual({
			cleanedUp: false,
			cleanupWarning: expect.stringContaining('Malformed gateway runtime record'),
			killedPid: null,
			ownershipEvidence: {
				kind: 'record-parse-error',
				message: 'expected schemaVersion',
				path: '/state/shravan/gateway-runtime.json',
			},
		});
		expect(logRecords).toEqual([
			['warning', { operation: 'load-gateway-runtime-record', zoneId: 'shravan' }],
		]);
	});

	it('throws on malformed records during offline cleanup', async () => {
		const processTermination = createExactProcessTerminationFixture();
		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions({ mode: 'offline-cleanup' }), {
				...processTermination,
				loadManagedGatewayRuntimeRecordResult: async () => ({
					error: new Error('expected schemaVersion'),
					kind: 'parse-error',
					path: '/state/shravan/gateway-runtime.json',
				}),
			}),
		).rejects.toThrow(/Malformed gateway runtime record/u);
	});

	it('refuses to clean up a runtime record from another project namespace', async () => {
		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions(), {
				...createExactProcessTerminationFixture(),
				deleteManagedGatewayRuntimeRecord: vi.fn(async () => {}),
				loadManagedGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(
						createGatewayRuntimeRecord({
							projectNamespace: 'shravan-claw-463c3e5f',
							sessionLabel: 'shravan-claw-463c3e5f:shravan:gateway',
						}),
					),
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 48_282 }),
			}),
		).rejects.toThrow(/belongs to projectNamespace 'shravan-claw-463c3e5f'/u);
	});

	it('skips mismatched records during in-process recovery without signaling the process', async () => {
		const logOperations: string[] = [];
		const processTermination = createExactProcessTerminationFixture();

		await expect(
			cleanupRecordedGatewayRuntime(
				createGatewayRecoveryOptions({
					mode: 'in-process-recovery',
					projectNamespace: 'shravan-claw-beta-25319b68',
					runtimeRecordTarget: createGatewayRuntimeRecordTarget({
						filePath: '/state/beta/gateway-runtime.json',
						zoneId: 'beta',
					}),
					zoneId: 'beta',
				}),
				{
					deleteManagedGatewayRuntimeRecord: vi.fn(async () => {}),
					...processTermination,
					loadManagedGatewayRuntimeRecordResult: async () =>
						loadedGatewayRuntimeRecord(
							createGatewayRuntimeRecord({
								projectNamespace: 'shravan-claw-463c3e5f',
								sessionLabel: 'shravan-claw-463c3e5f:sunfam:gateway',
								zoneId: 'sunfam',
							}),
						),
					log: (level, telemetry) => {
						logOperations.push(telemetry?.operation ?? level);
					},
					readTcpListenPortOwner: async () => ({
						command: 'qemu-system-aarch64',
						pid: 48_282,
					}),
				},
			),
		).resolves.toEqual({
			cleanedUp: false,
			cleanupWarning: expect.stringContaining('Skipping the stale runtime record'),
			killedPid: null,
			ownershipEvidence: {
				actualScope: 'projectNamespace:shravan-claw-463c3e5f',
				expectedScope: 'projectNamespace:shravan-claw-beta-25319b68',
				kind: 'record-scope-mismatch',
			},
		});

		expect(processTermination.terminateRecordedHostProcess).not.toHaveBeenCalled();
		expect(logOperations).toContain('validate-gateway-runtime-record-scope');
	});

	it.each([
		{
			expectedReason: /belongs to configPath '/u,
			fixture: { configPath: '/deployments/other/config/system.jsonc' },
			label: 'configPath fence',
		},
		{
			expectedReason: /belongs to controllerPort '19999'/u,
			fixture: { controllerPort: 19_999 },
			label: 'controllerPort fence',
		},
	])(
		'skips gateway cleanup on $label mismatch during in-process recovery',
		async ({ expectedReason, fixture }) => {
			const deleteManagedGatewayRuntimeRecord = vi.fn(async () => {});
			const processTermination = createExactProcessTerminationFixture();

			await expect(
				cleanupRecordedGatewayRuntime(
					createGatewayRecoveryOptions({ mode: 'in-process-recovery' }),
					{
						deleteManagedGatewayRuntimeRecord,
						...processTermination,
						loadManagedGatewayRuntimeRecordResult: async () =>
							loadedGatewayRuntimeRecord(createGatewayRuntimeRecord(fixture)),
						readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 48_282 }),
					},
				),
			).resolves.toEqual({
				cleanedUp: false,
				cleanupWarning: expect.stringMatching(expectedReason),
				killedPid: null,
				ownershipEvidence: expect.objectContaining({
					kind: 'record-scope-mismatch',
				}),
			});
			expect(processTermination.terminateRecordedHostProcess).not.toHaveBeenCalled();
			expect(deleteManagedGatewayRuntimeRecord).not.toHaveBeenCalled();
		},
	);

	it('skips gateway recovery when the ingress port is held by a different pid during startup recovery', async () => {
		const processTermination = createExactProcessTerminationFixture();
		const logOperations: string[] = [];

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions({ mode: 'in-process-recovery' }), {
				...processTermination,
				loadManagedGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(
						createGatewayRuntimeRecord({ ingressPort: 18_891, qemuPid: 111 }),
					),
				log: (level, telemetry) => {
					logOperations.push(telemetry?.operation ?? level);
				},
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 222 }),
			}),
		).resolves.toEqual({
			cleanedUp: false,
			cleanupWarning: expect.stringContaining('held by pid 222'),
			killedPid: null,
			ownershipEvidence: {
				expectedPid: 111,
				kind: 'port-owner-mismatch',
				ownerPid: 222,
				port: 18_891,
			},
		});
		expect(processTermination.terminateRecordedHostProcess).not.toHaveBeenCalled();
		expect(logOperations).toContain('verify-gateway-port-ownership');
	});

	it('throws in offline cleanup when the gateway ingress port is held by a different pid', async () => {
		const processTermination = createExactProcessTerminationFixture();

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions({ mode: 'offline-cleanup' }), {
				...processTermination,
				loadManagedGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(
						createGatewayRuntimeRecord({ ingressPort: 18_891, qemuPid: 111 }),
					),
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 222 }),
			}),
		).rejects.toThrow(/port 18891 is held by pid 222/u);
		expect(processTermination.terminateRecordedHostProcess).not.toHaveBeenCalled();
	});

	it('deletes a stale gateway record during in-process recovery when the current controller owns ingress', async () => {
		const deleteManagedGatewayRuntimeRecord = vi.fn(async () => {});
		const processTermination = createExactProcessTerminationFixture();
		const record = createGatewayRuntimeRecord({ ingressPort: 18_891, qemuPid: 111 });

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions({ mode: 'in-process-recovery' }), {
				deleteManagedGatewayRuntimeRecord,
				...processTermination,
				loadManagedGatewayRuntimeRecordResult: async () => loadedGatewayRuntimeRecord(record),
				readTcpListenPortOwner: async () => ({
					command: 'node agent-vm controller start',
					pid: process.pid,
				}),
			}),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: null,
		});
		expect(processTermination.terminateRecordedHostProcess).toHaveBeenCalledOnce();
		expect(deleteManagedGatewayRuntimeRecord).toHaveBeenCalledWith(gatewayRuntimeRecordTarget);
	});

	it('kills the recorded gateway process before deleting when its ingress port is already free', async () => {
		const deleteManagedGatewayRuntimeRecord = vi.fn(async () => {});
		const record = createGatewayRuntimeRecord({ qemuPid: 111 });
		const processFixture = createTerminatingProcessIdentityFixture();

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions(), {
				deleteManagedGatewayRuntimeRecord,
				exactProcessTermination: processFixture.exactProcessTermination,
				loadManagedGatewayRuntimeRecordResult: async () => loadedGatewayRuntimeRecord(record),
				readProcessIdentity: processFixture.readProcessIdentity,
				readTcpListenPortOwner: async () => null,
			}),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: 111,
		});
		expect(processFixture.terminateRecordedHostProcess).toHaveBeenCalledWith(
			expect.objectContaining({ identity: expect.objectContaining({ hostProcessId: 111 }) }),
		);
		expect(deleteManagedGatewayRuntimeRecord).toHaveBeenCalledWith(gatewayRuntimeRecordTarget);
	});

	it('kills an early persisted gateway process when ingress has not been established', async () => {
		const deleteManagedGatewayRuntimeRecord = vi.fn(async () => {});
		const record = createGatewayRuntimeRecord({ ingressPort: undefined, qemuPid: 111 });
		const processFixture = createTerminatingProcessIdentityFixture();
		const readTcpListenPortOwner = vi.fn();

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions(), {
				deleteManagedGatewayRuntimeRecord,
				exactProcessTermination: processFixture.exactProcessTermination,
				loadManagedGatewayRuntimeRecordResult: async () => loadedGatewayRuntimeRecord(record),
				readProcessIdentity: processFixture.readProcessIdentity,
				readTcpListenPortOwner,
			}),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: 111,
		});
		expect(readTcpListenPortOwner).not.toHaveBeenCalled();
		expect(processFixture.terminateRecordedHostProcess).toHaveBeenCalledWith(
			expect.objectContaining({ identity: expect.objectContaining({ hostProcessId: 111 }) }),
		);
		expect(deleteManagedGatewayRuntimeRecord).toHaveBeenCalledWith(gatewayRuntimeRecordTarget);
	});

	it('deletes a port-free stale record without signaling when its recorded pid was reused', async () => {
		const deleteManagedGatewayRuntimeRecord = vi.fn(async () => {});
		const processTermination = createExactProcessTerminationFixture();

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions(), {
				deleteManagedGatewayRuntimeRecord,
				...processTermination,
				loadManagedGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(createGatewayRuntimeRecord({ qemuPid: 111 })),
				readProcessIdentity: async () => ({
					command: 'node /tmp/not-gateway.js',
					lstart: 'Tue Apr 14 15:00:00 2026',
				}),
				readTcpListenPortOwner: async () => null,
			}),
		).resolves.toEqual({ cleanedUp: true, killedPid: null });
		expect(processTermination.terminateRecordedHostProcess).toHaveBeenCalledOnce();
		expect(deleteManagedGatewayRuntimeRecord).toHaveBeenCalledWith(gatewayRuntimeRecordTarget);
	});

	it('terminates an owned recorded qemu process, deletes the runtime record, and reports cleanup', async () => {
		const logRecords: Array<
			readonly [level: 'info' | 'warning', telemetry: ControllerDiagnosticTelemetry | undefined]
		> = [];
		const processFixture = createTerminatingProcessIdentityFixture();
		const deleteManagedGatewayRuntimeRecord = vi.fn(async () => {});

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions(), {
				deleteManagedGatewayRuntimeRecord,
				exactProcessTermination: processFixture.exactProcessTermination,
				loadManagedGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(createGatewayRuntimeRecord()),
				log: (level, telemetry) => {
					logRecords.push([level, telemetry]);
				},
				readProcessIdentity: processFixture.readProcessIdentity,
				readTcpListenPortOwner: async () => ({
					command: 'qemu-system-aarch64',
					pid: 48_282,
				}),
			}),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: 48_282,
		});

		expect(processFixture.terminateRecordedHostProcess).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ identity: expect.objectContaining({ hostProcessId: 48_282 }) }),
		);
		expect(deleteManagedGatewayRuntimeRecord).toHaveBeenCalledWith(gatewayRuntimeRecordTarget);
		expect(logRecords).toEqual([
			['info', { operation: 'inspect-gateway-runtime-record', zoneId: 'shravan' }],
			['info', { operation: 'remove-gateway-runtime-record', zoneId: 'shravan' }],
		]);
	});

	it('classifies a connection-refused cleanup failure as unavailable', async () => {
		const capturedRecords: LogRecord[] = [];
		await configure({
			loggers: [
				{
					category: ['agent-vm', 'controller', 'gateway'],
					lowestLevel: 'trace',
					sinks: ['capture'],
				},
			],
			reset: true,
			sinks: {
				capture: (record): void => {
					capturedRecords.push(record);
				},
			},
		});
		try {
			const processTermination = createExactProcessTerminationFixture();
			const result = await cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions(), {
				...processTermination,
				deleteManagedGatewayRuntimeRecord: async () => {
					throw new Error('connect ECONNREFUSED');
				},
				loadManagedGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(createGatewayRuntimeRecord()),
				readTcpListenPortOwner: async () => null,
			});

			expect(result).toMatchObject({ cleanedUp: false });
			expect(capturedRecords.at(-1)?.properties).toEqual({
				event: 'gateway-recovery-diagnostic',
				failureClass: 'failure',
				operation: 'delete-gateway-runtime-record',
				zoneId: 'shravan',
			});
		} finally {
			await dispose().catch(() => {});
			await reset();
		}
	});

	it('warns and skips when the recorded pid owns the port but is not a managed VM command', async () => {
		const processTermination = createExactProcessTerminationFixture();

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions({ mode: 'in-process-recovery' }), {
				...processTermination,
				loadManagedGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(createGatewayRuntimeRecord({ qemuPid: 111 })),
				readTcpListenPortOwner: async () => ({ command: '/usr/bin/python3', pid: 111 }),
			}),
		).resolves.toEqual({
			cleanedUp: false,
			cleanupWarning: expect.stringContaining('not a managed VM process'),
			killedPid: null,
			ownershipEvidence: {
				kind: 'unmanaged-port-owner',
				ownerCommand: '/usr/bin/python3',
				ownerPid: 111,
				port: 18_791,
			},
		});
		expect(processTermination.terminateRecordedHostProcess).not.toHaveBeenCalled();
	});

	it('fails closed when the recorded pid has the same start but a different command', async () => {
		const terminateRecordedHostProcess = vi.fn(async () => {
			throw new Error(
				'Gateway runtime record refusing SIGTERM to pid 48282: same process start identity was observed but command changed.',
			);
		});

		await expect(
			cleanupRecordedGatewayRuntime(createGatewayRecoveryOptions(), {
				deleteManagedGatewayRuntimeRecord: vi.fn(async () => {}),
				exactProcessTermination: { terminateRecordedHostProcess },
				loadManagedGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(createGatewayRuntimeRecord()),
				readProcessIdentity: async () => ({
					command: 'node /tmp/something-else.js',
					lstart: matchingProcessIdentity.lstart,
				}),
				readTcpListenPortOwner: async () => ({
					command: 'qemu-system-aarch64',
					pid: 48_282,
				}),
			}),
		).rejects.toThrow(/same process start identity was observed but command changed/u);
		expect(terminateRecordedHostProcess).toHaveBeenCalledOnce();
	});
});
