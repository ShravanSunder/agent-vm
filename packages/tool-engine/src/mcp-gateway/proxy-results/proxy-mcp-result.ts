import { type JsonValue } from '@agent-collaboration/tool-access/contracts';
import type { CallToolResult } from '@modelcontextprotocol/server';

import type { InputValidationIssue } from '#mcp-gateway/portal-tools/models/input-validation-results';
import { callExecutionInputSchema } from '#mcp-gateway/portal-tools/models/portal-tool-contracts';
import type {
	PortalBatchDiagnostic,
	PortalBatchResult,
	PortalToolResult,
} from '#mcp-gateway/portal-tools/models/portal-tool-contracts';
import type { ProxyMcpOperation } from '#mcp-gateway/proxy-results/models/proxy-mcp-result';

interface ProxyItemError {
	readonly code: string;
	readonly message: string;
	readonly issueCount?: number;
	readonly issues?: readonly InputValidationIssue[];
	readonly issuesTruncated?: number;
	readonly namespace?: string;
	readonly toolName?: string;
	readonly upstream?: unknown;
}
type ProxyCoreItem =
	| {
			readonly content: readonly { readonly type: 'json'; readonly value: unknown }[];
			readonly requestId: string;
			readonly status: 'success';
			readonly structuredContent: unknown;
	  }
	| { readonly error: ProxyItemError; readonly requestId: string; readonly status: 'failed' };
interface ProxyCoreResult {
	readonly auditEvents: readonly PortalBatchDiagnostic[];
	readonly content: readonly { readonly type: 'json'; readonly value: unknown }[];
	readonly items: readonly ProxyCoreItem[];
	readonly structuredContent?: PortalBatchResult;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function errorRecordFromUnknown(error: unknown): Record<string, unknown> {
	return isUnknownRecord(error) ? error : {};
}
function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
function isProjectionJsonValue(value: unknown, active = new Set<object>()): value is JsonValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	)
		return true;
	if (typeof value !== 'object' || active.has(value)) return false;
	active.add(value);
	const valid =
		(Array.isArray(value) && value.every((entry) => isProjectionJsonValue(entry, active))) ||
		(isUnknownRecord(value) &&
			Object.values(value).every((entry) => isProjectionJsonValue(entry, active)));
	active.delete(value);
	return valid;
}
function isJsonValueArray(value: unknown): value is readonly JsonValue[] {
	return Array.isArray(value) && value.every((entry) => isProjectionJsonValue(entry));
}
function isValidationIssueReceived(
	value: unknown,
): value is { readonly preview?: string; readonly type: string } {
	return (
		isUnknownRecord(value) &&
		typeof value.type === 'string' &&
		(value.preview === undefined || typeof value.preview === 'string')
	);
}
function isValidationIssue(value: unknown): value is InputValidationIssue {
	return (
		isUnknownRecord(value) &&
		typeof value.code === 'string' &&
		typeof value.message === 'string' &&
		Array.isArray(value.path) &&
		value.path.every((part) => typeof part === 'string' || typeof part === 'number') &&
		(value.expected === undefined || typeof value.expected === 'string') &&
		(value.keys === undefined || isStringArray(value.keys)) &&
		(value.received === undefined || isValidationIssueReceived(value.received)) &&
		(value.values === undefined || isJsonValueArray(value.values))
	);
}
function validationIssuesFromUnknown(error: unknown): readonly InputValidationIssue[] | undefined {
	const issues = errorRecordFromUnknown(error).issues;
	if (!Array.isArray(issues)) return undefined;
	const selected = issues.filter((issue): issue is InputValidationIssue =>
		isValidationIssue(issue),
	);
	return selected.length > 0 ? selected : undefined;
}
function receivedValueLabel(received: InputValidationIssue['received']): string | undefined {
	if (received === undefined) return undefined;
	if (received.preview === undefined) return received.type;
	const preview = received.type === 'string' ? JSON.stringify(received.preview) : received.preview;
	return `${received.type} ${preview}`;
}
function validationIssueSummary(issue: InputValidationIssue): string {
	const path = issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.');
	const details = [
		issue.expected === undefined ? undefined : `expected ${issue.expected}`,
		issue.values === undefined
			? undefined
			: `allowed values ${issue.values.map((value) => JSON.stringify(value) ?? '[unserializable-json-value]').join(', ')}`,
		issue.keys === undefined ? undefined : `unrecognized keys ${issue.keys.join(', ')}`,
		receivedValueLabel(issue.received) === undefined
			? undefined
			: `received ${receivedValueLabel(issue.received)}`,
		issue.message,
	].filter((detail): detail is string => detail !== undefined);
	return `${path}: ${details.join('; ')}`;
}
function messageFromUnknown(error: unknown): string {
	if (error instanceof Error) return error.message;
	const issues = validationIssuesFromUnknown(error);
	if (issues !== undefined) {
		const shown = issues.slice(0, 5);
		const remaining = issues.length - shown.length;
		const suffix =
			remaining > 0
				? ` | ${String(remaining)} more validation issue(s) omitted; call describe for the exact schema.`
				: '';
		return `Input validation failed: ${shown.map(validationIssueSummary).join(' | ')}${suffix}`;
	}
	const message = errorRecordFromUnknown(error).message;
	return typeof message === 'string' ? message : String(error);
}
function itemErrorFromPortalResult(
	result: Extract<PortalToolResult, { readonly ok: false }>,
): ProxyItemError {
	const record = errorRecordFromUnknown(result.error);
	const issues = validationIssuesFromUnknown(result.error);
	const shown = issues?.slice(0, 5);
	const truncated =
		issues === undefined || shown === undefined ? undefined : issues.length - shown.length;
	return {
		code: typeof record.kind === 'string' ? record.kind : 'portal_item_failed',
		message: messageFromUnknown(result.error),
		...(issues === undefined || shown === undefined
			? {}
			: {
					issueCount: issues.length,
					issues: shown,
					...(truncated === undefined || truncated <= 0 ? {} : { issuesTruncated: truncated }),
				}),
		...(typeof record.namespace === 'string' ? { namespace: record.namespace } : {}),
		...(typeof record.toolName === 'string' ? { toolName: record.toolName } : {}),
		...(record.upstream === undefined ? {} : { upstream: record.upstream }),
	};
}
function projectItem(requestId: string, result: PortalToolResult): ProxyCoreItem {
	return result.ok
		? {
				content: [{ type: 'json', value: result.output }],
				requestId,
				status: 'success',
				structuredContent: result.output,
			}
		: { error: itemErrorFromPortalResult(result), requestId, status: 'failed' };
}
function scalarResult(result: PortalBatchResult): ProxyCoreResult {
	return {
		auditEvents: result.diagnostics.map((diagnostic) => ({ ...diagnostic })),
		content: [{ type: 'json', value: result }],
		items: [],
		structuredContent: result,
	};
}

/** Preserve the proxy's text-wrapped core result, independently of its HTTP or stdio host. */
export function projectProxyMcpResult(props: {
	readonly operation: ProxyMcpOperation;
	readonly input: unknown;
	readonly result: PortalBatchResult;
}): CallToolResult {
	const parsed = callExecutionInputSchema.safeParse(props.input);
	let core: ProxyCoreResult;
	if (props.operation === 'direct' && props.result.errors.length === 0) {
		const result = Object.values(props.result.results)[0];
		core = {
			auditEvents: props.result.diagnostics.map((diagnostic) => ({ ...diagnostic })),
			content: [],
			items: result === undefined ? [] : [projectItem('catalog-call', result)],
		};
	} else if (
		props.operation !== 'mcp_portal_call' ||
		!parsed.success ||
		props.result.errors.length > 0
	) {
		core = scalarResult(props.result);
	} else {
		core = {
			auditEvents: props.result.diagnostics.map((diagnostic) => ({ ...diagnostic })),
			content: [],
			items: parsed.data.calls.map((request): ProxyCoreItem => {
				const result = props.result.results[request.id];
				return result === undefined
					? {
							error: {
								code: 'portal_item_missing',
								message: `MCP Portal did not return a result for request "${request.id}".`,
								namespace: request.namespace,
								toolName: request.toolName,
							},
							requestId: request.id,
							status: 'failed',
						}
					: projectItem(request.id, result);
			}),
		};
	}
	const failed =
		core.items.some((item) => item.status === 'failed') || core.structuredContent?.ok === false;
	return {
		content: [{ text: JSON.stringify(core), type: 'text' }],
		...(failed ? { isError: true } : {}),
	};
}
