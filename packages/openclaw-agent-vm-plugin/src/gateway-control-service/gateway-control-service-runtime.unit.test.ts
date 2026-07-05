import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { getOrCreateGatewayControlServiceRuntime } from './gateway-control-service-runtime.js';
import type { GatewayControlIdentity } from './gateway-control-service.js';

function createVerifierPublicKeyPem(): string {
	const { publicKey } = generateKeyPairSync('ed25519');
	return publicKey.export({ format: 'pem', type: 'spki' });
}

function createIdentity(overrides: Partial<GatewayControlIdentity> = {}): GatewayControlIdentity {
	return {
		bootId: 'boot-a',
		callerContextProofKey: 'test-caller-context-proof-key',
		controllerEpoch: 'controller-epoch-a',
		generationId: 'generation-a',
		peerId: 'gateway-zone-a',
		zoneId: 'zone-a',
		...overrides,
	};
}

describe('gateway control service runtime cache', () => {
	it('stops the old heartbeat when a new active identity replaces the same zone peer', () => {
		const verifierPublicKeyPem = createVerifierPublicKeyPem();
		const firstRuntime = getOrCreateGatewayControlServiceRuntime({
			identity: createIdentity(),
			verifierPublicKeyPem,
		});
		const stopHeartbeat = vi.fn();
		firstRuntime.heartbeat = { stop: stopHeartbeat };

		const secondRuntime = getOrCreateGatewayControlServiceRuntime({
			identity: createIdentity({ bootId: 'boot-b' }),
			verifierPublicKeyPem,
		});

		expect(secondRuntime).not.toBe(firstRuntime);
		expect(stopHeartbeat).toHaveBeenCalledTimes(1);
	});

	it('closes the old service when a new active identity replaces the same zone peer', async () => {
		const verifierPublicKeyPem = createVerifierPublicKeyPem();
		const firstRuntime = getOrCreateGatewayControlServiceRuntime({
			identity: createIdentity(),
			verifierPublicKeyPem,
		});
		const closeService = vi.spyOn(firstRuntime.service, 'close');

		const secondRuntime = getOrCreateGatewayControlServiceRuntime({
			identity: createIdentity({ bootId: 'boot-c' }),
			verifierPublicKeyPem,
		});

		expect(secondRuntime).not.toBe(firstRuntime);
		expect(closeService).toHaveBeenCalledTimes(1);
		await secondRuntime.service.close();
	});
});
