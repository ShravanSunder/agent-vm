import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import {
	CONTROL_PROTOCOL_VERSION,
	CONTROL_QUEUE_LIMITS,
	CONTROL_SESSION_TIMING_MS,
	ControlEnvelopeSchema,
	ControlHandshakeCredentialSchema,
	ControlHandshakeProofSchema,
	ControlMessageKindSchema,
	ControlMessageReceiptSchema,
	ControlReadyRequestProofSchema,
	ControlSessionCloseReasonSchema,
	assertControlMessageReceiptAccepted,
	assertControlEnvelopeMatchesDomainMessage,
	assertDerivedControlDeliveryPolicy,
	buildControlMessageExceptionRejectionReceipt,
	buildControlMessageRejectionReceipt,
	buildControlHandshakeSignaturePayload,
	buildControlReadyRequestSignaturePayload,
	buildControlProtocolJsonSchemas,
	coalesceLatestWinsByKey,
	controlMessageKindDisposition,
	evaluateControlSequenceContinuity,
	orderControlMessagesByEnvelopeSequence,
	shouldReplayControlEnvelope,
	type ControlDeliveryPolicy,
	type ControlEnvelope,
	type ControlReadyRequestProof,
} from './index.js';

async function readJsonSchemaArtifact(relativePath: string): Promise<unknown> {
	return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8')) as unknown;
}

const validEnvelope = {
	bootId: 'boot-a',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'epoch-a',
	createdAtMs: 1,
	deliveryPolicy: 'critical_idempotent',
	domain: 'gateway_control',
	kind: 'command',
	messageId: '22222222-2222-4222-8222-222222222222',
	operation: 'lease_create',
	peerId: 'gateway-zone-a',
	protocolVersion: CONTROL_PROTOCOL_VERSION,
	sequence: 1,
	sessionId: '33333333-3333-4333-8333-333333333333',
	zoneId: 'zone-a',
} satisfies ControlEnvelope;

describe('control protocol contracts', () => {
	it('strictly validates the shared envelope and rejects malformed fields', () => {
		expect(ControlEnvelopeSchema.parse(validEnvelope)).toEqual(validEnvelope);

		for (const invalidEnvelope of [
			{ ...validEnvelope, extra: true },
			{ ...validEnvelope, protocolVersion: 2 },
			{ ...validEnvelope, connectionId: 'not-a-uuid' },
			{ ...validEnvelope, sequence: -1 },
			{ ...validEnvelope, deliveryPolicy: 'bulk' },
		]) {
			expect(ControlEnvelopeSchema.safeParse(invalidEnvelope).success).toBe(false);
		}
	});

	it('exports JSON Schemas matching the reviewed static artifact', async () => {
		await expect(
			readJsonSchemaArtifact('./control-protocol-json-schema.snapshot.json'),
		).resolves.toEqual(buildControlProtocolJsonSchemas());
	});

	it('distinguishes accepted and rejected transport receipts', () => {
		expect(ControlMessageReceiptSchema.parse({ received: true })).toEqual({ received: true });
		const rejectedReceipt = buildControlMessageRejectionReceipt({
			errorClass: 'schema_validation_failed',
			safeMessage: 'control message was rejected',
		});

		expect(rejectedReceipt).toEqual({
			errorClass: 'schema_validation_failed',
			received: false,
			safeMessage: 'control message was rejected',
		});
		expect(() => assertControlMessageReceiptAccepted(rejectedReceipt)).toThrow(
			/control message was rejected/u,
		);
	});

	it('classifies schema parse failures separately from processing failures', () => {
		let schemaError: unknown;
		try {
			z.object({ messageId: z.string().uuid() }).strict().parse({ messageId: 'not-a-uuid' });
		} catch (error: unknown) {
			schemaError = error;
		}
		if (schemaError === undefined) {
			throw new Error('expected schema fixture to throw');
		}

		expect(
			buildControlMessageExceptionRejectionReceipt({
				error: schemaError,
				processingErrorClass: 'control_message_processing_failed',
				safeMessage: 'control message was rejected',
			}),
		).toEqual({
			errorClass: 'schema_validation_failed',
			received: false,
			safeMessage: 'control message was rejected',
		});

		expect(
			buildControlMessageExceptionRejectionReceipt({
				error: new Error('dispatcher unavailable'),
				processingErrorClass: 'control_message_processing_failed',
				safeMessage: 'control message was rejected',
			}),
		).toEqual({
			errorClass: 'control_message_processing_failed',
			received: false,
			safeMessage: 'control message was rejected',
		});
	});

	it('rejects cross-layer kind and operation mismatches', () => {
		expect(() =>
			assertControlEnvelopeMatchesDomainMessage(validEnvelope, {
				kind: 'command',
				operation: 'lease_create',
			}),
		).not.toThrow();

		expect(() =>
			assertControlEnvelopeMatchesDomainMessage(validEnvelope, {
				kind: 'event',
				operation: 'lease_create',
			}),
		).toThrow(/kind mismatch/u);

		expect(() =>
			assertControlEnvelopeMatchesDomainMessage(validEnvelope, {
				kind: 'command',
				operation: 'lease_release',
			}),
		).toThrow(/operation mismatch/u);
	});

	it('keeps identity fields only in the shared envelope', () => {
		const domainPayloadWithIdentityTwin = {
			bootId: 'boot-b',
			kind: 'command',
			operation: 'lease_create',
		};

		expect(
			z
				.object({
					kind: ControlMessageKindSchema,
					operation: z.string(),
				})
				.strict()
				.safeParse(domainPayloadWithIdentityTwin).success,
		).toBe(false);
	});

	it('maps every message kind to an owning disposition', () => {
		const mappedKinds = Object.keys(controlMessageKindDisposition).toSorted();

		expect(mappedKinds).toEqual([...ControlMessageKindSchema.options].toSorted());
		expect(ControlMessageKindSchema.options).not.toContain('command_ack');
		expect(ControlMessageKindSchema.options).not.toContain('observation');
		expect(ControlMessageKindSchema.options).not.toContain('resync_request');
		expect(ControlMessageKindSchema.options).not.toContain('resync_response');
		expect(ControlMessageKindSchema.options).not.toContain('snapshot');
	});

	it('keeps close reasons aligned with the accepted protocol vocabulary', () => {
		expect([...ControlSessionCloseReasonSchema.options].toSorted()).toEqual(
			[
				'normal_shutdown',
				'controller_restart',
				'peer_restart',
				'auth_failed',
				'protocol_version_mismatch',
				'domain_mismatch',
				'generation_mismatch',
				'controller_epoch_mismatch',
				'duplicate_session',
				'stale_session',
				'sequence_gap',
				'ack_timeout',
				'command_timeout',
				'resync_timeout',
				'queue_overflow',
				'message_too_large',
				'schema_validation_failed',
				'forbidden_bulk_message',
				'transport_error',
			].toSorted(),
		);
		expect(ControlSessionCloseReasonSchema.options).not.toContain('backpressure_overflow');
	});

	it('derives delivery policy instead of trusting the envelope claim', () => {
		const policyByOperation = {
			lease_create: 'single_use_critical',
		} satisfies Record<string, ControlDeliveryPolicy>;

		expect(() =>
			assertDerivedControlDeliveryPolicy({
				envelope: { ...validEnvelope, deliveryPolicy: 'single_use_critical' },
				policyByOperation,
			}),
		).not.toThrow();

		expect(() =>
			assertDerivedControlDeliveryPolicy({
				envelope: { ...validEnvelope, deliveryPolicy: 'latest_wins' },
				policyByOperation,
			}),
		).toThrow(/delivery policy mismatch/u);
	});

	it('coalesces latest-wins state by key and drops droppable messages from replay', () => {
		const snapshots = [
			{ key: 'lease-a', value: 1 },
			{ key: 'lease-b', value: 1 },
			{ key: 'lease-a', value: 2 },
		];

		expect(coalesceLatestWinsByKey(snapshots, (snapshot) => snapshot.key)).toEqual([
			{ key: 'lease-a', value: 2 },
			{ key: 'lease-b', value: 1 },
		]);

		expect(
			shouldReplayControlEnvelope({
				...validEnvelope,
				deliveryPolicy: 'droppable',
			}),
		).toBe(false);
		expect(
			shouldReplayControlEnvelope({
				...validEnvelope,
				deliveryPolicy: 'critical_idempotent',
			}),
		).toBe(true);
	});

	it('orders queued control messages by envelope sequence before lossy flush', () => {
		const sequencedMessages = [
			{ envelope: { sequence: 7 }, payload: 'newer-a' },
			{ envelope: { sequence: 6 }, payload: 'middle-b' },
			{ envelope: { sequence: 8 }, payload: 'newer-c' },
		] as const;

		expect(orderControlMessagesByEnvelopeSequence(sequencedMessages)).toEqual([
			{ envelope: { sequence: 6 }, payload: 'middle-b' },
			{ envelope: { sequence: 7 }, payload: 'newer-a' },
			{ envelope: { sequence: 8 }, payload: 'newer-c' },
		]);
	});

	it('fails closed on critical sequence gaps without advancing lossy delivery gaps', () => {
		expect(
			evaluateControlSequenceContinuity({
				envelope: validEnvelope,
				lastSeenSequence: 0,
			}),
		).toEqual({
			action: 'accept',
			nextLastSeenSequence: 1,
		});

		expect(
			evaluateControlSequenceContinuity({
				envelope: { ...validEnvelope, sequence: 0 },
				lastSeenSequence: 1,
			}),
		).toMatchObject({
			action: 'drop',
			nextLastSeenSequence: 1,
		});

		expect(
			evaluateControlSequenceContinuity({
				envelope: { ...validEnvelope, sequence: 3 },
				lastSeenSequence: 1,
			}),
		).toMatchObject({
			action: 'stale',
			closeReason: 'sequence_gap',
			nextLastSeenSequence: 1,
		});

		expect(
			evaluateControlSequenceContinuity({
				envelope: {
					...validEnvelope,
					commandId: undefined,
					deliveryPolicy: 'latest_wins',
					idempotencyKey: undefined,
					kind: 'event',
					operation: 'runtime_status',
					sequence: 3,
				},
				lastSeenSequence: 1,
			}),
		).toEqual({
			action: 'accept',
			nextLastSeenSequence: 1,
		});

		expect(
			evaluateControlSequenceContinuity({
				envelope: {
					...validEnvelope,
					commandId: undefined,
					deliveryPolicy: 'droppable',
					idempotencyKey: undefined,
					kind: 'event',
					operation: undefined,
					sequence: 5,
				},
				lastSeenSequence: 1,
			}),
		).toEqual({
			action: 'accept',
			nextLastSeenSequence: 1,
		});
	});

	it('keeps timing constants ordered against current lease defaults', () => {
		expect(CONTROL_SESSION_TIMING_MS.activeUseHeartbeatCadence).toBeLessThan(
			CONTROL_SESSION_TIMING_MS.activeUseStaleTtl,
		);
		expect(
			CONTROL_SESSION_TIMING_MS.connectTimeout + CONTROL_SESSION_TIMING_MS.commandAckTimeout,
		).toBeLessThan(10_000);
		expect(
			CONTROL_SESSION_TIMING_MS.engineIoPingInterval +
				CONTROL_SESSION_TIMING_MS.engineIoPingTimeout,
		).toBeLessThan(CONTROL_SESSION_TIMING_MS.activeUseStaleTtl);
		expect(CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace).toBeGreaterThan(
			CONTROL_SESSION_TIMING_MS.activeUseStaleTtl,
		);
		expect(CONTROL_SESSION_TIMING_MS.manualReconnectInitialDelay).toBeGreaterThan(0);
		expect(CONTROL_SESSION_TIMING_MS.manualReconnectInitialDelay).toBeLessThan(
			CONTROL_SESSION_TIMING_MS.manualReconnectMaxDelay,
		);
		expect(CONTROL_SESSION_TIMING_MS.manualReconnectJitterRatio).toBeGreaterThan(0);
		expect(CONTROL_SESSION_TIMING_MS.manualReconnectJitterRatio).toBeLessThan(1);
		expect(CONTROL_SESSION_TIMING_MS.priorityAckFailureThreshold).toBeGreaterThan(1);
		expect(CONTROL_QUEUE_LIMITS.maxHttpBufferBytes).toBe(65_536);
	});

	it('rejects query-string credential material and invalid handshake windows', () => {
		const validProof = {
			audience: 'gateway_control',
			bootId: 'boot-a',
			controllerEpoch: 'epoch-a',
			credentialId: 'credential-a',
			expiresAtMs: 2,
			generationId: 'generation-a',
			issuedAtMs: 1,
			nonce: 'nonce-with-enough-length',
			peerId: 'gateway-zone-a',
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			signature: 'signature-a',
			zoneId: 'zone-a',
		};

		expect(ControlHandshakeProofSchema.parse(validProof)).toEqual(validProof);
		const { signature: _signature, ...credentialInput } = validProof;
		const credential = ControlHandshakeCredentialSchema.parse(credentialInput);
		expect(buildControlHandshakeSignaturePayload(credential)).toBe(
			'{"audience":"gateway_control","bootId":"boot-a","controllerEpoch":"epoch-a","credentialId":"credential-a","expiresAtMs":2,"generationId":"generation-a","issuedAtMs":1,"nonce":"nonce-with-enough-length","peerId":"gateway-zone-a","protocolVersion":1,"zoneId":"zone-a"}',
		);
		expect(
			ControlHandshakeProofSchema.safeParse({
				...validProof,
				queryToken: 'forbidden',
			}).success,
		).toBe(false);
		expect(
			ControlHandshakeProofSchema.safeParse({
				...validProof,
				expiresAtMs: 1,
			}).success,
		).toBe(false);
	});

	it('signs one-use ready request proofs before nonce issuance', () => {
		const readyProof = {
			audience: 'gateway_control',
			bootId: 'boot-a',
			controllerEpoch: 'epoch-a',
			generationId: 'generation-a',
			issuedAtMs: 1,
			peerId: 'gateway-zone-a',
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			requestId: '44444444-4444-4444-8444-444444444444',
			signature: 'signature-a',
			zoneId: 'zone-a',
		} satisfies ControlReadyRequestProof;

		expect(ControlReadyRequestProofSchema.parse(readyProof)).toEqual(readyProof);
		const { signature: _signature, ...credentialInput } = readyProof;
		expect(buildControlReadyRequestSignaturePayload(credentialInput)).toBe(
			'{"audience":"gateway_control","bootId":"boot-a","controllerEpoch":"epoch-a","generationId":"generation-a","issuedAtMs":1,"peerId":"gateway-zone-a","protocolVersion":1,"requestId":"44444444-4444-4444-8444-444444444444","zoneId":"zone-a"}',
		);
		expect(
			ControlReadyRequestProofSchema.safeParse({
				...readyProof,
				requestId: 'not-a-uuid',
			}).success,
		).toBe(false);
	});

	it('rejects forbidden bulk envelopes at the contract boundary', () => {
		expect(
			shouldReplayControlEnvelope({
				...validEnvelope,
				deliveryPolicy: 'forbidden_bulk',
			}),
		).toBe(false);
	});
});
