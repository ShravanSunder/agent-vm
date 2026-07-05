import {
	createPrivateKey,
	generateKeyPairSync,
	randomBytes,
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
import {
	gatewayControlCommandExecutionTimeoutMsByOperation,
	gatewayControlDeliveryPolicyByKind,
	gatewayControlDeliveryPolicyByOperation,
} from '@agent-vm/gateway-control-contracts';
import { GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV } from '@agent-vm/gateway-interface';
import { z } from 'zod';

import {
	DEFAULT_GATEWAY_CONTROL_PATH,
	type ControlSessionClient,
	type ControlSessionEndpoint,
	createControlSessionClient,
} from './control-session-client.js';
import type {
	ControlSessionDispatcher,
	ControlSessionFenceRegistry,
} from './control-session-dispatcher.js';

export const GATEWAY_CONTROL_READY_PATH = '/__agent-vm/ready';

export interface GatewayControlSessionMaterial {
	readonly bootId: string;
	readonly callerContextProofKey: string;
	readonly controllerEpoch: string;
	readonly generationId: string;
	readonly peerId: string;
	readonly privateKey: KeyObject;
	readonly verifierPublicKeyPem: string;
	readonly zoneId: string;
}

export const serializedGatewayControlSessionMaterialSchema = z.strictObject({
	bootId: z.string().min(1),
	callerContextProofKey: z.string().min(32),
	controllerEpoch: z.string().min(1),
	generationId: z.string().min(1),
	peerId: z.string().min(1),
	privateKeyPkcs8Pem: z.string().min(1),
	verifierPublicKeyPem: z.string().min(1),
	zoneId: z.string().min(1),
});

export type SerializedGatewayControlSessionMaterial = z.infer<
	typeof serializedGatewayControlSessionMaterialSchema
>;

export interface CreateGatewayControlSessionMaterialOptions {
	readonly controllerEpoch: string;
	readonly zoneId: string;
}

export interface ConnectGatewayControlSessionOptions {
	readonly dispatcher?: ControlSessionDispatcher;
	readonly endpoint: ControlSessionEndpoint;
	readonly fetchImpl?: typeof fetch;
	readonly material: GatewayControlSessionMaterial;
	readonly sessionFenceRegistry?: ControlSessionFenceRegistry;
}

export function createGatewayControlSessionMaterial(
	options: CreateGatewayControlSessionMaterialOptions,
): GatewayControlSessionMaterial {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	return {
		bootId: randomUUID(),
		callerContextProofKey: randomBytes(32).toString('base64url'),
		controllerEpoch: options.controllerEpoch,
		generationId: randomUUID(),
		peerId: `gateway-${options.zoneId}`,
		privateKey,
		verifierPublicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
		zoneId: options.zoneId,
	};
}

export function serializeGatewayControlSessionMaterial(
	material: GatewayControlSessionMaterial,
): SerializedGatewayControlSessionMaterial {
	const privateKeyPkcs8Pem = material.privateKey.export({
		format: 'pem',
		type: 'pkcs8',
	});
	if (typeof privateKeyPkcs8Pem !== 'string') {
		throw new Error('Gateway control private key export did not return PEM text.');
	}
	return {
		bootId: material.bootId,
		callerContextProofKey: material.callerContextProofKey,
		controllerEpoch: material.controllerEpoch,
		generationId: material.generationId,
		peerId: material.peerId,
		privateKeyPkcs8Pem,
		verifierPublicKeyPem: material.verifierPublicKeyPem,
		zoneId: material.zoneId,
	};
}

export function deserializeGatewayControlSessionMaterial(
	material: SerializedGatewayControlSessionMaterial,
): GatewayControlSessionMaterial {
	const parsedMaterial = serializedGatewayControlSessionMaterialSchema.parse(material);
	return {
		bootId: parsedMaterial.bootId,
		callerContextProofKey: parsedMaterial.callerContextProofKey,
		controllerEpoch: parsedMaterial.controllerEpoch,
		generationId: parsedMaterial.generationId,
		peerId: parsedMaterial.peerId,
		privateKey: createPrivateKey(parsedMaterial.privateKeyPkcs8Pem),
		verifierPublicKeyPem: parsedMaterial.verifierPublicKeyPem,
		zoneId: parsedMaterial.zoneId,
	};
}

export function buildGatewayControlRuntimePluginConfig(
	material: GatewayControlSessionMaterial,
): Readonly<Record<string, unknown>> {
	return {
		bootId: material.bootId,
		controllerEpoch: material.controllerEpoch,
		generationId: material.generationId,
		peerId: material.peerId,
		verifierPublicKeyPem: material.verifierPublicKeyPem,
	};
}

export function buildGatewayControlPrivateEnvironment(
	material: GatewayControlSessionMaterial,
): Readonly<Record<typeof GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV, string>> {
	return {
		[GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV]: material.callerContextProofKey,
	};
}

function buildReadyUrl(endpoint: ControlSessionEndpoint): string {
	return `http://${endpoint.host}:${String(endpoint.port)}${GATEWAY_CONTROL_READY_PATH}`;
}

function assertCredentialMatchesMaterial(
	credential: ControlHandshakeCredential,
	material: GatewayControlSessionMaterial,
): void {
	if (
		credential.audience !== 'gateway_control' ||
		credential.bootId !== material.bootId ||
		credential.controllerEpoch !== material.controllerEpoch ||
		credential.generationId !== material.generationId ||
		credential.peerId !== material.peerId ||
		credential.protocolVersion !== CONTROL_PROTOCOL_VERSION ||
		credential.zoneId !== material.zoneId
	) {
		throw new Error(
			'Gateway control readiness credential did not match controller session material.',
		);
	}
}

function signGatewayControlCredential(
	credential: ControlHandshakeCredential,
	privateKey: KeyObject,
): string {
	return signPayload(
		null,
		Buffer.from(buildControlHandshakeSignaturePayload(credential)),
		privateKey,
	).toString('base64url');
}

function signGatewayControlReadyRequest(
	credential: ControlReadyRequestCredential,
	privateKey: KeyObject,
): string {
	return signPayload(
		null,
		Buffer.from(buildControlReadyRequestSignaturePayload(credential)),
		privateKey,
	).toString('base64url');
}

async function readSafeErrorResponseBody(response: Response): Promise<string | undefined> {
	const text = await response.text().catch(() => '');
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	return trimmed.slice(0, 200);
}

function buildControlReadyTimeoutSignal(): {
	readonly clear: () => void;
	readonly signal: AbortSignal;
} {
	const abortController = new AbortController();
	const timeout = setTimeout(() => {
		abortController.abort(
			new Error(
				`Gateway control readiness timed out after ${String(CONTROL_SESSION_TIMING_MS.connectTimeout)}ms.`,
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

export function buildGatewayControlReadyHeaders(options: {
	readonly material: GatewayControlSessionMaterial;
	readonly now?: () => number;
	readonly requestId?: string;
}): Readonly<Record<string, string>> {
	const readyRequest: ControlReadyRequestCredential = {
		audience: 'gateway_control',
		bootId: options.material.bootId,
		controllerEpoch: options.material.controllerEpoch,
		generationId: options.material.generationId,
		issuedAtMs: (options.now ?? (() => Date.now()))(),
		peerId: options.material.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		requestId: options.requestId ?? randomUUID(),
		zoneId: options.material.zoneId,
	};
	const signature = signGatewayControlReadyRequest(readyRequest, options.material.privateKey);
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

export function buildGatewayControlHandshakeHeaders(options: {
	readonly credential: ControlHandshakeCredential;
	readonly privateKey: KeyObject;
}): Readonly<Record<string, string>> {
	const signature = signGatewayControlCredential(options.credential, options.privateKey);
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

export async function fetchGatewayControlCredential(
	options: Pick<ConnectGatewayControlSessionOptions, 'endpoint' | 'fetchImpl' | 'material'>,
): Promise<ControlHandshakeCredential> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const readyTimeout = buildControlReadyTimeoutSignal();
	const response = await fetchImpl(buildReadyUrl(options.endpoint), {
		headers: {
			accept: 'application/json',
			...buildGatewayControlReadyHeaders({ material: options.material }),
		},
		method: 'GET',
		signal: readyTimeout.signal,
	}).finally(readyTimeout.clear);
	if (!response.ok) {
		const responseBody = await readSafeErrorResponseBody(response);
		throw new Error(
			`Gateway control readiness failed with HTTP ${String(response.status)} ${response.statusText}${
				responseBody === undefined ? '' : `: ${responseBody}`
			}`,
		);
	}
	return ControlHandshakeCredentialSchema.parse(await response.json());
}

export async function connectGatewayControlSession(
	options: ConnectGatewayControlSessionOptions,
): Promise<ControlSessionClient> {
	const buildHeaders = async (): Promise<Readonly<Record<string, string>>> => {
		const credential = await fetchGatewayControlCredential(options);
		assertCredentialMatchesMaterial(credential, options.material);
		return buildGatewayControlHandshakeHeaders({
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
			domain: 'gateway_control',
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
							domain: 'gateway_control',
							peerId: options.material.peerId,
							sessionId: response.sessionId,
							zoneId: options.material.zoneId,
						});
					},
				}),
		commandResultTimeoutMsByOperation: gatewayControlCommandExecutionTimeoutMsByOperation,
		policyByKind: gatewayControlDeliveryPolicyByKind,
		policyByOperation: gatewayControlDeliveryPolicyByOperation,
		refreshExtraHeaders: buildHeaders,
		timeoutMs: CONTROL_SESSION_TIMING_MS.connectTimeout,
	});
	await client.ready;
	return client;
}

export function buildGatewayControlEndpoint(options: {
	readonly host: string;
	readonly port: number;
}): ControlSessionEndpoint {
	return {
		host: options.host,
		path: DEFAULT_GATEWAY_CONTROL_PATH,
		port: options.port,
	};
}
