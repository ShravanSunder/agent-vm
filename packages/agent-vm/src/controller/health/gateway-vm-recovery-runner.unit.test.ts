import { describe, expect, it, vi } from 'vitest';

import {
	createCompleteVmDestroyReceipt,
	createManagedExecProcessStub,
	createTestVmOwnershipReservationReference,
} from '../../testing/managed-vm-test-helpers.js';
import type { VmCreationOwnership } from '../vm-ownership/vm-creation-ownership.js';
import type { GatewayZoneLifecycleState } from '../zone-runtimes/gateway-zone-state-machine.js';
import { ControllerZoneRuntimeStartError } from '../zone-runtimes/zone-runtime-errors.js';
import type { GatewayZoneRuntimeHandle } from '../zone-runtimes/zone-runtime-types.js';
import {
	classifyGatewayRecoveryRestartError,
	createGatewayVmRecoveryRunner,
	type RecoverableGatewayRuntime,
} from './gateway-vm-recovery-runner.js';

type RecoveryWriteLog = (message: string) => void;
type RecoveryWriteLogSpy = ReturnType<typeof vi.fn<RecoveryWriteLog>>;

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
		expect(writeLog).toHaveBeenCalledWith(expect.stringContaining('zone runtime not found'));
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
			zoneId: 'sunfam',
		});

		expectRecoveryLogToBeCredentialSafe(writeLog);
	});

	it('passes auto-recovery trigger to cold-start and restart runtime actions', async () => {
		const restart = vi.fn(async () => ({
			leaseReleaseFailureCount: 0,
			operationId: 'restart-op',
		}));
		const coldStart = vi.fn(async () => ({
			leaseReleaseFailureCount: 0,
			operationId: 'cold-start-op',
		}));
		const runningRuntime = createRuntime({
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
	});

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
	const loggedText = writeLog.mock.calls.map(([message]) => message).join('\n');

	expect(loggedText).toContain("'<1password-ref>'");
	expect(loggedText).toContain('OP_SERVICE_ACCOUNT_TOKEN=<redacted>');
	expect(loggedText).toContain('Bearer <redacted>');
	expect(loggedText).toContain('password=<redacted>');
	expect(loggedText).toContain('token=<redacted>');
	expect(loggedText).toContain('password="<redacted>"');
	expect(loggedText).toContain('"password":"<redacted>"');
	expect(loggedText).toContain('"token":"<redacted>"');
	expect(loggedText).toContain("'secret':'<redacted>'");

	expect(loggedText).not.toContain('op://');
	expect(loggedText).not.toContain('sunfam gateway');
	expect(loggedText).not.toContain('ops_recoveryserviceaccounttoken123456');
	expect(loggedText).not.toContain('ops_standaloneserviceaccounttoken123456');
	expect(loggedText).not.toContain('eyJunsafe.secret.signature');
	expect(loggedText).not.toContain('raw-password-value');
	expect(loggedText).not.toContain('raw-token-value');
	expect(loggedText).not.toContain('quoted-password-value');
	expect(loggedText).not.toContain('json-password-value');
	expect(loggedText).not.toContain('json-token-value');
	expect(loggedText).not.toContain('single-quoted-secret-value');
}

function createRuntime(overrides: Partial<RecoverableGatewayRuntime>): RecoverableGatewayRuntime {
	return {
		coldStart: async () => ({ leaseReleaseFailureCount: 0 }),
		getLifecycleState: () => ({ kind: 'stopped' }),
		getSnapshot: () => ({ lifecycleState: 'stopped' }),
		refreshCredentials: async () => ({ ok: true, zoneId: 'sunfam' }),
		restart: async () => ({ leaseReleaseFailureCount: 0 }),
		...overrides,
	};
}

function createGatewayHandle(vmId: string, hostPid: number): GatewayZoneRuntimeHandle {
	return {
		ingress: { host: '127.0.0.1', port: 18_791 },
		processSpec: {
			bootstrapCommand: 'bootstrap',
			guestListenPort: 18_789,
			healthCheck: { path: '/readyz', port: 18_789, type: 'http' },
			logPath: '/agent-vm/logs/gateway.log',
			startCommand: 'start',
		},
		vm: {
			close: async () => createCompleteVmDestroyReceipt(vmId),
			enableSsh: async () => ({ host: '127.0.0.1', port: 22 }),
			exec: () => createManagedExecProcessStub({ stdout: '' }),
			getHostPid: () => hostPid,
			id: vmId,
		},
		vmOwnership: createGatewayVmOwnershipStub(vmId),
	};
}

function createGatewayVmOwnershipStub(vmId: string): VmCreationOwnership {
	return {
		ownershipReservation: createTestVmOwnershipReservationReference(vmId, { role: 'gateway' }),
		destroyDetached: async () => createCompleteVmDestroyReceipt(vmId, { role: 'gateway' }),
		destroyLive: async (closeLiveVm) => await closeLiveVm(),
	};
}
