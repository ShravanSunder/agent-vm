import { describe, expect, it, vi } from 'vitest';

import type { GatewayExpectedAdmissionCohort } from '../../gateway/gateway-aggregate-admission-state.js';
import { createManagedGatewayBootContract } from '../../gateway/managed-gateway-boot-contract.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../../testing/managed-vm-test-helpers.js';
import type {
	ControllerDiagnosticLevel,
	ControllerDiagnosticTelemetry,
} from '../controller-diagnostic-logging.js';
import type { GatewayZoneLifecycleState } from '../zone-runtimes/gateway-zone-state-machine.js';
import { ControllerZoneRuntimeStartError } from '../zone-runtimes/zone-runtime-errors.js';
import type { GatewayZoneRuntimeHandle } from '../zone-runtimes/zone-runtime-types.js';
import type { GatewayVmRecoverySourceKey } from './gateway-vm-recovery-policy.js';
import {
	classifyGatewayRecoveryRestartError,
	createGatewayVmRecoveryRunner,
	type RecoverableGatewayRuntime,
} from './gateway-vm-recovery-runner.js';

type RecoveryWriteLog = (
	level: ControllerDiagnosticLevel,
	telemetry?: ControllerDiagnosticTelemetry,
) => void;
type RecoveryWriteLogSpy = ReturnType<typeof vi.fn<RecoveryWriteLog>>;

const testManagedGatewayBootContract = createManagedGatewayBootContract({
	bootEntry: 'hermes-gateway',
	configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
	environmentInputPath: '/run/agent-vm/managed-gateway/framework.environment.sh',
	framework: 'hermes',
	ingress: { guestPort: 18_789, kind: 'framework-http' },
	logIdentity: {
		guestPath: '/var/log/agent-vm/hermes-service.log',
		serviceName: 'agent-vm-hermes-test',
	},
	readiness: { guestPort: 18_789, kind: 'framework-http', path: '/readyz' },
	role: 'framework-service',
});

const testHermesZone = {
	agentToolVmProfiles: {},
	defaultToolVmProfile: 'standard',
	egressHosts: [],
	gateway: {
		config: '/config/hermes.json',
		cpus: 2,
		imageProfile: 'hermes',
		memory: '2G',
		port: 18_791,
		stateDir: '/storage/sunfam/state',
		type: 'hermes',
		profileSecretProjectionsByAgent: { main: {} },
		profilesByAgent: { main: 'main' },
		zoneFilesDir: '/storage/sunfam/zone-files',
		zoneRuntimeDir: '/storage/sunfam/runtime',
	},
	id: 'sunfam',
	secrets: {
		HERMES_GATEWAY_TOKEN: {
			audience: 'gateway',
			envVar: 'HERMES_GATEWAY_TOKEN',
			injection: 'env',
			source: 'environment',
		},
	},
} satisfies GatewayZoneRuntimeHandle['zone'];

describe('createGatewayVmRecoveryRunner', () => {
	it('observes only when the controller is stopping', async () => {
		const getRecoverableGatewayRuntime = vi.fn(() => createRuntime({}));
		const recoverGatewayVm = createGatewayVmRecoveryRunner({
			getRecoverableGatewayRuntime,
			getRuntimeReadiness: () => ({
				ready: false,
				reason: 'shutdown requested',
				state: 'stopping',
			}),
			now: () => 1_000,
			restartTimeoutMs: 5_000,
			writeLog: vi.fn(),
		});

		const result = await recoverGatewayVm({
			consecutiveFailures: 1,
			reason: 'gateway-service-unhealthy',
			zoneId: 'sunfam',
		});

		expect(result).toEqual({
			action: 'observe-only',
			elapsedMs: 0,
			errorCode: 'controller-stopping',
			result: 'failed',
		});
		expect(getRecoverableGatewayRuntime).not.toHaveBeenCalled();
	});

	it('observes only when the runtime is unavailable', async () => {
		const writeLog = vi.fn();
		const recoverGatewayVm = createGatewayVmRecoveryRunner({
			getRecoverableGatewayRuntime: () => {
				throw new Error('zone runtime not found');
			},
			getRuntimeReadiness: () => ({ ready: true, state: 'ready' }),
			now: () => 1_000,
			restartTimeoutMs: 5_000,
			writeLog,
		});

		const result = await recoverGatewayVm({
			consecutiveFailures: 1,
			reason: 'gateway-service-unhealthy',
			zoneId: 'sunfam',
		});

		expect(result).toEqual({
			action: 'observe-only',
			elapsedMs: 0,
			errorCode: 'runtime-unavailable',
			result: 'failed',
		});
		expect(writeLog).toHaveBeenCalledWith('warning', {
			operation: 'recover-gateway-runtime-lookup',
			zoneId: 'sunfam',
		});
	});

	it('preserves refresh failure operation id and classifies it as secret resolution', async () => {
		const runtime = createRuntime({
			getLifecycleState: () => ({
				coldStartEligible: true,
				error: {
					code: 'secret-resolution-failed',
					message: 'Failed to resolve zone secrets.',
				},
				kind: 'failed',
			}),
			refreshCredentials: async () => {
				throw new ControllerZoneRuntimeStartError(
					'sunfam',
					new Error('1Password SDK failed to create client'),
					{
						gatewayLifecycleErrorCode: 'secret-resolution-failed',
						operationId: 'sunfam-credentials-refresh-op',
					},
				);
			},
		});
		const recoverGatewayVm = createGatewayVmRecoveryRunner({
			getRecoverableGatewayRuntime: () => runtime,
			getRuntimeReadiness: () => ({ ready: true, state: 'ready' }),
			now: () => 1_000,
			restartTimeoutMs: 5_000,
			writeLog: vi.fn(),
		});

		const result = await recoverGatewayVm({
			consecutiveFailures: 1,
			reason: 'gateway-service-unhealthy',
			zoneId: 'sunfam',
		});

		expect(result).toEqual({
			action: 'gateway-vm-cold-start',
			elapsedMs: 0,
			errorCode: 'secret-resolution-failed',
			operationId: 'sunfam-credentials-refresh-op',
			result: 'failed',
		});
	});

	it('redacts credential refresh failure details before writing recovery logs', async () => {
		const writeLog = vi.fn<RecoveryWriteLog>();
		const runtime = createRuntime({
			getLifecycleState: () => ({
				coldStartEligible: true,
				error: {
					code: 'secret-resolution-failed',
					message: 'Failed to resolve zone secrets.',
				},
				kind: 'failed',
			}),
			refreshCredentials: async () => {
				throw new ControllerZoneRuntimeStartError(
					'sunfam',
					new Error(createUnsafeRecoveryErrorMessage()),
					{
						gatewayLifecycleErrorCode: 'secret-resolution-failed',
						operationId: 'sunfam-credentials-refresh-op',
					},
				);
			},
		});
		const recoverGatewayVm = createGatewayVmRecoveryRunner({
			getRecoverableGatewayRuntime: () => runtime,
			getRuntimeReadiness: () => ({ ready: true, state: 'ready' }),
			now: () => 1_000,
			restartTimeoutMs: 5_000,
			writeLog,
		});

		await recoverGatewayVm({
			consecutiveFailures: 1,
			reason: 'gateway-service-unhealthy',
			sourceKey: createGatewayRecoverySourceKey('old-gateway'),
			zoneId: 'sunfam',
		});

		expectRecoveryLogToBeCredentialSafe(writeLog);
	});

	it('redacts restart failure details before writing recovery logs', async () => {
		const writeLog = vi.fn<RecoveryWriteLog>();
		const runtime = createRuntime({
			getLifecycleState: () => ({
				gateway: createGatewayHandle('old-gateway', 111),
				kind: 'running',
			}),
			getSnapshot: () => ({
				bootedAt: '2026-06-07T10:00:00.000Z',
				gateway: {
					ingress: { host: '127.0.0.1', port: 18_791 },
					vm: { hostPid: 111, id: 'old-gateway' },
				},
				lifecycleState: 'running',
			}),
			restart: async () => {
				throw new Error(createUnsafeRecoveryErrorMessage());
			},
		});
		const recoverGatewayVm = createGatewayVmRecoveryRunner({
			getRecoverableGatewayRuntime: () => runtime,
			getRuntimeReadiness: () => ({ ready: true, state: 'ready' }),
			now: () => 1_000,
			restartTimeoutMs: 5_000,
			writeLog,
		});

		await recoverGatewayVm({
			consecutiveFailures: 1,
			reason: 'gateway-service-unhealthy',
			sourceKey: createGatewayRecoverySourceKey('old-gateway'),
			zoneId: 'sunfam',
		});

		expectRecoveryLogToBeCredentialSafe(writeLog);
	});

	it.each(['hermes'] as const)(
		'passes auto-recovery trigger to $gatewayType runtime actions',
		async (gatewayType) => {
			const restart = vi.fn(async () => ({
				leaseReleaseFailureCount: 0,
				operationId: 'restart-op',
			}));
			const coldStart = vi.fn(async () => ({
				leaseReleaseFailureCount: 0,
				operationId: 'cold-start-op',
			}));
			const runningRuntime = createRuntime({
				gatewayType,
				getLifecycleState: () => ({
					gateway: createGatewayHandle('old-gateway', 111),
					kind: 'running',
				}),
				getSnapshot: () => ({
					bootedAt: '2026-06-07T10:00:00.000Z',
					gateway: {
						ingress: { host: '127.0.0.1', port: 18_791 },
						vm: { hostPid: 111, id: 'old-gateway' },
					},
					lifecycleState: 'running',
				}),
				restart,
			});
			const failedRuntime = createRuntime({
				coldStart,
				gatewayType,
				getLifecycleState: () => ({
					coldStartEligible: true,
					error: { code: 'vm-process-missing', message: 'missing' },
					kind: 'failed',
				}),
				getSnapshot: () => ({
					bootedAt: '2026-06-07T10:01:00.000Z',
					gateway: {
						ingress: { host: '127.0.0.1', port: 18_791 },
						vm: { hostPid: 222, id: 'new-gateway' },
					},
					lifecycleState: 'running',
				}),
			});

			const recoverRunningGateway = createGatewayVmRecoveryRunner({
				getRecoverableGatewayRuntime: () => runningRuntime,
				getRuntimeReadiness: () => ({ ready: true, state: 'ready' }),
				now: () => 1_000,
				restartTimeoutMs: 5_000,
				writeLog: vi.fn(),
			});
			await recoverRunningGateway({
				consecutiveFailures: 1,
				reason: 'gateway-service-unhealthy',
				sourceKey: createGatewayRecoverySourceKey('old-gateway'),
				zoneId: 'sunfam',
			});

			const recoverFailedGateway = createGatewayVmRecoveryRunner({
				getRecoverableGatewayRuntime: () => failedRuntime,
				getRuntimeReadiness: () => ({ ready: true, state: 'ready' }),
				now: () => 1_000,
				restartTimeoutMs: 5_000,
				writeLog: vi.fn(),
			});
			await recoverFailedGateway({
				consecutiveFailures: 1,
				reason: 'gateway-service-unhealthy',
				zoneId: 'sunfam',
			});

			expect(restart).toHaveBeenCalledWith({
				operationTrigger: 'auto-recovery',
				timeoutMs: 5_000,
			});
			expect(coldStart).toHaveBeenCalledWith({
				operationTrigger: 'auto-recovery',
				timeoutMs: 5_000,
			});
		},
	);

	it('fails cold-start verification when the new snapshot lacks running VM identity', async () => {
		const runtime = createRuntime({
			coldStart: async () => ({ leaseReleaseFailureCount: 2, operationId: 'cold-start-op' }),
			getLifecycleState: () => ({
				coldStartEligible: true,
				error: { code: 'vm-process-missing', message: 'missing' },
				kind: 'failed',
			}),
			getSnapshot: () => ({
				gateway: {
					ingress: { host: '127.0.0.1', port: 18_791 },
					vm: { id: 'new-gateway' },
				},
				lifecycleState: 'running',
			}),
		});
		const recoverGatewayVm = createGatewayVmRecoveryRunner({
			getRecoverableGatewayRuntime: () => runtime,
			getRuntimeReadiness: () => ({ ready: true, state: 'ready' }),
			now: () => 1_000,
			restartTimeoutMs: 5_000,
			writeLog: vi.fn(),
		});

		const result = await recoverGatewayVm({
			consecutiveFailures: 1,
			reason: 'gateway-service-unhealthy',
			sourceKey: createGatewayRecoverySourceKey('same-gateway'),
			zoneId: 'sunfam',
		});

		expect(result).toEqual({
			action: 'gateway-vm-cold-start',
			elapsedMs: 0,
			errorCode: 'cold-start-verification-failed',
			result: 'failed',
		});
	});

	it('fails restart verification when the replacement VM identity does not change', async () => {
		const runtime = createRuntime({
			getLifecycleState: () => ({
				gateway: createGatewayHandle('same-gateway', 111),
				kind: 'running',
			}),
			getSnapshot: () => ({
				bootedAt: '2026-06-07T10:00:00.000Z',
				gateway: {
					ingress: { host: '127.0.0.1', port: 18_791 },
					vm: { hostPid: 111, id: 'same-gateway' },
				},
				lifecycleState: 'running',
			}),
			restart: async () => ({ leaseReleaseFailureCount: 0, operationId: 'restart-op' }),
		});
		const recoverGatewayVm = createGatewayVmRecoveryRunner({
			getRecoverableGatewayRuntime: () => runtime,
			getRuntimeReadiness: () => ({ ready: true, state: 'ready' }),
			now: () => 1_000,
			restartTimeoutMs: 5_000,
			writeLog: vi.fn(),
		});

		const result = await recoverGatewayVm({
			consecutiveFailures: 1,
			reason: 'gateway-service-unhealthy',
			sourceKey: createGatewayRecoverySourceKey('same-gateway'),
			zoneId: 'sunfam',
		});

		expect(result).toEqual({
			action: 'gateway-vm-restart',
			elapsedMs: 0,
			errorCode: 'restart-verification-failed',
			oldBootedAt: '2026-06-07T10:00:00.000Z',
			oldHostPid: 111,
			oldVmId: 'same-gateway',
			result: 'failed',
		});
	});

	it('preserves restart operation id when replacement VM identity changes', async () => {
		let snapshot = {
			bootedAt: '2026-06-07T10:00:00.000Z',
			gateway: {
				ingress: { host: '127.0.0.1', port: 18_791 },
				vm: { hostPid: 111, id: 'old-gateway' },
			},
			lifecycleState: 'running' as const,
		};
		const runtime = createRuntime({
			getLifecycleState: () => ({
				gateway: createGatewayHandle('old-gateway', 111),
				kind: 'running',
			}),
			getSnapshot: () => snapshot,
			restart: async () => {
				snapshot = {
					bootedAt: '2026-06-07T10:01:00.000Z',
					gateway: {
						ingress: { host: '127.0.0.1', port: 18_791 },
						vm: { hostPid: 222, id: 'new-gateway' },
					},
					lifecycleState: 'running',
				};
				return { leaseReleaseFailureCount: 3, operationId: 'restart-op' };
			},
		});
		const recoverGatewayVm = createGatewayVmRecoveryRunner({
			getRecoverableGatewayRuntime: () => runtime,
			getRuntimeReadiness: () => ({ ready: true, state: 'ready' }),
			now: () => 1_000,
			restartTimeoutMs: 5_000,
			writeLog: vi.fn(),
		});

		const result = await recoverGatewayVm({
			consecutiveFailures: 1,
			reason: 'gateway-service-unhealthy',
			sourceKey: createGatewayRecoverySourceKey('old-gateway'),
			zoneId: 'sunfam',
		});

		expect(result).toEqual({
			elapsedMs: 0,
			leaseReleaseFailureCount: 3,
			newBootedAt: '2026-06-07T10:01:00.000Z',
			newHostPid: 222,
			newVmId: 'new-gateway',
			oldBootedAt: '2026-06-07T10:00:00.000Z',
			oldHostPid: 111,
			oldVmId: 'old-gateway',
			operationId: 'restart-op',
			result: 'ok',
		});
	});

	it('preserves owner-unsafe classification when restart cleanup fails', async () => {
		let lifecycleState: GatewayZoneLifecycleState = {
			gateway: createGatewayHandle('old-gateway', 111),
			kind: 'running',
		};
		const runtime = createRuntime({
			getLifecycleState: () => lifecycleState,
			getSnapshot: () => ({
				bootedAt: '2026-06-07T10:00:00.000Z',
				gateway: {
					ingress: { host: '127.0.0.1', port: 18_791 },
					vm: { hostPid: 111, id: 'old-gateway' },
				},
				lifecycleState: 'running',
			}),
			restart: async () => {
				lifecycleState = {
					coldStartEligible: false,
					error: { code: 'owner-unsafe', message: 'gateway close timed out' },
					kind: 'failed',
				};
				throw new Error('gateway close timed out');
			},
		});
		const recoverGatewayVm = createGatewayVmRecoveryRunner({
			getRecoverableGatewayRuntime: () => runtime,
			getRuntimeReadiness: () => ({ ready: true, state: 'ready' }),
			now: () => 1_000,
			restartTimeoutMs: 5_000,
			writeLog: vi.fn(),
		});

		await expect(
			recoverGatewayVm({
				consecutiveFailures: 1,
				reason: 'gateway-service-unhealthy',
				sourceKey: createGatewayRecoverySourceKey('old-gateway'),
				zoneId: 'sunfam',
			}),
		).resolves.toEqual({
			action: 'gateway-vm-restart',
			elapsedMs: 0,
			errorCode: 'owner-unsafe',
			oldBootedAt: '2026-06-07T10:00:00.000Z',
			oldHostPid: 111,
			oldVmId: 'old-gateway',
			result: 'failed',
		});
	});

	it('refuses a stale Gateway source before mutating the current successor', async () => {
		const restart = vi.fn(async () => ({ leaseReleaseFailureCount: 0 }));
		const runtime = createRuntime({
			getLifecycleState: () => ({
				gateway: createGatewayHandle('gateway-vm-2', 222),
				kind: 'running',
			}),
			getSnapshot: () => ({
				bootedAt: '2026-07-11T18:00:00.000Z',
				gateway: { vm: { hostPid: 222, id: 'gateway-vm-2' } },
				lifecycleState: 'running',
			}),
			restart,
		});
		const recoverGatewayVm = createGatewayVmRecoveryRunner({
			getRecoverableGatewayRuntime: () => runtime,
			getRuntimeReadiness: () => ({ ready: true, state: 'ready' }),
			now: () => 1_000,
			restartTimeoutMs: 5_000,
			writeLog: vi.fn(),
		});

		await expect(
			recoverGatewayVm({
				consecutiveFailures: 1,
				reason: 'gateway-control-session-unhealthy',
				sourceKey: createGatewayRecoverySourceKey('gateway-vm-1'),
				zoneId: 'sunfam',
			}),
		).resolves.toEqual({
			action: 'observe-only',
			elapsedMs: 0,
			errorCode: 'stale-recovery-source',
			result: 'failed',
		});
		expect(restart).not.toHaveBeenCalled();
	});

	it('refuses recovery when the request omits the required current Gateway source identity', async () => {
		const restart = vi.fn(async () => ({ leaseReleaseFailureCount: 0 }));
		const runtime = createRuntime({
			getLifecycleState: () => ({
				gateway: createGatewayHandle('gateway-vm-1', 111),
				kind: 'running',
			}),
			getSnapshot: () => ({
				bootedAt: '2026-07-11T18:00:00.000Z',
				gateway: { vm: { hostPid: 111, id: 'gateway-vm-1' } },
				lifecycleState: 'running',
			}),
			restart,
		});
		const recoverGatewayVm = createGatewayVmRecoveryRunner({
			getRecoverableGatewayRuntime: () => runtime,
			getRuntimeReadiness: () => ({ ready: true, state: 'ready' }),
			now: () => 1_000,
			restartTimeoutMs: 5_000,
			writeLog: vi.fn(),
		});

		await expect(
			recoverGatewayVm({
				consecutiveFailures: 1,
				reason: 'gateway-service-unhealthy',
				zoneId: 'sunfam',
			}),
		).resolves.toEqual({
			action: 'observe-only',
			elapsedMs: 0,
			errorCode: 'stale-recovery-source',
			result: 'failed',
		});
		expect(restart).not.toHaveBeenCalled();
	});

	it('bounds a never-resolving credential refresh with an injected deadline', async () => {
		let nowMs = 0;
		let refreshSignal: AbortSignal | undefined;
		const timeoutCallbacks: Array<() => void> = [];
		const runtime = createRuntime({
			getLifecycleState: () => ({
				coldStartEligible: true,
				error: { code: 'secret-resolution-failed', message: 'credentials unavailable' },
				kind: 'failed',
			}),
			refreshCredentials: async (options) => {
				refreshSignal = options?.signal;
				return await new Promise<never>(() => {});
			},
		});
		const recoverGatewayVm = createGatewayVmRecoveryRunner({
			clearTimeoutImpl: vi.fn(),
			getRecoverableGatewayRuntime: () => runtime,
			getRuntimeReadiness: () => ({ ready: true, state: 'ready' }),
			now: () => nowMs,
			restartTimeoutMs: 5_000,
			setTimeoutImpl: (callback) => {
				timeoutCallbacks.push(callback);
				return { unref: vi.fn() } as unknown as NodeJS.Timeout;
			},
			writeLog: vi.fn(),
		});

		const recovery = recoverGatewayVm({
			consecutiveFailures: 1,
			reason: 'gateway-service-unhealthy',
			zoneId: 'sunfam',
		});
		await vi.waitFor(() => expect(timeoutCallbacks).toHaveLength(1));
		nowMs = 5_000;
		timeoutCallbacks[0]?.();
		expect(refreshSignal?.aborted).toBe(true);

		await expect(recovery).resolves.toEqual({
			action: 'gateway-vm-cold-start',
			elapsedMs: 5_000,
			errorCode: 'recovery-timeout',
			result: 'failed',
		});
	});
});

describe('classifyGatewayRecoveryRestartError', () => {
	it('classifies disk, secret, VM-create, and unknown restart failures', () => {
		expect(
			classifyGatewayRecoveryRestartError(Object.assign(new Error('full'), { code: 'ENOSPC' })),
		).toBe('restart-disk-failure');
		expect(classifyGatewayRecoveryRestartError(new Error('1Password credential unavailable'))).toBe(
			'restart-secret-failure',
		);
		expect(classifyGatewayRecoveryRestartError(new Error('qemu vm.create failed'))).toBe(
			'restart-vm-create-failed',
		);
		expect(classifyGatewayRecoveryRestartError(new Error('unexpected close'))).toBe(
			'restart-threw',
		);
	});
});

function createUnsafeRecoveryErrorMessage(): string {
	return [
		"failed to resolve 'op://agent-vm/sunfam gateway/password;field'",
		'OP_SERVICE_ACCOUNT_TOKEN=ops_recoveryserviceaccounttoken123456',
		'Bearer eyJunsafe.secret.signature',
		'password=raw-password-value',
		'token=raw-token-value',
		'password="quoted-password-value"',
		'"password":"json-password-value"',
		'"token":"json-token-value"',
		"'secret':'single-quoted-secret-value'",
		'standalone ops_standaloneserviceaccounttoken123456',
	].join(' ');
}

function expectRecoveryLogToBeCredentialSafe(writeLog: RecoveryWriteLogSpy): void {
	expect(writeLog).toHaveBeenCalledWith(
		'warning',
		expect.objectContaining({
			errorCode: expect.any(String),
			operation: expect.any(String),
			zoneId: 'sunfam',
		}),
	);
	for (const [level, telemetry] of writeLog.mock.calls) {
		expect(['info', 'warning']).toContain(level);
		expect(JSON.stringify(telemetry)).not.toContain('op://');
		expect(JSON.stringify(telemetry)).not.toContain('ops_recoveryserviceaccounttoken123456');
	}
}

function createRuntime(overrides: Partial<RecoverableGatewayRuntime>): RecoverableGatewayRuntime {
	return {
		coldStart: async () => ({ leaseReleaseFailureCount: 0 }),
		gatewayType: 'hermes',
		getLifecycleState: () => ({ kind: 'stopped' }),
		getSnapshot: () => ({ lifecycleState: 'stopped' }),
		refreshCredentials: async () => ({ ok: true, zoneId: 'sunfam' }),
		restart: async () => ({ leaseReleaseFailureCount: 0 }),
		...overrides,
	};
}

function createGatewayHandle(vmId: string, hostPid: number): GatewayZoneRuntimeHandle {
	return {
		bootContract: testManagedGatewayBootContract,
		executionModel: 'managed-gateway',
		expectedCohort: createExpectedAdmissionCohort(vmId),
		destroyGateway: async () => ({ kind: 'destroyed-clean' }),
		gatewayIdentity: createGatewayIdentity(vmId),
		image: {
			built: false,
			fingerprint: 'gateway-image-fingerprint',
			imageReference: '/images/hermes-gateway',
		},
		ingress: { host: '127.0.0.1', port: 18_791 },
		vm: {
			enableSsh: async () => ({
				close: async () => {},
				serverHostKey: TEST_SSH_SERVER_HOST_KEY,
				command: 'ssh gateway',
				host: '127.0.0.1',
				identityFile: '/tmp/gateway-identity',
				port: 22,
				user: 'root',
			}),
			exec: () => createManagedExecProcessStub({ stdout: '' }),
			getHostProcessId: () => hostPid,
			id: vmId,
		},
		zone: testHermesZone,
	};
}

function createExpectedAdmissionCohort(vmId: string): GatewayExpectedAdmissionCohort {
	return {
		controlIdentity: {
			controllerEpoch: 'controller-test',
			generationId: 'generation-test',
			peerId: 'tool-portal-control',
			processEpoch: 'tool-portal-process-test',
		},
		fence: {
			controllerEpoch: 'controller-test',
			gatewayEpoch: 'generation-test',
			vmId,
			zoneId: 'sunfam',
		},
		frameworkIdentity: {
			attachmentGeneration: 1,
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds: ['main'],
			frameworkEpoch: 'framework-epoch-test',
			frameworkKind: 'hermes',
			projectionCohortDigest:
				'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		},
		ingressIntent: {
			controlRoute: {
				audience: 'gateway-control',
				guestPort: 18_790,
				kind: 'tool-portal-control',
				prefix: '/_agent-vm/control',
				stripPrefix: true,
			},
			frameworkRootRoute: {
				guestPort: 18_789,
				kind: 'framework-root',
				prefix: '/',
				stripPrefix: true,
			},
		},
		providerRevision: 'provider-revision-test',
		requiredBackendRevision: 'required-backend-revision-test',
		semanticRevision: 'semantic-revision-test',
		toolPortalIdentity: {
			processEpoch: 'tool-portal-process-test',
			role: 'tool-portal',
			runtimeEpoch: 'runtime-epoch-test',
			serviceId: 'tool-portal-service-test',
		},
		udsIdentity: {
			frameworkEpoch: 'framework-epoch-test',
			gatewayEpoch: 'generation-test',
			runtimeEpoch: 'runtime-epoch-test',
			socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
		},
	};
}

function createGatewayRecoverySourceKey(vmId: string): GatewayVmRecoverySourceKey {
	return {
		bootId: 'boot-test',
		domain: 'gateway_control' as const,
		gatewayVmId: vmId,
		generationId: 'generation-test',
		zoneId: 'sunfam',
	};
}

function createGatewayIdentity(vmId: string): GatewayZoneRuntimeHandle['gatewayIdentity'] {
	return {
		bootId: 'boot-test',
		controllerEpoch: 'controller-test',
		gatewayEpochId: 'gateway-epoch-test',
		gatewayVmId: vmId,
		generationId: 'generation-test',
		zoneId: 'sunfam',
	};
}
