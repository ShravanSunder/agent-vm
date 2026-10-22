import {
	Client,
	StreamableHTTPClientTransport,
	type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import type { ToolPortalMcpResourceContent, ToolPortalMcpTransport } from './index.js';

const standaloneToolPortalApprovalMetaKey = 'agent-vm/tool-portal-approval-token';

export type CreateNodeToolPortalMcpTransportProps =
	| {
			readonly authorization: string;
			readonly endpoint: URL;
			readonly kind: 'http';
	  }
	| {
			readonly argv: readonly string[];
			readonly executable: string;
			readonly kind: 'scoped-stdio';
	  };

type NodeToolPortalSdkTransport = StdioClientTransport | StreamableHTTPClientTransport;

interface PendingRequestCapture {
	aborted: boolean;
	readonly method: string;
	requestId?: number | string;
	readonly sendCancellation: (requestId: number | string) => void;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeResourceContent(
	content: Awaited<ReturnType<Client['readResource']>>['contents'][number],
): ToolPortalMcpResourceContent {
	if ('blob' in content) {
		return content.mimeType === undefined
			? { blob: content.blob, kind: 'blob', uri: content.uri }
			: { blob: content.blob, kind: 'blob', mediaType: content.mimeType, uri: content.uri };
	}
	return content.mimeType === undefined
		? { kind: 'text', text: content.text, uri: content.uri }
		: { kind: 'text', mediaType: content.mimeType, text: content.text, uri: content.uri };
}

function createSdkTransport(
	props: CreateNodeToolPortalMcpTransportProps,
): NodeToolPortalSdkTransport {
	if (props.kind === 'http') {
		return new StreamableHTTPClientTransport(props.endpoint, {
			requestInit: {
				headers: { authorization: `Bearer ${props.authorization}` },
			},
		});
	}
	return new StdioClientTransport({
		args: [...props.argv],
		command: props.executable,
		stderr: 'pipe',
	});
}

function createClientTransportBridge(
	transport: NodeToolPortalSdkTransport,
	pendingRequestCaptures: PendingRequestCapture[],
): Transport {
	const clientTransport: Transport = {
		close: async () => await transport.close(),
		send: async (message, options) => {
			const messageRecord: unknown = message;
			if (
				isObjectRecord(messageRecord) &&
				typeof messageRecord['method'] === 'string' &&
				(typeof messageRecord['id'] === 'number' || typeof messageRecord['id'] === 'string')
			) {
				const requestMethod = messageRecord['method'];
				const requestId = messageRecord['id'];
				const captureIndex = pendingRequestCaptures.findIndex(
					(capture) => capture.method === requestMethod && capture.requestId === undefined,
				);
				const capture =
					captureIndex < 0 ? undefined : pendingRequestCaptures.splice(captureIndex, 1)[0];
				if (capture !== undefined) {
					capture.requestId = requestId;
					if (capture.aborted) capture.sendCancellation(requestId);
				}
			}
			if (transport instanceof StreamableHTTPClientTransport) {
				await transport.send(
					message,
					options === undefined
						? undefined
						: {
								...(options.resumptionToken === undefined
									? {}
									: { resumptionToken: options.resumptionToken }),
								...(options.onresumptiontoken === undefined
									? {}
									: { onresumptiontoken: options.onresumptiontoken }),
								...(options.requestSignal === undefined
									? {}
									: { requestSignal: options.requestSignal }),
								...(options.onRequestStreamEnd === undefined
									? {}
									: { onRequestStreamEnd: options.onRequestStreamEnd }),
								...(options.headers === undefined ? {} : { headers: options.headers }),
							},
				);
			} else {
				await transport.send(message);
			}
		},
		start: async () => {
			// oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport uses callback properties, not EventTarget.
			transport.onclose = () => clientTransport.onclose?.();
			// oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport uses callback properties, not EventTarget.
			transport.onerror = (error) => clientTransport.onerror?.(error);
			// oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport uses callback properties, not EventTarget.
			transport.onmessage = (message) => clientTransport.onmessage?.(message);
			await transport.start();
		},
		...(transport instanceof StreamableHTTPClientTransport
			? {
					hasPerRequestStream: true,
					setProtocolVersion: (version: string): void => transport.setProtocolVersion(version),
				}
			: {}),
	};
	if (transport instanceof StdioClientTransport) {
		// Expose the documented stdio shape so negotiation classifies this bridge correctly.
		Object.defineProperties(clientTransport, {
			stderr: { get: () => transport.stderr },
			pid: { get: () => transport.pid },
		});
	}
	return clientTransport;
}

/** Standard MCP transport adapter for the portable Tool Portal client. */
export function createNodeToolPortalMcpTransport(
	props: CreateNodeToolPortalMcpTransportProps,
): ToolPortalMcpTransport {
	const client = new Client(
		{ name: 'tool-portal', version: '1.0.0' },
		{ versionNegotiation: { mode: { pin: '2026-07-28' } } },
	);
	const transport = createSdkTransport(props);
	const pendingRequestCaptures: PendingRequestCapture[] = [];
	const clientTransport = createClientTransportBridge(transport, pendingRequestCaptures);

	async function requestWithCanonicalResultGrace<TResult>(requestProps: {
		readonly method: string;
		readonly options?: { readonly resultGraceAfterAbortMs?: number; readonly signal?: AbortSignal };
		readonly request: () => Promise<TResult>;
	}): Promise<TResult> {
		const signal = requestProps.options?.signal;
		const graceMilliseconds = requestProps.options?.resultGraceAfterAbortMs;
		if (signal === undefined || graceMilliseconds === undefined)
			return await requestProps.request();
		if (!Number.isInteger(graceMilliseconds) || graceMilliseconds <= 0) {
			throw new TypeError('Tool Portal canonical-result grace must be a positive integer.');
		}
		if (props.kind === 'http') {
			// Modern HTTP cancellation closes the response stream: its effective grace is zero.
			// Keep the existing grace-expired error identity and uncertainty semantics.
			try {
				return await requestProps.request();
			} catch (error) {
				if (signal.aborted) throw signal.reason ?? new Error('Tool Portal request interrupted.');
				throw error;
			}
		}
		let rejectAfterGrace: ((reason: unknown) => void) | undefined;
		let graceTimer: NodeJS.Timeout | undefined;
		let cancellationSent = false;
		const sendCancellation = (requestId: number | string): void => {
			if (cancellationSent) return;
			cancellationSent = true;
			void client
				.notification({
					method: 'notifications/cancelled',
					params: { reason: String(signal.reason), requestId },
				})
				.catch(() => undefined);
		};
		const capture: PendingRequestCapture = {
			aborted: signal.aborted,
			method: requestProps.method,
			sendCancellation,
		};
		pendingRequestCaptures.push(capture);
		const cancellationDeadline = new Promise<never>((_resolve, reject) => {
			rejectAfterGrace = reject;
		});
		const onAbort = (): void => {
			capture.aborted = true;
			if (capture.requestId !== undefined) sendCancellation(capture.requestId);
			graceTimer = setTimeout(
				() => rejectAfterGrace?.(signal.reason ?? new Error('Tool Portal request interrupted.')),
				graceMilliseconds,
			);
		};
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) onAbort();
		try {
			return await Promise.race([requestProps.request(), cancellationDeadline]);
		} finally {
			signal.removeEventListener('abort', onAbort);
			if (graceTimer !== undefined) clearTimeout(graceTimer);
			const captureIndex = pendingRequestCaptures.indexOf(capture);
			if (captureIndex >= 0) pendingRequestCaptures.splice(captureIndex, 1);
		}
	}
	return {
		callTool: async (call, options) => {
			if (!isObjectRecord(call.arguments)) {
				throw new TypeError('Tool Portal MCP arguments must be an object.');
			}
			const callArguments = call.arguments;
			const sdkRequestOptions =
				props.kind === 'http' || options?.resultGraceAfterAbortMs === undefined
					? options
					: undefined;
			const result = await requestWithCanonicalResultGrace({
				method: 'tools/call',
				...(options === undefined ? {} : { options }),
				request: async () =>
					await client.callTool(
						{
							...(call.approvalToken === undefined
								? {}
								: {
										_meta: {
											[standaloneToolPortalApprovalMetaKey]: call.approvalToken,
										},
									}),
							arguments: callArguments,
							name: call.name,
						},
						sdkRequestOptions,
					),
			});
			return result.structuredContent === undefined
				? {}
				: { structuredContent: result.structuredContent };
		},
		close: async () => {
			await client.close();
		},
		connect: async () => {
			await client.connect(clientTransport);
		},
		readResource: async (request, options) => {
			const sdkRequestOptions =
				props.kind === 'http' || options?.resultGraceAfterAbortMs === undefined
					? options
					: undefined;
			const result = await requestWithCanonicalResultGrace({
				method: 'resources/read',
				...(options === undefined ? {} : { options }),
				request: async () => await client.readResource(request, sdkRequestOptions),
			});
			return { contents: result.contents.map(normalizeResourceContent) };
		},
	};
}
