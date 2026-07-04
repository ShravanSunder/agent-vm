import {
	createPrivateKey,
	generateKeyPairSync,
	randomUUID,
	sign as signPayload,
	type KeyObject,
} from 'node:crypto';

import {
	CONTROL_HANDSHAKE_HEADER_NAMES,
	CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
	CONTROL_READY_HEADER_NAMES,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_SESSION_TIMING_MS,
	ControlHandshakeCredentialSchema,
	buildControlHandshakeSignaturePayload,
	buildControlReadyRequestSignaturePayload,
	type ControlHandshakeCredential,
	type ControlReadyRequestCredential,
} from '@agent-vm/control-protocol-contracts';
import { workerControlCommandExecutionTimeoutMsByOperation } from '@agent-vm/worker-control-contracts';

import {
	DEFAULT_WORKER_CONTROL_PATH,
	type ControlSessionClient,
	type ControlSessionEndpoint,
	createControlSessionClient,
} from './control-session-client.js';
import type {
	ControlSessionDispatcher,
	ControlSessionFenceRegistry,
} from './control-session-dispatcher.js';

export const WORKER_CONTROL_READY_PATH = '/__agent-vm/worker-ready';

export interface WorkerControlSessionMaterial {
	readonly bootId: string;
	readonly controllerEpoch: string;
	readonly generationId: string;
	readonly peerId: string;
	readonly privateKey: KeyObject;
	readonly verifierPublicKeyPem: string;
	readonly zoneId: string;
}

export interface SerializedWorkerControlSessionMaterial {
	readonly bootId: string;
	readonly controllerEpoch: string;
	readonly generationId: string;
	readonly peerId: string;
	readonly privateKeyPkcs8Pem: string;
	readonly verifierPublicKeyPem: string;
	readonly zoneId: string;
}

export interface CreateWorkerControlSessionMaterialOptions {
	readonly controllerEpoch: string;
	readonly taskId: string;
	readonly zoneId: string;
}

export interface ConnectWorkerControlSessionOptions {
	readonly dispatcher?: ControlSessionDispatcher;
	readonly endpoint: ControlSessionEndpoint;
	readonly fetchImpl?: typeof fetch;
	readonly material: WorkerControlSessionMaterial;
	readonly sessionFenceRegistry?: ControlSessionFenceRegistry;
}

export function createWorkerControlSessionMaterial(
	options: CreateWorkerControlSessionMaterialOptions,
): WorkerControlSessionMaterial {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	return {
		bootId: randomUUID(),
		controllerEpoch: options.controllerEpoch,
		generationId: randomUUID(),
		peerId: `worker-${options.zoneId}-${options.taskId}`,
		privateKey,
		verifierPublicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
		zoneId: options.zoneId,
	};
}

export function serializeWorkerControlSessionMaterial(
	material: WorkerControlSessionMaterial,
): SerializedWorkerControlSessionMaterial {
	const privateKeyPkcs8Pem = material.privateKey.export({
		format: 'pem',
		type: 'pkcs8',
	});
	if (typeof privateKeyPkcs8Pem !== 'string') {
		throw new Error('Worker control private key export did not return PEM text.');
	}
	return {
		bootId: material.bootId,
		controllerEpoch: material.controllerEpoch,
		generationId: material.generationId,
		peerId: material.peerId,
		privateKeyPkcs8Pem,
		verifierPublicKeyPem: material.verifierPublicKeyPem,
		zoneId: material.zoneId,
	};
}

export function deserializeWorkerControlSessionMaterial(
	material: SerializedWorkerControlSessionMaterial,
): WorkerControlSessionMaterial {
	return {
		bootId: material.bootId,
		controllerEpoch: material.controllerEpoch,
		generationId: material.generationId,
		peerId: material.peerId,
		privateKey: createPrivateKey(material.privateKeyPkcs8Pem),
		verifierPublicKeyPem: material.verifierPublicKeyPem,
		zoneId: material.zoneId,
	};
}

export function buildWorkerControlEnvironment(
	material: WorkerControlSessionMaterial,
): Readonly<Record<string, string>> {
	return {
		AGENT_VM_WORKER_CONTROL_BOOT_ID: material.bootId,
		AGENT_VM_WORKER_CONTROL_CONTROLLER_EPOCH: material.controllerEpoch,
		AGENT_VM_WORKER_CONTROL_GENERATION_ID: material.generationId,
		AGENT_VM_WORKER_CONTROL_PEER_ID: material.peerId,
		AGENT_VM_WORKER_CONTROL_PUBLIC_KEY_PEM: material.verifierPublicKeyPem,
		AGENT_VM_ZONE_ID: material.zoneId,
	};
}

function buildReadyUrl(endpoint: ControlSessionEndpoint): string {
	return `http://${endpoint.host}:${String(endpoint.port)}${WORKER_CONTROL_READY_PATH}`;
}

function assertCredentialMatchesMaterial(
	credential: ControlHandshakeCredential,
	material: WorkerControlSessionMaterial,
): void {
	if (
		credential.audience !== 'worker_control' ||
		credential.bootId !== material.bootId ||
		credential.controllerEpoch !== material.controllerEpoch ||
		credential.generationId !== material.generationId ||
		credential.peerId !== material.peerId ||
		credential.protocolVersion !== CONTROL_PROTOCOL_VERSION ||
		credential.zoneId !== material.zoneId
	) {
		throw new Error('Worker control readiness credential did not match session material.');
	}
}

function signWorkerControlCredential(
	credential: ControlHandshakeCredential,
	privateKey: KeyObject,
): string {
	return signPayload(
		null,
		Buffer.from(buildControlHandshakeSignaturePayload(credential)),
		privateKey,
	).toString('base64url');
}

function signWorkerControlReadyRequest(
	credential: ControlReadyRequestCredential,
	privateKey: KeyObject,
): string {
	return signPayload(
		null,
		Buffer.from(buildControlReadyRequestSignaturePayload(credential)),
		privateKey,
	).toString('base64url');
}

function buildControlReadyTimeoutSignal(): {
	readonly clear: () => void;
	readonly signal: AbortSignal;
} {
	const abortController = new AbortController();
	const timeout = setTimeout(() => {
		abortController.abort(
			new Error(
				`Worker control readiness timed out after ${String(CONTROL_SESSION_TIMING_MS.connectTimeout)}ms.`,
			),
		);
	}, CONTROL_SESSION_TIMING_MS.connectTimeout);
	timeout.unref?.();
	return {
		clear: () => {
			clearTimeout(timeout);
		},
		signal: abortController.signal,
	};
}

export function buildWorkerControlReadyHeaders(options: {
	readonly material: WorkerControlSessionMaterial;
	readonly now?: () => number;
	readonly requestId?: string;
}): Readonly<Record<string, string>> {
	const readyRequest: ControlReadyRequestCredential = {
		audience: 'worker_control',
		bootId: options.material.bootId,
		controllerEpoch: options.material.controllerEpoch,
		generationId: options.material.generationId,
		issuedAtMs: (options.now ?? (() => Date.now()))(),
		peerId: options.material.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		requestId: options.requestId ?? randomUUID(),
		zoneId: options.material.zoneId,
	};
	const signature = signWorkerControlReadyRequest(readyRequest, options.material.privateKey);
	return {
		[CONTROL_READY_HEADER_NAMES.bootId]: readyRequest.bootId,
		[CONTROL_READY_HEADER_NAMES.controllerEpoch]: readyRequest.controllerEpoch,
		[CONTROL_READY_HEADER_NAMES.domain]: readyRequest.audience,
		[CONTROL_READY_HEADER_NAMES.generationId]: readyRequest.generationId,
		[CONTROL_READY_HEADER_NAMES.issuedAtMs]: String(readyRequest.issuedAtMs),
		[CONTROL_READY_HEADER_NAMES.peerId]: readyRequest.peerId,
		[CONTROL_READY_HEADER_NAMES.protocol]: CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
		[CONTROL_READY_HEADER_NAMES.requestId]: readyRequest.requestId,
		[CONTROL_READY_HEADER_NAMES.signature]: signature,
		[CONTROL_READY_HEADER_NAMES.zoneId]: readyRequest.zoneId,
	};
}

export function buildWorkerControlHandshakeHeaders(options: {
	readonly credential: ControlHandshakeCredential;
	readonly privateKey: KeyObject;
}): Readonly<Record<string, string>> {
	const signature = signWorkerControlCredential(options.credential, options.privateKey);
	return {
		[CONTROL_HANDSHAKE_HEADER_NAMES.bootId]: options.credential.bootId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.controllerEpoch]: options.credential.controllerEpoch,
		[CONTROL_HANDSHAKE_HEADER_NAMES.credentialId]: options.credential.credentialId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.domain]: options.credential.audience,
		[CONTROL_HANDSHAKE_HEADER_NAMES.expiresAtMs]: String(options.credential.expiresAtMs),
		[CONTROL_HANDSHAKE_HEADER_NAMES.generationId]: options.credential.generationId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.issuedAtMs]: String(options.credential.issuedAtMs),
		[CONTROL_HANDSHAKE_HEADER_NAMES.nonce]: options.credential.nonce,
		[CONTROL_HANDSHAKE_HEADER_NAMES.peerId]: options.credential.peerId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.protocol]: CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
		[CONTROL_HANDSHAKE_HEADER_NAMES.signature]: signature,
		[CONTROL_HANDSHAKE_HEADER_NAMES.zoneId]: options.credential.zoneId,
	};
}

export async function fetchWorkerControlCredential(
	options: Pick<ConnectWorkerControlSessionOptions, 'endpoint' | 'fetchImpl' | 'material'>,
): Promise<ControlHandshakeCredential> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const readyTimeout = buildControlReadyTimeoutSignal();
	const response = await fetchImpl(buildReadyUrl(options.endpoint), {
		headers: {
			accept: 'application/json',
			...buildWorkerControlReadyHeaders({ material: options.material }),
		},
		method: 'GET',
		signal: readyTimeout.signal,
	}).finally(readyTimeout.clear);
	if (!response.ok) {
		throw new Error(
			`Worker control readiness failed with HTTP ${String(response.status)} ${response.statusText}`,
		);
	}
	return ControlHandshakeCredentialSchema.parse(await response.json());
}

export async function connectWorkerControlSession(
	options: ConnectWorkerControlSessionOptions,
): Promise<ControlSessionClient> {
	const buildHeaders = async (): Promise<Readonly<Record<string, string>>> => {
		const credential = await fetchWorkerControlCredential(options);
		assertCredentialMatchesMaterial(credential, options.material);
		return buildWorkerControlHandshakeHeaders({
			credential,
			privateKey: options.material.privateKey,
		});
	};
	const extraHeaders = await buildHeaders();
	const client = createControlSessionClient({
		endpoint: {
			host: options.endpoint.host,
			path: options.endpoint.path,
			port: options.endpoint.port,
		},
		...(options.dispatcher === undefined ? {} : { dispatcher: options.dispatcher }),
		extraHeaders,
		identity: {
			bootId: options.material.bootId,
			controllerEpoch: options.material.controllerEpoch,
			domain: 'worker_control',
			peerId: options.material.peerId,
		},
		...(options.sessionFenceRegistry === undefined
			? {}
			: {
					onHelloResponse: (response) => {
						if (response.outcome !== 'accepted') {
							return;
						}
						options.sessionFenceRegistry?.acceptSession({
							bootId: options.material.bootId,
							connectionId: response.connectionId,
							controllerEpoch: response.controllerEpoch,
							domain: 'worker_control',
							peerId: options.material.peerId,
							sessionId: response.sessionId,
							zoneId: options.material.zoneId,
						});
					},
				}),
		commandResultTimeoutMsByOperation: workerControlCommandExecutionTimeoutMsByOperation,
		policyByOperation: {},
		refreshExtraHeaders: buildHeaders,
		timeoutMs: CONTROL_SESSION_TIMING_MS.connectTimeout,
	});
	await client.ready;
	return client;
}

export function buildWorkerControlEndpoint(options: {
	readonly host: string;
	readonly port: number;
}): ControlSessionEndpoint {
	return {
		host: options.host,
		path: DEFAULT_WORKER_CONTROL_PATH,
		port: options.port,
	};
}
