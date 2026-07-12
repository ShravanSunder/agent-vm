import type { GatewayDisposableControlSessionClient } from '../../control-session/gateway-disposable-control-session-client.js';
import type { OpenClawProcessReliabilityFaultActuator } from '../../process-supervisor/openclaw-process-supervisor.js';
import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../../vm-ownership/vm-ownership-contracts.js';

export interface ReliabilityFaultGenerationFence {
	readonly generation: number;
	readonly id: string;
}

export interface OpenClawProcessReliabilityFaultTargetSnapshot {
	readonly controllerGeneration: ReliabilityFaultGenerationFence;
	readonly controlSession?: GatewayDisposableControlSessionClient | undefined;
	readonly gateway: GatewayEpochIdentity;
	readonly gatewayGeneration: ReliabilityFaultGenerationFence;
	readonly openClawProcessGeneration: ReliabilityFaultGenerationFence;
	readonly processEpoch: string;
	readonly reliabilityFaultActuator: OpenClawProcessReliabilityFaultActuator;
	readonly target: ReliabilityFaultGenerationFence & { readonly kind: 'openclaw-process' };
}

export interface OpenClawProcessReliabilityFaultTargetRegistry {
	getCurrent(
		target?: ReliabilityFaultGenerationFence,
	): OpenClawProcessReliabilityFaultTargetSnapshot | undefined;
	isCurrent(snapshot: OpenClawProcessReliabilityFaultTargetSnapshot): boolean;
	publish(options: {
		readonly controlSession?: GatewayDisposableControlSessionClient | undefined;
		readonly gateway: GatewayEpochIdentity;
		readonly processEpoch: string;
		readonly reliabilityFaultActuator: OpenClawProcessReliabilityFaultActuator;
	}): OpenClawProcessReliabilityFaultTargetSnapshot;
	revoke(options: {
		readonly gateway: GatewayEpochIdentity;
		readonly processEpoch: string;
	}): boolean;
}

function freezeGenerationFence(
	fence: ReliabilityFaultGenerationFence,
): ReliabilityFaultGenerationFence {
	return Object.freeze({ generation: fence.generation, id: fence.id });
}

function generationFencesEqual(
	left: ReliabilityFaultGenerationFence,
	right: ReliabilityFaultGenerationFence,
): boolean {
	return left.generation === right.generation && left.id === right.id;
}

export function createOpenClawProcessReliabilityFaultTargetRegistry(options: {
	readonly controllerGeneration: ReliabilityFaultGenerationFence;
}): OpenClawProcessReliabilityFaultTargetRegistry {
	const controllerGeneration = freezeGenerationFence(options.controllerGeneration);
	const currentByZone = new Map<string, OpenClawProcessReliabilityFaultTargetSnapshot>();
	const gatewayGenerationByZone = new Map<
		string,
		{
			readonly gateway: GatewayEpochIdentity;
			readonly generation: ReliabilityFaultGenerationFence;
		}
	>();
	let gatewayGenerationCounter = 0;
	let nextProcessGeneration = 1;

	return {
		getCurrent(target): OpenClawProcessReliabilityFaultTargetSnapshot | undefined {
			if (target !== undefined) {
				return [...currentByZone.values()].find((snapshot) =>
					generationFencesEqual(snapshot.target, target),
				);
			}
			return currentByZone.size === 1 ? currentByZone.values().next().value : undefined;
		},
		isCurrent(snapshot): boolean {
			return currentByZone.get(snapshot.gateway.zoneId) === snapshot;
		},
		publish(publication): OpenClawProcessReliabilityFaultTargetSnapshot {
			const gateway = Object.freeze({ ...publication.gateway });
			const retainedGatewayGeneration = gatewayGenerationByZone.get(gateway.zoneId);
			let gatewayGeneration = retainedGatewayGeneration?.generation;
			if (
				retainedGatewayGeneration === undefined ||
				!gatewayIdentitiesEqual(retainedGatewayGeneration.gateway, gateway)
			) {
				gatewayGenerationCounter += 1;
				gatewayGeneration = freezeGenerationFence({
					generation: gatewayGenerationCounter,
					id: gateway.gatewayEpochId,
				});
				gatewayGenerationByZone.set(gateway.zoneId, {
					gateway,
					generation: gatewayGeneration,
				});
			}
			if (gatewayGeneration === undefined) {
				throw new Error('OpenClaw reliability target Gateway generation was not selected.');
			}
			const openClawProcessGeneration = freezeGenerationFence({
				generation: nextProcessGeneration,
				id: publication.processEpoch,
			});
			nextProcessGeneration += 1;
			const target = Object.freeze({
				...openClawProcessGeneration,
				kind: 'openclaw-process' as const,
			});
			const snapshot = Object.freeze({
				controllerGeneration,
				controlSession: publication.controlSession,
				gateway,
				gatewayGeneration,
				openClawProcessGeneration,
				processEpoch: publication.processEpoch,
				reliabilityFaultActuator: publication.reliabilityFaultActuator,
				target,
			});
			currentByZone.set(gateway.zoneId, snapshot);
			return snapshot;
		},
		revoke(revocation): boolean {
			const current = currentByZone.get(revocation.gateway.zoneId);
			if (
				current === undefined ||
				!gatewayIdentitiesEqual(current.gateway, revocation.gateway) ||
				current.processEpoch !== revocation.processEpoch
			) {
				return false;
			}
			currentByZone.delete(revocation.gateway.zoneId);
			return true;
		},
	};
}
