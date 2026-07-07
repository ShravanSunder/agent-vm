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
import { WorkerControlRpcMessageSchema } from '@agent-vm/worker-control-contracts';
import { io as createSocketIoClient, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';

import { createWorkerControlApplicationMessageHandler } from './worker-control-application-handler.js';
import { attachWorkerControlUpgradeHandler } from './worker-control-http-server.js';
import {
	CONTROL_HANDSHAKE_HEADER_NAMES,
	CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
	WORKER_CONTROL_FAILED_UPGRADE_ATTEMPT_LIMIT,
	WORKER_CONTROL_READY_PATH,
	WORKER_CONTROL_SOCKET_PATH,
	buildWorkerControlSignaturePayload,
	createWorkerControlService,
	createWorkerControlServiceOptionsFromEnvironment,
	type WorkerControlAcceptedSession,
	type WorkerControlIssuedCredential,
	type WorkerControlService,
} from './worker-control-service.js';

interface ControlServiceFixture {
	readonly clientHeadersFor: (credential: WorkerControlIssuedCredential) => Record<string, string>;
	readonly readyHeadersFor: (options?: {
		readonly issuedAtMs?: number;
		readonly requestId?: string;
	}) => Record<string, string>;
	readonly service: WorkerControlService;
}

const activeSockets: Socket[] = [];
const activeServers: HttpServer[] = [];
const identity = {
	bootId: 'worker-boot-a',
	controllerEpoch: 'controller-epoch-a',
	generationId: 'worker-generation-a',
	peerId: 'worker-zone-a',
	zoneId: 'zone-a',
} as const;

function workerGitPushEnvelopeFor(
	session: WorkerControlAcceptedSession,
	sequence = 1,
): ControlEnvelope {
	return {
		bootId: identity.bootId,
		commandId: '44444444-4444-4444-8444-444444444444',
		connectionId: session.connectionId,
		controllerEpoch: identity.controllerEpoch,
		createdAtMs: 1,
		deliveryPolicy: 'single_use_critical',
		domain: 'worker_control',
		idempotencyKey: 'worker-git-push-command-key',
		kind: 'command',
		messageId: '22222222-2222-4222-8222-222222222222',
		operation: 'git_push',
		peerId: identity.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence,
		sessionId: session.sessionId,
		zoneId: identity.zoneId,
	};
}

function workerCommandResultEnvelopeFor(
	requestEnvelope: ControlEnvelope,
	sequence = 1,
): ControlEnvelope {
	return {
		...requestEnvelope,
		createdAtMs: requestEnvelope.createdAtMs + 1,
		deliveryPolicy: 'single_use_critical',
		kind: 'command_result',
		messageId: '99999999-9999-4999-8999-999999999999',
		sequence,
	};
}

function workerGitPushOkResponsePayloadFor(responseToMessageId: string): {
	readonly gitPush: {
		readonly results: readonly [
			{
				readonly branch: string;
				readonly repoUrl: string;
				readonly success: true;
			},
		];
	};
	readonly responseToMessageId: string;
	readonly result: 'ok';
} {
	return {
		gitPush: {
			results: [
				{
					branch: 'agent/task-1',
					repoUrl: 'https://github.com/example/repo.git',
					success: true,
				},
			],
		},
		responseToMessageId,
		result: 'ok',
	};
}

function workerRuntimeStatusEnvelopeFor(
	session: WorkerControlAcceptedSession,
	sequence: number,
	messageId: string,
): ControlEnvelope {
	return {
		bootId: identity.bootId,
		connectionId: session.connectionId,
		controllerEpoch: identity.controllerEpoch,
		createdAtMs: 1,
		deliveryPolicy: 'latest_wins',
		domain: 'worker_control',
		kind: 'event',
		messageId,
		operation: 'worker_runtime_status',
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
			typeof createWorkerControlService
		>[0]['applicationMessageHandler'];
		readonly handleEngineUpgrade?: Parameters<
			typeof createWorkerControlService
		>[0]['handleEngineUpgrade'];
	} = {},
): ControlServiceFixture {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	const verifierPublicKeyPem = publicKey.export({ format: 'pem', type: 'spki' });
	const service = createWorkerControlService({
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
				audience: 'worker_control',
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
				Buffer.from(buildWorkerControlSignaturePayload(proofWithoutSignature)),
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
				audience: 'worker_control',
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
	};
}

async function listenWithService(service: WorkerControlService): Promise<number> {
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://worker.local');
		if (url.pathname === WORKER_CONTROL_READY_PATH) {
			service.handleReadyRequest(req, res);
			return;
		}
		res.statusCode = 404;
		res.end('not found\n');
	});
	attachWorkerControlUpgradeHandler({ server, workerControlService: service });
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
	service: WorkerControlService,
): Promise<number> {
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://worker.local');
		if (url.pathname === WORKER_CONTROL_READY_PATH) {
			service.handleReadyRequest(req, res);
			return;
		}
		res.statusCode = 404;
		res.end('not found\n');
	});
	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url ?? '/', 'http://worker.local');
		if (url.pathname !== WORKER_CONTROL_SOCKET_PATH) {
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

async function waitForWorkerAcceptedSession(
	service: ReturnType<typeof createWorkerControlService>,
): Promise<
	Awaited<ReturnType<ReturnType<typeof createWorkerControlService>['getAcceptedSession']>>
> {
	const attemptRead = async (
		attempt: number,
	): Promise<
		Awaited<ReturnType<ReturnType<typeof createWorkerControlService>['getAcceptedSession']>>
	> => {
		try {
			return await service.getAcceptedSession();
		} catch (error) {
			if (attempt >= 20) {
				throw error;
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
			return await attemptRead(attempt + 1);
		}
	};
	return await attemptRead(1);
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
			`GET ${WORKER_CONTROL_SOCKET_PATH}?${query} HTTP/1.1`,
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
): Promise<WorkerControlIssuedCredential> {
	const response = await fetch(`http://127.0.0.1:${String(port)}${WORKER_CONTROL_READY_PATH}`, {
		headers,
	});
	expect(response.status).toBe(200);
	return (await response.json()) as WorkerControlIssuedCredential;
}

describe('worker control service', () => {
	it('derives service options from complete control boot environment only', () => {
		expect(createWorkerControlServiceOptionsFromEnvironment({})).toBeUndefined();
		expect(
			createWorkerControlServiceOptionsFromEnvironment({
				AGENT_VM_ZONE_ID: identity.zoneId,
			}),
		).toBeUndefined();
		expect(() =>
			createWorkerControlServiceOptionsFromEnvironment({
				AGENT_VM_WORKER_CONTROL_BOOT_ID: 'worker-boot-a',
			}),
		).toThrow(/configuration is incomplete/u);

		const options = createWorkerControlServiceOptionsFromEnvironment({
			AGENT_VM_WORKER_CONTROL_BOOT_ID: identity.bootId,
			AGENT_VM_WORKER_CONTROL_CONTROLLER_EPOCH: identity.controllerEpoch,
			AGENT_VM_WORKER_CONTROL_GENERATION_ID: identity.generationId,
			AGENT_VM_WORKER_CONTROL_PEER_ID: identity.peerId,
			AGENT_VM_WORKER_CONTROL_PUBLIC_KEY_PEM: 'public-key',
			AGENT_VM_ZONE_ID: identity.zoneId,
		});
		expect(options).toMatchObject({
			identity,
			verifierPublicKeyPem: 'public-key',
		});
	});

	it('requires signed one-use ready proof before issuing credentials', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const readyUrl = `http://127.0.0.1:${String(port)}${WORKER_CONTROL_READY_PATH}`;

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
		expect(firstCredential.audience).toBe('worker_control');
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

		expect(credential.audience).toBe('worker_control');
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
			path: WORKER_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'worker_control',
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
			path: WORKER_CONTROL_SOCKET_PATH,
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
				domain: 'worker_control',
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
			path: WORKER_CONTROL_SOCKET_PATH,
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
				domain: 'worker_control',
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
				domain: 'worker_control',
				peerId: identity.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
			} satisfies ControlHello),
		);
		expect(freshHelloResponse.outcome).toBe('accepted');
		await expect(fixture.service.getAcceptedSession()).resolves.toMatchObject({
			sessionId: freshHelloResponse.sessionId,
		});
		await waitForSocketDisconnect(firstClient);
		expect(firstClient.connected).toBe(false);
	});

	it('keeps the incumbent usable after an abandoned full-resync challenger disconnects', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const firstCredential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const firstClient = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(firstCredential),
			forceNew: true,
			path: WORKER_CONTROL_SOCKET_PATH,
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
				domain: 'worker_control',
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
			path: WORKER_CONTROL_SOCKET_PATH,
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
				domain: 'worker_control',
				peerId: identity.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
			} satisfies ControlHello),
		);
		expect(secondHelloResponse.outcome).toBe('resync_required');

		secondClient.disconnect();
		await waitForSocketDisconnect(secondClient);
		await expect(waitForWorkerAcceptedSession(fixture.service)).resolves.toMatchObject({
			sessionId: firstHelloResponse.sessionId,
		});
		expect(firstClient.connected).toBe(true);
	});

	it('accepts reconnect hello continuity after service process state is lost', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: WORKER_CONTROL_SOCKET_PATH,
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
				domain: 'worker_control',
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
			path: WORKER_CONTROL_SOCKET_PATH,
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
				domain: 'worker_control',
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
			path: WORKER_CONTROL_SOCKET_PATH,
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
				domain: 'worker_control',
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
			path: WORKER_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		await client.timeout(1_000).emitWithAck('control:hello', {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);

		expect(fixture.service.nextPeerSequence({ deliveryPolicy: 'latest_wins' })).toBe(1);
		expect(fixture.service.nextPeerSequence({ deliveryPolicy: 'latest_wins' })).toBe(1);
		expect(fixture.service.nextPeerSequence()).toBe(1);
		expect(fixture.service.nextPeerSequence()).toBe(2);
	});

	it('releases an unreceipted priority peer sequence for retry', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: WORKER_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		let observedCancelCount = 0;
		client.on('control:message', (envelope: unknown, _payload: unknown, acknowledge) => {
			observedCancelCount += 1;
			if (observedCancelCount === 1) {
				acknowledge({
					errorClass: 'test_receipt_rejected',
					received: false,
					safeMessage: 'test priority receipt rejected',
				});
				return;
			}
			acknowledge({ received: true });
			const controlEnvelope = envelope as ControlEnvelope;
			client.emit(
				'control:message',
				workerCommandResultEnvelopeFor(controlEnvelope, 1),
				{
					kind: 'command_result',
					operation: 'operation_cancel',
					payload: {
						activeOperationId: '77777777-7777-4777-8777-777777777777',
						responseToMessageId: controlEnvelope.messageId,
						result: 'ok',
					},
				},
				() => undefined,
			);
		});
		await waitForSocketConnect(client);
		await client.timeout(1_000).emitWithAck('control:hello', {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const cancelEnvelope = {
			...workerGitPushEnvelopeFor(acceptedSession, fixture.service.nextPeerSequence()),
			commandId: '55555555-5555-4555-8555-555555555555',
			deliveryPolicy: 'acked_idempotent',
			idempotencyKey: 'operation-cancel-key',
			messageId: '10000000-0000-4000-8000-000000000001',
			operation: 'operation_cancel',
		} satisfies ControlEnvelope;
		const cancelMessage = {
			kind: 'command',
			operation: 'operation_cancel',
			payload: {
				activeOperationId: '77777777-7777-4777-8777-777777777777',
				initiatedBy: 'controller',
				reason: 'operator_cancelled',
			},
		};

		await expect(
			fixture.service.emitApplicationMessage(
				cancelEnvelope,
				{ kind: 'command', operation: 'operation_cancel' },
				cancelMessage,
			),
		).rejects.toThrow(/test priority receipt rejected/u);
		expect(fixture.service.nextPeerSequence()).toBe(1);
		await expect(
			fixture.service.emitApplicationMessage(
				{
					...cancelEnvelope,
					messageId: '10000000-0000-4000-8000-000000000002',
					sequence: fixture.service.nextPeerSequence(),
				},
				{ kind: 'command', operation: 'operation_cancel' },
				cancelMessage,
			),
		).resolves.toEqual({
			kind: 'command_result',
			operation: 'operation_cancel',
			payload: {
				activeOperationId: '77777777-7777-4777-8777-777777777777',
				responseToMessageId: '10000000-0000-4000-8000-000000000002',
				result: 'ok',
			},
		});
		expect(observedCancelCount).toBe(2);
	});

	it('keeps the socket open for a fresh hello after resync_required', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: WORKER_CONTROL_SOCKET_PATH,
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
				domain: 'worker_control',
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
					workerCommandResultEnvelopeFor(workerGitPushEnvelopeFor(acceptedSession)),
					{
						kind: 'command_result',
						operation: 'git_push',
						payload: workerGitPushOkResponsePayloadFor('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
					},
				),
		).resolves.toEqual({ received: true });

		const resyncResponse = ControlHelloResponseSchema.parse(
			await client.timeout(1_000).emitWithAck('control:hello', {
				bootId: identity.bootId,
				controllerEpoch: identity.controllerEpoch,
				domain: 'worker_control',
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
				domain: 'worker_control',
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
			length: WORKER_CONTROL_FAILED_UPGRADE_ATTEMPT_LIMIT,
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
			path: WORKER_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'worker_control',
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

	it('emits worker control RPC messages over the accepted Socket.IO connection', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: WORKER_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		const observedMessages: unknown[] = [];
		client.on(
			'control:message',
			(envelope: unknown, payload: unknown, acknowledge: (response: unknown) => void) => {
				const controlEnvelope = envelope as ControlEnvelope;
				observedMessages.push({ envelope, payload });
				const commandResultMessage = {
					kind: 'command_result',
					operation: 'git_push',
					payload: workerGitPushOkResponsePayloadFor(controlEnvelope.messageId),
				};
				acknowledge({ received: true });
				setImmediate(() => {
					client.emit(
						'control:message',
						workerCommandResultEnvelopeFor(controlEnvelope),
						commandResultMessage,
						() => undefined,
					);
				});
			},
		);
		await waitForSocketConnect(client);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await client.timeout(1_000).emitWithAck('control:hello', helloPayload);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const envelope = workerGitPushEnvelopeFor(acceptedSession, fixture.service.nextPeerSequence());
		const workerMessage = {
			kind: 'command',
			operation: 'git_push',
			payload: {
				branchName: 'agent/task-1',
				command: {
					commandId: envelope.commandId,
					idempotencyKey: envelope.idempotencyKey,
				},
				repoUrl: 'https://github.com/example/repo.git',
				task: {
					taskId: 'task-1',
				},
			},
		};

		await expect(
			fixture.service.emitApplicationMessage(
				envelope,
				{ kind: 'command', operation: 'git_push' },
				workerMessage,
			),
		).resolves.toEqual({
			kind: 'command_result',
			operation: 'git_push',
			payload: workerGitPushOkResponsePayloadFor(envelope.messageId),
		});
		expect(observedMessages).toEqual([
			{
				envelope,
				payload: workerMessage,
			},
		]);
	});

	it('waits for worker command_result beyond the transport ack timeout', async () => {
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
			path: WORKER_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		client.on(
			'control:message',
			(envelope: unknown, _payload: unknown, acknowledge: (response: unknown) => void) => {
				const controlEnvelope = envelope as ControlEnvelope;
				acknowledge({ received: true });
				observeTransportReceipt?.();
				void commandResultRelease.then(() => {
					client.emit(
						'control:message',
						workerCommandResultEnvelopeFor(controlEnvelope),
						{
							kind: 'command_result',
							operation: 'git_push',
							payload: workerGitPushOkResponsePayloadFor(controlEnvelope.messageId),
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
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const envelope = workerGitPushEnvelopeFor(acceptedSession, fixture.service.nextPeerSequence());

		let commandResolvedBeforeRelease = false;
		const commandResultPromise = fixture.service
			.emitApplicationMessage(
				envelope,
				{ kind: 'command', operation: 'git_push' },
				{
					kind: 'command',
					operation: 'git_push',
					payload: {
						branchName: 'agent/task-1',
						command: {
							commandId: envelope.commandId,
							idempotencyKey: envelope.idempotencyKey,
						},
						repoUrl: 'https://github.com/example/repo.git',
						task: {
							taskId: 'task-1',
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
			operation: 'git_push',
		});
	});

	it('does not resolve worker command waiters from stale-session command_result frames', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: WORKER_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		client.on(
			'control:message',
			(envelope: unknown, _payload: unknown, acknowledge: (response: unknown) => void) => {
				const controlEnvelope = envelope as ControlEnvelope;
				acknowledge({ received: true });
				setImmediate(() => {
					client.emit(
						'control:message',
						{
							...workerCommandResultEnvelopeFor(controlEnvelope),
							sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
						},
						{
							kind: 'command_result',
							operation: 'git_push',
							payload: workerGitPushOkResponsePayloadFor(controlEnvelope.messageId),
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
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const envelope = workerGitPushEnvelopeFor(acceptedSession, fixture.service.nextPeerSequence());

		await expect(
			fixture.service.emitApplicationMessage(
				envelope,
				{ kind: 'command', operation: 'git_push' },
				{
					kind: 'command',
					operation: 'git_push',
					payload: {
						branchName: 'agent/task-1',
						command: {
							commandId: envelope.commandId,
							idempotencyKey: envelope.idempotencyKey,
						},
						repoUrl: 'https://github.com/example/repo.git',
						task: {
							taskId: 'task-1',
						},
					},
				},
				{ commandResultTimeoutMs: 50 },
			),
		).rejects.toThrow(/worker control command result timed out/u);
	});

	it('rejects outbound command promises promptly when the accepted socket disconnects', async () => {
		const fixture = createFixture();
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: WORKER_CONTROL_SOCKET_PATH,
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
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const envelope = workerGitPushEnvelopeFor(acceptedSession, fixture.service.nextPeerSequence());
		const commandResult = fixture.service.emitApplicationMessage(
			envelope,
			{ kind: 'command', operation: 'git_push' },
			{
				kind: 'command',
				operation: 'git_push',
				payload: {
					branchName: 'agent/task-1',
					command: {
						commandId: envelope.commandId,
						idempotencyKey: envelope.idempotencyKey,
					},
					repoUrl: 'https://github.com/example/repo.git',
					task: {
						taskId: 'task-1',
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

	it('receives controller-originated worker control RPC messages and emits command_result separately', async () => {
		const handledPayloads: unknown[] = [];
		const fixture = createFixture(() => 1_000, {
			applicationMessageHandler: {
				handle: async ({ envelope, payload }) => {
					handledPayloads.push(payload);
					return {
						kind: 'command_result',
						operation: 'git_push',
						payload: workerGitPushOkResponsePayloadFor(envelope.messageId),
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
			path: WORKER_CONTROL_SOCKET_PATH,
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
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await client.timeout(1_000).emitWithAck('control:hello', helloPayload);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const envelope = workerGitPushEnvelopeFor(acceptedSession);
		const workerMessage = {
			kind: 'command',
			operation: 'git_push',
			payload: {
				branchName: 'agent/task-1',
				command: {
					commandId: envelope.commandId,
					idempotencyKey: envelope.idempotencyKey,
				},
				repoUrl: 'https://github.com/example/repo.git',
				task: {
					taskId: 'task-1',
				},
			},
		};

		await expect(
			client.timeout(1_000).emitWithAck('control:message', envelope, workerMessage),
		).resolves.toEqual({ received: true });
		await commandResultObserved;
		expect(handledPayloads).toEqual([workerMessage]);
		expect(observedCommandResults).toEqual([
			{
				kind: 'command_result',
				operation: 'git_push',
				payload: workerGitPushOkResponsePayloadFor(envelope.messageId),
			},
		]);
	});

	it('emits controller-originated worker command_result replies in inbound sequence order', async () => {
		let releaseFirstHandler: (() => void) | undefined;
		const firstHandlerReleased = new Promise<void>((resolve) => {
			releaseFirstHandler = resolve;
		});
		let handleCount = 0;
		let resolveSecondHandlerStarted: (() => void) | undefined;
		const secondHandlerStarted = new Promise<void>((resolve) => {
			resolveSecondHandlerStarted = resolve;
		});
		const fixture = createFixture(() => 1_000, {
			applicationMessageHandler: {
				handle: async ({ envelope }) => {
					handleCount += 1;
					if (handleCount === 1) {
						await firstHandlerReleased;
					} else {
						resolveSecondHandlerStarted?.();
					}
					return {
						kind: 'command_result',
						operation: 'git_push',
						payload: workerGitPushOkResponsePayloadFor(envelope.messageId),
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
			path: WORKER_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		const observedEnvelopes: ControlEnvelope[] = [];
		const observedCommandResults: unknown[] = [];
		let resolveBothCommandResultsObserved: (() => void) | undefined;
		const bothCommandResultsObserved = new Promise<void>((resolve) => {
			resolveBothCommandResultsObserved = resolve;
		});
		client.on(
			'control:message',
			(envelope: unknown, payload: unknown, acknowledge: (response: unknown) => void) => {
				const controlEnvelope = envelope as ControlEnvelope;
				if (controlEnvelope.kind === 'command_result') {
					observedEnvelopes.push(controlEnvelope);
					observedCommandResults.push(payload);
					if (observedCommandResults.length === 2) {
						resolveBothCommandResultsObserved?.();
					}
				}
				acknowledge({ received: true });
			},
		);
		await waitForSocketConnect(client);

		await client.timeout(1_000).emitWithAck('control:hello', {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const firstEnvelope = workerGitPushEnvelopeFor(acceptedSession, 1);
		const secondEnvelope = {
			...workerGitPushEnvelopeFor(acceptedSession, 2),
			commandId: '55555555-5555-4555-8555-555555555555',
			idempotencyKey: 'worker-git-push-command-key-2',
			messageId: '33333333-3333-4333-8333-333333333333',
		} satisfies ControlEnvelope;
		const workerMessage = {
			kind: 'command',
			operation: 'git_push',
			payload: {
				branchName: 'agent/task-1',
				command: {
					commandId: firstEnvelope.commandId,
					idempotencyKey: firstEnvelope.idempotencyKey,
				},
				repoUrl: 'https://github.com/example/repo.git',
				task: {
					taskId: 'task-1',
				},
			},
		};

		await client.timeout(1_000).emitWithAck('control:message', firstEnvelope, workerMessage);
		await client.timeout(1_000).emitWithAck('control:message', secondEnvelope, workerMessage);
		await secondHandlerStarted;
		expect(observedCommandResults).toEqual([]);
		if (releaseFirstHandler === undefined) {
			throw new Error('Expected first handler release hook to be registered.');
		}
		releaseFirstHandler();
		await bothCommandResultsObserved;

		expect(observedEnvelopes.map((envelope) => envelope.sequence)).toEqual([1, 2]);
		expect(observedCommandResults).toEqual([
			{
				kind: 'command_result',
				operation: 'git_push',
				payload: workerGitPushOkResponsePayloadFor(firstEnvelope.messageId),
			},
			{
				kind: 'command_result',
				operation: 'git_push',
				payload: workerGitPushOkResponsePayloadFor(secondEnvelope.messageId),
			},
		]);
		expect(client.connected).toBe(true);
	});

	it('does not let no-reply worker events block later command_result replies', async () => {
		let releaseEventHandler: (() => void) | undefined;
		const eventHandlerReleased = new Promise<void>((resolve) => {
			releaseEventHandler = resolve;
		});
		const fixture = createFixture(() => 1_000, {
			applicationMessageHandler: {
				handle: async ({ envelope }) => {
					if (envelope.kind === 'event') {
						await eventHandlerReleased;
						return undefined;
					}
					return {
						kind: 'command_result',
						operation: 'git_push',
						payload: workerGitPushOkResponsePayloadFor(envelope.messageId),
					};
				},
				messageIdentity: ({ payload }) => {
					const message = payload as {
						readonly kind: DomainControlMessageIdentity['kind'];
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
			path: WORKER_CONTROL_SOCKET_PATH,
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

		await client.timeout(1_000).emitWithAck('control:hello', {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const eventEnvelope = workerRuntimeStatusEnvelopeFor(
			acceptedSession,
			1,
			'10000000-0000-4000-8000-000000000001',
		);
		const commandEnvelope = workerGitPushEnvelopeFor(acceptedSession, 1);

		await client.timeout(1_000).emitWithAck('control:message', eventEnvelope, {
			kind: 'event',
			operation: 'worker_runtime_status',
			payload: {
				findings: [{ id: 'event-a', ok: true }],
				observedAtMs: 1,
				statusKind: 'task_status',
			},
		});
		await client.timeout(1_000).emitWithAck('control:message', commandEnvelope, {
			kind: 'command',
			operation: 'git_push',
			payload: {
				branchName: 'agent/task-1',
				command: {
					commandId: commandEnvelope.commandId,
					idempotencyKey: commandEnvelope.idempotencyKey,
				},
				repoUrl: 'https://github.com/example/repo.git',
				task: {
					taskId: 'task-1',
				},
			},
		});

		await commandResultObserved;
		expect(observedCommandResults).toEqual([
			{
				kind: 'command_result',
				operation: 'git_push',
				payload: workerGitPushOkResponsePayloadFor(commandEnvelope.messageId),
			},
		]);
		releaseEventHandler?.();
	});

	it('returns a failed command_result when the worker handler throws after ack', async () => {
		const fixture = createFixture(() => 1_000, {
			applicationMessageHandler: {
				buildHandlerFailureResult: ({ envelope, payload }) => {
					const message = payload as { readonly kind: 'command'; readonly operation: string };
					return {
						kind: 'command_result',
						operation: message.operation,
						payload: {
							error: {
								errorClass: 'test_worker_handler_failed',
								retryable: true,
								safeMessage: 'test worker handler failed',
							},
							responseToMessageId: envelope.messageId,
							result: 'failed',
						},
					};
				},
				handle: async () => {
					throw new Error('worker handler failed after ack');
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
			path: WORKER_CONTROL_SOCKET_PATH,
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
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await client.timeout(1_000).emitWithAck('control:hello', helloPayload);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const envelope = workerGitPushEnvelopeFor(acceptedSession);
		const workerMessage = {
			kind: 'command',
			operation: 'git_push',
			payload: {
				branchName: 'agent/task-1',
				command: {
					commandId: envelope.commandId,
					idempotencyKey: envelope.idempotencyKey,
				},
				repoUrl: 'https://github.com/example/repo.git',
				task: {
					taskId: 'task-1',
				},
			},
		};

		await expect(
			client.timeout(1_000).emitWithAck('control:message', envelope, workerMessage),
		).resolves.toEqual({ received: true });
		await commandResultObserved;
		expect(observedCommandResults).toEqual([
			{
				kind: 'command_result',
				operation: 'git_push',
				payload: {
					error: {
						errorClass: 'test_worker_handler_failed',
						retryable: true,
						safeMessage: 'test worker handler failed',
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
					operation: 'git_push',
					payload: workerGitPushOkResponsePayloadFor(envelope.messageId),
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
			path: WORKER_CONTROL_SOCKET_PATH,
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
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await client.timeout(1_000).emitWithAck('control:hello', helloPayload);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const workerMessage = {
			kind: 'command',
			operation: 'git_push',
			payload: {
				branchName: 'agent/task-1',
				command: {
					commandId: '44444444-4444-4444-8444-444444444444',
					idempotencyKey: 'worker-git-push-command-key',
				},
				repoUrl: 'https://github.com/example/repo.git',
				task: {
					taskId: 'task-1',
				},
			},
		};

		await expect(
			client
				.timeout(1_000)
				.emitWithAck('control:message', workerGitPushEnvelopeFor(acceptedSession), workerMessage),
		).resolves.toEqual({ received: true });
		await waitForSocketDisconnect(client);
		await expect(
			client
				.timeout(100)
				.emitWithAck(
					'control:message',
					workerGitPushEnvelopeFor(acceptedSession, 2),
					workerMessage,
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
			path: WORKER_CONTROL_SOCKET_PATH,
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
							workerCommandResultEnvelopeFor(controlEnvelope, 1),
							{
								kind: 'command_result',
								operation: 'git_push',
								payload: workerGitPushOkResponsePayloadFor(controlEnvelope.messageId),
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
						workerCommandResultEnvelopeFor(controlEnvelope, 2),
						{
							kind: 'command_result',
							operation: 'git_push',
							payload: workerGitPushOkResponsePayloadFor(controlEnvelope.messageId),
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
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const firstEnvelope = workerGitPushEnvelopeFor(
			acceptedSession,
			fixture.service.nextPeerSequence(),
		);
		const secondEnvelope = {
			...workerGitPushEnvelopeFor(acceptedSession, fixture.service.nextPeerSequence()),
			commandId: '55555555-5555-4555-8555-555555555555',
			idempotencyKey: 'worker-git-push-command-key-2',
			messageId: '33333333-3333-4333-8333-333333333333',
		} satisfies ControlEnvelope;
		const workerMessage = {
			kind: 'command',
			operation: 'git_push',
			payload: {
				branchName: 'agent/task-1',
				command: {
					commandId: firstEnvelope.commandId,
					idempotencyKey: firstEnvelope.idempotencyKey,
				},
				repoUrl: 'https://github.com/example/repo.git',
				task: {
					taskId: 'task-1',
				},
			},
		};

		const firstSend = fixture.service.emitApplicationMessage(
			firstEnvelope,
			{ kind: 'command', operation: 'git_push' },
			workerMessage,
		);
		const secondSend = fixture.service.emitApplicationMessage(
			secondEnvelope,
			{ kind: 'command', operation: 'git_push' },
			workerMessage,
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
				operation: 'git_push',
				payload: workerGitPushOkResponsePayloadFor(firstEnvelope.messageId),
			},
			{
				kind: 'command_result',
				operation: 'git_push',
				payload: workerGitPushOkResponsePayloadFor(secondEnvelope.messageId),
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
			path: WORKER_CONTROL_SOCKET_PATH,
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
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const floodCount = CONTROL_QUEUE_LIMITS.queueMessageCap * 2;

		await Promise.all(
			Array.from({ length: floodCount }, (_unused, eventIndex) =>
				fixture.service.emitApplicationMessage(
					workerRuntimeStatusEnvelopeFor(
						acceptedSession,
						fixture.service.nextPeerSequence(),
						`10000000-0000-4000-8000-${String(eventIndex + 1).padStart(12, '0')}`,
					),
					{ kind: 'event', operation: 'worker_runtime_status' },
					{
						kind: 'event',
						operation: 'worker_runtime_status',
						payload: {
							findings: [{ id: `event-${String(eventIndex)}`, ok: true }],
							observedAtMs: eventIndex + 1,
							statusKind: 'task_status',
						},
					},
				),
			),
		);
		await observedMessage;

		expect(observedPayloads).toEqual([
			{
				kind: 'event',
				operation: 'worker_runtime_status',
				payload: {
					findings: [{ id: `event-${String(floodCount - 1)}`, ok: true }],
					observedAtMs: floodCount,
					statusKind: 'task_status',
				},
			},
		]);
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
			path: WORKER_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		await client.timeout(1_000).emitWithAck('control:hello', {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const lossyEnvelope = workerRuntimeStatusEnvelopeFor(
			acceptedSession,
			3,
			'10000000-0000-4000-8000-000000000004',
		);
		const lossyPayload = {
			kind: 'event',
			operation: 'worker_runtime_status',
			payload: {
				findings: [{ id: 'advisory-after-gap', ok: true }],
				observedAtMs: 1,
				statusKind: 'task_status',
			},
		};
		const criticalEnvelope = workerGitPushEnvelopeFor(acceptedSession, 1);
		const criticalPayload = {
			kind: 'command',
			operation: 'git_push',
			payload: {
				branchName: 'agent/task-1',
				command: {
					commandId: criticalEnvelope.commandId,
					idempotencyKey: criticalEnvelope.idempotencyKey,
				},
				repoUrl: 'https://github.com/example/repo.git',
				task: {
					taskId: 'task-1',
				},
			},
		};

		await expect(
			client.timeout(1_000).emitWithAck('control:message', lossyEnvelope, lossyPayload),
		).resolves.toEqual({ received: true });
		await expect(
			client.timeout(1_000).emitWithAck('control:message', criticalEnvelope, criticalPayload),
		).resolves.toEqual({ received: true });
		expect(client.connected).toBe(true);
		expect(handledPayloads).toEqual([lossyPayload, criticalPayload]);
	});

	it('rejects controller-originated operation_cancel over worker_control without closing the session', async () => {
		const fixture = createFixture(() => 1_000, {
			applicationMessageHandler: createWorkerControlApplicationMessageHandler(),
		});
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: WORKER_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		const observedCommandResults: unknown[] = [];
		const commandResultObserved = new Promise<void>((resolve) => {
			client.on('control:message', (_envelope: unknown, payload: unknown, acknowledge) => {
				observedCommandResults.push(payload);
				if (typeof acknowledge === 'function') {
					acknowledge({ received: true });
				}
				resolve();
			});
		});
		await waitForSocketConnect(client);

		await client.timeout(1_000).emitWithAck('control:hello', {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const cancelEnvelope = {
			...workerGitPushEnvelopeFor(acceptedSession, 1),
			commandId: '55555555-5555-4555-8555-555555555555',
			deliveryPolicy: 'acked_idempotent',
			idempotencyKey: 'operation-cancel-key',
			messageId: '66666666-6666-4666-8666-666666666666',
			operation: 'operation_cancel',
		} satisfies ControlEnvelope;

		await expect(
			client.timeout(1_000).emitWithAck('control:message', cancelEnvelope, {
				kind: 'command',
				operation: 'operation_cancel',
				payload: {
					activeOperationId: '77777777-7777-4777-8777-777777777777',
					initiatedBy: 'controller',
					reason: 'operator_cancelled',
				},
			}),
		).resolves.toEqual({ received: true });
		await commandResultObserved;

		expect(observedCommandResults).toEqual([
			{
				kind: 'command_result',
				operation: 'operation_cancel',
				payload: {
					activeOperationId: '77777777-7777-4777-8777-777777777777',
					error: {
						errorClass: 'worker_control_cancel_not_supported',
						retryable: false,
						safeMessage: 'worker task cancellation remains on the ingress HTTP task close route',
					},
					responseToMessageId: cancelEnvelope.messageId,
					result: 'rejected',
				},
			},
		]);
		expect(client.connected).toBe(true);
	});

	it('rejects malformed worker control messages without a positive receipt', async () => {
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
			path: WORKER_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await client.timeout(1_000).emitWithAck('control:hello', helloPayload);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const envelope = workerGitPushEnvelopeFor(acceptedSession);

		await expect(
			client.timeout(1_000).emitWithAck('control:message', envelope, {
				kind: 'command',
				operation: 'git_push',
				payload: {},
			}),
		).resolves.toEqual({
			errorClass: 'schema_validation_failed',
			received: false,
			safeMessage: 'worker control message was rejected',
		});
		expect(handledPayloads).toEqual([]);
	});

	it('rejects worker control processing failures without labeling them as schema failures', async () => {
		const fixture = createFixture(() => 1_000);
		const port = await listenWithService(fixture.service);
		const credential = await fetchIssuedCredential(port, fixture.readyHeadersFor());
		const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
			addTrailingSlash: false,
			extraHeaders: fixture.clientHeadersFor(credential),
			forceNew: true,
			path: WORKER_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await client.timeout(1_000).emitWithAck('control:hello', helloPayload);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const envelope = workerGitPushEnvelopeFor(acceptedSession);
		const workerMessage = WorkerControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'git_push',
			payload: {
				branchName: 'agent/task-1',
				command: {
					commandId: envelope.commandId,
					idempotencyKey: envelope.idempotencyKey,
				},
				repoUrl: 'https://github.com/example/repo.git',
				task: {
					taskId: 'task-1',
				},
			},
		});

		await expect(
			client.timeout(1_000).emitWithAck('control:message', envelope, workerMessage),
		).resolves.toEqual({
			errorClass: 'worker_control_message_processing_failed',
			received: false,
			safeMessage: 'worker control message was rejected',
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
			path: WORKER_CONTROL_SOCKET_PATH,
			reconnection: false,
			timeout: 2_000,
			transports: ['websocket'],
		});
		activeSockets.push(client);
		await waitForSocketConnect(client);

		const helloPayload = {
			bootId: identity.bootId,
			controllerEpoch: identity.controllerEpoch,
			domain: 'worker_control',
			peerId: identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies ControlHello;
		await client.timeout(1_000).emitWithAck('control:hello', helloPayload);
		const acceptedSession = await fixture.service.getAcceptedSession();
		const envelope = workerGitPushEnvelopeFor(acceptedSession, 2);
		const workerMessage = {
			kind: 'command',
			operation: 'git_push',
			payload: {
				branchName: 'agent/task-1',
				command: {
					commandId: envelope.commandId,
					idempotencyKey: envelope.idempotencyKey,
				},
				repoUrl: 'https://github.com/example/repo.git',
				task: {
					taskId: 'task-1',
				},
			},
		};

		await expect(
			client.timeout(100).emitWithAck('control:message', envelope, workerMessage),
		).rejects.toThrow();
		expect(handledPayloads).toEqual([]);
	});
});
