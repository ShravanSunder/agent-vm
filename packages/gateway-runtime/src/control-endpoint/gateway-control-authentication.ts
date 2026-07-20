import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
	CONTROL_HANDSHAKE_HEADER_NAMES,
	CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_READY_HEADER_NAMES,
	ControlHandshakeProofSchema,
	ControlReadyRequestProofSchema,
	buildControlHandshakeSignaturePayload,
	buildControlReadyRequestSignaturePayload,
	type ControlHandshakeProof,
	type ControlReadyRequestProof,
} from '@agent-vm/control-protocol-contracts';

import type {
	GatewayControlIdentity,
	GatewayControlIssuedCredential,
} from './gateway-control-endpoint-contracts.js';

function firstHeader(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function parseIntegerHeader(request: IncomingMessage, name: string): number | undefined {
	const value = firstHeader(request, name);
	if (value === undefined || !/^[0-9]+$/u.test(value)) return undefined;
	return Number.parseInt(value, 10);
}

function requestUrl(request: IncomingMessage): URL {
	return new URL(request.url ?? '/', 'http://gateway-runtime.local');
}

export function requestHasQueryParameters(request: IncomingMessage): boolean {
	return [...requestUrl(request).searchParams.keys()].length > 0;
}

export function requestHasValidSocketIoUpgradeQuery(request: IncomingMessage): boolean {
	const url = requestUrl(request);
	const allowedEntries = new Set(['EIO', 'transport']);
	for (const key of url.searchParams.keys()) {
		if (!allowedEntries.has(key)) return false;
	}
	return (
		url.searchParams.getAll('EIO').length === 1 &&
		url.searchParams.get('EIO') === '4' &&
		url.searchParams.getAll('transport').length === 1 &&
		url.searchParams.get('transport') === 'websocket'
	);
}

export function parseHandshakeProofFromHeaders(
	request: IncomingMessage,
): ControlHandshakeProof | undefined {
	if (
		firstHeader(request, CONTROL_HANDSHAKE_HEADER_NAMES.protocol) !==
		CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE
	) {
		return undefined;
	}
	const issuedAtMs = parseIntegerHeader(request, CONTROL_HANDSHAKE_HEADER_NAMES.issuedAtMs);
	const expiresAtMs = parseIntegerHeader(request, CONTROL_HANDSHAKE_HEADER_NAMES.expiresAtMs);
	if (issuedAtMs === undefined || expiresAtMs === undefined) return undefined;
	const parsed = ControlHandshakeProofSchema.safeParse({
		audience: firstHeader(request, CONTROL_HANDSHAKE_HEADER_NAMES.domain),
		bootId: firstHeader(request, CONTROL_HANDSHAKE_HEADER_NAMES.bootId),
		controllerEpoch: firstHeader(request, CONTROL_HANDSHAKE_HEADER_NAMES.controllerEpoch),
		credentialId: firstHeader(request, CONTROL_HANDSHAKE_HEADER_NAMES.credentialId),
		expiresAtMs,
		generationId: firstHeader(request, CONTROL_HANDSHAKE_HEADER_NAMES.generationId),
		issuedAtMs,
		nonce: firstHeader(request, CONTROL_HANDSHAKE_HEADER_NAMES.nonce),
		peerId: firstHeader(request, CONTROL_HANDSHAKE_HEADER_NAMES.peerId),
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		signature: firstHeader(request, CONTROL_HANDSHAKE_HEADER_NAMES.signature),
		zoneId: firstHeader(request, CONTROL_HANDSHAKE_HEADER_NAMES.zoneId),
	});
	return parsed.success ? parsed.data : undefined;
}

export function parseReadyRequestProofFromHeaders(
	request: IncomingMessage,
): ControlReadyRequestProof | undefined {
	if (
		firstHeader(request, CONTROL_READY_HEADER_NAMES.protocol) !==
		CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE
	) {
		return undefined;
	}
	const issuedAtMs = parseIntegerHeader(request, CONTROL_READY_HEADER_NAMES.issuedAtMs);
	if (issuedAtMs === undefined) return undefined;
	const parsed = ControlReadyRequestProofSchema.safeParse({
		audience: firstHeader(request, CONTROL_READY_HEADER_NAMES.domain),
		bootId: firstHeader(request, CONTROL_READY_HEADER_NAMES.bootId),
		controllerEpoch: firstHeader(request, CONTROL_READY_HEADER_NAMES.controllerEpoch),
		generationId: firstHeader(request, CONTROL_READY_HEADER_NAMES.generationId),
		issuedAtMs,
		peerId: firstHeader(request, CONTROL_READY_HEADER_NAMES.peerId),
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		requestId: firstHeader(request, CONTROL_READY_HEADER_NAMES.requestId),
		signature: firstHeader(request, CONTROL_READY_HEADER_NAMES.signature),
		zoneId: firstHeader(request, CONTROL_READY_HEADER_NAMES.zoneId),
	});
	return parsed.success ? parsed.data : undefined;
}

export function proofMatchesCredential(
	proof: ControlHandshakeProof,
	credential: GatewayControlIssuedCredential,
): boolean {
	return (
		proof.audience === credential.audience &&
		proof.bootId === credential.bootId &&
		proof.controllerEpoch === credential.controllerEpoch &&
		proof.credentialId === credential.credentialId &&
		proof.expiresAtMs === credential.expiresAtMs &&
		proof.generationId === credential.generationId &&
		proof.issuedAtMs === credential.issuedAtMs &&
		proof.nonce === credential.nonce &&
		proof.peerId === credential.peerId &&
		proof.protocolVersion === credential.protocolVersion &&
		proof.zoneId === credential.zoneId
	);
}

export function verifyGatewayControlProofSignature(
	proof: ControlHandshakeProof,
	verifierPublicKeyPem: string,
): boolean {
	const { signature, ...signedProof } = proof;
	return verifySignature(
		null,
		Buffer.from(buildControlHandshakeSignaturePayload(signedProof)),
		createPublicKey(verifierPublicKeyPem),
		Buffer.from(signature, 'base64url'),
	);
}

export function readyProofMatchesIdentity(
	proof: ControlReadyRequestProof,
	identity: GatewayControlIdentity,
): boolean {
	return (
		proof.audience === 'gateway_control' &&
		proof.bootId === identity.bootId &&
		proof.controllerEpoch === identity.controllerEpoch &&
		proof.generationId === identity.generationId &&
		proof.peerId === identity.peerId &&
		proof.protocolVersion === CONTROL_PROTOCOL_VERSION &&
		proof.zoneId === identity.zoneId
	);
}

export function verifyGatewayControlReadyProofSignature(
	proof: ControlReadyRequestProof,
	verifierPublicKeyPem: string,
): boolean {
	const { signature, ...signedProof } = proof;
	return verifySignature(
		null,
		Buffer.from(buildControlReadyRequestSignaturePayload(signedProof)),
		createPublicKey(verifierPublicKeyPem),
		Buffer.from(signature, 'base64url'),
	);
}
