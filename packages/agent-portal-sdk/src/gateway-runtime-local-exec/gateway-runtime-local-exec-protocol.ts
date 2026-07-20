const MAXIMUM_LOCAL_EXEC_FRAME_BYTES = 128 * 1024;
const MAXIMUM_LOCAL_EXEC_STREAM_CHUNK_BYTES = 64 * 1024;
const MAXIMUM_LOCAL_EXEC_TOKEN_BYTES = 256;

export type GatewayRuntimeLocalExecClientFrame =
	| { readonly kind: 'authenticate'; readonly token: string }
	| { readonly kind: 'cancel' }
	| { readonly contentBase64: string; readonly kind: 'stdin-chunk' }
	| { readonly kind: 'stdin-end' }
	| { readonly columns: number; readonly kind: 'terminal-resize'; readonly rows: number };

export type GatewayRuntimeLocalExecServerFrame =
	| { readonly kind: 'accepted' }
	| { readonly contentBase64: string; readonly kind: 'stderr-chunk' }
	| { readonly kind: 'stderr-end' }
	| { readonly exitCode: number | null; readonly kind: 'exited' }
	| { readonly message: string; readonly kind: 'rejected' }
	| { readonly contentBase64: string; readonly kind: 'stdout-chunk' }
	| { readonly kind: 'stdout-end' };

export class GatewayRuntimeLocalExecProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GatewayRuntimeLocalExecProtocolError';
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
	const actualKeys = Object.keys(value).toSorted();
	const expectedKeys = keys.toSorted();
	if (
		actualKeys.length !== expectedKeys.length ||
		actualKeys.some((key, index) => key !== expectedKeys[index])
	) {
		throw new GatewayRuntimeLocalExecProtocolError('Local exec frame contains unexpected fields.');
	}
}

function requireString(value: unknown, fieldName: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new GatewayRuntimeLocalExecProtocolError(
			`Local exec frame field '${fieldName}' must be a non-empty string.`,
		);
	}
	return value;
}

function requireBoundedToken(value: unknown): string {
	const token = requireString(value, 'token');
	if (Buffer.byteLength(token, 'utf8') > MAXIMUM_LOCAL_EXEC_TOKEN_BYTES) {
		throw new GatewayRuntimeLocalExecProtocolError(
			'Local exec reservation token exceeds the byte limit.',
		);
	}
	return token;
}

function requireCanonicalBase64(value: unknown): string {
	const encoded = requireString(value, 'contentBase64');
	const decoded = Buffer.from(encoded, 'base64');
	if (
		decoded.byteLength > MAXIMUM_LOCAL_EXEC_STREAM_CHUNK_BYTES ||
		decoded.toString('base64') !== encoded
	) {
		throw new GatewayRuntimeLocalExecProtocolError(
			'Local exec stream content must be canonical bounded base64.',
		);
	}
	return encoded;
}

function requireTerminalDimension(value: unknown, fieldName: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 1_000) {
		throw new GatewayRuntimeLocalExecProtocolError(
			`Local exec frame field '${fieldName}' must be a bounded positive integer.`,
		);
	}
	return value as number;
}

function parseJsonObject(line: string): Readonly<Record<string, unknown>> {
	if (Buffer.byteLength(line, 'utf8') > MAXIMUM_LOCAL_EXEC_FRAME_BYTES) {
		throw new GatewayRuntimeLocalExecProtocolError('Local exec frame exceeds the byte limit.');
	}
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error: unknown) {
		throw new GatewayRuntimeLocalExecProtocolError(
			error instanceof Error
				? `Local exec frame is not valid JSON: ${error.message}`
				: 'Local exec frame is not valid JSON.',
		);
	}
	if (!isRecord(value)) {
		throw new GatewayRuntimeLocalExecProtocolError('Local exec frame must be an object.');
	}
	return value;
}

export function encodeGatewayRuntimeLocalExecFrame(
	frame: GatewayRuntimeLocalExecClientFrame | GatewayRuntimeLocalExecServerFrame,
): string {
	return `${JSON.stringify(frame)}\n`;
}

export function parseGatewayRuntimeLocalExecClientFrame(
	line: string,
): GatewayRuntimeLocalExecClientFrame {
	const value = parseJsonObject(line);
	const kind = requireString(value.kind, 'kind');
	switch (kind) {
		case 'authenticate':
			requireExactKeys(value, ['kind', 'token']);
			return { kind, token: requireBoundedToken(value.token) };
		case 'cancel':
		case 'stdin-end':
			requireExactKeys(value, ['kind']);
			return { kind };
		case 'stdin-chunk':
			requireExactKeys(value, ['contentBase64', 'kind']);
			return { contentBase64: requireCanonicalBase64(value.contentBase64), kind };
		case 'terminal-resize':
			requireExactKeys(value, ['columns', 'kind', 'rows']);
			return {
				columns: requireTerminalDimension(value.columns, 'columns'),
				kind,
				rows: requireTerminalDimension(value.rows, 'rows'),
			};
		default:
			throw new GatewayRuntimeLocalExecProtocolError(`Unknown local exec client frame '${kind}'.`);
	}
}

export function parseGatewayRuntimeLocalExecServerFrame(
	line: string,
): GatewayRuntimeLocalExecServerFrame {
	const value = parseJsonObject(line);
	const kind = requireString(value.kind, 'kind');
	switch (kind) {
		case 'accepted':
		case 'stderr-end':
		case 'stdout-end':
			requireExactKeys(value, ['kind']);
			return { kind };
		case 'stderr-chunk':
		case 'stdout-chunk':
			requireExactKeys(value, ['contentBase64', 'kind']);
			return { contentBase64: requireCanonicalBase64(value.contentBase64), kind };
		case 'exited':
			requireExactKeys(value, ['exitCode', 'kind']);
			if (
				value.exitCode !== null &&
				(!Number.isSafeInteger(value.exitCode) ||
					(value.exitCode as number) < 0 ||
					(value.exitCode as number) > 255)
			) {
				throw new GatewayRuntimeLocalExecProtocolError(
					"Local exec frame field 'exitCode' must be null or an integer from 0 through 255.",
				);
			}
			return { exitCode: value.exitCode as number | null, kind };
		case 'rejected':
			requireExactKeys(value, ['kind', 'message']);
			return { kind, message: requireString(value.message, 'message') };
		default:
			throw new GatewayRuntimeLocalExecProtocolError(`Unknown local exec server frame '${kind}'.`);
	}
}

export class GatewayRuntimeLocalExecLineDecoder {
	#buffer = Buffer.alloc(0);

	push(chunk: Uint8Array): readonly string[] {
		if (chunk.byteLength + this.#buffer.byteLength > MAXIMUM_LOCAL_EXEC_FRAME_BYTES) {
			throw new GatewayRuntimeLocalExecProtocolError(
				'Local exec frame batch exceeds the byte limit.',
			);
		}
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		const lines: string[] = [];
		let newlineIndex = this.#buffer.indexOf(0x0a);
		while (newlineIndex >= 0) {
			const line = this.#buffer.subarray(0, newlineIndex).toString('utf8');
			this.#buffer = this.#buffer.subarray(newlineIndex + 1);
			if (Buffer.byteLength(line, 'utf8') > MAXIMUM_LOCAL_EXEC_FRAME_BYTES) {
				throw new GatewayRuntimeLocalExecProtocolError('Local exec frame exceeds the byte limit.');
			}
			if (line.length > 0) lines.push(line);
			newlineIndex = this.#buffer.indexOf(0x0a);
		}
		if (this.#buffer.byteLength > MAXIMUM_LOCAL_EXEC_FRAME_BYTES) {
			throw new GatewayRuntimeLocalExecProtocolError('Local exec frame exceeds the byte limit.');
		}
		return lines;
	}
}
