export const workerRequestBodyBytes = 4 * 1024 * 1024;
export const workerUpstreamResponseBytes = 4 * 1024 * 1024;
export const workerReplyBytes = 16 * 1024 * 1024;
export const workerBatchCalls = 50;
export const workerBatchConcurrency = 6;

/** One queue per batch; admission lasts through the whole call, including its response. */
export function createBatchScheduler(): {
	readonly run: <TResult>(call: () => Promise<TResult>) => Promise<TResult>;
} {
	let activeCalls = 0;
	const pending: (() => void)[] = [];
	return {
		async run<TResult>(call: () => Promise<TResult>): Promise<TResult> {
			if (activeCalls >= workerBatchConcurrency)
				await new Promise<void>((resolve) => pending.push(resolve));
			else activeCalls += 1;
			try {
				return await call();
			} finally {
				const next = pending.shift();
				if (next === undefined) activeCalls -= 1;
				else next();
			}
		},
	};
}

export function serializedBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
import { jsonValueSchema } from '@agent-collaboration/tool-access/contracts';
import { upstreamMcpFailureDetailsFromUnknown } from '@agent-collaboration/tool-engine/connectors';
import type { DispatchInvocation, ResourceResult } from '@agent-collaboration/tool-engine/dispatch';
import {
	projectProxyMcpResult,
	type PortalBatchResult,
	type PortalToolResult,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import { SERVER_INFO_META_KEY } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const workerProtocolIdentity = { name: 'tool-host-cloudflare', version: '0.0.153' };
export function serializedWorkerReplyBytes(result: unknown, id: string | number): number {
	const projected = z.record(z.string(), z.unknown()).parse(result);
	return serializedBytes({
		jsonrpc: '2.0',
		id,
		result: {
			...projected,
			resultType: 'complete',
			_meta: { [SERVER_INFO_META_KEY]: workerProtocolIdentity },
		},
	});
}

const budgetCallSchema = z.object({
	id: z.string(),
	namespace: z.string(),
	toolName: z.string(),
	arguments: z.record(z.string(), z.unknown()),
});
export interface WorkerRequestLimits {
	readonly begin: (input: unknown, id: string | number) => PortalBatchResult | undefined;
	readonly invoke: (
		invocation: DispatchInvocation,
		call: () => Promise<unknown>,
	) => Promise<ResourceResult>;
}

/** Bound retained results before the gateway accumulates them; count the shared proxy projection. */
export function createWorkerRequestLimits(): WorkerRequestLimits {
	const scheduler = createBatchScheduler();
	let input: unknown;
	let requestId: string | number = '';
	const retained: Record<string, PortalToolResult> = {};
	return {
		begin: (value, id) => {
			input = value;
			requestId = id;
			const parsed = z.object({ calls: z.array(budgetCallSchema) }).safeParse(value);
			if (!parsed.success) return undefined;
			if (parsed.data.calls.length > workerBatchCalls)
				return {
					ok: false,
					diagnostics: [],
					results: {},
					errors: [{ kind: 'too_many_calls', message: 'Worker batches allow at most 50 calls.' }],
				};
			for (const call of parsed.data.calls)
				retained[call.id] = {
					ok: false,
					input: call,
					error: { kind: 'failed', reason: 'too-large' },
				};
			return undefined;
		},
		invoke: async (invocation, call) =>
			scheduler.run(async () => {
				let value: unknown;
				try {
					value = await call();
				} catch (error) {
					const failure = upstreamMcpFailureDetailsFromUnknown(error);
					return {
						kind: 'failed',
						reason:
							failure?.causeMessage?.startsWith('MCP upstream response exceeded') === true
								? 'upstream-response-too-large'
								: 'upstream-unavailable',
					};
				}
				const result = jsonValueSchema.parse(value);
				const id = invocation.operationKey.item;
				const previous = retained[id];
				retained[id] = {
					ok: true,
					input: {},
					output: {
						namespace: invocation.capability.namespace,
						toolName: invocation.capability.tool,
						result,
					},
				};
				const projected = projectProxyMcpResult({
					operation: 'mcp_portal_call',
					input,
					result: projectWorkerLimitRefusals({
						ok: true,
						errors: [],
						diagnostics: [],
						results: retained,
					}),
				});
				if (serializedWorkerReplyBytes(projected, requestId) > workerReplyBytes) {
					if (previous === undefined) delete retained[id];
					else retained[id] = previous;
					return { kind: 'failed', reason: 'too-large' };
				}
				return { kind: 'completed', result };
			}),
	};
}

/** Worker-only limit refusals have an explicit public reason rather than an opaque dispatcher error. */
export function projectWorkerLimitRefusals(result: PortalBatchResult): PortalBatchResult {
	return {
		...result,
		results: Object.fromEntries(
			Object.entries(result.results).map(([id, item]) => {
				if (item.ok) return [id, item];
				const failure = z
					.object({
						kind: z.literal('failed'),
						reason: z.enum(['too-large', 'upstream-response-too-large']),
					})
					.safeParse(item.error);
				return [
					id,
					failure.success
						? {
								...item,
								error: {
									kind: 'too_large_result',
									message:
										failure.data.reason === 'too-large'
											? 'Tool result exceeds the Worker reply limit.'
											: 'Tool server response exceeds 4 MiB.',
								},
							}
						: item,
				];
			}),
		),
	};
}
