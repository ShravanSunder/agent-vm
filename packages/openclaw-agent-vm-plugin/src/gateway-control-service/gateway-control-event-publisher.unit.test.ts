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
			elapsedMs: 15,
			kind: 'tool-vm-ssh',
			leaseId: 'lease-main',
			observedAtMs: 1_000,
			operation: 'probe',
			result: 'ok',
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
					eventKind: 'tool-vm-ssh',
					leaseId: 'lease-main',
					operation: 'probe',
					observedAtMs: 1_000,
					result: 'ok',
				}),
			},
		);
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
