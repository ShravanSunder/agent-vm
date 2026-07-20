import { generateKeyPairSync, randomUUID, sign as signPayload, type KeyObject } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';

import {
	CONTROL_HANDSHAKE_HEADER_NAMES,
	CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_READY_HEADER_NAMES,
	buildControlHandshakeSignaturePayload,
	buildControlReadyRequestSignaturePayload,
	type ControlEnvelope,
	type ControlHandshakeCredential,
	type ControlReadyRequestCredential,
} from '@agent-vm/control-protocol-contracts';
import {
	GatewayControlHelloResponseSchema,
	GatewayControlRpcMessageSchema,
	type GatewayControlHello,
} from '@agent-vm/gateway-control-contracts';
import { io as createSocketIoClient, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';

import {
	GATEWAY_CONTROL_READY_PATH,
	GATEWAY_CONTROL_SOCKET_PATH,
	startGatewayControlEndpoint,
	type GatewayControlEndpoint,
	type GatewayControlIssuedCredential,
} from './gateway-control-endpoint.js';

const identity = {
	bootId: 'gateway-boot-a',
	controllerEpoch: 'controller-epoch-a',
	generationId: 'gateway-generation-a',
	peerId: 'gateway-zone-a',
	processEpoch: 'tool-portal-process-a',
	zoneId: 'zone-a',
} as const;

const activeClients: Socket[] = [];
const activeEndpoints: GatewayControlEndpoint[] = [];

afterEach(async () => {
	for (const client of activeClients.splice(0)) client.close();
	await Promise.all(activeEndpoints.splice(0).map(async (endpoint) => await endpoint.close()));
});

function readyHeadersFor(props: {
	readonly privateKey: KeyObject;
	readonly requestId: string;
}): Readonly<Record<string, string>> {
	const credential = {
		audience: 'gateway_control',
		bootId: identity.bootId,
		controllerEpoch: identity.controllerEpoch,
		generationId: identity.generationId,
		issuedAtMs: 1_000,
		peerId: identity.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		requestId: props.requestId,
		zoneId: identity.zoneId,
	} satisfies ControlReadyRequestCredential;
	const signature = signPayload(
		null,
		Buffer.from(buildControlReadyRequestSignaturePayload(credential)),
		props.privateKey,
	).toString('base64url');
	return {
		[CONTROL_READY_HEADER_NAMES.bootId]: credential.bootId,
		[CONTROL_READY_HEADER_NAMES.controllerEpoch]: credential.controllerEpoch,
		[CONTROL_READY_HEADER_NAMES.domain]: credential.audience,
		[CONTROL_READY_HEADER_NAMES.generationId]: credential.generationId,
		[CONTROL_READY_HEADER_NAMES.issuedAtMs]: String(credential.issuedAtMs),
		[CONTROL_READY_HEADER_NAMES.peerId]: credential.peerId,
		[CONTROL_READY_HEADER_NAMES.protocol]: CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
		[CONTROL_READY_HEADER_NAMES.requestId]: credential.requestId,
		[CONTROL_READY_HEADER_NAMES.signature]: signature,
		[CONTROL_READY_HEADER_NAMES.zoneId]: credential.zoneId,
	};
}

function handshakeHeadersFor(props: {
	readonly credential: GatewayControlIssuedCredential;
	readonly privateKey: KeyObject;
}): Readonly<Record<string, string>> {
	const credential = {
		audience: props.credential.audience,
		bootId: props.credential.bootId,
		controllerEpoch: props.credential.controllerEpoch,
		credentialId: props.credential.credentialId,
		expiresAtMs: props.credential.expiresAtMs,
		generationId: props.credential.generationId,
		issuedAtMs: props.credential.issuedAtMs,
		nonce: props.credential.nonce,
		peerId: props.credential.peerId,
		protocolVersion: props.credential.protocolVersion,
		zoneId: props.credential.zoneId,
	} satisfies ControlHandshakeCredential;
	const signature = signPayload(
		null,
		Buffer.from(buildControlHandshakeSignaturePayload(credential)),
		props.privateKey,
	).toString('base64url');
	return {
		[CONTROL_HANDSHAKE_HEADER_NAMES.bootId]: credential.bootId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.controllerEpoch]: credential.controllerEpoch,
		[CONTROL_HANDSHAKE_HEADER_NAMES.credentialId]: credential.credentialId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.domain]: credential.audience,
		[CONTROL_HANDSHAKE_HEADER_NAMES.expiresAtMs]: String(credential.expiresAtMs),
		[CONTROL_HANDSHAKE_HEADER_NAMES.generationId]: credential.generationId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.issuedAtMs]: String(credential.issuedAtMs),
		[CONTROL_HANDSHAKE_HEADER_NAMES.nonce]: credential.nonce,
		[CONTROL_HANDSHAKE_HEADER_NAMES.peerId]: credential.peerId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.protocol]: CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
		[CONTROL_HANDSHAKE_HEADER_NAMES.signature]: signature,
		[CONTROL_HANDSHAKE_HEADER_NAMES.zoneId]: credential.zoneId,
	};
}

async function waitForSocketConnect(client: Socket): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		client.once('connect', resolve);
		client.once('connect_error', reject);
	});
}

async function sendRawHttpRequest(props: {
	readonly port: number;
	readonly request: string;
}): Promise<string> {
	const socket = net.createConnection({ host: '127.0.0.1', port: props.port });
	socket.setEncoding('utf8');
	let response = '';
	socket.on('data', (chunk: string) => {
		response += chunk;
	});
	await once(socket, 'connect', { signal: AbortSignal.timeout(1_000) });
	socket.end(props.request);
	await once(socket, 'close', { signal: AbortSignal.timeout(1_000) });
	return response;
}

async function connectControlClient(props: {
	readonly attachmentGeneration: number;
	readonly endpoint: GatewayControlEndpoint;
	readonly privateKey: KeyObject;
}): Promise<{
	readonly client: Socket;
	readonly response: ReturnType<typeof GatewayControlHelloResponseSchema.parse>;
}> {
	const baseUrl = `http://${props.endpoint.readiness.host}:${String(props.endpoint.readiness.port)}`;
	const readyResponse = await fetch(`${baseUrl}${GATEWAY_CONTROL_READY_PATH}`, {
		headers: readyHeadersFor({ privateKey: props.privateKey, requestId: randomUUID() }),
	});
	if (!readyResponse.ok) throw new Error('Gateway control test credential issue failed.');
	const credential = (await readyResponse.json()) as GatewayControlIssuedCredential;
	const client = createSocketIoClient(baseUrl, {
		addTrailingSlash: false,
		extraHeaders: handshakeHeadersFor({ credential, privateKey: props.privateKey }),
		forceNew: true,
		path: GATEWAY_CONTROL_SOCKET_PATH,
		reconnection: false,
		transports: ['websocket'],
	});
	activeClients.push(client);
	await waitForSocketConnect(client);
	const hello = {
		attachmentGeneration: props.attachmentGeneration,
		controllerEpoch: identity.controllerEpoch,
		domain: 'gateway_control',
		gatewayEpoch: identity.generationId,
		peerId: identity.peerId,
		processEpoch: identity.processEpoch,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
	} satisfies GatewayControlHello;
	const response = GatewayControlHelloResponseSchema.parse(
		await client.timeout(1_000).emitWithAck('control:hello', hello),
	);
	return { client, response };
}

describe('gateway control endpoint', () => {
	it('observes only newly accepted current sessions with bounded unsubscribe lifetime', async () => {
		// Arrange
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		const endpoint = await startGatewayControlEndpoint({
			identity,
			listen: { host: '127.0.0.1', port: 0 },
			nonceTtlMs: 1_000,
			now: () => 1_000,
			verifierPublicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
		});
		activeEndpoints.push(endpoint);
		const observedConnectionIds: string[] = [];
		const observerFailures: unknown[] = [];
		const observation = endpoint.service.observeAcceptedSessions(
			(session) => observedConnectionIds.push(session.connectionId),
			(error) => observerFailures.push(error),
		);
		const containedObserverFailures: unknown[] = [];
		const throwingObservation = endpoint.service.observeAcceptedSessions(
			() => {
				throw new Error('injected accepted-session observer failure');
			},
			(error) => containedObserverFailures.push(error),
		);
		const capacityObservations = Array.from({ length: 30 }, () =>
			endpoint.service.observeAcceptedSessions(
				() => undefined,
				() => undefined,
			),
		);
		expect(() =>
			endpoint.service.observeAcceptedSessions(
				() => undefined,
				() => undefined,
			),
		).toThrow('accepted-session observer limit reached: 32');

		// Act
		const first = await connectControlClient({
			attachmentGeneration: 1,
			endpoint,
			privateKey,
		});
		const stale = await connectControlClient({
			attachmentGeneration: 1,
			endpoint,
			privateKey,
		});
		const firstDisconnected = new Promise<void>((resolve) => {
			first.client.once('disconnect', () => resolve());
		});
		const replacement = await connectControlClient({
			attachmentGeneration: 2,
			endpoint,
			privateKey,
		});
		await firstDisconnected;
		observation.unsubscribe();
		observation.unsubscribe();
		const afterUnsubscribe = await connectControlClient({
			attachmentGeneration: 3,
			endpoint,
			privateKey,
		});

		// Assert
		expect(first.response.outcome).toBe('accepted');
		expect(stale.response.outcome).toBe('stale_attachment');
		expect(replacement.response.outcome).toBe('accepted');
		expect(afterUnsubscribe.response.outcome).toBe('accepted');
		expect(observedConnectionIds).toEqual([
			first.response.connectionId,
			replacement.response.connectionId,
		]);
		expect(observerFailures).toEqual([]);
		expect(containedObserverFailures).toHaveLength(3);
		throwingObservation.unsubscribe();
		for (const capacityObservation of capacityObservations) {
			capacityObservation.unsubscribe();
		}
		await expect(endpoint.close({ drainTimeoutMs: 100 })).resolves.toBeUndefined();
	});

	it('publishes accepted-session replacement and terminal disconnect state', async () => {
		// Arrange
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		const endpoint = await startGatewayControlEndpoint({
			identity,
			listen: { host: '127.0.0.1', port: 0 },
			nonceTtlMs: 1_000,
			now: () => 1_000,
			verifierPublicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
		});
		activeEndpoints.push(endpoint);
		const observedStates: (string | undefined)[] = [];
		let resolveDisconnectedState: (() => void) | undefined;
		const disconnectedState = new Promise<void>((resolve) => {
			resolveDisconnectedState = resolve;
		});
		const observation = endpoint.service.observeSessionState(
			(session) => {
				observedStates.push(session?.connectionId);
				if (session === undefined) resolveDisconnectedState?.();
			},
			(error) => {
				throw error;
			},
		);

		// Act
		const first = await connectControlClient({
			attachmentGeneration: 1,
			endpoint,
			privateKey,
		});
		const replacement = await connectControlClient({
			attachmentGeneration: 2,
			endpoint,
			privateKey,
		});
		const replacementDisconnected = new Promise<void>((resolve) => {
			replacement.client.once('disconnect', () => resolve());
		});
		replacement.client.close();
		await replacementDisconnected;
		await disconnectedState;

		// Assert
		expect(observedStates).toEqual([
			first.response.connectionId,
			replacement.response.connectionId,
			undefined,
		]);
		observation.unsubscribe();
	});

	it('rejects malformed request targets without terminating the listener', async () => {
		// Arrange
		const { publicKey } = generateKeyPairSync('ed25519');
		const endpoint = await startGatewayControlEndpoint({
			identity,
			listen: { host: '127.0.0.1', port: 0 },
			verifierPublicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
		});
		activeEndpoints.push(endpoint);

		// Act
		const malformedRequestResponse = await sendRawHttpRequest({
			port: endpoint.readiness.port,
			request: 'GET http://[ HTTP/1.1\r\nHost: gateway-runtime.local\r\nConnection: close\r\n\r\n',
		});
		const malformedUpgradeResponse = await sendRawHttpRequest({
			port: endpoint.readiness.port,
			request:
				'GET http://[ HTTP/1.1\r\nHost: gateway-runtime.local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
		});
		const liveResponse = await fetch(
			`http://${endpoint.readiness.host}:${String(endpoint.readiness.port)}${GATEWAY_CONTROL_READY_PATH}`,
		);

		// Assert
		expect(malformedRequestResponse).toMatch(/^HTTP\/1\.1 400 /u);
		expect(malformedUpgradeResponse).toMatch(/^HTTP\/1\.1 400 /u);
		expect(liveResponse.status).toBe(401);
	});

	it('does not poison endpoint retirement after invalid close options', async () => {
		// Arrange
		const { publicKey } = generateKeyPairSync('ed25519');
		const endpoint = await startGatewayControlEndpoint({
			identity,
			listen: { host: '127.0.0.1', port: 0 },
			verifierPublicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
		});

		// Act / Assert
		await expect(endpoint.close({ drainTimeoutMs: 0 })).rejects.toThrow('must be positive');
		await expect(endpoint.close({ drainTimeoutMs: 100 })).resolves.toBeUndefined();
	});

	it('binds a framework-neutral authenticated controller control endpoint', async () => {
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		const endpoint = await startGatewayControlEndpoint({
			identity,
			listen: { host: '127.0.0.1', port: 0 },
			nonceTtlMs: 1_000,
			now: () => 1_000,
			verifierPublicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
		});
		activeEndpoints.push(endpoint);
		const baseUrl = `http://${endpoint.readiness.host}:${String(endpoint.readiness.port)}`;

		const unsignedReady = await fetch(`${baseUrl}${GATEWAY_CONTROL_READY_PATH}`);
		expect(unsignedReady.status).toBe(401);

		const readyHeaders = readyHeadersFor({
			privateKey,
			requestId: '99999999-9999-4999-8999-999999999999',
		});
		const readyResponse = await fetch(`${baseUrl}${GATEWAY_CONTROL_READY_PATH}`, {
			headers: readyHeaders,
		});
		expect(readyResponse.status).toBe(200);
		const credential = (await readyResponse.json()) as GatewayControlIssuedCredential;

		const replayedReady = await fetch(`${baseUrl}${GATEWAY_CONTROL_READY_PATH}`, {
			headers: readyHeaders,
		});
		expect(replayedReady.status).toBe(401);

		const client = createSocketIoClient(baseUrl, {
			addTrailingSlash: false,
			extraHeaders: handshakeHeadersFor({ credential, privateKey }),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			transports: ['websocket'],
		});
		activeClients.push(client);
		await waitForSocketConnect(client);
		const hello = {
			attachmentGeneration: 1,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			gatewayEpoch: identity.generationId,
			peerId: identity.peerId,
			processEpoch: identity.processEpoch,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies GatewayControlHello;
		const response = GatewayControlHelloResponseSchema.parse(
			await client.timeout(1_000).emitWithAck('control:hello', hello),
		);

		expect(response.outcome).toBe('accepted');
		const acceptedSession = endpoint.service.getCurrentAcceptedSession();
		expect(endpoint.service.getCurrentAcceptedSession()).toMatchObject({
			attachmentGeneration: 1,
			gatewayEpoch: identity.generationId,
			processEpoch: identity.processEpoch,
		});
		expect(endpoint.readiness).toMatchObject({
			host: '127.0.0.1',
			readyPath: GATEWAY_CONTROL_READY_PATH,
			socketPath: GATEWAY_CONTROL_SOCKET_PATH,
		});
		if (acceptedSession === undefined) throw new Error('expected accepted control session');
		const responseMessage = new Promise<{
			readonly envelope: ControlEnvelope;
			readonly payload: unknown;
		}>((resolve) => {
			client.once('control:message', (envelope, payload, acknowledge) => {
				acknowledge({ received: true });
				resolve({ envelope: envelope as ControlEnvelope, payload });
			});
		});
		const commandEnvelope = {
			bootId: acceptedSession.bootId,
			connectionId: acceptedSession.connectionId,
			controllerEpoch: identity.controllerEpoch,
			createdAtMs: 1,
			deliveryPolicy: 'acked_idempotent',
			domain: 'gateway_control',
			idempotencyKey: 'control-ping-1',
			kind: 'command',
			messageId: '22222222-2222-4222-8222-222222222222',
			operation: 'control_ping',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			sequence: 1,
			sessionId: acceptedSession.sessionId,
			zoneId: identity.zoneId,
		} satisfies ControlEnvelope;
		await expect(
			client.timeout(1_000).emitWithAck(
				'control:message',
				commandEnvelope,
				GatewayControlRpcMessageSchema.parse({
					kind: 'command',
					operation: 'control_ping',
					payload: {},
				}),
			),
		).resolves.toEqual({ received: true });
		await expect(responseMessage).resolves.toMatchObject({
			envelope: {
				kind: 'command_result',
				operation: 'control_ping',
				sequence: 1,
			},
			payload: {
				kind: 'command_result',
				operation: 'control_ping',
				payload: {
					responseToMessageId: commandEnvelope.messageId,
					result: 'ok',
				},
			},
		});
	});
});
