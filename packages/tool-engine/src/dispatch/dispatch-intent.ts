import type { JsonValue } from '@agent-collaboration/tool-access/contracts';

import type { DispatchInvocation } from '#dispatch/dispatch-contracts';

/** V1 sorts object keys by UTF-16 code units, independently of the host locale. */
export function canonicalDispatchJson(value: JsonValue): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalDispatchJson).join(',')}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalDispatchJson(value[key] ?? null)}`)
		.join(',')}}`;
}
export async function dispatchIntentDigest(
	invocation: Omit<DispatchInvocation, 'intentDigest' | 'approvalReceiptRef'>,
): Promise<string> {
	const bytes = new TextEncoder().encode(
		canonicalDispatchJson({
			version: 'tool-intent-v1',
			authority: invocation.authority,
			capability: invocation.capability,
			arguments: invocation.arguments,
			backendKind: invocation.backendKind,
			bindingRevision: invocation.bindingRevision,
			surface: invocation.surface,
		}),
	);
	const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
