import { describe, expect, it, vi } from 'vitest';

import type { GatewayDisposableControlSessionClient } from '../../control-session/gateway-disposable-control-session-client.js';
import type { OpenClawProcessReliabilityFaultActuator } from '../../process-supervisor/openclaw-process-supervisor.js';
import type { GatewayEpochIdentity } from '../../vm-ownership/vm-ownership-contracts.js';
import { createOpenClawProcessReliabilityFaultTargetRegistry } from './openclaw-process-reliability-fault-target-registry.js';

const CONTROLLER_GENERATION = { generation: 7, id: 'controller-epoch-1' } as const;

const GATEWAY_ONE = {
	bootId: 'gateway-boot-1',
	controllerEpoch: CONTROLLER_GENERATION.id,
	gatewayEpochId: 'gateway-epoch-1',
	gatewayVmId: 'gateway-vm-1',
	generationId: 'gateway-generation-1',
	zoneId: 'shravan',
} satisfies GatewayEpochIdentity;

const GATEWAY_TWO = {
	...GATEWAY_ONE,
	bootId: 'gateway-boot-2',
	gatewayEpochId: 'gateway-epoch-2',
	gatewayVmId: 'gateway-vm-2',
	generationId: 'gateway-generation-2',
	zoneId: 'beta',
} satisfies GatewayEpochIdentity;

function createReliabilityFaultActuator(): OpenClawProcessReliabilityFaultActuator {
	return {
		terminateOwnedProcess: vi.fn(async () => {
			throw new Error('registry tests must not invoke the actuator');
		}),
	};
}

function createControlSession(name: string): GatewayDisposableControlSessionClient {
	return {
		close: vi.fn(),
		emitApplicationMessage: vi.fn(async () => ({ ok: true })),
		fenceCurrentSession: vi.fn(() => ({ status: 'not-current' as const })),
		getDiagnostics: vi.fn(() => ({
			accepted: true,
			attachmentGeneration: 1,
			connected: true,
			endpointPath: '/__agent-vm/gateway-control',
			helloCount: 1,
			lastHelloResponse: {
				attachmentGeneration: 1,
				connectionId: `${name}-connection`,
				controllerEpoch: CONTROLLER_GENERATION.id,
				outcome: 'accepted' as const,
				sessionId: `${name}-session`,
			},
			ready: true,
			reconnectAttempts: 0,
			reconnectExhausted: false,
			transportName: 'websocket',
		})),
		ready: Promise.resolve({
			attachmentGeneration: 1,
			connectionId: `${name}-connection`,
			controllerEpoch: CONTROLLER_GENERATION.id,
			outcome: 'accepted',
			sessionId: `${name}-session`,
		}),
	};
}

describe('createOpenClawProcessReliabilityFaultTargetRegistry', () => {
	it('publishes an immutable exact controller/Gateway/process snapshot', () => {
		const registry = createOpenClawProcessReliabilityFaultTargetRegistry({
			controllerGeneration: CONTROLLER_GENERATION,
		});
		const reliabilityFaultActuator = createReliabilityFaultActuator();
		const controlSession = createControlSession('process-1');

		const snapshot = registry.publish({
			controlSession,
			gateway: GATEWAY_ONE,
			processEpoch: 'process-1',
			reliabilityFaultActuator,
		});

		expect(snapshot).toMatchObject({
			controllerGeneration: CONTROLLER_GENERATION,
			controlSession,
			gateway: GATEWAY_ONE,
			processEpoch: 'process-1',
			reliabilityFaultActuator,
			target: {
				id: 'process-1',
				kind: 'openclaw-process',
			},
		});
		expect(snapshot.gatewayGeneration).toMatchObject({ id: GATEWAY_ONE.gatewayEpochId });
		expect(snapshot.openClawProcessGeneration).toMatchObject({ id: 'process-1' });
		expect(snapshot.target.generation).toBe(snapshot.openClawProcessGeneration.generation);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.controllerGeneration)).toBe(true);
		expect(Object.isFrozen(snapshot.gateway)).toBe(true);
		expect(Object.isFrozen(snapshot.gatewayGeneration)).toBe(true);
		expect(Object.isFrozen(snapshot.openClawProcessGeneration)).toBe(true);
		expect(Object.isFrozen(snapshot.target)).toBe(true);
		expect(registry.getCurrent()).toBe(snapshot);
		expect(registry.isCurrent(snapshot)).toBe(true);
	});

	it('publishes monotonically newer target generations and makes the predecessor stale', () => {
		const registry = createOpenClawProcessReliabilityFaultTargetRegistry({
			controllerGeneration: CONTROLLER_GENERATION,
		});
		const first = registry.publish({
			controlSession: createControlSession('process-1'),
			gateway: GATEWAY_ONE,
			processEpoch: 'process-1',
			reliabilityFaultActuator: createReliabilityFaultActuator(),
		});
		const second = registry.publish({
			controlSession: createControlSession('process-2'),
			gateway: GATEWAY_ONE,
			processEpoch: 'process-2',
			reliabilityFaultActuator: createReliabilityFaultActuator(),
		});

		expect(second.openClawProcessGeneration.generation).toBeGreaterThan(
			first.openClawProcessGeneration.generation,
		);
		expect(second.target.generation).toBeGreaterThan(first.target.generation);
		expect(registry.getCurrent()).toBe(second);
		expect(registry.isCurrent(first)).toBe(false);
		expect(registry.isCurrent(second)).toBe(true);
	});

	it('revokes only the exact current G/P and never revives an older snapshot', () => {
		const registry = createOpenClawProcessReliabilityFaultTargetRegistry({
			controllerGeneration: CONTROLLER_GENERATION,
		});
		const firstControlSession = createControlSession('process-1');
		const secondControlSession = createControlSession('process-2');
		const first = registry.publish({
			controlSession: firstControlSession,
			gateway: GATEWAY_ONE,
			processEpoch: 'process-1',
			reliabilityFaultActuator: createReliabilityFaultActuator(),
		});
		const second = registry.publish({
			controlSession: secondControlSession,
			gateway: GATEWAY_ONE,
			processEpoch: 'process-2',
			reliabilityFaultActuator: createReliabilityFaultActuator(),
		});

		expect(registry.revoke({ gateway: GATEWAY_ONE, processEpoch: 'process-1' })).toBe(false);
		expect(registry.getCurrent()).toBe(second);
		expect(registry.getCurrent()?.controlSession).toBe(secondControlSession);
		expect(registry.getCurrent()?.controlSession).not.toBe(firstControlSession);
		expect(registry.revoke({ gateway: GATEWAY_ONE, processEpoch: 'process-2' })).toBe(true);
		expect(registry.getCurrent()).toBeUndefined();
		expect(registry.isCurrent(first)).toBe(false);
		expect(registry.isCurrent(second)).toBe(false);
	});

	it('retains independent exact targets for multiple OpenClaw zones', () => {
		const registry = createOpenClawProcessReliabilityFaultTargetRegistry({
			controllerGeneration: CONTROLLER_GENERATION,
		});
		const zoneOne = registry.publish({
			controlSession: createControlSession('zone-1'),
			gateway: GATEWAY_ONE,
			processEpoch: 'process-zone-1',
			reliabilityFaultActuator: createReliabilityFaultActuator(),
		});
		const zoneTwo = registry.publish({
			controlSession: createControlSession('zone-2'),
			gateway: GATEWAY_TWO,
			processEpoch: 'process-zone-2',
			reliabilityFaultActuator: createReliabilityFaultActuator(),
		});

		expect(registry.getCurrent()).toBeUndefined();
		expect(registry.getCurrent(zoneOne.target)).toBe(zoneOne);
		expect(registry.getCurrent(zoneTwo.target)).toBe(zoneTwo);
		expect(registry.revoke({ gateway: GATEWAY_ONE, processEpoch: 'process-zone-1' })).toBe(true);
		expect(registry.getCurrent(zoneOne.target)).toBeUndefined();
		expect(registry.getCurrent(zoneTwo.target)).toBe(zoneTwo);
	});
});
