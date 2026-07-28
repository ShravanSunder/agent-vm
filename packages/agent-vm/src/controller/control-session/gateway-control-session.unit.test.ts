import { CONTROL_PROTOCOL_VERSION } from '@agent-vm/control-protocol-contracts';
import { describe, expect, it, vi } from 'vitest';

const disposableClientMocks = vi.hoisted(() => ({
	create: vi.fn(),
}));

vi.mock('./gateway-disposable-control-session-client.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./gateway-disposable-control-session-client.js')>()),
	createGatewayDisposableControlSessionClient: disposableClientMocks.create,
}));

import {
	buildGatewayControlEndpoint,
	buildGatewayControlReadyHeaders,
	connectGatewayControlSession,
	createGatewayControlSessionMaterial,
	deriveGatewayControlSessionMaterialForProcess,
	deserializeGatewayControlSessionMaterial,
	fetchGatewayControlCredential,
	nextGatewayControlAttachmentGeneration,
	serializeGatewayControlSessionMaterial,
} from './gateway-control-session.js';

function buildReadyCredentialResponse(
	material: ReturnType<typeof createGatewayControlSessionMaterial>,
): Response {
	const issuedAtMs = Date.now();
	return new Response(
		JSON.stringify({
			audience: 'gateway_control',
			bootId: material.bootId,
			controllerEpoch: material.controllerEpoch,
			credentialId: '11111111-1111-4111-8111-111111111111',
			expiresAtMs: issuedAtMs + 1_000,
			generationId: material.generationId,
			issuedAtMs,
			nonce: 'gateway-ready-nonce',
			peerId: material.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			zoneId: material.zoneId,
		}),
		{ headers: { 'content-type': 'application/json' }, status: 200 },
	);
}

describe('gateway control session material', () => {
	it('preserves caller-supplied Gateway identity while minting fresh session authority', () => {
		const material = createGatewayControlSessionMaterial({
			agentIds: ['agent-a'],
			bootId: 'gateway-boot-a',
			controllerEpoch: 'controller-epoch-a',
			generationId: 'gateway-generation-a',
			processEpoch: 'process-epoch-a',
			zoneId: 'zone-a',
		});

		expect(material).toMatchObject({
			bootId: 'gateway-boot-a',
			controllerEpoch: 'controller-epoch-a',
			generationId: 'gateway-generation-a',
			peerId: 'gateway-zone-a',
			processEpoch: 'process-epoch-a',
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
		expect(firstMaterial.processEpoch).not.toBe('');
		expect(firstMaterial.processEpoch).not.toBe(firstMaterial.bootId);
		expect(secondMaterial.bootId).not.toBe(firstMaterial.bootId);
		expect(secondMaterial.generationId).not.toBe(firstMaterial.generationId);
		expect(secondMaterial.processEpoch).not.toBe(firstMaterial.processEpoch);
	});

	it('derives P2 material by preserving exact G-scoped authority and changing only processEpoch', () => {
		const previousMaterial = createGatewayControlSessionMaterial({
			agentIds: ['agent-a', 'agent-b'],
			bootId: 'gateway-boot-a',
			controllerEpoch: 'controller-epoch-a',
			generationId: 'gateway-generation-a',
			processEpoch: 'process-epoch-1',
			zoneId: 'zone-a',
		});

		const successorMaterial = deriveGatewayControlSessionMaterialForProcess(
			previousMaterial,
			'process-epoch-2',
		);

		expect(successorMaterial).toEqual({
			...previousMaterial,
			processEpoch: 'process-epoch-2',
		});
		expect(successorMaterial).not.toBe(previousMaterial);
		expect(successorMaterial.privateKey).toBe(previousMaterial.privateKey);
		expect(successorMaterial.privateKey.export({ format: 'pem', type: 'pkcs8' })).toBe(
			previousMaterial.privateKey.export({ format: 'pem', type: 'pkcs8' }),
		);
		expect(successorMaterial.verifierPublicKeyPem).toBe(previousMaterial.verifierPublicKeyPem);
		expect(successorMaterial.callerContextProofKey).toBe(previousMaterial.callerContextProofKey);
		expect(successorMaterial.agentAuthorityKeys).toBe(previousMaterial.agentAuthorityKeys);
		expect(successorMaterial.agentAuthorityKeys).toEqual(previousMaterial.agentAuthorityKeys);
		expect(successorMaterial).toMatchObject({
			bootId: previousMaterial.bootId,
			controllerEpoch: previousMaterial.controllerEpoch,
			generationId: previousMaterial.generationId,
			peerId: previousMaterial.peerId,
			processEpoch: 'process-epoch-2',
			zoneId: previousMaterial.zoneId,
		});
	});

	it.each([
		['empty', ''],
		['unchanged', 'process-epoch-1'],
	])('rejects a %s selected process epoch', (_label, selectedProcessEpoch) => {
		const previousMaterial = createGatewayControlSessionMaterial({
			bootId: 'gateway-boot-a',
			controllerEpoch: 'controller-epoch-a',
			generationId: 'gateway-generation-a',
			processEpoch: 'process-epoch-1',
			zoneId: 'zone-a',
		});

		expect(() =>
			deriveGatewayControlSessionMaterialForProcess(previousMaterial, selectedProcessEpoch),
		).toThrow(
			'Gateway control selected process epoch must be nonempty and differ from the previous process epoch.',
		);
	});

	it('keeps attachment generation monotonic across process material in one Gateway epoch', () => {
		const firstProcessMaterial = createGatewayControlSessionMaterial({
			bootId: 'gateway-boot-monotonic',
			controllerEpoch: 'controller-epoch-monotonic',
			generationId: 'gateway-epoch-monotonic',
			processEpoch: 'process-epoch-1',
			zoneId: 'zone-monotonic',
		});
		const secondProcessMaterial = createGatewayControlSessionMaterial({
			bootId: 'gateway-boot-monotonic',
			controllerEpoch: 'controller-epoch-monotonic',
			generationId: 'gateway-epoch-monotonic',
			processEpoch: 'process-epoch-2',
			zoneId: 'zone-monotonic',
		});
		const successorGatewayMaterial = createGatewayControlSessionMaterial({
			bootId: 'gateway-boot-successor',
			controllerEpoch: 'controller-epoch-monotonic',
			generationId: 'gateway-epoch-successor',
			processEpoch: 'process-epoch-successor',
			zoneId: 'zone-monotonic',
		});

		expect(nextGatewayControlAttachmentGeneration(firstProcessMaterial)).toBe(1);
		expect(nextGatewayControlAttachmentGeneration(secondProcessMaterial)).toBe(2);
		expect(nextGatewayControlAttachmentGeneration(successorGatewayMaterial)).toBe(1);
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
			processEpoch: material.processEpoch,
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

	it('retries transient pre-publication ingress unavailability before accepting a readiness credential', async () => {
		vi.useFakeTimers();
		try {
			const material = createGatewayControlSessionMaterial({
				controllerEpoch: 'epoch-a',
				zoneId: 'zone-a',
			});
			let fetchAttemptCount = 0;
			const fetchImpl = vi.fn<typeof fetch>(async () => {
				fetchAttemptCount += 1;
				return fetchAttemptCount === 1
					? new Response('bad gateway\n', { status: 502, statusText: 'Bad Gateway' })
					: buildReadyCredentialResponse(material);
			});
			const connectedClient = {
				close: vi.fn(),
				ready: Promise.resolve(),
			};
			disposableClientMocks.create.mockReturnValue(connectedClient);

			const connectionPromise = connectGatewayControlSession({
				endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
				fetchImpl,
				material,
			});
			const connectionExpectation = expect(connectionPromise).resolves.toBe(connectedClient);

			await vi.runAllTimersAsync();
			await connectionExpectation;
			expect(fetchImpl).toHaveBeenCalledTimes(2);
			expect(disposableClientMocks.create).toHaveBeenCalledOnce();
		} finally {
			disposableClientMocks.create.mockReset();
			vi.useRealTimers();
		}
	});

	it('does not retry readiness authentication failures during initial attachment', async () => {
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'epoch-a',
			zoneId: 'zone-a',
		});
		const fetchImpl = vi.fn<typeof fetch>(
			async () =>
				new Response('unauthorized: signature_mismatch', {
					status: 401,
					statusText: 'Unauthorized',
				}),
		);

		await expect(
			fetchGatewayControlCredential({
				endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
				fetchImpl,
				material,
				retryTransientUnavailable: true,
			}),
		).rejects.toThrow(
			'Gateway control readiness failed with HTTP 401 Unauthorized: unauthorized: signature_mismatch',
		);
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it('aborts a pending credential wait with the owner reason before creating a client', async () => {
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'epoch-a',
			zoneId: 'zone-a',
		});
		const abortController = new AbortController();
		const addEventListener = vi.spyOn(abortController.signal, 'addEventListener');
		const removeEventListener = vi.spyOn(abortController.signal, 'removeEventListener');
		let markFetchStarted: (() => void) | undefined;
		const fetchStarted = new Promise<void>((resolve) => {
			markFetchStarted = resolve;
		});
		const fetchImpl: typeof fetch = async () => {
			markFetchStarted?.();
			return await new Promise<Response>(() => undefined);
		};
		const abortReason = new Error('successor attachment deadline expired');

		const connectPromise = connectGatewayControlSession({
			endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
			fetchImpl,
			material,
			signal: abortController.signal,
		});
		await fetchStarted;
		abortController.abort(abortReason);

		await expect(connectPromise).rejects.toBe(abortReason);
		expect(disposableClientMocks.create).not.toHaveBeenCalled();
		expect(removeEventListener).toHaveBeenCalledTimes(addEventListener.mock.calls.length);
	});

	it('aborts a pending client readiness wait, closes the client, and removes its listener', async () => {
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'epoch-a',
			zoneId: 'zone-a',
		});
		const abortController = new AbortController();
		const addEventListener = vi.spyOn(abortController.signal, 'addEventListener');
		const removeEventListener = vi.spyOn(abortController.signal, 'removeEventListener');
		const close = vi.fn();
		let markClientCreated: (() => void) | undefined;
		const clientCreated = new Promise<void>((resolve) => {
			markClientCreated = resolve;
		});
		disposableClientMocks.create.mockImplementation(() => {
			markClientCreated?.();
			return {
				close,
				ready: new Promise<void>(() => undefined),
			};
		});
		const abortReason = new Error('successor attachment deadline expired');

		const connectPromise = connectGatewayControlSession({
			endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
			fetchImpl: async () => buildReadyCredentialResponse(material),
			material,
			signal: abortController.signal,
		});
		await clientCreated;
		abortController.abort(abortReason);

		await expect(connectPromise).rejects.toBe(abortReason);
		expect(close).toHaveBeenCalledOnce();
		expect(removeEventListener).toHaveBeenCalledTimes(addEventListener.mock.calls.length);
	});

	it('removes cancellation listeners when the disposable client becomes ready', async () => {
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'epoch-a',
			zoneId: 'zone-a',
		});
		const abortController = new AbortController();
		const addEventListener = vi.spyOn(abortController.signal, 'addEventListener');
		const removeEventListener = vi.spyOn(abortController.signal, 'removeEventListener');
		const close = vi.fn();
		const disposableClient = {
			close,
			ready: Promise.resolve(),
		};
		disposableClientMocks.create.mockReturnValue(disposableClient);

		const connectedClient = await connectGatewayControlSession({
			endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
			fetchImpl: async () => buildReadyCredentialResponse(material),
			material,
			signal: abortController.signal,
		});

		expect(connectedClient).toBe(disposableClient);
		expect(close).not.toHaveBeenCalled();
		expect(removeEventListener).toHaveBeenCalledTimes(addEventListener.mock.calls.length);
	});
});
