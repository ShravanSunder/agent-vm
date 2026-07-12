import {
	CONTROL_HANDSHAKE_HEADER_NAMES,
	CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
	CONTROL_PROTOCOL_VERSION,
} from '@agent-vm/control-protocol-contracts';
import { describe, expect, it } from 'vitest';

import {
	WORKER_CONTROL_READY_PATH,
	buildWorkerControlEndpoint,
	buildWorkerControlEnvironment,
	buildWorkerControlHandshakeHeaders,
	buildWorkerControlReadyHeaders,
	createWorkerControlSessionMaterial,
	deserializeWorkerControlSessionMaterial,
	fetchWorkerControlCredential,
	serializeWorkerControlSessionMaterial,
} from './worker-control-session.js';

describe('worker control session material', () => {
	it('serializes and restores the controller signing material for host-only persistence', () => {
		const material = createWorkerControlSessionMaterial({
			controllerEpoch: 'epoch-a',
			taskId: 'task-1',
			zoneId: 'zone-a',
		});

		const serializedMaterial = serializeWorkerControlSessionMaterial(material);
		const restoredMaterial = deserializeWorkerControlSessionMaterial(serializedMaterial);

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
			buildWorkerControlReadyHeaders({
				material: restoredMaterial,
				now: () => 1,
				requestId: 'ready-request-a',
			}),
		).toEqual(
			buildWorkerControlReadyHeaders({
				material,
				now: () => 1,
				requestId: 'ready-request-a',
			}),
		);
	});

	it('builds the private Worker control endpoint and boot environment', () => {
		const material = createWorkerControlSessionMaterial({
			controllerEpoch: 'epoch-a',
			taskId: 'task-1',
			zoneId: 'zone-a',
		});

		expect(buildWorkerControlEndpoint({ host: '127.0.0.1', port: 18080 })).toEqual({
			host: '127.0.0.1',
			path: '/__agent-vm/worker-control',
			port: 18080,
		});
		expect(WORKER_CONTROL_READY_PATH).toBe('/__agent-vm/worker-ready');
		expect(buildWorkerControlEnvironment(material)).toEqual({
			AGENT_VM_WORKER_CONTROL_BOOT_ID: material.bootId,
			AGENT_VM_WORKER_CONTROL_CONTROLLER_EPOCH: 'epoch-a',
			AGENT_VM_WORKER_CONTROL_GENERATION_ID: material.generationId,
			AGENT_VM_WORKER_CONTROL_PEER_ID: 'worker-zone-a-task-1',
			AGENT_VM_WORKER_CONTROL_PUBLIC_KEY_PEM: material.verifierPublicKeyPem,
			AGENT_VM_ZONE_ID: 'zone-a',
		});
	});

	it('signs Worker control handshake headers for the worker_control audience', () => {
		const material = createWorkerControlSessionMaterial({
			controllerEpoch: 'epoch-a',
			taskId: 'task-1',
			zoneId: 'zone-a',
		});

		const headers = buildWorkerControlHandshakeHeaders({
			credential: {
				audience: 'worker_control',
				bootId: material.bootId,
				controllerEpoch: material.controllerEpoch,
				credentialId: '11111111-1111-4111-8111-111111111111',
				expiresAtMs: 2_000,
				generationId: material.generationId,
				issuedAtMs: 1_000,
				nonce: 'worker-nonce',
				peerId: material.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
				zoneId: material.zoneId,
			},
			privateKey: material.privateKey,
		});

		expect(headers).toMatchObject({
			[CONTROL_HANDSHAKE_HEADER_NAMES.bootId]: material.bootId,
			[CONTROL_HANDSHAKE_HEADER_NAMES.controllerEpoch]: material.controllerEpoch,
			[CONTROL_HANDSHAKE_HEADER_NAMES.credentialId]: '11111111-1111-4111-8111-111111111111',
			[CONTROL_HANDSHAKE_HEADER_NAMES.domain]: 'worker_control',
			[CONTROL_HANDSHAKE_HEADER_NAMES.generationId]: material.generationId,
			[CONTROL_HANDSHAKE_HEADER_NAMES.nonce]: 'worker-nonce',
			[CONTROL_HANDSHAKE_HEADER_NAMES.peerId]: material.peerId,
			[CONTROL_HANDSHAKE_HEADER_NAMES.protocol]: CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
			[CONTROL_HANDSHAKE_HEADER_NAMES.zoneId]: material.zoneId,
		});
		expect(headers[CONTROL_HANDSHAKE_HEADER_NAMES.signature]).toEqual(expect.any(String));
	});

	it('bounds readiness credential fetches with an abort signal', async () => {
		const material = createWorkerControlSessionMaterial({
			controllerEpoch: 'epoch-a',
			taskId: 'task-1',
			zoneId: 'zone-a',
		});
		const observedFetchInit: RequestInit[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			observedFetchInit.push(init ?? {});
			return new Response(
				JSON.stringify({
					audience: 'worker_control',
					bootId: material.bootId,
					controllerEpoch: material.controllerEpoch,
					credentialId: '11111111-1111-4111-8111-111111111111',
					expiresAtMs: Date.now() + 1_000,
					generationId: material.generationId,
					issuedAtMs: Date.now(),
					nonce: 'worker-ready-nonce',
					peerId: material.peerId,
					protocolVersion: CONTROL_PROTOCOL_VERSION,
					zoneId: material.zoneId,
				}),
				{ headers: { 'content-type': 'application/json' }, status: 200 },
			);
		};

		await fetchWorkerControlCredential({
			endpoint: buildWorkerControlEndpoint({ host: '127.0.0.1', port: 18080 }),
			fetchImpl,
			material,
		});

		expect(observedFetchInit[0]?.signal).toBeInstanceOf(AbortSignal);
	});
});
