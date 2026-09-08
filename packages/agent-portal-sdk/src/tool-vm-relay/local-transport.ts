import { createConnection, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';

import {
	createPortalArtifactReadResourceRequest,
	PortalArtifactReadRequestSchema,
	PortalArtifactReadResultSchema,
	type PortalArtifactReadRequest,
} from '../artifact-surface/index.js';
import { encodeCanonicalJson } from '../portable-contracts/index.js';
import type { ToolPortalMcpTransport } from '../tool-portal-mcp-client/index.js';
import { encodeRelayFrame, PortalRelayDecoder, type RelayMessage } from './relay-protocol.js';

interface PendingRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly cleanup: () => void;
	readonly artifact?: {
		readonly request: PortalArtifactReadRequest;
		readonly chunks: Buffer[];
		bytes: number;
	};
}

function portalOperation(name: string): 'list' | 'search' | 'describe' | 'call' {
	switch (name) {
		case 'tool_portal_list':
			return 'list';
		case 'tool_portal_search':
			return 'search';
		case 'tool_portal_describe':
			return 'describe';
		case 'tool_portal_call':
			return 'call';
		default:
			throw new Error('Only Portal operations are available in the managed transport.');
	}
}

export function createLocalToolPortalTransport(props: {
	readonly environment: Readonly<Record<string, string | undefined>>;
}): ToolPortalMcpTransport {
	const socketPath = props.environment['AGENT_VM_TOOL_PORTAL_SOCKET'];
	if (!socketPath) throw new Error('No managed Portal execution context is available.');
	if (!isAbsolute(socketPath) || socketPath.includes('\0'))
		throw new Error('Portal socket requires an absolute guest path.');
	let socket: Socket | undefined;
	let ready = false;
	let closed = false;
	let nextId = 0;
	let maximumPending = 16;
	let maximumMessageBytes = 1_048_576;
	let handshake: { resolve: () => void; reject: (error: Error) => void } | undefined;
	const pending = new Map<string, PendingRequest>();
	const decoder = new PortalRelayDecoder();

	function fail(error: Error): void {
		closed = true;
		ready = false;
		handshake?.reject(error);
		handshake = undefined;
		for (const request of pending.values()) {
			request.cleanup();
			request.reject(error);
		}
		pending.clear();
		socket?.destroy();
	}

	function finish(requestId: string, value: unknown): void {
		const request = pending.get(requestId);
		if (!request) throw new Error('Unexpected Portal response ID.');
		pending.delete(requestId);
		request.cleanup();
		request.resolve(value);
	}

	function receiveArtifact(
		message: Extract<RelayMessage, { kind: 'artifact-chunk' | 'artifact-end' }>,
		request: PendingRequest,
	): void {
		const assembly = request.artifact;
		if (
			!assembly ||
			encodeCanonicalJson(message.reference) !== encodeCanonicalJson(assembly.request.reference)
		)
			throw new Error('Unexpected artifact reference.');
		if (message.kind === 'artifact-chunk') {
			const bytes = Buffer.from(message.contentBase64, 'base64');
			if (
				message.offsetBytes !== assembly.request.offsetBytes + assembly.bytes ||
				bytes.length === 0 ||
				bytes.length > 65_536 ||
				bytes.toString('base64') !== message.contentBase64 ||
				assembly.bytes + bytes.length > assembly.request.maxBytes
			)
				throw new Error('Invalid artifact chunk position or bounds.');
			assembly.chunks.push(bytes);
			assembly.bytes += bytes.length;
			return;
		}
		const expected = Math.min(
			assembly.request.maxBytes,
			Math.max(0, assembly.request.reference.byteLength - assembly.request.offsetBytes),
		);
		if (
			message.offsetBytes !== assembly.request.offsetBytes ||
			message.byteLength !== assembly.bytes ||
			assembly.bytes !== expected ||
			message.truncated !==
				message.offsetBytes + assembly.bytes < assembly.request.reference.byteLength
		)
			throw new Error('Invalid artifact completion.');
		finish(message.requestId, {
			contentBase64: Buffer.concat(assembly.chunks).toString('base64'),
			reference: message.reference,
			offsetBytes: message.offsetBytes,
			truncated: message.truncated,
			...(message.mediaType === undefined ? {} : { mediaType: message.mediaType }),
		});
	}

	function receive(message: RelayMessage): void {
		if (message.kind === 'ready') {
			if (!handshake || ready) throw new Error('Unexpected Portal handshake.');
			maximumPending = message.maxPendingRequests;
			maximumMessageBytes = message.maxMessageBytes;
			ready = true;
			handshake.resolve();
			handshake = undefined;
			return;
		}
		if (!('requestId' in message)) throw new Error('Unexpected Portal frame.');
		const request = pending.get(message.requestId);
		if (!request) throw new Error('Unexpected Portal response identity.');
		if (message.kind === 'artifact-chunk' || message.kind === 'artifact-end') {
			receiveArtifact(message, request);
			return;
		}
		if (message.kind === 'result') {
			finish(message.requestId, message.result);
			return;
		}
		if (message.kind === 'error') {
			pending.delete(message.requestId);
			request.cleanup();
			request.reject(
				new Error(`Portal relay request failed (${message.code}); dispatch=${message.dispatch}.`),
			);
			return;
		}
		throw new Error('Unexpected Portal response kind.');
	}

	async function requestOperation(
		operation: 'list' | 'search' | 'describe' | 'call' | 'artifact-read',
		argumentsValue: unknown,
		options?: { readonly signal?: AbortSignal; readonly resultGraceAfterAbortMs?: number },
		artifact?: PortalArtifactReadRequest,
	): Promise<unknown> {
		const signal = options?.signal;
		const graceMs = options?.resultGraceAfterAbortMs;
		if (graceMs !== undefined && (!Number.isInteger(graceMs) || graceMs <= 0)) {
			throw new TypeError('Tool Portal canonical-result grace must be a positive integer.');
		}
		if (!ready || closed || !socket) throw new Error('Portal execution connection is unavailable.');
		if (signal?.aborted) throw new Error('Portal request cancelled before dispatch.');
		if (
			pending.size >= maximumPending ||
			(artifact && [...pending.values()].some((request) => request.artifact))
		)
			throw new Error('Portal request capacity exceeded before dispatch.');
		const requestId = String(++nextId);
		const frame = encodeRelayFrame({
			kind: 'request',
			requestId,
			operation,
			request: argumentsValue,
		});
		if (frame.byteLength - frame.indexOf('\r\n\r\n') - 4 > maximumMessageBytes) {
			throw new Error('Portal message exceeds negotiated limit before dispatch.');
		}
		const activeSocket = socket;
		return await new Promise<unknown>((resolve, reject) => {
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			const abort = (): void => {
				// Keep the ID reserved until its terminal response; no response can be assigned to another call.
				activeSocket.write(encodeRelayFrame({ kind: 'cancel', requestId }));
				const rejectCancelled = (): void =>
					reject(new Error('Portal request cancelled; its effect may be uncertain.'));
				if (graceMs === undefined) rejectCancelled();
				else graceTimer = setTimeout(rejectCancelled, graceMs);
			};
			pending.set(requestId, {
				resolve,
				reject,
				cleanup: () => {
					signal?.removeEventListener('abort', abort);
					if (graceTimer !== undefined) clearTimeout(graceTimer);
				},
				...(artifact === undefined
					? {}
					: { artifact: { request: artifact, chunks: [], bytes: 0 } }),
			});
			signal?.addEventListener('abort', abort, { once: true });
			activeSocket.write(frame);
		});
	}

	return {
		connect: async (): Promise<void> => {
			if (closed || socket) throw new Error('Portal transport is already connected or closed.');
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => fail(new Error('Portal handshake timeout.')), 5_000);
				handshake = {
					resolve: () => {
						clearTimeout(timer);
						resolve();
					},
					reject: (error) => {
						clearTimeout(timer);
						reject(error);
					},
				};
				socket = createConnection(socketPath);
				socket.once('connect', () =>
					socket?.write(encodeRelayFrame({ kind: 'hello', version: 1 })),
				);
				socket.on('data', (chunk: Buffer) => {
					try {
						for (const message of decoder.feed(chunk)) receive(message);
					} catch {
						fail(new Error('Invalid Portal traffic; outstanding effects may be uncertain.'));
					}
				});
				socket.once('error', () =>
					fail(new Error('Portal connection failed; outstanding effects may be uncertain.')),
				);
				socket.once('close', () =>
					fail(new Error('Portal connection ended; outstanding effects may be uncertain.')),
				);
			});
		},
		close: async (): Promise<void> => {
			fail(new Error('Portal client closed; outstanding effects may be uncertain.'));
		},
		callTool: async (call, options) => {
			const operation = portalOperation(call.name);
			if (call.approvalToken !== undefined)
				throw new Error('Managed Portal cannot accept standalone approval tokens.');
			return {
				structuredContent: await requestOperation(operation, call.arguments, options),
			};
		},
		readResource: async (request, options) => {
			const range = PortalArtifactReadRequestSchema.parse(
				request['_meta']['agent-vm/artifact-read-request'],
			);
			if (
				encodeCanonicalJson(createPortalArtifactReadResourceRequest(range)) !==
				encodeCanonicalJson(request)
			)
				throw new Error('Artifact URI and range do not match.');
			const result = PortalArtifactReadResultSchema.parse(
				await requestOperation('artifact-read', range, options, range),
			);
			return {
				contents: [
					{
						kind: 'blob',
						blob: result.contentBase64,
						uri: request.uri,
						...(result.mediaType === undefined ? {} : { mediaType: result.mediaType }),
					},
				],
			};
		},
	};
}
