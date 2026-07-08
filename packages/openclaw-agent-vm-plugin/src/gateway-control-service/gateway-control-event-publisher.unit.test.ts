import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createGatewayControlEventPublisher,
	startGatewayControlSessionHeartbeat,
} from './gateway-control-event-publisher.js';
import type { GatewayControlService } from './gateway-control-service.js';

function createControlServiceStub(): GatewayControlService {
	let sequence = 0;
	return {
		close: vi.fn(async () => {}),
		emitApplicationMessage: vi.fn(async () => ({ ok: true })),
		getAcceptedSession: vi.fn(async () => ({
			...identity,
			connectionId: '55555555-5555-4555-8555-555555555555',
			sessionId: '33333333-3333-4333-8333-333333333333',
		})),
		getCredentialState: vi.fn(() => undefined),
		handleReadyRequest: vi.fn(() => true),
		handleUpgrade: vi.fn(() => true),
		nextPeerSequence: vi.fn(() => {
			sequence += 1;
			return sequence;
		}),
	};
}

const identity = {
	bootId: 'gateway-boot-a',
	callerContextAgentAuthorityKeys: {},
	callerContextProofKey: 'test-caller-context-proof-key',
	controllerEpoch: 'controller-epoch-a',
	generationId: 'gateway-generation-a',
	peerId: 'gateway-zone-a',
	zoneId: 'shravan',
};

afterEach(() => {
	vi.useRealTimers();
});

describe('gateway control event publisher', () => {
	it('publishes health events over gateway_control without controller HTTP', async () => {
		const controlService = createControlServiceStub();
		const publisher = createGatewayControlEventPublisher({
			controlService,
			createId: () => '11111111-1111-4111-8111-111111111111',
			identity,
			now: () => 1_000,
		});

		await publisher.publishHealthEvent({
			agentId: 'main',
			causationId: '22222222-2222-4222-8222-222222222222',
			correlationId: '33333333-3333-4333-8333-333333333333',
			elapsedMs: 15,
			requestId: 'request-1',
			kind: 'tool-vm-ssh',
			leaseId: 'lease-main',
			observedAtMs: 1_000,
			operation: 'probe',
			result: 'ok',
			runId: 'run-1',
			sessionKeyDigest: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
			toolCallId: 'tool-call-1',
			traceId: '0123456789abcdef0123456789abcdef',
			zoneId: identity.zoneId,
		});

		expect(controlService.emitApplicationMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				deliveryPolicy: 'append_only_observation',
				domain: 'gateway_control',
				kind: 'event',
				operation: 'health_event',
				zoneId: identity.zoneId,
			}),
			{
				kind: 'event',
				operation: 'health_event',
			},
			{
				kind: 'event',
				operation: 'health_event',
				payload: expect.objectContaining({
					agentId: 'main',
					correlation: {
						causationId: '22222222-2222-4222-8222-222222222222',
						correlationId: '33333333-3333-4333-8333-333333333333',
						requestId: 'request-1',
						runId: 'run-1',
						sessionKeyDigest: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
						toolCallId: 'tool-call-1',
						traceId: '0123456789abcdef0123456789abcdef',
					},
					eventKind: 'tool-vm-ssh',
					leaseId: 'lease-main',
					operation: 'probe',
					observedAtMs: 1_000,
					result: 'ok',
				}),
			},
		);
	});

	it('publishes Tool VM lifecycle health evidence over gateway_control', async () => {
		const controlService = createControlServiceStub();
		const publisher = createGatewayControlEventPublisher({
			controlService,
			createId: () => '11111111-1111-4111-8111-111111111111',
			identity,
			now: () => 1_000,
		});

		await publisher.publishHealthEvent({
			activeUseId: '66666666-6666-4666-8666-666666666666',
			agentId: 'main',
			callerContextState: 'stale',
			elapsedMs: 15,
			errorCode: 'ssh-command-failed',
			kind: 'tool-vm-ssh',
			leaseId: '01890f00-0000-7000-8000-000000000001',
			leaseRejectionReason: 'caller_context_stale',
			lifecycleEventRole: 'plugin_observation',
			lifecycleTransition: 'current_to_stale',
			observedAtMs: 1_000,
			oldLeaseId: '01890f00-0000-7000-8000-000000000001',
			operation: 'file-bridge',
			result: 'failed',
			transitionId: '77777777-7777-4777-8777-777777777777',
			zoneId: identity.zoneId,
		});

		expect(controlService.emitApplicationMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				deliveryPolicy: 'append_only_observation',
				domain: 'gateway_control',
				kind: 'event',
				operation: 'health_event',
			}),
			{
				kind: 'event',
				operation: 'health_event',
			},
			{
				kind: 'event',
				operation: 'health_event',
				payload: expect.objectContaining({
					activeUseId: '66666666-6666-4666-8666-666666666666',
					callerContextState: 'stale',
					eventKind: 'tool-vm-ssh',
					leaseRejectionReason: 'caller_context_stale',
					lifecycleEventRole: 'plugin_observation',
					lifecycleTransition: 'current_to_stale',
					oldLeaseId: '01890f00-0000-7000-8000-000000000001',
					transitionId: '77777777-7777-4777-8777-777777777777',
				}),
			},
		);
	});

	it('rejects controller-final Tool VM lifecycle evidence from the plugin publisher', async () => {
		const controlService = createControlServiceStub();
		const publisher = createGatewayControlEventPublisher({
			controlService,
			createId: () => '11111111-1111-4111-8111-111111111111',
			identity,
			now: () => 1_000,
		});

		await expect(
			publisher.publishHealthEvent({
				agentId: 'main',
				callerContextState: 'ok',
				elapsedMs: 15,
				kind: 'tool-vm-ssh',
				leaseId: '01890f00-0000-7000-8000-000000000002',
				lifecycleEventRole: 'controller_final',
				lifecycleTransition: 'stale_to_reacquired',
				observedAtMs: 1_000,
				oldLeaseId: '01890f00-0000-7000-8000-000000000001',
				operation: 'file-bridge',
				replacementLeaseId: '01890f00-0000-7000-8000-000000000002',
				result: 'ok',
				transitionId: '77777777-7777-4777-8777-777777777777',
				zoneId: identity.zoneId,
			}),
		).rejects.toThrow('controller_final');
		expect(controlService.emitApplicationMessage).not.toHaveBeenCalled();
	});

	it('publishes runtime status over gateway_control without controller HTTP', async () => {
		const controlService = createControlServiceStub();
		const publisher = createGatewayControlEventPublisher({
			controlService,
			createId: () => '22222222-2222-4222-8222-222222222222',
			identity,
			now: () => 2_000,
		});

		await publisher.publishOpenClawRuntimeStatus({
			findings: [{ hint: 'ok', id: 'tool-vm-runtime-config', ok: true }],
			pluginId: 'gondolin',
			zoneId: identity.zoneId,
		});

		expect(controlService.emitApplicationMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				deliveryPolicy: 'latest_wins',
				domain: 'gateway_control',
				kind: 'event',
				operation: 'runtime_status',
				zoneId: identity.zoneId,
			}),
			{
				kind: 'event',
				operation: 'runtime_status',
			},
			{
				kind: 'event',
				operation: 'runtime_status',
				payload: {
					findings: [{ id: 'tool-vm-runtime-config', ok: true, safeMessage: 'ok' }],
					observedAtMs: 2_000,
					statusKind: 'gondolin',
				},
			},
			{ waitForReceipt: true },
		);
		expect(controlService.nextPeerSequence).toHaveBeenCalledWith({
			deliveryPolicy: 'latest_wins',
		});
	});

	it('publishes control-session heartbeat on the priority heartbeat lane', async () => {
		const controlService = createControlServiceStub();
		const publisher = createGatewayControlEventPublisher({
			controlService,
			createId: () => '33333333-3333-4333-8333-333333333333',
			identity,
			now: () => 3_000,
		});

		await publisher.publishControlSessionHeartbeat({
			elapsedMs: 2,
			observedAtMs: 2_998,
		});

		expect(controlService.emitApplicationMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				deliveryPolicy: 'critical_idempotent',
				domain: 'gateway_control',
				kind: 'heartbeat',
				zoneId: identity.zoneId,
			}),
			{
				kind: 'heartbeat',
			},
			{
				kind: 'heartbeat',
				payload: {
					elapsedMs: 2,
					observedAtMs: 2_998,
				},
			},
		);
	});

	it('publishes control-session heartbeat immediately and on cadence', async () => {
		vi.useFakeTimers();
		const publisher = {
			publishControlSessionHeartbeat: vi.fn(async () => {}),
			publishHealthEvent: vi.fn(async () => {}),
			publishOpenClawRuntimeStatus: vi.fn(async () => {}),
		};

		const handle = startGatewayControlSessionHeartbeat({
			identity,
			intervalMs: 1_000,
			now: () => 10_000,
			publisher,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(publisher.publishControlSessionHeartbeat).toHaveBeenCalledTimes(1);
		expect(publisher.publishControlSessionHeartbeat).toHaveBeenLastCalledWith({
			elapsedMs: 0,
			observedAtMs: 10_000,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		expect(publisher.publishControlSessionHeartbeat).toHaveBeenCalledTimes(2);

		handle.stop();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(publisher.publishControlSessionHeartbeat).toHaveBeenCalledTimes(2);
	});

	it('keeps heartbeat cadence alive when the control session is not connected yet', async () => {
		vi.useFakeTimers();
		const writeLog = vi.fn();
		const publisher = {
			publishControlSessionHeartbeat: vi
				.fn()
				.mockRejectedValueOnce(new Error('gateway control session is not connected'))
				.mockResolvedValue(undefined),
			publishHealthEvent: vi.fn(async () => {}),
			publishOpenClawRuntimeStatus: vi.fn(async () => {}),
		};

		startGatewayControlSessionHeartbeat({
			identity,
			intervalMs: 1_000,
			now: () => 20_000,
			publisher,
			writeLog,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(writeLog).toHaveBeenCalledWith(
			'[gondolin] gateway control-session heartbeat skipped: gateway control session is not connected',
		);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(publisher.publishControlSessionHeartbeat).toHaveBeenCalledTimes(2);
	});
});
