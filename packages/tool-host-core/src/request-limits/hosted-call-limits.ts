import type { HostedProxyLimits } from '#tool-host-core/request-limits/models/hosted-proxy-limits';
/** One queue per batch; admission lasts through the whole call, including its response. */
export function createBatchScheduler(batchConcurrency: number): {
	readonly run: <TResult>(call: () => Promise<TResult>) => Promise<TResult>;
} {
	let activeCalls = 0;
	const pending: (() => void)[] = [];
	return {
		async run<TResult>(call: () => Promise<TResult>): Promise<TResult> {
			if (activeCalls >= batchConcurrency)
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
import {
	projectProxyMcpResult,
	type PortalBatchResult,
	type PortalToolResult,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import { SERVER_INFO_META_KEY, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const hostedProtocolIdentity = { name: 'tool-host-cloudflare', version: '0.0.153' };
export function serializedHostedReplyBytes(result: unknown, id: string | number): number {
	const projected = z.record(z.string(), z.unknown()).parse(result);
	return serializedBytes({
		jsonrpc: '2.0',
		id,
		result: {
			...projected,
			resultType: 'complete',
			_meta: { [SERVER_INFO_META_KEY]: hostedProtocolIdentity },
		},
	});
}

const budgetCallSchema = z.object({
	id: z.string(),
	namespace: z.string(),
	toolName: z.string(),
	arguments: z.record(z.string(), z.unknown()),
});
import type { HostedRequestLimits } from '#tool-host-core/request-limits/models/hosted-request-limits';

/** Bound retained results before the gateway accumulates them; count the shared proxy projection. */
export function createHostedRequestLimits(limits: HostedProxyLimits): HostedRequestLimits {
	const scheduler = createBatchScheduler(limits.batchConcurrency);
	let input: unknown;
	let requestId: string | number = '';
	const retained: Record<string, PortalToolResult> = {};
	const startedCalls = new Set<string>();
	return {
		callHasStarted: (itemId) => startedCalls.has(itemId),
		begin: (value, id) => {
			input = value;
			requestId = id;
			const rawCalls =
				typeof value === 'object' && value !== null && 'calls' in value ? value.calls : undefined;
			if (Array.isArray(rawCalls) && rawCalls.length > limits.batchCalls)
				return {
					ok: false,
					diagnostics: [],
					results: {},
					errors: [{ kind: 'too_many_calls', message: 'Worker batches allow at most 50 calls.' }],
				};
			const parsed = z.object({ calls: z.array(budgetCallSchema) }).safeParse(value);
			if (!parsed.success) return undefined;
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
				// Crossing this invocation boundary may cause an effect, even if its outcome is failed or unknown.
				startedCalls.add(invocation.operationKey.item);
				const outcome = await call();
				if (outcome.kind !== 'completed') return outcome;
				const result = outcome.result;
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
					result: projectHostedLimitRefusals({
						ok: true,
						errors: [],
						diagnostics: [],
						results: retained,
					}),
				});
				if (serializedHostedReplyBytes(projected, requestId) > limits.replyBytes) {
					if (previous === undefined) delete retained[id];
					else retained[id] = previous;
					return { kind: 'failed', reason: 'too-large' };
				}
				return { kind: 'completed', result };
			}),
	};
}

/** Worker-only limit refusals have an explicit public reason rather than an opaque dispatcher error. */
export function projectHostedLimitRefusals(result: PortalBatchResult): PortalBatchResult {
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

interface HostedToolResultProjection {
	readonly operation: Parameters<typeof projectProxyMcpResult>[0]['operation'];
	readonly input: unknown;
	readonly result: PortalBatchResult;
	readonly callHasStarted: (itemId: string) => boolean;
}

/** Stable request order within no-effect, ran/unknown, and completed classes. */
export function hostedReplyTrimOrder(props: HostedToolResultProjection): readonly string[] {
	let requestIds: string[];
	if (props.operation === 'direct') {
		// The Worker assigns exactly one item to a native direct call.
		requestIds = Object.entries(props.result.results).map(([id]) => id);
	} else {
		const ids = z.array(z.object({ id: z.string() }));
		const requested =
			props.operation === 'mcp_portal_call'
				? z.object({ calls: ids }).safeParse(props.input)
				: z.object({ requests: ids }).safeParse(props.input);
		if (!requested.success) return [];
		const requests = 'calls' in requested.data ? requested.data.calls : requested.data.requests;
		requestIds = requests.map((request) => request.id);
	}
	const noEffect: string[] = [];
	const ranOrUnknown: string[] = [];
	const completed: string[] = [];
	for (const id of requestIds) {
		const item = props.result.results[id];
		if (item === undefined) continue;
		if (!props.callHasStarted(id)) noEffect.push(id);
		else if (item.ok) completed.push(id);
		else ranOrUnknown.push(id);
	}
	return [...noEffect, ...ranOrUnknown, ...completed];
}

/** Include every emitted item; preserve completed effects until no-effect output has been trimmed. */
export function projectBoundedHostedToolResult(
	props: HostedToolResultProjection & {
		readonly requestId: string | number;
		readonly limits: HostedProxyLimits;
	},
): { readonly result: PortalBatchResult; readonly response: CallToolResult } {
	// A raw-count refusal must not revalidate descriptors in the shared projection.
	const projectionInput = props.result.errors.some((error) => error.kind === 'too_many_calls')
		? {}
		: props.input;
	const project = (result: PortalBatchResult, input: unknown = projectionInput): CallToolResult =>
		projectProxyMcpResult({
			operation: props.operation,
			input,
			result: projectHostedLimitRefusals(result),
		});
	const fits = (response: CallToolResult): boolean =>
		serializedHostedReplyBytes(response, props.requestId) <= props.limits.replyBytes;
	const original = project(props.result);
	if (fits(original)) return { result: props.result, response: original };
	// Trim certain no-effect output first; an executed call result is the last thing to discard.
	if (props.result.errors.length === 0) {
		const results: Record<string, PortalToolResult> = { ...props.result.results };
		for (const id of hostedReplyTrimOrder(props)) {
			results[id] = { ok: false, input: {}, error: { kind: 'failed', reason: 'too-large' } };
			const bounded: PortalBatchResult = { ...props.result, ok: false, results };
			const response = project(bounded);
			if (fits(response)) return { result: bounded, response };
		}
	}
	// Scalar validation errors, diagnostics or even identifiers may themselves exceed the reply budget.
	const refused: PortalBatchResult = {
		ok: false,
		diagnostics: [],
		results: {},
		errors: [{ kind: 'too_large_result', message: 'Tool result exceeds the Worker reply limit.' }],
	};
	return { result: refused, response: project(refused, {}) };
}
