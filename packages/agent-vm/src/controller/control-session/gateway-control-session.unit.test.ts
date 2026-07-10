import { CONTROL_PROTOCOL_VERSION } from '@agent-vm/control-protocol-contracts';
import { describe, expect, it } from 'vitest';

import {
	buildGatewayControlEndpoint,
	buildGatewayControlReadyHeaders,
	createGatewayControlSessionMaterial,
	deserializeGatewayControlSessionMaterial,
	fetchGatewayControlCredential,
	serializeGatewayControlSessionMaterial,
} from './gateway-control-session.js';

describe('gateway control session material', () => {
	it('preserves caller-supplied Gateway identity while minting fresh session authority', () => {
		const material = createGatewayControlSessionMaterial({
			agentIds: ['agent-a'],
			bootId: 'gateway-boot-a',
			controllerEpoch: 'controller-epoch-a',
			generationId: 'gateway-generation-a',
			zoneId: 'zone-a',
		});

		expect(material).toMatchObject({
			bootId: 'gateway-boot-a',
			controllerEpoch: 'controller-epoch-a',
			generationId: 'gateway-generation-a',
			peerId: 'gateway-zone-a',
			zoneId: 'zone-a',
		});
		expect(material.agentAuthorityKeys['agent-a']).toHaveLength(43);
		expect(material.callerContextProofKey).toHaveLength(43);
		expect(material.privateKey.type).toBe('private');
		expect(material.verifierPublicKeyPem).toContain('BEGIN PUBLIC KEY');
	});

	it('mints nonempty unique Gateway identities when the caller does not supply them', () => {
		const firstMaterial = createGatewayControlSessionMaterial({
			controllerEpoch: 'controller-epoch-a',
			zoneId: 'zone-a',
		});
		const secondMaterial = createGatewayControlSessionMaterial({
			controllerEpoch: 'controller-epoch-a',
			zoneId: 'zone-a',
		});

		expect(firstMaterial.bootId).not.toBe('');
		expect(firstMaterial.generationId).not.toBe('');
		expect(secondMaterial.bootId).not.toBe(firstMaterial.bootId);
		expect(secondMaterial.generationId).not.toBe(firstMaterial.generationId);
	});

	it('serializes and restores the controller signing material for host-only persistence', () => {
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'epoch-a',
			zoneId: 'zone-a',
		});

		const serializedMaterial = serializeGatewayControlSessionMaterial(material);
		const restoredMaterial = deserializeGatewayControlSessionMaterial(serializedMaterial);

		expect(serializedMaterial.privateKeyPkcs8Pem).toContain('BEGIN PRIVATE KEY');
		expect(restoredMaterial).toMatchObject({
			bootId: material.bootId,
			controllerEpoch: material.controllerEpoch,
			generationId: material.generationId,
			peerId: material.peerId,
			verifierPublicKeyPem: material.verifierPublicKeyPem,
			zoneId: material.zoneId,
		});
		expect(
			buildGatewayControlReadyHeaders({
				material: restoredMaterial,
				now: () => 1,
				requestId: 'ready-request-a',
			}),
		).toEqual(
			buildGatewayControlReadyHeaders({
				material,
				now: () => 1,
				requestId: 'ready-request-a',
			}),
		);
	});

	it('bounds readiness credential fetches with an abort signal', async () => {
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'epoch-a',
			zoneId: 'zone-a',
		});
		const observedFetchInit: RequestInit[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			observedFetchInit.push(init ?? {});
			return new Response(
				JSON.stringify({
					audience: 'gateway_control',
					bootId: material.bootId,
					controllerEpoch: material.controllerEpoch,
					credentialId: '11111111-1111-4111-8111-111111111111',
					expiresAtMs: Date.now() + 1_000,
					generationId: material.generationId,
					issuedAtMs: Date.now(),
					nonce: 'gateway-ready-nonce',
					peerId: material.peerId,
					protocolVersion: CONTROL_PROTOCOL_VERSION,
					zoneId: material.zoneId,
				}),
				{ headers: { 'content-type': 'application/json' }, status: 200 },
			);
		};

		await fetchGatewayControlCredential({
			endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
			fetchImpl,
			material,
		});

		expect(observedFetchInit[0]?.signal).toBeInstanceOf(AbortSignal);
	});
});
