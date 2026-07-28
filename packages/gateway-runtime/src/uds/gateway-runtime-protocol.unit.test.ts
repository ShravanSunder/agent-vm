import {
	DEFAULT_GATEWAY_RUNTIME_FRAME_LIMITS,
	GatewayRuntimeFrameDecoder,
	GatewayRuntimeProtocolError,
	encodeGatewayRuntimeFrame,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import { describe, expect, it } from 'vitest';

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const PROTOCOL_ERROR_CODES = {
	bufferLimitExceeded: 'BUFFER_LIMIT_EXCEEDED',
	contentLengthOverflow: 'CONTENT_LENGTH_OVERFLOW',
	contentTooLarge: 'CONTENT_TOO_LARGE',
	duplicateContentLength: 'DUPLICATE_CONTENT_LENGTH',
	frameLimitExceeded: 'FRAME_LIMIT_EXCEEDED',
	headerTooLarge: 'HEADER_TOO_LARGE',
	incompleteFrameBody: 'INCOMPLETE_FRAME_BODY',
	incompleteFrameHeader: 'INCOMPLETE_FRAME_HEADER',
	invalidJson: 'INVALID_JSON',
	invalidJsonRpcEnvelope: 'INVALID_JSON_RPC_ENVELOPE',
	invalidUtf8: 'INVALID_UTF8',
	jsonRpcBatchUnsupported: 'JSON_RPC_BATCH_UNSUPPORTED',
	malformedHeader: 'MALFORMED_HEADER',
	missingHeaderDelimiter: 'MISSING_HEADER_DELIMITER',
	negativeContentLength: 'NEGATIVE_CONTENT_LENGTH',
	nonDecimalContentLength: 'NON_DECIMAL_CONTENT_LENGTH',
	unknownHeader: 'UNKNOWN_HEADER',
	unknownJsonRpcField: 'UNKNOWN_JSON_RPC_FIELD',
	unsafeContentLength: 'UNSAFE_CONTENT_LENGTH',
	unsupportedJsonRpcVersion: 'UNSUPPORTED_JSON_RPC_VERSION',
} as const satisfies Readonly<Record<string, string>>;

const strictRequest = {
	id: 'request-猫',
	jsonrpc: '2.0',
	method: 'portal.echo',
	params: {
		text: 'Zażółć 🧪',
	},
} as const;

const strictErrorObject = { code: -32_001, message: 'Portal request failed.' } as const;

const strictErrorResponse = {
	error: { ...strictErrorObject, data: { retryable: false } },
	id: 'request-error',
	jsonrpc: '2.0',
} as const;

function concatenateBytes(chunks: readonly Uint8Array[]): Uint8Array {
	const totalByteLength = chunks.reduce(
		(accumulatedByteLength, chunk) => accumulatedByteLength + chunk.byteLength,
		0,
	);
	const concatenatedBytes = new Uint8Array(totalByteLength);
	let writeOffset = 0;

	for (const chunk of chunks) {
		concatenatedBytes.set(chunk, writeOffset);
		writeOffset += chunk.byteLength;
	}

	return concatenatedBytes;
}

function encodeBytes(value: string): Uint8Array {
	return textEncoder.encode(value);
}

function frameBodyBytes(bodyBytes: Uint8Array): Uint8Array {
	return concatenateBytes([
		encodeBytes(`Content-Length: ${bodyBytes.byteLength}\r\n\r\n`),
		bodyBytes,
	]);
}

function frameBodyText(bodyText: string): Uint8Array {
	return frameBodyBytes(encodeBytes(bodyText));
}

function frameJsonValue(value: unknown): Uint8Array {
	const serializedValue = JSON.stringify(value);
	if (serializedValue === undefined) {
		throw new Error('test fixture must be JSON serializable');
	}
	return frameBodyText(serializedValue);
}

function captureProtocolError(action: () => unknown): GatewayRuntimeProtocolError {
	try {
		action();
	} catch (error: unknown) {
		expect(error).toBeInstanceOf(GatewayRuntimeProtocolError);
		if (error instanceof GatewayRuntimeProtocolError) {
			return error;
		}
		throw error;
	}

	throw new Error('expected GatewayRuntimeProtocolError');
}

describe('gateway runtime Content-Length frame codec', () => {
	it('roundtrips one strict JSON-RPC 2.0 request using UTF-8 byte length', () => {
		// Arrange
		const serializedRequest = JSON.stringify(strictRequest);
		const utf8BodyByteLength = encodeBytes(serializedRequest).byteLength;
		const decoder = new GatewayRuntimeFrameDecoder();

		// Act
		const encodedFrame = encodeGatewayRuntimeFrame(strictRequest);
		const [encodedHeader, encodedBody] = textDecoder.decode(encodedFrame).split('\r\n\r\n');
		const decodedMessages = decoder.push(encodedFrame);
		decoder.finish();

		// Assert
		expect(encodedHeader).toBe(`Content-Length: ${utf8BodyByteLength}`);
		expect(utf8BodyByteLength).toBeGreaterThan(serializedRequest.length);
		expect(encodeBytes(encodedBody ?? '').byteLength).toBe(utf8BodyByteLength);
		expect(decodedMessages).toEqual([strictRequest]);
		expect(decoder.bufferedByteLength).toBe(0);
		expect(DEFAULT_GATEWAY_RUNTIME_FRAME_LIMITS.maxHeaderBytes).toBeGreaterThan(0);
		expect(DEFAULT_GATEWAY_RUNTIME_FRAME_LIMITS.maxContentBytes).toBeGreaterThan(0);
		expect(DEFAULT_GATEWAY_RUNTIME_FRAME_LIMITS.maxBufferedBytes).toBeGreaterThan(0);
		expect(DEFAULT_GATEWAY_RUNTIME_FRAME_LIMITS.maxFramesPerChunk).toBeGreaterThan(0);
	});

	it('retains bounded state across fragmented header and body chunks before decoding', () => {
		// Arrange
		const decoder = new GatewayRuntimeFrameDecoder({ maxBufferedBytes: 512 });
		const encodedFrame = encodeGatewayRuntimeFrame(strictRequest, { maxBufferedBytes: 512 });
		const headerDelimiterByteLength = encodeBytes('\r\n\r\n').byteLength;
		const headerEndOffset = textDecoder.decode(encodedFrame).indexOf('\r\n\r\n');
		const bodyStartOffset = headerEndOffset + headerDelimiterByteLength;
		const bodyMiddleOffset =
			bodyStartOffset + Math.floor((encodedFrame.length - bodyStartOffset) / 2);

		// Act
		const afterPartialHeader = decoder.push(encodedFrame.subarray(0, 7));
		const partialHeaderBufferedByteLength = decoder.bufferedByteLength;
		const afterPartialBody = decoder.push(encodedFrame.subarray(7, bodyMiddleOffset));
		const partialBodyBufferedByteLength = decoder.bufferedByteLength;
		const afterCompleteBody = decoder.push(encodedFrame.subarray(bodyMiddleOffset));

		// Assert
		expect(afterPartialHeader).toEqual([]);
		expect(partialHeaderBufferedByteLength).toBeGreaterThan(0);
		expect(partialHeaderBufferedByteLength).toBeLessThanOrEqual(512);
		expect(afterPartialBody).toEqual([]);
		expect(partialBodyBufferedByteLength).toBeGreaterThan(0);
		expect(partialBodyBufferedByteLength).toBeLessThanOrEqual(512);
		expect(afterCompleteBody).toEqual([strictRequest]);
		expect(decoder.bufferedByteLength).toBe(0);
	});

	it('decodes multiple complete frames in one chunk through maxFramesPerChunk', () => {
		// Arrange
		const decoder = new GatewayRuntimeFrameDecoder({ maxFramesPerChunk: 3 });
		const messages = [
			{ id: 1, jsonrpc: '2.0', method: 'portal.first' },
			{
				id: 2,
				jsonrpc: '2.0',
				method: 'portal.second',
				params: ['structured'],
			},
			strictErrorResponse,
		] as const;
		const combinedFrames = concatenateBytes(
			messages.map((message) => encodeGatewayRuntimeFrame(message)),
		);

		// Act
		const decodedMessages = decoder.push(combinedFrames);

		// Assert
		expect(decodedMessages).toEqual(messages);
		expect(decoder.bufferedByteLength).toBe(0);
	});

	it('rejects duplicate Content-Length headers including case variation', () => {
		// Arrange
		const duplicateHeaderFrames = [
			encodeBytes('Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}'),
			encodeBytes('Content-Length: 2\r\ncontent-length: 2\r\n\r\n{}'),
		];

		// Act
		const errors = duplicateHeaderFrames.map((frame) => {
			const decoder = new GatewayRuntimeFrameDecoder();
			return captureProtocolError(() => decoder.push(frame));
		});

		// Assert
		expect(errors.map((error) => error.code)).toEqual([
			PROTOCOL_ERROR_CODES.duplicateContentLength,
			PROTOCOL_ERROR_CODES.duplicateContentLength,
		]);
	});

	it('distinguishes malformed, unknown, and missing header failures', () => {
		// Arrange
		const malformedHeaderDecoder = new GatewayRuntimeFrameDecoder();
		const unknownHeaderDecoder = new GatewayRuntimeFrameDecoder();
		const missingDelimiterDecoder = new GatewayRuntimeFrameDecoder();

		// Act
		const malformedHeaderError = captureProtocolError(() =>
			malformedHeaderDecoder.push(encodeBytes('Content-Length 2\r\n\r\n{}')),
		);
		const unknownHeaderError = captureProtocolError(() =>
			unknownHeaderDecoder.push(encodeBytes('Content-Length: 2\r\nX-Trace: forbidden\r\n\r\n{}')),
		);
		missingDelimiterDecoder.push(encodeBytes('Content-Length: 2\r\n{}'));
		const missingDelimiterError = captureProtocolError(() => missingDelimiterDecoder.finish());

		// Assert
		expect(malformedHeaderError.code).toBe(PROTOCOL_ERROR_CODES.malformedHeader);
		expect(unknownHeaderError.code).toBe(PROTOCOL_ERROR_CODES.unknownHeader);
		expect(missingDelimiterError.code).toBe(PROTOCOL_ERROR_CODES.missingHeaderDelimiter);
	});

	it('rejects negative, non-decimal, and unsafe Content-Length declarations', () => {
		// Arrange
		const invalidContentLengths = [
			{ expectedCode: PROTOCOL_ERROR_CODES.negativeContentLength, value: '-1' },
			{ expectedCode: PROTOCOL_ERROR_CODES.nonDecimalContentLength, value: '1.5' },
			{
				expectedCode: PROTOCOL_ERROR_CODES.unsafeContentLength,
				value: '9007199254740992',
			},
		] as const;

		// Act
		const observedCodes = invalidContentLengths.map(({ value }) => {
			const decoder = new GatewayRuntimeFrameDecoder();
			return captureProtocolError(() =>
				decoder.push(encodeBytes(`Content-Length: ${value}\r\n\r\n`)),
			).code;
		});

		// Assert
		expect(observedCodes).toEqual(invalidContentLengths.map(({ expectedCode }) => expectedCode));
	});

	it('rejects a safe declared frame that overflows maxBufferedBytes', () => {
		// Arrange
		const decoder = new GatewayRuntimeFrameDecoder({
			maxBufferedBytes: 64,
			maxContentBytes: 128,
			maxHeaderBytes: 64,
		});
		const safeDeclaredContentLength = 48;

		// Act
		const error = captureProtocolError(() =>
			decoder.push(encodeBytes(`Content-Length: ${safeDeclaredContentLength}\r\n\r\n`)),
		);

		// Assert
		expect(Number.isSafeInteger(safeDeclaredContentLength)).toBe(true);
		expect(safeDeclaredContentLength).toBeLessThanOrEqual(128);
		expect(error.code).toBe(PROTOCOL_ERROR_CODES.contentLengthOverflow);
		expect(decoder.bufferedByteLength).toBeLessThanOrEqual(64);
	});

	it('fails header and content limits before retaining unbounded input', () => {
		// Arrange
		const headerLimitedDecoder = new GatewayRuntimeFrameDecoder({
			maxBufferedBytes: 8_192,
			maxContentBytes: 4_096,
			maxHeaderBytes: 32,
		});
		const contentLimitedDecoder = new GatewayRuntimeFrameDecoder({
			maxBufferedBytes: 128,
			maxContentBytes: 8,
			maxHeaderBytes: 64,
		});
		const oversizedHeaderChunk = encodeBytes('X'.repeat(4_096));

		// Act
		const headerError = captureProtocolError(() => headerLimitedDecoder.push(oversizedHeaderChunk));
		const contentError = captureProtocolError(() =>
			contentLimitedDecoder.push(encodeBytes('Content-Length: 9\r\n\r\n')),
		);

		// Assert
		expect(headerError.code).toBe(PROTOCOL_ERROR_CODES.headerTooLarge);
		expect(headerLimitedDecoder.bufferedByteLength).toBeLessThanOrEqual(32);
		expect(contentError.code).toBe(PROTOCOL_ERROR_CODES.contentTooLarge);
		expect(contentLimitedDecoder.bufferedByteLength).toBeLessThanOrEqual(64);
	});

	it('enforces maxBufferedBytes on retained incomplete input', () => {
		// Arrange
		const decoder = new GatewayRuntimeFrameDecoder({
			maxBufferedBytes: 64,
			maxContentBytes: 128,
			maxHeaderBytes: 128,
		});
		const incompleteHeaderBeyondBufferLimit = encodeBytes('X'.repeat(65));

		// Act
		const error = captureProtocolError(() => decoder.push(incompleteHeaderBeyondBufferLimit));

		// Assert
		expect(error.code).toBe(PROTOCOL_ERROR_CODES.bufferLimitExceeded);
		expect(decoder.bufferedByteLength).toBeLessThanOrEqual(64);
	});

	it('rejects an oversized incoming chunk before retaining it and remains terminally failed', () => {
		// Arrange
		const maxBufferedBytes = 128;
		const decoder = new GatewayRuntimeFrameDecoder({
			maxBufferedBytes,
			maxContentBytes: 96,
			maxFramesPerChunk: 8,
			maxHeaderBytes: 64,
		});
		const individuallyBoundedFrame = frameJsonValue({
			id: 1,
			jsonrpc: '2.0',
			method: 'portal.echo',
		});
		const oversizedIncomingChunk = concatenateBytes([
			individuallyBoundedFrame,
			individuallyBoundedFrame,
			individuallyBoundedFrame,
		]);

		// Act
		const initialError = captureProtocolError(() => decoder.push(oversizedIncomingChunk));
		const bufferedByteLengthAfterFailure = decoder.bufferedByteLength;
		const resumedError = captureProtocolError(() => decoder.push(individuallyBoundedFrame));

		// Assert
		expect(individuallyBoundedFrame.byteLength).toBeLessThanOrEqual(maxBufferedBytes);
		expect(oversizedIncomingChunk.byteLength).toBeGreaterThan(maxBufferedBytes);
		expect(initialError.code).toBe(PROTOCOL_ERROR_CODES.bufferLimitExceeded);
		expect(resumedError).toBe(initialError);
		expect(bufferedByteLengthAfterFailure).toBe(0);
		expect(decoder.bufferedByteLength).toBe(0);
	});

	it('enforces maxFramesPerChunk before decoding an extra complete frame', () => {
		// Arrange
		const decoder = new GatewayRuntimeFrameDecoder({ maxFramesPerChunk: 2 });
		const threeFrames = concatenateBytes([
			encodeGatewayRuntimeFrame({ id: 1, jsonrpc: '2.0', method: 'portal.first' }),
			encodeGatewayRuntimeFrame({ id: 2, jsonrpc: '2.0', method: 'portal.second' }),
			encodeGatewayRuntimeFrame({ id: 3, jsonrpc: '2.0', method: 'portal.third' }),
		]);

		// Act
		const error = captureProtocolError(() => decoder.push(threeFrames));

		// Assert
		expect(error.code).toBe(PROTOCOL_ERROR_CODES.frameLimitExceeded);
	});

	it('rejects invalid UTF-8 before invalid JSON and rejects invalid JSON separately', () => {
		// Arrange
		const invalidUtf8Decoder = new GatewayRuntimeFrameDecoder();
		const invalidJsonDecoder = new GatewayRuntimeFrameDecoder();
		const invalidUtf8Frame = frameBodyBytes(new Uint8Array([0xc3, 0x28]));
		const invalidJsonFrame = frameBodyText('{"jsonrpc":');

		// Act
		const invalidUtf8Error = captureProtocolError(() => invalidUtf8Decoder.push(invalidUtf8Frame));
		const invalidJsonError = captureProtocolError(() => invalidJsonDecoder.push(invalidJsonFrame));

		// Assert
		expect(invalidUtf8Error.code).toBe(PROTOCOL_ERROR_CODES.invalidUtf8);
		expect(invalidJsonError.code).toBe(PROTOCOL_ERROR_CODES.invalidJson);
	});

	it('rejects top-level JSON-RPC batches and non-object payloads', () => {
		// Arrange
		const batchFrame = frameJsonValue([strictRequest]);
		const nonObjectFrames = [null, 'scalar', 42].map(frameJsonValue);

		// Act
		const batchDecoder = new GatewayRuntimeFrameDecoder();
		const batchError = captureProtocolError(() => batchDecoder.push(batchFrame));
		const nonObjectErrors = nonObjectFrames.map((frame) => {
			const decoder = new GatewayRuntimeFrameDecoder();
			return captureProtocolError(() => decoder.push(frame));
		});

		// Assert
		expect(batchError.code).toBe(PROTOCOL_ERROR_CODES.jsonRpcBatchUnsupported);
		expect(nonObjectErrors.map((error) => error.code)).toEqual([
			PROTOCOL_ERROR_CODES.invalidJsonRpcEnvelope,
			PROTOCOL_ERROR_CODES.invalidJsonRpcEnvelope,
			PROTOCOL_ERROR_CODES.invalidJsonRpcEnvelope,
		]);
	});

	it('rejects the wrong JSON-RPC version and unknown top-level envelope fields', () => {
		// Arrange
		const wrongVersionDecoder = new GatewayRuntimeFrameDecoder();
		const unknownFieldDecoder = new GatewayRuntimeFrameDecoder();
		const wrongVersionFrame = frameJsonValue({
			id: 'request-a',
			jsonrpc: '1.0',
			method: 'portal.echo',
		});
		const unknownFieldFrame = frameJsonValue({
			...strictRequest,
			publicAuthority: 'forbidden',
		});

		// Act
		const wrongVersionError = captureProtocolError(() =>
			wrongVersionDecoder.push(wrongVersionFrame),
		);
		const unknownFieldError = captureProtocolError(() =>
			unknownFieldDecoder.push(unknownFieldFrame),
		);

		// Assert
		expect(wrongVersionError.code).toBe(PROTOCOL_ERROR_CODES.unsupportedJsonRpcVersion);
		expect(unknownFieldError.code).toBe(PROTOCOL_ERROR_CODES.unknownJsonRpcField);
	});

	it.each([
		{ invalidParams: null, paramsKind: 'null' },
		{ invalidParams: 'scalar', paramsKind: 'a string' },
		{ invalidParams: 42, paramsKind: 'a number' },
		{ invalidParams: false, paramsKind: 'a boolean' },
	])('rejects JSON-RPC request params when params is $paramsKind', ({ invalidParams }) => {
		// Arrange
		const decoder = new GatewayRuntimeFrameDecoder();
		const requestFrame = frameJsonValue({
			id: 'invalid-params',
			jsonrpc: '2.0',
			method: 'portal.echo',
			params: invalidParams,
		});

		// Act
		const error = captureProtocolError(() => decoder.push(requestFrame));

		// Assert
		expect(error.code).toBe(PROTOCOL_ERROR_CODES.invalidJsonRpcEnvelope);
	});

	it.each([
		{
			errorObject: { message: strictErrorObject.message },
			invalidShape: 'code is missing',
		},
		{
			errorObject: { code: strictErrorObject.code },
			invalidShape: 'message is missing',
		},
		{
			errorObject: { ...strictErrorObject, code: '-32001' },
			invalidShape: 'code is a string',
		},
		{
			errorObject: { ...strictErrorObject, code: -32_001.5 },
			invalidShape: 'code is fractional',
		},
		{
			errorObject: { ...strictErrorObject, code: Number.MAX_SAFE_INTEGER + 1 },
			invalidShape: 'code exceeds the safe integer range',
		},
		{
			errorObject: { ...strictErrorObject, message: 42 },
			invalidShape: 'message is not a string',
		},
	])('rejects a JSON-RPC error response when $invalidShape', ({ errorObject }) => {
		// Arrange
		const decoder = new GatewayRuntimeFrameDecoder();
		const errorResponseFrame = frameJsonValue({
			error: errorObject,
			id: 'request-error',
			jsonrpc: '2.0',
		});

		// Act
		const error = captureProtocolError(() => decoder.push(errorResponseFrame));

		// Assert
		expect(error.code).toBe(PROTOCOL_ERROR_CODES.invalidJsonRpcEnvelope);
	});

	it('rejects unknown fields inside a JSON-RPC error object', () => {
		// Arrange
		const decoder = new GatewayRuntimeFrameDecoder();
		const errorResponseFrame = frameJsonValue({
			error: {
				...strictErrorObject,
				publicAuthority: 'forbidden',
			},
			id: 'request-error',
			jsonrpc: '2.0',
		});

		// Act
		const error = captureProtocolError(() => decoder.push(errorResponseFrame));

		// Assert
		expect(error.code).toBe(PROTOCOL_ERROR_CODES.unknownJsonRpcField);
	});

	it('rejects partial terminal headers and bodies from finish()', () => {
		// Arrange
		const partialHeaderDecoder = new GatewayRuntimeFrameDecoder();
		const partialBodyDecoder = new GatewayRuntimeFrameDecoder();
		partialHeaderDecoder.push(encodeBytes('Content-Len'));
		partialBodyDecoder.push(encodeBytes('Content-Length: 10\r\n\r\n{}'));

		// Act
		const partialHeaderError = captureProtocolError(() => partialHeaderDecoder.finish());
		const partialBodyError = captureProtocolError(() => partialBodyDecoder.finish());

		// Assert
		expect(partialHeaderError.code).toBe(PROTOCOL_ERROR_CODES.incompleteFrameHeader);
		expect(partialBodyError.code).toBe(PROTOCOL_ERROR_CODES.incompleteFrameBody);
	});

	it('remains terminally failed and cannot retain or decode later input', () => {
		// Arrange
		const decoder = new GatewayRuntimeFrameDecoder();
		const malformedFrame = encodeBytes('Content-Length 2\r\n\r\n{}');
		const validFrame = encodeGatewayRuntimeFrame(strictRequest);

		// Act
		const initialError = captureProtocolError(() => decoder.push(malformedFrame));
		const bufferedByteLengthAfterFailure = decoder.bufferedByteLength;
		const resumedError = captureProtocolError(() => decoder.push(validFrame));

		// Assert
		expect(initialError.code).toBe(PROTOCOL_ERROR_CODES.malformedHeader);
		expect(resumedError.code).toEqual(expect.any(String));
		expect(decoder.bufferedByteLength).toBe(bufferedByteLengthAfterFailure);
	});
});

describe('gateway runtime frame encoder validation', () => {
	it('rejects batches, non-objects, and the wrong JSON-RPC version', () => {
		// Arrange
		const invalidMessages = [
			{ expectedCode: PROTOCOL_ERROR_CODES.jsonRpcBatchUnsupported, value: [strictRequest] },
			{ expectedCode: PROTOCOL_ERROR_CODES.invalidJsonRpcEnvelope, value: null },
			{ expectedCode: PROTOCOL_ERROR_CODES.invalidJsonRpcEnvelope, value: 'scalar' },
			{
				expectedCode: PROTOCOL_ERROR_CODES.unsupportedJsonRpcVersion,
				value: { id: 'request-a', jsonrpc: '1.0', method: 'portal.echo' },
			},
		] as const;

		// Act
		const observedCodes = invalidMessages.map(
			({ value }) => captureProtocolError(() => encodeGatewayRuntimeFrame(value)).code,
		);

		// Assert
		expect(observedCodes).toEqual(invalidMessages.map(({ expectedCode }) => expectedCode));
	});

	it('rejects a message whose UTF-8 body exceeds maxContentBytes', () => {
		// Arrange
		const serializedRequestByteLength = encodeBytes(JSON.stringify(strictRequest)).byteLength;
		const maxContentBytes = serializedRequestByteLength - 1;

		// Act
		const error = captureProtocolError(() =>
			encodeGatewayRuntimeFrame(strictRequest, { maxContentBytes }),
		);

		// Assert
		expect(error.code).toBe(PROTOCOL_ERROR_CODES.contentTooLarge);
	});

	it('rejects an envelope whose wire serialization removes a validated result field', () => {
		// Arrange
		const responseWithUndefinedResult = {
			id: 1,
			jsonrpc: '2.0',
			result: undefined,
		} as const;
		let encodedFrame: Uint8Array | undefined;

		// Act
		const error = captureProtocolError(() => {
			encodedFrame = encodeGatewayRuntimeFrame(responseWithUndefinedResult);
		});

		// Assert
		expect(error.code).toBe(PROTOCOL_ERROR_CODES.invalidJsonRpcEnvelope);
		expect(encodedFrame).toBeUndefined();
	});
});
