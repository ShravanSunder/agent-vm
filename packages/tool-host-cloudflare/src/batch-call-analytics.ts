import type { PortalBatchResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import { z } from 'zod';

import {
	writeCallAnalytics,
	type CallAnalytics,
	type CallAnalyticsBinding,
} from '#worker-host/call-analytics';
import { serializedBytes } from '#worker-host/worker-call-limits';

export function recordBatchCallAnalytics(props: {
	readonly organizationId: string;
	readonly organizationName: string;
	readonly agentClientId: string;
	readonly mode: 'direct' | 'indirect';
	readonly input: unknown;
	readonly result: PortalBatchResult;
	readonly startedAt: number;
	readonly binding: CallAnalyticsBinding;
	readonly log: (event: { readonly event: 'analytics-write-dropped' }) => void;
	readonly trustedTool: (namespace: string, toolName: string) => boolean;
	readonly requiresApproval: (namespace: string, toolName: string) => boolean;
}): void {
	const parsed = z
		.object({
			calls: z.array(
				z.object({
					id: z.string(),
					namespace: z.string(),
					toolName: z.string(),
					arguments: z.unknown(),
				}),
			),
		})
		.safeParse(props.input);
	if (!parsed.success) return;
	for (const call of parsed.data.calls) {
		const item = props.result.results[call.id];
		const known = props.trustedTool(call.namespace, call.toolName);
		const needsApproval = known && props.requiresApproval(call.namespace, call.toolName);
		let outcome: CallAnalytics['outcome'] = 'refused';
		let failureKind: CallAnalytics['failureKind'] = 'authorization';
		if (item?.ok === true) {
			outcome = 'ran';
			failureKind = 'none';
		} else if (item !== undefined) {
			const error = z
				.object({ kind: z.string().optional(), reason: z.string().optional() })
				.safeParse(item.error);
			if (
				needsApproval &&
				(error.data?.kind === 'approval_token_invalid' ||
					error.data?.kind === 'approval_token_missing' ||
					error.data?.kind === 'not-dispatched')
			) {
				outcome = 'needs approval';
				failureKind = 'approval';
			} else if (
				error.data?.kind === 'failed' ||
				error.data?.kind === 'ambiguous' ||
				error.data?.kind === 'upstream_call_failed'
			) {
				outcome = 'failed';
				failureKind =
					error.data.reason === 'too-large' || error.data.reason === 'upstream-response-too-large'
						? 'too-large'
						: 'upstream';
			}
		}
		writeCallAnalytics({
			binding: props.binding,
			log: props.log,
			call: {
				organizationId: props.organizationId,
				organizationName: props.organizationName,
				agentName: props.agentClientId,
				mode: props.mode,
				serverName: known ? call.namespace : 'unknown',
				toolName: known ? call.toolName : 'unknown',
				outcome,
				failureKind,
				durationMs: Math.max(0, Date.now() - props.startedAt),
				requestBytes: serializedBytes(call.arguments),
				responseBytes: item === undefined ? 0 : serializedBytes(item),
			},
		});
	}
}
