import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { StandaloneToolPortalAuthenticatedEnvelopeSchema } from './standalone-tool-portal-bearer-credentials.js';

export const STANDALONE_TOOL_PORTAL_APPROVAL_AUDIENCE = 'tool-portal:approval:v1';
export const STANDALONE_TOOL_PORTAL_APPROVAL_META_KEY = 'agent-vm/tool-portal-approval-token';

const maximumApprovalTokenCharacters = 16_384;
const defaultMaximumConsumedApprovalTokens = 4_096;
const defaultMaximumTokenLifetimeMilliseconds = 5 * 60 * 1_000;
const defaultChallengeLifetimeMilliseconds = 5 * 60 * 1_000;

const StandaloneToolPortalApprovalFingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

const StandaloneToolPortalProtectedCallSchema = z
	.object({
		call: z
			.object({
				arguments: z.record(z.string(), z.unknown()),
				id: z.string().min(1),
				name: z.string().min(1),
				namespace: z.string().min(1),
			})
			.strict(),
		operationId: z.string().min(1),
	})
	.strict();

export const StandaloneToolPortalApprovalBatchIntentSchema = z
	.object({
		authenticatedEnvelope: StandaloneToolPortalAuthenticatedEnvelopeSchema,
		protectedCalls: z.array(StandaloneToolPortalProtectedCallSchema).min(1).max(50),
		semanticRevisions: z
			.object({
				activeRevision: z.string().min(1),
				bindingRevision: z.string().min(1),
				catalogRevision: z.string().min(1),
				profilePolicyRevision: z.string().min(1),
				providerRevision: z.string().min(1),
				schemaRevision: z.string().min(1),
			})
			.strict(),
		surfaceClass: z.enum(['http', 'mcp']),
	})
	.strict();

export type StandaloneToolPortalApprovalBatchIntent = z.infer<
	typeof StandaloneToolPortalApprovalBatchIntentSchema
>;

const StandaloneToolPortalApprovalPayloadSchema = z
	.object({
		audience: z.literal(STANDALONE_TOOL_PORTAL_APPROVAL_AUDIENCE),
		expiresAt: z.string().datetime(),
		fingerprint: StandaloneToolPortalApprovalFingerprintSchema,
		keyVersion: z.number().int().positive(),
		serviceGeneration: z.string().min(1),
		tokenId: z.string().uuid(),
		version: z.literal(1),
	})
	.strict();

type StandaloneToolPortalApprovalPayload = z.infer<
	typeof StandaloneToolPortalApprovalPayloadSchema
>;

export interface StandaloneToolPortalApprovalCredential {
	readonly agentId: string;
	readonly hmacKey: string;
	readonly keyVersion: number;
}

export interface StandaloneToolPortalApprovalReservation {
	readonly batchFingerprint: `sha256:${string}`;
	readonly expiresAt: string;
	readonly operationIds: readonly string[];
	readonly reservationId: string;
	readonly serviceGeneration: string;
	readonly tokenId: string;
}

export type StandaloneToolPortalApprovalAdmission =
	| {
			readonly challenge: {
				readonly challengeId: string;
				readonly createdAt: string;
				readonly expiresAt: string;
				readonly fingerprint: `sha256:${string}`;
			};
			readonly kind: 'approval-required';
	  }
	| {
			readonly kind: 'dispatch-reserved';
			readonly reservation: StandaloneToolPortalApprovalReservation;
	  }
	| {
			readonly kind: 'not-dispatched';
			readonly reason:
				| 'consumed-without-dispatch'
				| 'expired'
				| 'invalid-proof'
				| 'revoked'
				| 'saturated'
				| 'stale-fingerprint'
				| 'stale-generation';
	  }
	| { readonly kind: 'ambiguous'; readonly reason: 'dispatch-armed' };

export type StandaloneToolPortalApprovalArmResult =
	| {
			readonly authority: {
				readonly batchFingerprint: `sha256:${string}`;
				readonly kind: 'standalone-hmac-batch';
				readonly operationIds: readonly string[];
				readonly serviceGeneration: string;
				readonly tokenId: string;
			};
			readonly kind: 'dispatch-authorized';
	  }
	| { readonly kind: 'not-dispatched'; readonly reason: 'consumed-without-dispatch' }
	| { readonly kind: 'ambiguous'; readonly reason: 'dispatch-armed' };

export interface StandaloneToolPortalApprovalCoordinator {
	readonly activateCredentials: (
		credentials: readonly StandaloneToolPortalApprovalCredential[],
	) => void;
	readonly armDispatch: (
		reservation: StandaloneToolPortalApprovalReservation,
	) => StandaloneToolPortalApprovalArmResult;
	readonly proveNotDispatched: (reservation: StandaloneToolPortalApprovalReservation) => boolean;
	readonly reserveDispatch: (
		intent: StandaloneToolPortalApprovalBatchIntent,
		approvalToken?: string,
	) => StandaloneToolPortalApprovalAdmission;
}

interface CreateStandaloneToolPortalApprovalCoordinatorProps {
	readonly challengeLifetimeMs?: number;
	readonly credentials: readonly StandaloneToolPortalApprovalCredential[];
	readonly maximumConsumedTokens?: number;
	readonly maximumTokenLifetimeMs?: number;
	readonly now?: () => Date;
	readonly serviceGeneration: string;
}

interface CreateStandaloneToolPortalApprovalTokenProps {
	readonly expiresAt: string;
	readonly hmacKey: string;
	readonly intent: StandaloneToolPortalApprovalBatchIntent;
	readonly keyVersion: number;
	readonly override?: Readonly<Record<string, unknown>>;
	readonly tokenId: string;
}

type TokenConsumptionStatus = 'armed' | 'proven-not-dispatched' | 'reserved';

interface TokenConsumptionTombstone {
	readonly expiresAtTime: number;
	readonly reservation: StandaloneToolPortalApprovalReservation;
	status: TokenConsumptionStatus;
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('Approval token numbers must be finite.');
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
	if (typeof value === 'object') {
		return `{${Object.entries(value)
			.filter(([, fieldValue]) => fieldValue !== undefined)
			.toSorted(([leftName], [rightName]) => compareUtf8(leftName, rightName))
			.map(([fieldName, fieldValue]) => `${JSON.stringify(fieldName)}:${canonicalJson(fieldValue)}`)
			.join(',')}}`;
	}
	throw new TypeError('Approval token values must be JSON-compatible.');
}

export function deriveStandaloneToolPortalApprovalBatchFingerprint(
	intent: StandaloneToolPortalApprovalBatchIntent,
): `sha256:${string}` {
	const parsedIntent = StandaloneToolPortalApprovalBatchIntentSchema.parse(intent);
	return `sha256:${createHash('sha256')
		.update('standalone-tool-portal-protected-batch-v1', 'utf8')
		.update('\0')
		.update(canonicalJson(parsedIntent), 'utf8')
		.digest('hex')}`;
}

function signPayload(payloadJson: string, hmacKey: string): Buffer {
	return createHmac('sha256', hmacKey).update(payloadJson, 'utf8').digest();
}

/** Create a proof only inside a protected operator approval integration that owns the HMAC key. */
export function createStandaloneToolPortalApprovalToken(
	props: CreateStandaloneToolPortalApprovalTokenProps,
): string {
	const payload = {
		audience: STANDALONE_TOOL_PORTAL_APPROVAL_AUDIENCE,
		expiresAt: props.expiresAt,
		fingerprint: deriveStandaloneToolPortalApprovalBatchFingerprint(props.intent),
		keyVersion: props.keyVersion,
		serviceGeneration: props.intent.authenticatedEnvelope.serviceGeneration,
		tokenId: props.tokenId,
		version: 1,
		...props.override,
	};
	const payloadJson = canonicalJson(payload);
	return `${Buffer.from(payloadJson, 'utf8').toString('base64url')}.${signPayload(payloadJson, props.hmacKey).toString('base64url')}`;
}

function parseToken(token: string): {
	readonly payload: StandaloneToolPortalApprovalPayload;
	readonly payloadJson: string;
	readonly signature: Buffer;
} | null {
	if (token.length === 0 || token.length > maximumApprovalTokenCharacters) return null;
	const [payloadPart, signaturePart, extra] = token.split('.');
	if (payloadPart === undefined || signaturePart === undefined || extra !== undefined) return null;
	try {
		const payloadBytes = Buffer.from(payloadPart, 'base64url');
		const signature = Buffer.from(signaturePart, 'base64url');
		if (
			payloadBytes.toString('base64url') !== payloadPart ||
			signature.toString('base64url') !== signaturePart ||
			signature.length !== 32
		) {
			return null;
		}
		const payloadJson = payloadBytes.toString('utf8');
		const payload = StandaloneToolPortalApprovalPayloadSchema.safeParse(
			JSON.parse(payloadJson) as unknown,
		);
		return payload.success ? { payload: payload.data, payloadJson, signature } : null;
	} catch {
		return null;
	}
}

function signaturesMatch(expected: Buffer, candidate: Buffer): boolean {
	return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

function compileCredentials(credentials: readonly StandaloneToolPortalApprovalCredential[]): {
	readonly byAgentAndVersion: ReadonlyMap<string, StandaloneToolPortalApprovalCredential>;
	readonly versionByAgent: ReadonlyMap<string, number>;
} {
	const byAgentAndVersion = new Map<string, StandaloneToolPortalApprovalCredential>();
	const versionByAgent = new Map<string, number>();
	for (const credential of credentials) {
		if (
			credential.agentId.length === 0 ||
			credential.hmacKey.length === 0 ||
			!Number.isInteger(credential.keyVersion) ||
			credential.keyVersion < 1
		) {
			throw new TypeError('Standalone Tool Portal approval credentials are invalid.');
		}
		if (versionByAgent.has(credential.agentId)) {
			throw new TypeError(
				'Standalone Tool Portal approval credentials must identify unique agents.',
			);
		}
		byAgentAndVersion.set(`${credential.agentId}\0${String(credential.keyVersion)}`, credential);
		versionByAgent.set(credential.agentId, credential.keyVersion);
	}
	return { byAgentAndVersion, versionByAgent };
}

function reservationsEqual(
	left: StandaloneToolPortalApprovalReservation,
	right: StandaloneToolPortalApprovalReservation,
): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

export function createStandaloneToolPortalApprovalCoordinator(
	props: CreateStandaloneToolPortalApprovalCoordinatorProps,
): StandaloneToolPortalApprovalCoordinator {
	const now = props.now ?? (() => new Date());
	const challengeLifetimeMs = props.challengeLifetimeMs ?? defaultChallengeLifetimeMilliseconds;
	const maximumConsumedTokens = props.maximumConsumedTokens ?? defaultMaximumConsumedApprovalTokens;
	const maximumTokenLifetimeMs =
		props.maximumTokenLifetimeMs ?? defaultMaximumTokenLifetimeMilliseconds;
	if (props.serviceGeneration.length === 0) {
		throw new TypeError('Standalone Tool Portal service generation must be non-empty.');
	}
	for (const [name, value] of [
		['challenge lifetime', challengeLifetimeMs],
		['consumed-token bound', maximumConsumedTokens],
		['maximum token lifetime', maximumTokenLifetimeMs],
	] as const) {
		if (!Number.isInteger(value) || value <= 0) {
			throw new TypeError(`Standalone Tool Portal ${name} must be positive.`);
		}
	}
	let compiledCredentials = compileCredentials(props.credentials);
	const highestCredentialVersionByAgent = new Map(compiledCredentials.versionByAgent);
	const tombstonesByTokenId = new Map<string, TokenConsumptionTombstone>();

	function pruneTombstones(currentTime: number): void {
		for (const [tokenId, tombstone] of tombstonesByTokenId) {
			if (tombstone.expiresAtTime <= currentTime) tombstonesByTokenId.delete(tokenId);
		}
	}

	function existingConsumption(tokenId: string): StandaloneToolPortalApprovalAdmission | null {
		const tombstone = tombstonesByTokenId.get(tokenId);
		if (tombstone === undefined) return null;
		return tombstone.status === 'armed'
			? { kind: 'ambiguous', reason: 'dispatch-armed' }
			: { kind: 'not-dispatched', reason: 'consumed-without-dispatch' };
	}

	return {
		activateCredentials: (credentials) => {
			const nextCredentials = compileCredentials(credentials);
			for (const [agentId, nextVersion] of nextCredentials.versionByAgent) {
				const highestVersion = highestCredentialVersionByAgent.get(agentId);
				if (highestVersion !== undefined && nextVersion <= highestVersion) {
					throw new TypeError(
						`Standalone Tool Portal approval credentialVersion must increase for agent "${agentId}".`,
					);
				}
			}
			for (const [agentId, nextVersion] of nextCredentials.versionByAgent) {
				highestCredentialVersionByAgent.set(agentId, nextVersion);
			}
			compiledCredentials = nextCredentials;
		},
		armDispatch: (candidateReservation) => {
			const tombstone = tombstonesByTokenId.get(candidateReservation.tokenId);
			if (
				tombstone === undefined ||
				!reservationsEqual(tombstone.reservation, candidateReservation)
			) {
				return { kind: 'not-dispatched', reason: 'consumed-without-dispatch' };
			}
			if (tombstone.status === 'armed') {
				return { kind: 'ambiguous', reason: 'dispatch-armed' };
			}
			if (tombstone.status === 'proven-not-dispatched') {
				return { kind: 'not-dispatched', reason: 'consumed-without-dispatch' };
			}
			tombstone.status = 'armed';
			return {
				authority: {
					batchFingerprint: candidateReservation.batchFingerprint,
					kind: 'standalone-hmac-batch',
					operationIds: candidateReservation.operationIds,
					serviceGeneration: candidateReservation.serviceGeneration,
					tokenId: candidateReservation.tokenId,
				},
				kind: 'dispatch-authorized',
			};
		},
		proveNotDispatched: (candidateReservation) => {
			const tombstone = tombstonesByTokenId.get(candidateReservation.tokenId);
			if (
				tombstone === undefined ||
				tombstone.status !== 'reserved' ||
				!reservationsEqual(tombstone.reservation, candidateReservation)
			) {
				return false;
			}
			tombstone.status = 'proven-not-dispatched';
			return true;
		},
		reserveDispatch: (candidateIntent, approvalToken) => {
			const intent = StandaloneToolPortalApprovalBatchIntentSchema.parse(candidateIntent);
			const fingerprint = deriveStandaloneToolPortalApprovalBatchFingerprint(intent);
			const currentTime = now().getTime();
			pruneTombstones(currentTime);
			if (intent.authenticatedEnvelope.serviceGeneration !== props.serviceGeneration) {
				return { kind: 'not-dispatched', reason: 'stale-generation' };
			}
			if (approvalToken === undefined) {
				return {
					challenge: {
						challengeId: fingerprint.slice('sha256:'.length, 'sha256:'.length + 32),
						createdAt: new Date(currentTime).toISOString(),
						expiresAt: new Date(currentTime + challengeLifetimeMs).toISOString(),
						fingerprint,
					},
					kind: 'approval-required',
				};
			}
			const parsedToken = parseToken(approvalToken);
			if (parsedToken === null) return { kind: 'not-dispatched', reason: 'invalid-proof' };
			if (
				parsedToken.payload.serviceGeneration !== props.serviceGeneration ||
				parsedToken.payload.serviceGeneration !== intent.authenticatedEnvelope.serviceGeneration
			) {
				return { kind: 'not-dispatched', reason: 'stale-generation' };
			}
			const existing = existingConsumption(parsedToken.payload.tokenId);
			if (existing !== null) return existing;
			const principal = intent.authenticatedEnvelope.principal;
			if (parsedToken.payload.keyVersion !== principal.credentialVersion) {
				return { kind: 'not-dispatched', reason: 'stale-fingerprint' };
			}
			const credential = compiledCredentials.byAgentAndVersion.get(
				`${principal.agentId}\0${String(parsedToken.payload.keyVersion)}`,
			);
			if (
				credential === undefined ||
				!signaturesMatch(
					signPayload(parsedToken.payloadJson, credential.hmacKey),
					parsedToken.signature,
				)
			) {
				return { kind: 'not-dispatched', reason: 'revoked' };
			}
			const expiresAtTime = Date.parse(parsedToken.payload.expiresAt);
			if (expiresAtTime <= currentTime) return { kind: 'not-dispatched', reason: 'expired' };
			if (expiresAtTime - currentTime > maximumTokenLifetimeMs) {
				return { kind: 'not-dispatched', reason: 'invalid-proof' };
			}
			if (parsedToken.payload.fingerprint !== fingerprint) {
				return { kind: 'not-dispatched', reason: 'stale-fingerprint' };
			}
			if (tombstonesByTokenId.size >= maximumConsumedTokens) {
				return { kind: 'not-dispatched', reason: 'saturated' };
			}
			const reservation: StandaloneToolPortalApprovalReservation = Object.freeze({
				batchFingerprint: fingerprint,
				expiresAt: parsedToken.payload.expiresAt,
				operationIds: Object.freeze(intent.protectedCalls.map(({ operationId }) => operationId)),
				reservationId: createHash('sha256')
					.update(`standalone-reservation:${parsedToken.payload.tokenId}`, 'utf8')
					.digest('hex'),
				serviceGeneration: props.serviceGeneration,
				tokenId: parsedToken.payload.tokenId,
			});
			tombstonesByTokenId.set(parsedToken.payload.tokenId, {
				expiresAtTime,
				reservation,
				status: 'reserved',
			});
			return { kind: 'dispatch-reserved', reservation };
		},
	};
}
