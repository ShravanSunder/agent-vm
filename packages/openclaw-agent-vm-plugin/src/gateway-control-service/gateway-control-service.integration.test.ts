import { generateKeyPairSync, sign as signPayload } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { createServer, type Server as HttpServer } from 'node:http';
import net from 'node:net';

import {
	CONTROL_QUEUE_LIMITS,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_READY_HEADER_NAMES,
	ControlHelloResponseSchema,
	buildControlReadyRequestSignaturePayload,
	type ControlEnvelope,
	type ControlHandshakeProof,
	type ControlHello,
	type ControlReadyRequestProof,
	type DomainControlMessageIdentity,
} from '@agent-vm/control-protocol-contracts';
import { GatewayControlRpcMessageSchema } from '@agent-vm/gateway-control-contracts';
import { io as createSocketIoClient, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';

import {
	CONTROL_HANDSHAKE_HEADER_NAMES,
	CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
	GATEWAY_CONTROL_FAILED_UPGRADE_ATTEMPT_LIMIT,
	GATEWAY_CONTROL_READY_PATH,
	GATEWAY_CONTROL_SOCKET_PATH,
	buildGatewayControlSignaturePayload,
	createGatewayControlService,
	type GatewayControlAcceptedSession,
	type GatewayControlIdentity,
	type GatewayControlIssuedCredential,
	type GatewayControlService,
} from './gateway-control-service.js';

interface ControlServiceFixture {
	readonly clientHeadersFor: (credential: GatewayControlIssuedCredential) => Record<string, string>;
	readonly readyHeadersFor: (options?: {
		readonly issuedAtMs?: number;
		readonly requestId?: string;
	}) => Record<string, string>;
	readonly service: GatewayControlService;
	readonly verifierPublicKeyPem: string;
}

const activeSockets: Socket[] = [];
const activeServers: HttpServer[] = [];
const identity = {
	bootId: 'gateway-boot-a',
	callerContextAgentAuthorityKeys: {},
	callerContextProofKey: 'test-caller-context-proof-key',
	controllerEpoch: 'controller-epoch-a',
	generationId: 'gateway-generation-a',
	peerId: 'gateway-zone-a',
	zoneId: 'zone-a',
} satisfies GatewayControlIdentity;

function gatewayLeaseCreateEnvelopeFor(
	session: GatewayControlAcceptedSession,
	sequence = 1,
): ControlEnvelope {
	return {
		bootId: identity.bootId,
		commandId: '44444444-4444-4444-8444-444444444444',
		connectionId: session.connectionId,
		controllerEpoch: identity.controllerEpoch,
		createdAtMs: 1,
		deliveryPolicy: 'critical_idempotent',
		domain: 'gateway_control',
		idempotencyKey: 'lease-create-command-key',
		kind: 'command',
		messageId: '22222222-2222-4222-8222-222222222222',
		operation: 'lease_create',
		peerId: identity.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence,
		sessionId: session.sessionId,
		zoneId: identity.zoneId,
	};
}

function gatewayCommandResultEnvelopeFor(
	requestEnvelope: ControlEnvelope,
	sequence = 1,
): ControlEnvelope {
	return {
		...requestEnvelope,
		createdAtMs: requestEnvelope.createdAtMs + 1,
		deliveryPolicy: 'critical_idempotent',
		kind: 'command_result',
		messageId: '99999999-9999-4999-8999-999999999999',
		sequence,
	};
}

function gatewayLeaseOkResponsePayloadFor(responseToMessageId: string): {
	readonly lease: {
		readonly agentId: string;
		readonly idleTtlMs: number;
		readonly leaseId: string;
		readonly state: 'idle';
		readonly tcpSlot: number;
		readonly transport: 'ssh-sandbox';
		readonly workdir: string;
		readonly zoneId: string;
	};
	readonly responseToMessageId: string;
	readonly result: 'ok';
} {
	return {
		lease: {
			agentId: 'main',
			idleTtlMs: 120_000,
			leaseId: 'lease-main',
			state: 'idle',
			tcpSlot: 7,
			transport: 'ssh-sandbox',
			workdir: '/workspace',
			zoneId: identity.zoneId,
		},
		responseToMessageId,
		result: 'ok',
	};
}

function gatewayRuntimeStatusEnvelopeFor(
	session: GatewayControlAcceptedSession,
	sequence: number,
	messageId: string,
): ControlEnvelope {
	return {
		bootId: identity.bootId,
		connectionId: session.connectionId,
		controllerEpoch: identity.controllerEpoch,
		createdAtMs: 1,
		deliveryPolicy: 'latest_wins',
		domain: 'gateway_control',
		kind: 'event',
		messageId,
		operation: 'runtime_status',
		peerId: identity.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence,
		sessionId: session.sessionId,
		zoneId: identity.zoneId,
	};
}

afterEach(async () => {
	for (const socket of activeSockets.splice(0)) {
		socket.close();
	}
	await Promise.all(
		activeServers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error) {
							reject(error);
							return;
						}
						resolve();
					});
				}),
		),
	);
});

function createFixture(
	now: () => number = () => 1_000,
	serviceOptions: {
		readonly applicationMessageHandler?: Parameters<
			typeof createGatewayControlService
		>[0]['applicationMessageHandler'];
		readonly handleEngineUpgrade?: Parameters<
			typeof createGatewayControlService
		>[0]['handleEngineUpgrade'];
	} = {},
): ControlServiceFixture {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	const verifierPublicKeyPem = publicKey.export({ format: 'pem', type: 'spki' });
	const service = createGatewayControlService({
		...(serviceOptions.applicationMessageHandler === undefined
			? {}
			: { applicationMessageHandler: serviceOptions.applicationMessageHandler }),
		...(serviceOptions.handleEngineUpgrade === undefined
			? {}
			: { handleEngineUpgrade: serviceOptions.handleEngineUpgrade }),
		identity,
		nonceTtlMs: 100,
		now,
		verifierPublicKeyPem,
	});

	return {
		clientHeadersFor: (credential) => {
			const proofWithoutSignature = {
				audience: 'gateway_control',
				bootId: credential.bootId,
				controllerEpoch: credential.controllerEpoch,
				credentialId: credential.credentialId,
				expiresAtMs: credential.expiresAtMs,
				generationId: credential.generationId,
				issuedAtMs: credential.issuedAtMs,
				nonce: credential.nonce,
				peerId: credential.peerId,
				protocolVersion: credential.protocolVersion,
				zoneId: credential.zoneId,
			} satisfies Omit<ControlHandshakeProof, 'signature'>;
			const signature = signPayload(
				null,
				Buffer.from(buildGatewayControlSignaturePayload(proofWithoutSignature)),
				privateKey,
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
		},
		readyHeadersFor: (readyOptions = {}) => {
			const proofWithoutSignature = {
				audience: 'gateway_control',
				bootId: identity.bootId,
				controllerEpoch: identity.controllerEpoch,
				generationId: identity.generationId,
				issuedAtMs: readyOptions.issuedAtMs ?? now(),
				peerId: identity.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
				requestId: readyOptions.requestId ?? '99999999-9999-4999-8999-999999999999',
				zoneId: identity.zoneId,
			} satisfies Omit<ControlReadyRequestProof, 'signature'>;
			const signature = signPayload(
				null,
				Buffer.from(buildControlReadyRequestSignaturePayload(proofWithoutSignature)),
				privateKey,
			).toString('base64url');
			return {
				[CONTROL_READY_HEADER_NAMES.bootId]: proofWithoutSignature.bootId,
				[CONTROL_READY_HEADER_NAMES.controllerEpoch]: proofWithoutSignature.controllerEpoch,
				[CONTROL_READY_HEADER_NAMES.domain]: proofWithoutSignature.audience,
				[CONTROL_READY_HEADER_NAMES.generationId]: proofWithoutSignature.generationId,
				[CONTROL_READY_HEADER_NAMES.issuedAtMs]: String(proofWithoutSignature.issuedAtMs),
				[CONTROL_READY_HEADER_NAMES.peerId]: proofWithoutSignature.peerId,
				[CONTROL_READY_HEADER_NAMES.protocol]: CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
				[CONTROL_READY_HEADER_NAMES.requestId]: proofWithoutSignature.requestId,
				[CONTROL_READY_HEADER_NAMES.signature]: signature,
				[CONTROL_READY_HEADER_NAMES.zoneId]: proofWithoutSignature.zoneId,
			};
		},
		service,
		verifierPublicKeyPem,
	};
}

async function listenWithService(service: GatewayControlService): Promise<number> {
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://openclaw.local');
		if (url.pathname === GATEWAY_CONTROL_READY_PATH) {
			service.handleReadyRequest(req, res);
			return;
		}
		res.statusCode = 404;
		res.end('not found\n');
	});
	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url ?? '/', 'http://openclaw.local');
		if (url.pathname === GATEWAY_CONTROL_SOCKET_PATH) {
			service.handleUpgrade(req, socket, head);
			return;
		}
		socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
		socket.destroy();
	});
	activeServers.push(server);
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const address = server.address();
	if (typeof address !== 'object' || address === null) {
		throw new Error('Expected TCP server address.');
	}
	return address.port;
}

async function listenWithServiceCatchingUpgradeErrors(
	service: GatewayControlService,
): Promise<number> {
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://openclaw.local');
		if (url.pathname === GATEWAY_CONTROL_READY_PATH) {
			service.handleReadyRequest(req, res);
			return;
		}
		res.statusCode = 404;
		res.end('not found\n');
	});
	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url ?? '/', 'http://openclaw.local');
		if (url.pathname !== GATEWAY_CONTROL_SOCKET_PATH) {
			socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
			socket.destroy();
			return;
		}
		try {
			service.handleUpgrade(req, socket, head);
		} catch {
			socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
			socket.destroy();
		}
	});
	activeServers.push(server);
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const address = server.address();
	if (typeof address !== 'object' || address === null) {
		throw new Error('Expected TCP server address.');
	}
	return address.port;
}

function waitForSocketConnect(socket: Socket): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once('connect', () => resolve());
		socket.once('connect_error', (error: Error) => reject(error));
	});
}

async function waitForSocketDisconnect(socket: Socket): Promise<void> {
	if (!socket.connected) {
		return;
	}
	await new Promise<void>((resolve) => {
		socket.once('disconnect', () => resolve());
	});
}

function waitForNodeEvent(emitter: EventEmitter, eventName: string): Promise<void> {
	return new Promise((resolve) => {
		emitter.once(eventName, () => resolve());
	});
}

async function readRawUpgradeResponse(
	port: number,
	headers: Readonly<Record<string, string>>,
	query = 'EIO=4&transport=websocket',
): Promise<string> {
	const socket = net.connect({ host: '127.0.0.1', port });
	socket.setEncoding('utf8');
	await waitForNodeEvent(socket, 'connect');
	socket.write(
		[
			`GET ${GATEWAY_CONTROL_SOCKET_PATH}?${query} HTTP/1.1`,
			`Host: 127.0.0.1:${String(port)}`,
			'Connection: Upgrade',
			'Upgrade: websocket',
			'Sec-WebSocket-Version: 13',
			'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
			...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
			'\r\n',
		].join('\r\n'),
	);
	let response = '';
	socket.on('data', (chunk) => {
		response += chunk;
	});
	await waitForNodeEvent(socket, 'close');
	return response;
}

async function fetchIssuedCredential(
	port: number,
	headers: Readonly<Record<string, string>>,
): Promise<GatewayControlIssuedCredential> {
	const response = await fetch(`http://127.0.0.1:${String(port)}${GATEWAY_CONTROL_READY_PATH}`, {
		headers,
	});
	expect(response.status).toBe(200);
	return (await response.json()) as GatewayControlIssuedCredential;
}

describe('gateway control service', () => {
	it('requires signed one-use ready proof before issuing credentials', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const readyUrl = `http://127.0.0.1:${String(port)}${GATEWAY_CONTROL_READY_PATH}`;

		const unsignedResponse = await fetch(readyUrl);
		expect(unsignedResponse.status).toBe(401);
		await expect(unsignedResponse.text()).resolves.toBe('unauthorized\n');

		const queryCredentialResponse = await fetch(`${readyUrl}?x-agent-vm-control-signature=leak`, {
			headers: fixture.readyHeadersFor(),
		});
		expect(queryCredentialResponse.status).toBe(401);
		await expect(queryCredentialResponse.text()).resolves.toBe('unauthorized\n');

		const neutralQueryResponse = await fetch(`${readyUrl}?debug=signature-leak`, {
			headers: fixture.readyHeadersFor(),
		});
		expect(neutralQueryResponse.status).toBe(401);
		await expect(neutralQueryResponse.text()).resolves.toBe('unauthorized\n');

		const firstCredential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		expect(firstCredential.audience).toBe('gateway_control');
		expect(fixture.service.getCredentialState(firstCredential.credentialId)).toBe('issued');

		const replayedResponse = await fetch(readyUrl, { headers: fixture.readyHeadersFor() });
		expect(replayedResponse.status).toBe(401);
		await expect(replayedResponse.text()).resolves.toBe('unauthorized\n');
		expect(fixture.service.getCredentialState(firstCredential.credentialId)).toBe('issued');
	});

	it('accepts ready proofs inside the bounded controller-to-vm clock skew window', async () => {
		const fixture = createFixture(() => 1_000);
		const port = await listenWithService(fixture.service);

		const credential = await fetchIssuedCredential(
			port,
			fixture.readyHeadersFor({
				issuedAtMs: 31_000,
				requestId: '88888888-8888-4888-8888-888888888888',
			}),
		);

		expect(credential.audience).toBe('gateway_control');
		expect(Object.hasOwn(credential, 'callerContextProofKey')).toBe(false);
		expect(fixture.service.getCredentialState(credential.credentialId)).toBe('issued');
	});

	it('issues a nonce and accepts only a signed websocket-only Socket.IO upgrade', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const headers = fixture.clientHeadersFor(credential);

		const badResponse = await readRawUpgradeResponse(port, {});
		expect(badResponse).toMatch(/^HTTP\/1\.1 400 Bad Request/u);
		expect(badResponse).not.toContain('101 Switching Protocols');

		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: headers,
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await expect(
			client.timeout(1_000).emitWithAck('control:hello', helloPayload),
		).resolves.toMatchObject({
			controllerEpoch: identity.controllerEpoch,
			outcome: 'accepted',
		});
		expect(client.io.engine.transport.name).toBe('websocket');
		expect(fixture.service.getCredentialState(credential.credentialId)).toBe('accepted');

		const duplicateResponse = await readRawUpgradeResponse(port, headers);
		expect(duplicateResponse).toMatch(/^HTTP\/1\.1 400 Bad Request/u);
		expect(duplicateResponse).not.toContain('101 Switching Protocols');
		expect(client.connected).toBe(true);
	});

	it('requires full resync before accepting a replacement socket without continuity', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const firstCredential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const firstClient = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(firstCredential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(firstClient);
		await waitForSocketConnect(firstClient);
		const firstHelloResponse = ControlHelloResponseSchema.parse(
			await firstClient.timeout(1_000).emitWithAck('control:hello', {
				bootId: identity.bootId,
				controllerEpoch: identity.controllerEpoch,
				domain: 'gateway_control',
				peerId: identity.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
			} satisfies ControlHello),
		);
		expect(firstHelloResponse.outcome).toBe('accepted');

		const secondCredential = await fetchIssuedCredential(
			port,
			fixture.readyHeadersFor({ requestId: '88888888-8888-4888-8888-888888888888' }),
		);
		const secondClient = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(secondCredential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(secondClient);
		await waitForSocketConnect(secondClient);

		const secondHelloResponse = ControlHelloResponseSchema.parse(
			await secondClient.timeout(1_000).emitWithAck('control:hello', {
				bootId: identity.bootId,
				controllerEpoch: identity.controllerEpoch,
				domain: 'gateway_control',
				peerId: identity.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
			} satisfies ControlHello),
		);

		expect(secondHelloResponse.outcome).toBe('resync_required');
		expect(firstClient.connected).toBe(true);
		await expect(fixture.service.getAcceptedSession()).resolves.toMatchObject({
			sessionId: firstHelloResponse.sessionId,
		});
		const freshHelloResponse = ControlHelloResponseSchema.parse(
			await secondClient.timeout(1_000).emitWithAck('control:hello', {
				bootId: identity.bootId,
				controllerEpoch: identity.controllerEpoch,
				domain: 'gateway_control',
				peerId: identity.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
			} satisfies ControlHello),
		);
		expect(freshHelloResponse.outcome).toBe('accepted');
		await waitForSocketDisconnect(firstClient);
		expect(firstClient.connected).toBe(false);
	});

	it('accepts reconnect hello continuity after service process state is lost', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		const helloResponse = ControlHelloResponseSchema.parse(
			await client.timeout(1_000).emitWithAck('control:hello', {
				bootId: identity.bootId,
				controllerEpoch: identity.controllerEpoch,
				domain: 'gateway_control',
				lastSeenControllerSequence: 9,
				lastSeenPeerSequence: 4,
				peerId: identity.peerId,
				previousSessionId: '33333333-3333-4333-8333-333333333333',
				protocolVersion: CONTROL_PROTOCOL_VERSION,
			} satisfies ControlHello),
		);

		expect(helloResponse.outcome).toBe('accepted');
		expect(await fixture.service.getAcceptedSession()).toMatchObject({
			sessionId: helloResponse.sessionId,
		});
	});

	it('resets unobserved peer sequence allocations to the reconnect hello continuity point', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const firstCredential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const firstClient = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(firstCredential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(firstClient);
		await waitForSocketConnect(firstClient);

		const firstHelloResponse = ControlHelloResponseSchema.parse(
			await firstClient.timeout(1_000).emitWithAck('control:hello', {
				bootId: identity.bootId,
				controllerEpoch: identity.controllerEpoch,
				domain: 'gateway_control',
				peerId: identity.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
			} satisfies ControlHello),
		);
		expect(firstHelloResponse.outcome).toBe('accepted');

		expect(fixture.service.nextPeerSequence()).toBe(1);
		expect(fixture.service.nextPeerSequence()).toBe(2);

		const secondCredential = await fetchIssuedCredential(
			port,
			fixture.readyHeadersFor({ requestId: '77777777-7777-4777-8777-777777777777' }),
		);
		const secondClient = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(secondCredential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(secondClient);
		await waitForSocketConnect(secondClient);

		const secondHelloResponse = ControlHelloResponseSchema.parse(
			await secondClient.timeout(1_000).emitWithAck('control:hello', {
				bootId: identity.bootId,
				controllerEpoch: identity.controllerEpoch,
				domain: 'gateway_control',
				lastSeenControllerSequence: 0,
				lastSeenPeerSequence: 0,
				peerId: identity.peerId,
				previousSessionId: firstHelloResponse.sessionId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
			} satisfies ControlHello),
		);

		expect(secondHelloResponse.outcome).toBe('accepted');
		expect(fixture.service.nextPeerSequence()).toBe(1);
	});

	it('does not reserve hard peer sequence slots for latest-wins advisory sends', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		await client.timeout(1_000).emitWithAck('control:hello', {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);

		expect(fixture.service.nextPeerSequence({ deliveryPolicy: 'latest_wins' })).toBe(1);
		expect(fixture.service.nextPeerSequence({ deliveryPolicy: 'latest_wins' })).toBe(1);
		expect(fixture.service.nextPeerSequence()).toBe(1);
		expect(fixture.service.nextPeerSequence()).toBe(2);
	});

	it('keeps the socket open for a fresh hello after resync_required', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		const firstHelloResponse = ControlHelloResponseSchema.parse(
			await client.timeout(1_000).emitWithAck('control:hello', {
				bootId: identity.bootId,
				controllerEpoch: identity.controllerEpoch,
				domain: 'gateway_control',
				peerId: identity.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
			} satisfies ControlHello),
		);
		const acceptedSession = await fixture.service.getAcceptedSession();
		await expect(
			client
				.timeout(1_000)
				.emitWithAck(
					'control:message',
					gatewayCommandResultEnvelopeFor(gatewayLeaseCreateEnvelopeFor(acceptedSession)),
					{
						kind: 'command_result',
						operation: 'lease_create',
						payload: gatewayLeaseOkResponsePayloadFor('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
					},
				),
		).resolves.toEqual({ received: true });

		const resyncResponse = ControlHelloResponseSchema.parse(
			await client.timeout(1_000).emitWithAck('control:hello', {
				bootId: identity.bootId,
				controllerEpoch: identity.controllerEpoch,
				domain: 'gateway_control',
				lastSeenControllerSequence: 0,
				lastSeenPeerSequence: 0,
				peerId: identity.peerId,
				previousSessionId: firstHelloResponse.sessionId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
			} satisfies ControlHello),
		);
		expect(resyncResponse.outcome).toBe('resync_required');
		expect(client.connected).toBe(true);

		const freshHelloResponse = ControlHelloResponseSchema.parse(
			await client.timeout(1_000).emitWithAck('control:hello', {
				bootId: identity.bootId,
				controllerEpoch: identity.controllerEpoch,
				domain: 'gateway_control',
				peerId: identity.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
			} satisfies ControlHello),
		);
		expect(freshHelloResponse.outcome).toBe('accepted');
	});

	it('rejects expired credentials and query-string credential material before 101', async () => {
		let observedAtMs = 1_000;
		const fixture = createFixture(() => observedAtMs);
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const headers = fixture.clientHeadersFor(credential);

		observedAtMs = 32_000;

		const expiredResponse = await readRawUpgradeResponse(port, headers);
		expect(expiredResponse).toMatch(/^HTTP\/1\.1 400 Bad Request/u);
		expect(expiredResponse).not.toContain('101 Switching Protocols');
		expect(fixture.service.getCredentialState(credential.credentialId)).toBe('expired');

		const freshCredential = await fetchIssuedCredential(
			port,
			fixture.readyHeadersFor({ requestId: '88888888-8888-4888-8888-888888888888' }),
		);
		const queryCredentialResponse = await readRawUpgradeResponse(
			port,
			fixture.clientHeadersFor(freshCredential),
			'EIO=4&transport=websocket&x-agent-vm-control-signature=leak',
		);
		expect(queryCredentialResponse).toMatch(/^HTTP\/1\.1 400 Bad Request/u);
		expect(queryCredentialResponse).not.toContain('101 Switching Protocols');
		expect(fixture.service.getCredentialState(freshCredential.credentialId)).toBe('issued');

		const neutralQueryCredentialResponse = await readRawUpgradeResponse(
			port,
			fixture.clientHeadersFor(freshCredential),
			'EIO=4&transport=websocket&debug=signature-leak',
		);
		expect(neutralQueryCredentialResponse).toMatch(/^HTTP\/1\.1 400 Bad Request/u);
		expect(neutralQueryCredentialResponse).not.toContain('101 Switching Protocols');
		expect(fixture.service.getCredentialState(freshCredential.credentialId)).toBe('issued');
	});

	it('does not let anonymous failed upgrades block a later valid credential', async () => {
		const observedAtMs = 1_000;
		const fixture = createFixture(() => observedAtMs);
		const port = await listenWithService(fixture.service);

		const badResponses = await Array.from({
			length: GATEWAY_CONTROL_FAILED_UPGRADE_ATTEMPT_LIMIT,
		}).reduce<Promise<string[]>>(async (previousResponses) => {
			const responses = await previousResponses;
			const badResponse = await readRawUpgradeResponse(port, {});
			return [...responses, badResponse];
		}, Promise.resolve([]));
		for (const badResponse of badResponses) {
			expect(badResponse).toBe('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
			expect(badResponse).not.toContain('101 Switching Protocols');
		}

		const freshCredential = await fetchIssuedCredential(
			port,
			fixture.readyHeadersFor({ requestId: '88888888-8888-4888-8888-888888888888' }),
		);
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(freshCredential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await expect(
			client.timeout(1_000).emitWithAck('control:hello', helloPayload),
		).resolves.toMatchObject({
			controllerEpoch: identity.controllerEpoch,
			outcome: 'accepted',
		});
	});

	it('evicts failed accepted credentials after Engine.IO handoff throws', async () => {
		let observedAtMs = 1_000;
		const fixture = createFixture(() => observedAtMs, {
			handleEngineUpgrade: () => {
				throw new Error('forced Engine.IO handoff failure');
			},
		});
		const port = await listenWithServiceCatchingUpgradeErrors(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());

		const response = await readRawUpgradeResponse(port, fixture.clientHeadersFor(credential));

		expect(response).toMatch(/^HTTP\/1\.1 500 Internal Server Error/u);
		expect(fixture.service.getCredentialState(credential.credentialId)).toBe('failed');
		observedAtMs += 101;
		expect(fixture.service.getCredentialState(credential.credentialId)).toBeUndefined();
	});

	it('emits gateway control RPC messages over the accepted Socket.IO connection', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		const observedMessages: unknown[] = [];
		client.on('control:message', (envelope: unknown, payload: unknown, acknowledge) => {
			const controlEnvelope = envelope as ControlEnvelope;
			observedMessages.push({ envelope, payload });
			const commandResultMessage = {
				kind: 'command_result',
				operation: 'lease_create',
				payload: gatewayLeaseOkResponsePayloadFor(controlEnvelope.messageId),
			};
			acknowledge({ received: true });
			setImmediate(() => {
				client.emit(
					'control:message',
					gatewayCommandResultEnvelopeFor(controlEnvelope),
					commandResultMessage,
					() => undefined,
				);
			});
		});
		await waitForSocketConnect(client);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await client.timeout(1_000).emitWithAck('control:hello', helloPayload);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const gatewayLeaseCreateEnvelope = gatewayLeaseCreateEnvelopeFor(
			acceptedSession,
			fixture.service.nextPeerSequence(),
		);

		const serviceWithRpc = fixture.service as GatewayControlService & {
			emitApplicationMessage(
				envelope: ControlEnvelope,
				domainMessage: DomainControlMessageIdentity,
				payload: unknown,
			): Promise<unknown>;
		};
		const gatewayMessage = {
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: {
					callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				},
			},
		};

		await expect(
			serviceWithRpc.emitApplicationMessage(
				gatewayLeaseCreateEnvelope,
				{ kind: 'command', operation: 'lease_create' },
				gatewayMessage,
			),
		).resolves.toEqual({
			kind: 'command_result',
			operation: 'lease_create',
			payload: gatewayLeaseOkResponsePayloadFor(gatewayLeaseCreateEnvelope.messageId),
		});
		expect(observedMessages).toEqual([
			{
				envelope: gatewayLeaseCreateEnvelope,
				payload: gatewayMessage,
			},
		]);
	});

	it('waits for gateway command_result beyond the transport ack timeout', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		let releaseCommandResult: (() => void) | undefined;
		const commandResultRelease = new Promise<void>((resolve) => {
			releaseCommandResult = resolve;
		});
		let observeTransportReceipt: (() => void) | undefined;
		const transportReceiptObserved = new Promise<void>((resolve) => {
			observeTransportReceipt = resolve;
		});
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		client.on('control:message', (envelope: unknown, _payload: unknown, acknowledge) => {
			const controlEnvelope = envelope as ControlEnvelope;
			acknowledge({ received: true });
			observeTransportReceipt?.();
			void commandResultRelease.then(() => {
				client.emit(
					'control:message',
					gatewayCommandResultEnvelopeFor(controlEnvelope),
					{
						kind: 'command_result',
						operation: 'lease_create',
						payload: gatewayLeaseOkResponsePayloadFor(controlEnvelope.messageId),
					},
					() => undefined,
				);
			});
		});
		await waitForSocketConnect(client);
		await client.timeout(1_000).emitWithAck('control:hello', {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const gatewayLeaseCreateEnvelope = gatewayLeaseCreateEnvelopeFor(
			acceptedSession,
			fixture.service.nextPeerSequence(),
		);

		let commandResolvedBeforeRelease = false;
		const commandResultPromise = fixture.service
			.emitApplicationMessage(
				gatewayLeaseCreateEnvelope,
				{ kind: 'command', operation: 'lease_create' },
				{
					kind: 'command',
					operation: 'lease_create',
					payload: {
						callerContext: {
							callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
						},
					},
				},
				{ commandResultTimeoutMs: 500 },
			)
			.then((result) => {
				commandResolvedBeforeRelease = true;
				return result;
			});
		await transportReceiptObserved;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(commandResolvedBeforeRelease).toBe(false);
		if (releaseCommandResult === undefined) {
			throw new Error('Expected command result release hook to be registered.');
		}
		releaseCommandResult();
		await expect(commandResultPromise).resolves.toMatchObject({
			kind: 'command_result',
			operation: 'lease_create',
		});
	});

	it('does not resolve gateway command waiters from stale-session command_result frames', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		client.on('control:message', (envelope: unknown, _payload: unknown, acknowledge) => {
			const controlEnvelope = envelope as ControlEnvelope;
			acknowledge({ received: true });
			setImmediate(() => {
				client.emit(
					'control:message',
					{
						...gatewayCommandResultEnvelopeFor(controlEnvelope),
						sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
					},
					{
						kind: 'command_result',
						operation: 'lease_create',
						payload: gatewayLeaseOkResponsePayloadFor(controlEnvelope.messageId),
					},
					() => undefined,
				);
			});
		});
		await waitForSocketConnect(client);
		await client.timeout(1_000).emitWithAck('control:hello', {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const gatewayLeaseCreateEnvelope = gatewayLeaseCreateEnvelopeFor(
			acceptedSession,
			fixture.service.nextPeerSequence(),
		);

		await expect(
			fixture.service.emitApplicationMessage(
				gatewayLeaseCreateEnvelope,
				{ kind: 'command', operation: 'lease_create' },
				{
					kind: 'command',
					operation: 'lease_create',
					payload: {
						callerContext: {
							callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
						},
					},
				},
				{ commandResultTimeoutMs: 50 },
			),
		).rejects.toThrow(/gateway control command result timed out/u);
	});

	it('rejects outbound command promises promptly when the accepted socket disconnects', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		let resolveCommandObserved: (() => void) | undefined;
		const commandObserved = new Promise<void>((resolve) => {
			resolveCommandObserved = resolve;
		});
		client.on(
			'control:message',
			(_envelope: unknown, _payload: unknown, acknowledge: (response: unknown) => void) => {
				acknowledge({ received: true });
				resolveCommandObserved?.();
			},
		);
		await waitForSocketConnect(client);
		await client.timeout(1_000).emitWithAck('control:hello', {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const gatewayLeaseCreateEnvelope = gatewayLeaseCreateEnvelopeFor(
			acceptedSession,
			fixture.service.nextPeerSequence(),
		);
		const commandResult = fixture.service.emitApplicationMessage(
			gatewayLeaseCreateEnvelope,
			{ kind: 'command', operation: 'lease_create' },
			{
				kind: 'command',
				operation: 'lease_create',
				payload: {
					callerContext: {
						callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
					},
				},
			},
			{ commandResultTimeoutMs: 5_000 },
		);
		commandResult.catch(() => undefined);
		await commandObserved;
		client.disconnect();

		await expect(commandResult).rejects.toThrow(/control_session_disconnect/u);
	});

	it('receives controller-originated gateway control RPC messages and emits command_result separately', async () => {
		const handledPayloads: unknown[] = [];
		const fixture = createFixture(() => 1_000, {
			applicationMessageHandler: {
				handle: async ({ envelope, payload }) => {
					handledPayloads.push(payload);
					return {
						kind: 'command_result',
						operation: 'lease_create',
						payload: gatewayLeaseOkResponsePayloadFor(envelope.messageId),
					};
				},
				messageIdentity: ({ payload }) => {
					const message = payload as { readonly kind: 'command'; readonly operation: string };
					return { kind: message.kind, operation: message.operation };
				},
			},
		});
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		const observedCommandResults: unknown[] = [];
		let resolveCommandResultObserved: (() => void) | undefined;
		const commandResultObserved = new Promise<void>((resolve) => {
			resolveCommandResultObserved = resolve;
		});
		client.on(
			'control:message',
			(envelope: unknown, payload: unknown, acknowledge: (response: unknown) => void) => {
				const controlEnvelope = envelope as ControlEnvelope;
				if (controlEnvelope.kind === 'command_result') {
					observedCommandResults.push(payload);
					resolveCommandResultObserved?.();
				}
				acknowledge({ received: true });
			},
		);
		await waitForSocketConnect(client);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await client.timeout(1_000).emitWithAck('control:hello', helloPayload);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const envelope = gatewayLeaseCreateEnvelopeFor(acceptedSession);
		const gatewayMessage = {
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: {
					callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				},
			},
		};

		await expect(
			client.timeout(1_000).emitWithAck('control:message', envelope, gatewayMessage),
		).resolves.toEqual({ received: true });
		await commandResultObserved;
		expect(handledPayloads).toEqual([gatewayMessage]);
		expect(observedCommandResults).toEqual([
			{
				kind: 'command_result',
				operation: 'lease_create',
				payload: gatewayLeaseOkResponsePayloadFor(envelope.messageId),
			},
		]);
	});

	it('returns a failed command_result when the gateway handler throws after ack', async () => {
		const fixture = createFixture(() => 1_000, {
			applicationMessageHandler: {
				buildHandlerFailureResult: ({ envelope, payload }) => {
					const message = payload as { readonly kind: 'command'; readonly operation: string };
					return {
						kind: 'command_result',
						operation: message.operation,
						payload: {
							error: {
								errorClass: 'test_gateway_handler_failed',
								retryable: true,
								safeMessage: 'test gateway handler failed',
							},
							responseToMessageId: envelope.messageId,
							result: 'failed',
						},
					};
				},
				handle: async () => {
					throw new Error('gateway handler failed after ack');
				},
				messageIdentity: ({ payload }) => {
					const message = payload as { readonly kind: 'command'; readonly operation: string };
					return { kind: message.kind, operation: message.operation };
				},
			},
		});
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		const observedCommandResults: unknown[] = [];
		let resolveCommandResultObserved: (() => void) | undefined;
		const commandResultObserved = new Promise<void>((resolve) => {
			resolveCommandResultObserved = resolve;
		});
		client.on(
			'control:message',
			(envelope: unknown, payload: unknown, acknowledge: (response: unknown) => void) => {
				if ((envelope as ControlEnvelope).kind === 'command_result') {
					observedCommandResults.push(payload);
					resolveCommandResultObserved?.();
				}
				acknowledge({ received: true });
			},
		);
		await waitForSocketConnect(client);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await client.timeout(1_000).emitWithAck('control:hello', helloPayload);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const envelope = gatewayLeaseCreateEnvelopeFor(acceptedSession);
		const gatewayMessage = {
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: {
					callerContextId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				},
				gatewayWorkspaceDir: '/workspace',
			},
		};

		await expect(
			client.timeout(1_000).emitWithAck('control:message', envelope, gatewayMessage),
		).resolves.toEqual({ received: true });
		await commandResultObserved;
		expect(observedCommandResults).toEqual([
			{
				kind: 'command_result',
				operation: 'lease_create',
				payload: {
					error: {
						errorClass: 'test_gateway_handler_failed',
						retryable: true,
						safeMessage: 'test gateway handler failed',
					},
					responseToMessageId: envelope.messageId,
					result: 'failed',
				},
			},
		]);
	});

	it('closes when a reserved handler response receipt is rejected', async () => {
		const fixture = createFixture(() => 1_000, {
			applicationMessageHandler: {
				handle: async ({ envelope }) => ({
					kind: 'command_result',
					operation: 'lease_create',
					payload: gatewayLeaseOkResponsePayloadFor(envelope.messageId),
				}),
				messageIdentity: ({ payload }) => {
					const message = payload as { readonly kind: 'command'; readonly operation: string };
					return { kind: message.kind, operation: message.operation };
				},
			},
		});
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		const responseSequences: number[] = [];
		client.on(
			'control:message',
			(envelope: unknown, _payload: unknown, acknowledge: (response: unknown) => void) => {
				const controlEnvelope = envelope as ControlEnvelope;
				if (controlEnvelope.kind === 'command_result') {
					responseSequences.push(controlEnvelope.sequence);
					acknowledge({
						errorClass: 'test_rejected_receipt',
						received: false,
						safeMessage: 'test rejected handler response',
					});
					return;
				}
				acknowledge({ received: true });
			},
		);
		await waitForSocketConnect(client);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await client.timeout(1_000).emitWithAck('control:hello', helloPayload);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const gatewayMessage = {
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: {
					callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				},
			},
		};

		await expect(
			client
				.timeout(1_000)
				.emitWithAck(
					'control:message',
					gatewayLeaseCreateEnvelopeFor(acceptedSession),
					gatewayMessage,
				),
		).resolves.toEqual({ received: true });
		await waitForSocketDisconnect(client);
		await expect(
			client
				.timeout(100)
				.emitWithAck(
					'control:message',
					gatewayLeaseCreateEnvelopeFor(acceptedSession, 2),
					gatewayMessage,
				),
		).rejects.toThrow();

		expect(responseSequences).toEqual([1]);
	});

	it('sends concurrent outbound critical commands while the earlier receipt is pending', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		let releaseFirstReceipt: (() => void) | undefined;
		const firstReceiptRelease = new Promise<void>((resolve) => {
			releaseFirstReceipt = resolve;
		});
		let resolveSecondMessageObserved: (() => void) | undefined;
		const secondMessageObserved = new Promise<void>((resolve) => {
			resolveSecondMessageObserved = resolve;
		});
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		const observedSequences: number[] = [];
		client.on(
			'control:message',
			(envelope: unknown, _payload: unknown, acknowledge: (response: unknown) => void) => {
				const controlEnvelope = envelope as ControlEnvelope;
				observedSequences.push(controlEnvelope.sequence);
				if (controlEnvelope.sequence === 1) {
					void firstReceiptRelease.then(() => {
						acknowledge({ received: true });
						client.emit(
							'control:message',
							gatewayCommandResultEnvelopeFor(controlEnvelope, 1),
							{
								kind: 'command_result',
								operation: 'lease_create',
								payload: gatewayLeaseOkResponsePayloadFor(controlEnvelope.messageId),
							},
							() => undefined,
						);
					});
					return;
				}
				acknowledge({ received: true });
				resolveSecondMessageObserved?.();
				void firstReceiptRelease.then(() => {
					client.emit(
						'control:message',
						gatewayCommandResultEnvelopeFor(controlEnvelope, 2),
						{
							kind: 'command_result',
							operation: 'lease_create',
							payload: gatewayLeaseOkResponsePayloadFor(controlEnvelope.messageId),
						},
						() => undefined,
					);
				});
			},
		);
		await waitForSocketConnect(client);
		await client.timeout(1_000).emitWithAck('control:hello', {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const firstEnvelope = gatewayLeaseCreateEnvelopeFor(
			acceptedSession,
			fixture.service.nextPeerSequence(),
		);
		const secondEnvelope = {
			...gatewayLeaseCreateEnvelopeFor(acceptedSession, fixture.service.nextPeerSequence()),
			commandId: '55555555-5555-4555-8555-555555555555',
			idempotencyKey: 'lease-create-command-key-2',
			messageId: '33333333-3333-4333-8333-333333333333',
		} satisfies ControlEnvelope;
		const gatewayMessage = {
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: {
					callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				},
			},
		};

		const firstSend = fixture.service.emitApplicationMessage(
			firstEnvelope,
			{ kind: 'command', operation: 'lease_create' },
			gatewayMessage,
		);
		const secondSend = fixture.service.emitApplicationMessage(
			secondEnvelope,
			{ kind: 'command', operation: 'lease_create' },
			gatewayMessage,
		);
		await Promise.race([
			secondMessageObserved,
			secondSend.then(
				() => {
					throw new Error('Second outbound command resolved before it was observed.');
				},
				(error: unknown) => {
					throw error;
				},
			),
		]);
		expect(observedSequences).toEqual([1, 2]);
		if (releaseFirstReceipt === undefined) {
			throw new Error('Expected first receipt release hook to be registered.');
		}
		releaseFirstReceipt();

		await expect(Promise.all([firstSend, secondSend])).resolves.toEqual([
			{
				kind: 'command_result',
				operation: 'lease_create',
				payload: gatewayLeaseOkResponsePayloadFor(firstEnvelope.messageId),
			},
			{
				kind: 'command_result',
				operation: 'lease_create',
				payload: gatewayLeaseOkResponsePayloadFor(secondEnvelope.messageId),
			},
		]);
		expect(client.connected).toBe(true);
	});

	it('coalesces peer-originated latest-wins events before sending to Socket.IO', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		const observedPayloads: unknown[] = [];
		const observedMessage = new Promise<void>((resolve) => {
			client.on('control:message', (_envelope: unknown, payload: unknown) => {
				observedPayloads.push(payload);
				resolve();
			});
		});
		await waitForSocketConnect(client);
		await client.timeout(1_000).emitWithAck('control:hello', {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const floodCount = CONTROL_QUEUE_LIMITS.queueMessageCap * 2;

		await Promise.all(
			Array.from({ length: floodCount }, (_unused, eventIndex) =>
				fixture.service.emitApplicationMessage(
					gatewayRuntimeStatusEnvelopeFor(
						acceptedSession,
						fixture.service.nextPeerSequence(),
						`10000000-0000-4000-8000-${String(eventIndex + 1).padStart(12, '0')}`,
					),
					{ kind: 'event', operation: 'runtime_status' },
					{
						kind: 'event',
						operation: 'runtime_status',
						payload: {
							findings: [{ id: `event-${String(eventIndex)}`, ok: true }],
							observedAtMs: eventIndex + 1,
							statusKind: 'openclaw-runtime',
						},
					},
				),
			),
		);
		await observedMessage;

		expect(observedPayloads).toEqual([
			{
				kind: 'event',
				operation: 'runtime_status',
				payload: {
					findings: [{ id: `event-${String(floodCount - 1)}`, ok: true }],
					observedAtMs: floodCount,
					statusKind: 'openclaw-runtime',
				},
			},
		]);
	});

	it('can wait for a latest-wins event receipt before dependent commands proceed', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		let acknowledgeRuntimeStatus: (() => void) | undefined;
		const observedRuntimeStatus = new Promise<void>((resolve) => {
			client.on(
				'control:message',
				(_envelope: unknown, _payload: unknown, acknowledge: (response: unknown) => void) => {
					acknowledgeRuntimeStatus = () => acknowledge({ received: true });
					resolve();
				},
			);
		});
		await waitForSocketConnect(client);
		await client.timeout(1_000).emitWithAck('control:hello', {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		let publishResolved = false;

		const publishPromise = fixture.service
			.emitApplicationMessage(
				gatewayRuntimeStatusEnvelopeFor(
					acceptedSession,
					fixture.service.nextPeerSequence({ deliveryPolicy: 'latest_wins' }),
					'10000000-0000-4000-8000-000000000101',
				),
				{ kind: 'event', operation: 'runtime_status' },
				{
					kind: 'event',
					operation: 'runtime_status',
					payload: {
						findings: [{ id: 'runtime-ready', ok: true }],
						observedAtMs: 1,
						statusKind: 'openclaw-runtime',
					},
				},
				{ waitForReceipt: true },
			)
			.then((receipt) => {
				publishResolved = true;
				return receipt;
			});

		await observedRuntimeStatus;
		expect(publishResolved).toBe(false);
		acknowledgeRuntimeStatus?.();
		await expect(publishPromise).resolves.toEqual({ received: true });
		expect(publishResolved).toBe(true);
	});

	it('keeps critical controller messages admissible after lossy advisory sequence gaps', async () => {
		const handledPayloads: unknown[] = [];
		const fixture = createFixture(() => 1_000, {
			applicationMessageHandler: {
				handle: async ({ payload }) => {
					handledPayloads.push(payload);
					return undefined;
				},
				messageIdentity: ({ payload }) => {
					const message = payload as {
						readonly kind: 'command' | 'event';
						readonly operation: string;
					};
					return { kind: message.kind, operation: message.operation };
				},
			},
		});
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		await client.timeout(1_000).emitWithAck('control:hello', {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const lossyEnvelope = gatewayRuntimeStatusEnvelopeFor(
			acceptedSession,
			3,
			'10000000-0000-4000-8000-000000000001',
		);
		const lossyPayload = {
			kind: 'event',
			operation: 'runtime_status',
			payload: {
				findings: [{ id: 'advisory-after-gap', ok: true }],
				observedAtMs: 1,
				statusKind: 'openclaw-runtime',
			},
		};

		await expect(
			client.timeout(1_000).emitWithAck('control:message', lossyEnvelope, lossyPayload),
		).resolves.toEqual({ received: true });
		await expect(
			client
				.timeout(1_000)
				.emitWithAck('control:message', gatewayLeaseCreateEnvelopeFor(acceptedSession, 1), {
					kind: 'command',
					operation: 'lease_create',
					payload: {
						callerContext: {
							callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
						},
					},
				}),
		).resolves.toEqual({ received: true });
		expect(client.connected).toBe(true);
		expect(handledPayloads).toEqual([
			lossyPayload,
			{
				kind: 'command',
				operation: 'lease_create',
				payload: {
					callerContext: {
						callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
					},
				},
			},
		]);
	});

	it('rejects malformed gateway control messages without a positive receipt', async () => {
		const handledPayloads: unknown[] = [];
		const fixture = createFixture(() => 1_000, {
			applicationMessageHandler: {
				handle: async ({ payload }) => {
					handledPayloads.push(payload);
					return undefined;
				},
				messageIdentity: ({ payload }) => {
					const message = payload as { readonly kind: 'command'; readonly operation: string };
					return { kind: message.kind, operation: message.operation };
				},
			},
		});
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await client.timeout(1_000).emitWithAck('control:hello', helloPayload);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const envelope = gatewayLeaseCreateEnvelopeFor(acceptedSession);

		await expect(
			client.timeout(1_000).emitWithAck('control:message', envelope, {
				kind: 'command',
				operation: 'lease_create',
				payload: {},
			}),
		).resolves.toEqual({
			errorClass: 'schema_validation_failed',
			received: false,
			safeMessage: 'gateway control message was rejected',
		});
		expect(handledPayloads).toEqual([]);
	});

	it('rejects gateway control processing failures without labeling them as schema failures', async () => {
		const fixture = createFixture(() => 1_000);
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await client.timeout(1_000).emitWithAck('control:hello', helloPayload);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const envelope = gatewayLeaseCreateEnvelopeFor(acceptedSession);
		const gatewayMessage = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: {
					callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				},
			},
		});

		await expect(
			client.timeout(1_000).emitWithAck('control:message', envelope, gatewayMessage),
		).resolves.toEqual({
			errorClass: 'gateway_control_message_processing_failed',
			received: false,
			safeMessage: 'gateway control message was rejected',
		});
	});

	it('closes instead of handling controller-originated critical messages after a sequence gap', async () => {
		const handledPayloads: unknown[] = [];
		const fixture = createFixture(() => 1_000, {
			applicationMessageHandler: {
				handle: async ({ payload }) => {
					handledPayloads.push(payload);
					return undefined;
				},
				messageIdentity: ({ payload }) => {
					const message = payload as { readonly kind: 'command'; readonly operation: string };
					return { kind: message.kind, operation: message.operation };
				},
			},
		});
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await client.timeout(1_000).emitWithAck('control:hello', helloPayload);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const envelope = gatewayLeaseCreateEnvelopeFor(acceptedSession, 2);
		const gatewayMessage = {
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: {
					callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				},
			},
		};

		await expect(
			client.timeout(100).emitWithAck('control:message', envelope, gatewayMessage),
		).rejects.toThrow();
		expect(handledPayloads).toEqual([]);
	});

	it('does not expose an accepted control session before validated hello completes', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const serviceWithRpc = fixture.service as GatewayControlService & {
			emitApplicationMessage(
				envelope: ControlEnvelope,
				domainMessage: DomainControlMessageIdentity,
				payload: unknown,
			): Promise<unknown>;
		};
		let acceptedSessionResolved = false;
		const acceptedSessionPromise = fixture.service.getAcceptedSession().then((session) => {
			acceptedSessionResolved = true;
			return session;
		});
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		client.on('control:message', (envelope: unknown, _payload: unknown, acknowledge) => {
			const controlEnvelope = envelope as ControlEnvelope;
			const commandResultMessage = {
				kind: 'command_result',
				operation: 'lease_create',
				payload: gatewayLeaseOkResponsePayloadFor(controlEnvelope.messageId),
			};
			acknowledge({ received: true });
			setImmediate(() => {
				client.emit(
					'control:message',
					gatewayCommandResultEnvelopeFor(controlEnvelope),
					commandResultMessage,
					() => undefined,
				);
			});
		});
		await waitForSocketConnect(client);
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});
		expect(acceptedSessionResolved).toBe(false);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'gateway_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await client.timeout(1_000).emitWithAck('control:hello', helloPayload);
		const acceptedSession = await acceptedSessionPromise;
		const gatewayLeaseCreateEnvelope = gatewayLeaseCreateEnvelopeFor(
			acceptedSession,
			fixture.service.nextPeerSequence(),
		);
		const gatewayMessage = {
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: {
					callerContextId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
				},
			},
		};

		await expect(
			serviceWithRpc.emitApplicationMessage(
				gatewayLeaseCreateEnvelope,
				{ kind: 'command', operation: 'lease_create' },
				gatewayMessage,
			),
		).resolves.toEqual({
			kind: 'command_result',
			operation: 'lease_create',
			payload: gatewayLeaseOkResponsePayloadFor(gatewayLeaseCreateEnvelope.messageId),
		});
	});
});
