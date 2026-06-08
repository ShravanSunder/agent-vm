import { describe, expect, it, vi } from 'vitest';

import { createManagedExecProcessStub } from '../../testing/managed-vm-test-helpers.js';
import type { GatewayZoneLifecycleState } from '../zone-runtimes/gateway-zone-state-machine.js';
import { ControllerZoneRuntimeStartError } from '../zone-runtimes/zone-runtime-errors.js';
import type { GatewayZoneRuntimeHandle } from '../zone-runtimes/zone-runtime-types.js';
import {
	createGatewayVmRecoveryRunner,
	type RecoverableGatewayRuntime,
} from './gateway-vm-recovery-runner.js';

describe('createGatewayVmRecoveryRunner', () => {
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
			close: async () => {},
			enableSsh: async () => ({ host: '127.0.0.1', port: 22 }),
			exec: () => createManagedExecProcessStub({ stdout: '' }),
			getHostPid: () => hostPid,
			id: vmId,
		},
	};
}
