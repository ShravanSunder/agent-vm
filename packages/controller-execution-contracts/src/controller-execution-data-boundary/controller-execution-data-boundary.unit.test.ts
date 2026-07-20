import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
	ControllerExecutionDataCreditSchema,
	ControllerExecutionDataFrameSchema,
	ControllerExecutionDataHandshakeSchema,
	ControllerExecutionDataPayloadMaxBytes,
	ControllerExecutionWebSocketPath,
	type ControllerExecutionDataFrame,
	type ControllerExecutionDataCredit,
	type ControllerExecutionDataHandshake,
} from './index.js';

const validBinding = {
	audience: 'controller-execution-data',
	channelId: 'channel-a',
	controllerEpoch: 'controller-epoch-a',
	executionFingerprint: 'sha256:execution-a',
	gatewayEpoch: 'gateway-epoch-a',
	operationId: 'operation-a',
	runtimeEpoch: 'runtime-epoch-a',
	stablePrincipal: 'a'.repeat(64),
} as const;

const validHandshake = {
	...validBinding,
	kind: 'handshake',
} satisfies ControllerExecutionDataHandshake;

const validDataFrame = {
	...validBinding,
	creditBytes: 1_024,
	kind: 'data',
	payloadBase64: 'AAECAw==',
	sequence: 0,
} satisfies ControllerExecutionDataFrame;

const expectedPayloadMaxBytes = 1024 * 1024;

describe('controller execution WebSocket route contract', () => {
	it('publishes the one exact private controller-execution path', () => {
		expect(ControllerExecutionWebSocketPath).toBe('/agent-vm/controller-execution');
	});
});

describe('controller execution data handshake boundary', () => {
	it('requires the canonical stable principal and rejects the retired principalId field', () => {
		const handshakeWithStablePrincipal = {
			...validBinding,
			kind: 'handshake',
		};

		expect(
			ControllerExecutionDataHandshakeSchema.safeParse(handshakeWithStablePrincipal).success,
		).toBe(true);
		expect(
			ControllerExecutionDataHandshakeSchema.safeParse({
				...handshakeWithStablePrincipal,
				stablePrincipal: 'not-a-stable-principal',
			}).success,
		).toBe(false);
		expect(
			ControllerExecutionDataHandshakeSchema.safeParse({
				...handshakeWithStablePrincipal,
				principalId: 'retired-principal',
			}).success,
		).toBe(false);
	});

	it('accepts only the private execution-data audience with the complete binding', () => {
		const parsedHandshake = ControllerExecutionDataHandshakeSchema.parse(validHandshake);

		expect(parsedHandshake).toEqual(validHandshake);
	});

	it('rejects the wrong audience and every missing binding component', () => {
		const wrongAudienceResult = ControllerExecutionDataHandshakeSchema.safeParse({
			...validHandshake,
			audience: 'gateway-control',
		});
		const { audience: _omittedAudience, ...missingAudienceHandshake } = validHandshake;
		const bindingFields = [
			'channelId',
			'controllerEpoch',
			'executionFingerprint',
			'gatewayEpoch',
			'operationId',
			'runtimeEpoch',
			'stablePrincipal',
		] as const;

		expect(wrongAudienceResult.success).toBe(false);
		expect(ControllerExecutionDataHandshakeSchema.safeParse(missingAudienceHandshake).success).toBe(
			false,
		);
		for (const bindingField of bindingFields) {
			const { [bindingField]: _omittedBinding, ...missingBindingHandshake } = validHandshake;
			expect(
				ControllerExecutionDataHandshakeSchema.safeParse(missingBindingHandshake).success,
			).toBe(false);
		}
	});

	it('rejects empty binding identifiers and public extra fields', () => {
		const bindingFields = [
			'channelId',
			'controllerEpoch',
			'executionFingerprint',
			'gatewayEpoch',
			'operationId',
			'runtimeEpoch',
			'stablePrincipal',
		] as const;

		for (const bindingField of bindingFields) {
			expect(
				ControllerExecutionDataHandshakeSchema.safeParse({
					...validHandshake,
					[bindingField]: '',
				}).success,
			).toBe(false);
		}
		expect(
			ControllerExecutionDataHandshakeSchema.safeParse({
				...validHandshake,
				controllerUrl: 'ws://attacker.invalid/execution',
			}).success,
		).toBe(false);
		expect(
			ControllerExecutionDataHandshakeSchema.safeParse({
				...validHandshake,
				creditBytes: 1_024,
				sequence: 0,
			}).success,
		).toBe(false);
	});
});

describe('controller execution data frame boundary', () => {
	it('requires complete binding on strict credit returns', () => {
		const credit = {
			...validBinding,
			availableCreditBytes: 1_024,
			kind: 'credit',
			nextSequence: 1,
			queuedBytes: 0,
		} satisfies ControllerExecutionDataCredit;

		expect(ControllerExecutionDataCreditSchema.parse(credit)).toEqual(credit);
		expect(
			ControllerExecutionDataCreditSchema.safeParse({
				...credit,
				operationId: 'attacker-operation',
				principalOverride: 'attacker-principal',
			}).success,
		).toBe(false);
	});

	it.each([
		['data', validDataFrame],
		[
			'eof',
			{
				...validBinding,
				creditBytes: 1_021,
				kind: 'eof',
				sequence: 1,
			} satisfies ControllerExecutionDataFrame,
		],
		[
			'cancel',
			{
				...validBinding,
				creditBytes: 1_021,
				kind: 'cancel',
				sequence: 1,
			} satisfies ControllerExecutionDataFrame,
		],
	] as const)('accepts a strict %s frame', (_frameKind, frame) => {
		const parsedFrame = ControllerExecutionDataFrameSchema.parse(frame);

		expect(parsedFrame).toEqual(frame);
	});

	it('rejects the wrong or missing execution-data audience', () => {
		const { audience: _omittedAudience, ...missingAudienceFrame } = validDataFrame;

		expect(
			ControllerExecutionDataFrameSchema.safeParse({
				...validDataFrame,
				audience: 'gateway-control',
			}).success,
		).toBe(false);
		expect(ControllerExecutionDataFrameSchema.safeParse(missingAudienceFrame).success).toBe(false);
	});

	it('requires every non-audience binding identifier to be present and non-empty', () => {
		const bindingFields = [
			'channelId',
			'controllerEpoch',
			'executionFingerprint',
			'gatewayEpoch',
			'operationId',
			'runtimeEpoch',
			'stablePrincipal',
		] as const;

		for (const bindingField of bindingFields) {
			const { [bindingField]: _omittedBinding, ...missingBindingFrame } = validDataFrame;
			expect(ControllerExecutionDataFrameSchema.safeParse(missingBindingFrame).success).toBe(false);
			expect(
				ControllerExecutionDataFrameSchema.safeParse({
					...validDataFrame,
					[bindingField]: '',
				}).success,
			).toBe(false);
		}
	});

	it.each([
		['negative sequence', { sequence: -1 }],
		['fractional sequence', { sequence: 0.5 }],
		['unsafe sequence', { sequence: Number.MAX_SAFE_INTEGER + 1 }],
		['negative credit', { creditBytes: -1 }],
		['fractional credit', { creditBytes: 0.5 }],
		['unsafe credit', { creditBytes: Number.MAX_SAFE_INTEGER + 1 }],
	] as const)('rejects %s', (_label, invalidFields) => {
		const parseResult = ControllerExecutionDataFrameSchema.safeParse({
			...validDataFrame,
			...invalidFields,
		});

		expect(parseResult.success).toBe(false);
	});

	it('accepts canonical bounded base64 and rejects non-canonical or oversized bytes', () => {
		const maximumPayload = Buffer.alloc(expectedPayloadMaxBytes).toString('base64');
		const oversizedPayload = Buffer.alloc(expectedPayloadMaxBytes + 1).toString('base64');

		expect(ControllerExecutionDataPayloadMaxBytes).toBe(expectedPayloadMaxBytes);
		expect(
			ControllerExecutionDataFrameSchema.safeParse({
				...validDataFrame,
				payloadBase64: maximumPayload,
			}).success,
		).toBe(true);
		expect(
			ControllerExecutionDataFrameSchema.safeParse({
				...validDataFrame,
				payloadBase64: oversizedPayload,
			}).success,
		).toBe(false);
		for (const nonCanonicalPayload of ['AQ', 'AQ===', 'AQ==\n', 'A_Q=']) {
			expect(
				ControllerExecutionDataFrameSchema.safeParse({
					...validDataFrame,
					payloadBase64: nonCanonicalPayload,
				}).success,
			).toBe(false);
		}
	});

	it('rejects unknown kinds, public authority, and duplicate semantic payload fields', () => {
		expect(
			ControllerExecutionDataFrameSchema.safeParse({
				...validDataFrame,
				kind: 'stdout',
			}).success,
		).toBe(false);
		expect(
			ControllerExecutionDataFrameSchema.safeParse({
				...validDataFrame,
				principalOverride: 'attacker-principal',
			}).success,
		).toBe(false);
		for (const duplicatePayloadFields of [
			{ payload: [0, 1, 2, 3] },
			{ payloadBytes: new Uint8Array([0, 1, 2, 3]) },
			{ contentBase64: validDataFrame.payloadBase64 },
			{ cancelled: false },
			{ eof: false },
		]) {
			expect(
				ControllerExecutionDataFrameSchema.safeParse({
					...validDataFrame,
					...duplicatePayloadFields,
				}).success,
			).toBe(false);
		}
	});

	it.each(['eof', 'cancel'] as const)(
		'rejects payload bytes and duplicate terminal semantics on %s',
		(frameKind) => {
			const terminalFrame = {
				...validBinding,
				creditBytes: 1_021,
				kind: frameKind,
				sequence: 1,
			};

			expect(
				ControllerExecutionDataFrameSchema.safeParse({
					...terminalFrame,
					payloadBase64: validDataFrame.payloadBase64,
				}).success,
			).toBe(false);
			expect(
				ControllerExecutionDataFrameSchema.safeParse({
					...terminalFrame,
					cancelled: frameKind === 'cancel',
					eof: frameKind === 'eof',
				}).success,
			).toBe(false);
		},
	);
});
