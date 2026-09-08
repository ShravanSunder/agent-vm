import { z } from 'zod';

import { JsonValueSchema } from '../contract-primitives/index.js';

export const MAX_RELAY_MESSAGE_BYTES = 1_048_576;
const MAX_RELAY_HEADER_BYTES = 8_192;
const relayRequestId = z.string().min(1);
const jsonObject = z.record(z.string(), JsonValueSchema);

export const RelayMessageSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('hello'), version: z.literal(1) }).strict(),
	z
		.object({
			kind: z.literal('ready'),
			version: z.literal(1),
			maxMessageBytes: z.number().int().positive().max(MAX_RELAY_MESSAGE_BYTES),
			maxPendingRequests: z.number().int().positive().max(16),
		})
		.strict(),
	z
		.object({
			kind: z.literal('request'),
			requestId: relayRequestId,
			operation: z.enum(['list', 'search', 'describe', 'call', 'artifact-read']),
			request: jsonObject,
		})
		.strict(),
	z.object({ kind: z.literal('result'), requestId: relayRequestId, result: jsonObject }).strict(),
	z
		.object({
			kind: z.literal('error'),
			requestId: relayRequestId,
			code: z.string().min(1).max(128),
			dispatch: z.enum(['not-dispatched', 'uncertain', 'completed']),
		})
		.strict(),
	z.object({ kind: z.literal('cancel'), requestId: relayRequestId }).strict(),
	z.object({ kind: z.literal('close') }).strict(),
	z
		.object({
			kind: z.literal('credit'),
			requests: z.number().int().min(0).max(16),
			bytes: z
				.number()
				.int()
				.min(0)
				.max(64 * 1024 * 1024),
		})
		.strict(),
	z
		.object({
			kind: z.literal('artifact-chunk'),
			requestId: relayRequestId,
			reference: jsonObject,
			offsetBytes: z.number().int().nonnegative(),
			contentBase64: z.string().max(90_000),
		})
		.strict(),
	z
		.object({
			kind: z.literal('artifact-end'),
			requestId: relayRequestId,
			reference: jsonObject,
			offsetBytes: z.number().int().nonnegative(),
			byteLength: z
				.number()
				.int()
				.min(0)
				.max(16 * 1024 * 1024),
			truncated: z.boolean(),
			mediaType: z.string().optional(),
		})
		.strict(),
]);

export type RelayMessage = z.infer<typeof RelayMessageSchema>;

function parseRelayJson(body: string): unknown {
	const parsed: unknown = JSON.parse(body);
	// JSON.parse accepts duplicate keys. Inspect only structural tokens after it
	// has validated syntax, decoding key escapes before checking uniqueness.
	const stack: ({ kind: 'object'; keys: Set<string>; expectsKey: boolean } | { kind: 'array' })[] =
		[];
	for (const tokenMatch of body.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]/gu)) {
		const token = tokenMatch[0];
		if (token === '{') {
			stack.push({ kind: 'object', keys: new Set(), expectsKey: true });
			continue;
		}
		if (token === '[') {
			stack.push({ kind: 'array' });
			continue;
		}
		if (token === '}' || token === ']') {
			stack.pop();
			continue;
		}
		const current = stack.at(-1);
		if (current?.kind !== 'object') continue;
		if (token === ',') {
			current.expectsKey = true;
			continue;
		}
		if (token === ':') {
			current.expectsKey = false;
			continue;
		}
		if (current.expectsKey && token.startsWith('"')) {
			const key: unknown = JSON.parse(token);
			if (typeof key !== 'string' || current.keys.has(key))
				throw new Error('Duplicate relay JSON key.');
			current.keys.add(key);
		}
	}
	return parsed;
}

export function encodeRelayFrame(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(RelayMessageSchema.parse(message)), 'utf8');
	if (body.byteLength > MAX_RELAY_MESSAGE_BYTES)
		throw new Error('Relay message exceeds its byte limit.');
	return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`), body]);
}

export class PortalRelayDecoder {
	#buffer: Buffer = Buffer.alloc(0);
	#bodyLength: number | undefined;
	#failed = false;
	readonly #utf8 = new TextDecoder('utf-8', { fatal: true });

	feed(chunk: Uint8Array): readonly RelayMessage[] {
		if (this.#failed) throw new Error('Relay decoder is closed after invalid traffic.');
		try {
			const bufferLimit = MAX_RELAY_MESSAGE_BYTES + MAX_RELAY_HEADER_BYTES;
			if (chunk.byteLength > bufferLimit) throw new Error('Relay input exceeds its buffer limit.');
			const messages: RelayMessage[] = [];
			let position = 0;
			while (position < chunk.byteLength) {
				const capacity = bufferLimit - this.#buffer.byteLength;
				if (capacity <= 0) throw new Error('Relay input exceeds its buffer limit.');
				const end = Math.min(chunk.byteLength, position + capacity);
				this.#buffer = Buffer.concat([this.#buffer, chunk.subarray(position, end)]);
				messages.push(...this.#drain());
				position = end;
			}
			return messages;
		} catch (error: unknown) {
			this.#failed = true;
			this.#buffer = Buffer.alloc(0);
			throw error;
		}
	}

	#drain(): readonly RelayMessage[] {
		const messages: RelayMessage[] = [];
		while (true) {
			if (this.#bodyLength === undefined) {
				const delimiter = this.#buffer.indexOf('\r\n\r\n');
				if (delimiter < 0) {
					if (this.#buffer.byteLength > MAX_RELAY_HEADER_BYTES)
						throw new Error('Relay header exceeds its limit.');
					return messages;
				}
				if (delimiter > MAX_RELAY_HEADER_BYTES) throw new Error('Relay header exceeds its limit.');
				const header = this.#utf8.decode(this.#buffer.subarray(0, delimiter));
				const match = /^Content-Length: ([0-9]{1,7})$/u.exec(header);
				if (!match) throw new Error('Malformed relay header.');
				this.#bodyLength = Number(match[1]);
				if (this.#bodyLength < 1 || this.#bodyLength > MAX_RELAY_MESSAGE_BYTES)
					throw new Error('Relay body exceeds its limit.');
				this.#buffer = this.#buffer.subarray(delimiter + 4);
			}
			if (this.#buffer.byteLength < this.#bodyLength) return messages;
			const body = this.#utf8.decode(this.#buffer.subarray(0, this.#bodyLength));
			this.#buffer = this.#buffer.subarray(this.#bodyLength);
			this.#bodyLength = undefined;
			messages.push(RelayMessageSchema.parse(parseRelayJson(body)));
		}
	}
}
