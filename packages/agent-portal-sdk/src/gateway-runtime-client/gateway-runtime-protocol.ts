export type GatewayRuntimeProtocolErrorCode =
	| 'BUFFER_LIMIT_EXCEEDED'
	| 'CONTENT_LENGTH_OVERFLOW'
	| 'CONTENT_TOO_LARGE'
	| 'DUPLICATE_CONTENT_LENGTH'
	| 'FRAME_LIMIT_EXCEEDED'
	| 'HEADER_TOO_LARGE'
	| 'INCOMPLETE_FRAME_BODY'
	| 'INCOMPLETE_FRAME_HEADER'
	| 'INVALID_JSON'
	| 'INVALID_JSON_RPC_ENVELOPE'
	| 'INVALID_UTF8'
	| 'JSON_RPC_BATCH_UNSUPPORTED'
	| 'MALFORMED_HEADER'
	| 'MISSING_HEADER_DELIMITER'
	| 'NEGATIVE_CONTENT_LENGTH'
	| 'NON_DECIMAL_CONTENT_LENGTH'
	| 'UNKNOWN_HEADER'
	| 'UNKNOWN_JSON_RPC_FIELD'
	| 'UNSAFE_CONTENT_LENGTH'
	| 'UNSUPPORTED_JSON_RPC_VERSION';

export interface GatewayRuntimeFrameLimits {
	readonly maxBufferedBytes: number;
	readonly maxContentBytes: number;
	readonly maxFramesPerChunk: number;
	readonly maxHeaderBytes: number;
}

export const DEFAULT_GATEWAY_RUNTIME_FRAME_LIMITS = Object.freeze({
	maxBufferedBytes: 1_056_768,
	maxContentBytes: 1_048_576,
	maxFramesPerChunk: 32,
	maxHeaderBytes: 8_192,
}) satisfies GatewayRuntimeFrameLimits;

export type GatewayRuntimeFrameLimitOverrides = Partial<GatewayRuntimeFrameLimits>;

export type GatewayRuntimeJsonRpcMessage = Readonly<Record<string, unknown>> & {
	readonly jsonrpc: '2.0';
};

interface PendingFrameBody {
	readonly bodyStartOffset: number;
	readonly contentLength: number;
}

const headerDelimiter = new Uint8Array([13, 10, 13, 10]);
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

export class GatewayRuntimeProtocolError extends Error {
	readonly code: GatewayRuntimeProtocolErrorCode;

	constructor(code: GatewayRuntimeProtocolErrorCode, message: string) {
		super(message);
		this.name = 'GatewayRuntimeProtocolError';
		this.code = code;
	}
}

function protocolError(
	code: GatewayRuntimeProtocolErrorCode,
	message: string,
): GatewayRuntimeProtocolError {
	return new GatewayRuntimeProtocolError(code, message);
}

function assertPositiveLimit(value: number, fieldName: keyof GatewayRuntimeFrameLimits): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${fieldName} must be a positive safe integer.`);
	}
}

function resolveFrameLimits(
	overrides: GatewayRuntimeFrameLimitOverrides,
): GatewayRuntimeFrameLimits {
	const limits = {
		...DEFAULT_GATEWAY_RUNTIME_FRAME_LIMITS,
		...overrides,
	};
	assertPositiveLimit(limits.maxBufferedBytes, 'maxBufferedBytes');
	assertPositiveLimit(limits.maxContentBytes, 'maxContentBytes');
	assertPositiveLimit(limits.maxFramesPerChunk, 'maxFramesPerChunk');
	assertPositiveLimit(limits.maxHeaderBytes, 'maxHeaderBytes');
	return Object.freeze(limits);
}

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	if (left.byteLength === 0) return new Uint8Array(right);
	if (right.byteLength === 0) return new Uint8Array(left);
	const combinedBytes = new Uint8Array(left.byteLength + right.byteLength);
	combinedBytes.set(left, 0);
	combinedBytes.set(right, left.byteLength);
	return combinedBytes;
}

function findHeaderDelimiter(bytes: Uint8Array): number {
	outer: for (
		let offset = 0;
		offset <= bytes.byteLength - headerDelimiter.byteLength;
		offset += 1
	) {
		for (
			let delimiterOffset = 0;
			delimiterOffset < headerDelimiter.byteLength;
			delimiterOffset += 1
		) {
			if (bytes[offset + delimiterOffset] !== headerDelimiter[delimiterOffset]) continue outer;
		}
		return offset;
	}
	return -1;
}

function decodeUtf8(bytes: Uint8Array, code: GatewayRuntimeProtocolErrorCode): string {
	try {
		return strictUtf8Decoder.decode(bytes);
	} catch {
		throw protocolError(code, 'Gateway runtime frame contains invalid UTF-8.');
	}
}

function parseContentLength(headerBytes: Uint8Array): number {
	const headerText = decodeUtf8(headerBytes, 'MALFORMED_HEADER');
	const headerLines = headerText.split('\r\n');
	let contentLengthText: string | undefined;

	for (const headerLine of headerLines) {
		const delimiterIndex = headerLine.indexOf(':');
		if (delimiterIndex <= 0) {
			throw protocolError('MALFORMED_HEADER', 'Gateway runtime frame header is malformed.');
		}
		const headerName = headerLine.slice(0, delimiterIndex).trim().toLowerCase();
		if (headerName !== 'content-length') {
			throw protocolError(
				'UNKNOWN_HEADER',
				`Gateway runtime frame header '${headerName}' is unknown.`,
			);
		}
		if (contentLengthText !== undefined) {
			throw protocolError(
				'DUPLICATE_CONTENT_LENGTH',
				'Gateway runtime frame contains duplicate Content-Length headers.',
			);
		}
		contentLengthText = headerLine.slice(delimiterIndex + 1).trim();
	}

	if (contentLengthText === undefined || contentLengthText.length === 0) {
		throw protocolError('MALFORMED_HEADER', 'Gateway runtime frame is missing Content-Length.');
	}
	if (contentLengthText.startsWith('-')) {
		throw protocolError('NEGATIVE_CONTENT_LENGTH', 'Content-Length must not be negative.');
	}
	if (!/^\d+$/u.test(contentLengthText)) {
		throw protocolError(
			'NON_DECIMAL_CONTENT_LENGTH',
			'Content-Length must contain decimal digits.',
		);
	}

	const contentLengthBigInt = BigInt(contentLengthText);
	if (contentLengthBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw protocolError('UNSAFE_CONTENT_LENGTH', 'Content-Length exceeds the safe integer range.');
	}
	return Number(contentLengthBigInt);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasSupportedJsonRpcVersion(
	value: Readonly<Record<string, unknown>>,
): value is GatewayRuntimeJsonRpcMessage {
	return value.jsonrpc === '2.0';
}

function jsonRpcIdIsValid(value: unknown): boolean {
	return (
		typeof value === 'string' ||
		(typeof value === 'number' && Number.isSafeInteger(value)) ||
		value === null
	);
}

function jsonRpcParamsAreValid(value: unknown): boolean {
	return Array.isArray(value) || isJsonObject(value);
}

function hasOnlyKeys(
	record: Readonly<Record<string, unknown>>,
	allowedKeys: ReadonlySet<string>,
): boolean {
	return Object.keys(record).every((key) => allowedKeys.has(key));
}

function validateJsonRpcErrorObject(value: unknown): void {
	if (!isJsonObject(value)) {
		throw protocolError('INVALID_JSON_RPC_ENVELOPE', 'JSON-RPC error object is invalid.');
	}
	const allowedErrorKeys = new Set(['code', 'data', 'message']);
	if (!hasOnlyKeys(value, allowedErrorKeys)) {
		throw protocolError('UNKNOWN_JSON_RPC_FIELD', 'JSON-RPC error object has an unknown field.');
	}
	if (!Number.isSafeInteger(value.code) || typeof value.message !== 'string') {
		throw protocolError('INVALID_JSON_RPC_ENVELOPE', 'JSON-RPC error object is invalid.');
	}
}

function validateJsonRpcEnvelope(value: unknown): GatewayRuntimeJsonRpcMessage {
	if (Array.isArray(value)) {
		throw protocolError('JSON_RPC_BATCH_UNSUPPORTED', 'JSON-RPC batches are not supported.');
	}
	if (!isJsonObject(value)) {
		throw protocolError('INVALID_JSON_RPC_ENVELOPE', 'JSON-RPC messages must be objects.');
	}
	if (!hasSupportedJsonRpcVersion(value)) {
		throw protocolError(
			'UNSUPPORTED_JSON_RPC_VERSION',
			'Gateway runtime requires JSON-RPC version 2.0.',
		);
	}

	if (Object.hasOwn(value, 'method')) {
		const allowedRequestKeys = new Set(['id', 'jsonrpc', 'method', 'params']);
		if (!hasOnlyKeys(value, allowedRequestKeys)) {
			throw protocolError('UNKNOWN_JSON_RPC_FIELD', 'JSON-RPC request has an unknown field.');
		}
		if (
			typeof value.method !== 'string' ||
			value.method.length === 0 ||
			(Object.hasOwn(value, 'id') && !jsonRpcIdIsValid(value.id)) ||
			(Object.hasOwn(value, 'params') && !jsonRpcParamsAreValid(value.params))
		) {
			throw protocolError('INVALID_JSON_RPC_ENVELOPE', 'JSON-RPC request envelope is invalid.');
		}
		return value;
	}

	const hasResult = Object.hasOwn(value, 'result');
	const hasError = Object.hasOwn(value, 'error');
	const allowedResponseKeys = new Set(['error', 'id', 'jsonrpc', 'result']);
	if (!hasOnlyKeys(value, allowedResponseKeys)) {
		throw protocolError('UNKNOWN_JSON_RPC_FIELD', 'JSON-RPC response has an unknown field.');
	}
	if (!Object.hasOwn(value, 'id') || !jsonRpcIdIsValid(value.id) || hasResult === hasError) {
		throw protocolError('INVALID_JSON_RPC_ENVELOPE', 'JSON-RPC response envelope is invalid.');
	}
	if (hasError) validateJsonRpcErrorObject(value.error);
	return value;
}

function parseFrameBody(bodyBytes: Uint8Array): GatewayRuntimeJsonRpcMessage {
	const bodyText = decodeUtf8(bodyBytes, 'INVALID_UTF8');
	let parsedBody: unknown;
	try {
		parsedBody = JSON.parse(bodyText) as unknown;
	} catch {
		throw protocolError('INVALID_JSON', 'Gateway runtime frame body is not valid JSON.');
	}
	return validateJsonRpcEnvelope(parsedBody);
}

export class GatewayRuntimeFrameDecoder {
	readonly #limits: GatewayRuntimeFrameLimits;
	#buffer: Uint8Array = new Uint8Array(0);
	#pendingFrameBody: PendingFrameBody | undefined;
	#terminalError: GatewayRuntimeProtocolError | undefined;

	constructor(limitOverrides: GatewayRuntimeFrameLimitOverrides = {}) {
		this.#limits = resolveFrameLimits(limitOverrides);
	}

	get bufferedByteLength(): number {
		return this.#buffer.byteLength;
	}

	#fail(error: GatewayRuntimeProtocolError): never {
		this.#terminalError ??= error;
		throw this.#terminalError;
	}

	push(chunk: Uint8Array): readonly GatewayRuntimeJsonRpcMessage[] {
		if (this.#terminalError !== undefined) throw this.#terminalError;
		if (chunk.byteLength > this.#limits.maxBufferedBytes - this.#buffer.byteLength) {
			this.#fail(
				protocolError(
					'BUFFER_LIMIT_EXCEEDED',
					'Gateway runtime decoder input exceeds its buffer limit.',
				),
			);
		}
		let workingBuffer = concatenateBytes(this.#buffer, chunk);
		let pendingFrameBody = this.#pendingFrameBody;
		const decodedMessages: GatewayRuntimeJsonRpcMessage[] = [];

		try {
			while (workingBuffer.byteLength > 0) {
				if (pendingFrameBody === undefined) {
					const headerDelimiterOffset = findHeaderDelimiter(workingBuffer);
					if (headerDelimiterOffset < 0) {
						if (workingBuffer.byteLength > this.#limits.maxHeaderBytes) {
							this.#fail(
								protocolError(
									'HEADER_TOO_LARGE',
									'Gateway runtime frame header exceeds its limit.',
								),
							);
						}
						if (workingBuffer.byteLength > this.#limits.maxBufferedBytes) {
							this.#fail(
								protocolError('BUFFER_LIMIT_EXCEEDED', 'Gateway runtime decoder buffer is full.'),
							);
						}
						break;
					}
					if (headerDelimiterOffset > this.#limits.maxHeaderBytes) {
						this.#fail(
							protocolError('HEADER_TOO_LARGE', 'Gateway runtime frame header exceeds its limit.'),
						);
					}

					const bodyStartOffset = headerDelimiterOffset + headerDelimiter.byteLength;
					const contentLength = parseContentLength(
						workingBuffer.subarray(0, headerDelimiterOffset),
					);
					if (contentLength > this.#limits.maxContentBytes) {
						this.#fail(
							protocolError('CONTENT_TOO_LARGE', 'Gateway runtime frame body exceeds its limit.'),
						);
					}
					if (bodyStartOffset + contentLength > this.#limits.maxBufferedBytes) {
						this.#fail(
							protocolError(
								'CONTENT_LENGTH_OVERFLOW',
								'Gateway runtime frame cannot fit within the decoder buffer limit.',
							),
						);
					}
					pendingFrameBody = { bodyStartOffset, contentLength };
				}

				const bodyEndOffset = pendingFrameBody.bodyStartOffset + pendingFrameBody.contentLength;
				if (workingBuffer.byteLength < bodyEndOffset) break;
				if (decodedMessages.length >= this.#limits.maxFramesPerChunk) {
					this.#fail(
						protocolError(
							'FRAME_LIMIT_EXCEEDED',
							'Gateway runtime chunk contains too many complete frames.',
						),
					);
				}

				decodedMessages.push(
					parseFrameBody(workingBuffer.subarray(pendingFrameBody.bodyStartOffset, bodyEndOffset)),
				);
				workingBuffer = workingBuffer.slice(bodyEndOffset);
				pendingFrameBody = undefined;
			}
		} catch (error: unknown) {
			if (error instanceof GatewayRuntimeProtocolError) this.#fail(error);
			throw error;
		}

		this.#buffer = workingBuffer;
		this.#pendingFrameBody = pendingFrameBody;
		return decodedMessages;
	}

	finish(): void {
		if (this.#terminalError !== undefined) throw this.#terminalError;
		if (this.#buffer.byteLength === 0) return;
		if (this.#pendingFrameBody !== undefined) {
			this.#fail(protocolError('INCOMPLETE_FRAME_BODY', 'Gateway runtime frame body ended early.'));
		}

		const bufferedHeader = new TextDecoder().decode(this.#buffer);
		const code = bufferedHeader.includes('\r\n')
			? 'MISSING_HEADER_DELIMITER'
			: 'INCOMPLETE_FRAME_HEADER';
		this.#fail(protocolError(code, 'Gateway runtime frame header ended early.'));
	}
}

export function encodeGatewayRuntimeFrame(
	message: unknown,
	limitOverrides: GatewayRuntimeFrameLimitOverrides = {},
): Uint8Array {
	validateJsonRpcEnvelope(message);
	const limits = resolveFrameLimits(limitOverrides);
	let serializedMessage: string | undefined;
	try {
		serializedMessage = JSON.stringify(message);
	} catch {
		throw protocolError('INVALID_JSON_RPC_ENVELOPE', 'JSON-RPC message is not serializable.');
	}
	if (serializedMessage === undefined) {
		throw protocolError('INVALID_JSON_RPC_ENVELOPE', 'JSON-RPC message is not serializable.');
	}
	validateJsonRpcEnvelope(JSON.parse(serializedMessage) as unknown);
	const bodyBytes = utf8Encoder.encode(serializedMessage);
	if (bodyBytes.byteLength > limits.maxContentBytes) {
		throw protocolError('CONTENT_TOO_LARGE', 'Gateway runtime frame body exceeds its limit.');
	}
	const headerBytes = utf8Encoder.encode(`Content-Length: ${bodyBytes.byteLength}\r\n\r\n`);
	if (headerBytes.byteLength - headerDelimiter.byteLength > limits.maxHeaderBytes) {
		throw protocolError('HEADER_TOO_LARGE', 'Gateway runtime frame header exceeds its limit.');
	}
	if (headerBytes.byteLength + bodyBytes.byteLength > limits.maxBufferedBytes) {
		throw protocolError(
			'CONTENT_LENGTH_OVERFLOW',
			'Gateway runtime frame cannot fit within the buffer limit.',
		);
	}
	return concatenateBytes(headerBytes, bodyBytes);
}
