import {
	PortalCallRequestSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
	type PortalBackendDescribeResult,
	type PortalBackendListResult,
	type PortalBackendSearchResult,
	type PortalCallResult,
} from '@agent-vm/agent-portal-sdk';
import type { ToolPortalBackendKind } from '@agent-vm/config-contracts';
import type { GatewayRuntimeToolPortalDispatchAuthority } from '@agent-vm/gateway-control-contracts';
import type { ToolPortalApprovalPort, ToolPortalBackendPort } from '@agent-vm/tool-portal';

export class GatewayRuntimeUnavailablePortError extends Error {
	readonly code = 'runtime-port-unavailable';

	constructor(message: string) {
		super(message);
		this.name = GatewayRuntimeUnavailablePortError.name;
	}
}

function operationIdFromDispatchAuthority(
	authority: GatewayRuntimeToolPortalDispatchAuthority,
): string {
	switch (authority.kind) {
		case 'without-approval':
			return authority.operationId;
		case 'approval-grant':
			return authority.grant.operationId;
		case 'controller-approval-reservation':
			return authority.reservation.operationId;
		default: {
			const unreachableAuthority: never = authority;
			throw new Error(`Unsupported dispatch authority: ${String(unreachableAuthority)}`);
		}
	}
}

function unavailableCallResult(props: {
	readonly owningGeneration: string;
	readonly request: Parameters<ToolPortalBackendPort<ToolPortalBackendKind>['call']>[0];
	readonly authority: GatewayRuntimeToolPortalDispatchAuthority;
}): PortalCallResult {
	const request = PortalCallRequestSchema.parse(props.request);
	const operationId = operationIdFromDispatchAuthority(props.authority);
	return {
		items: request.calls.map((call) => ({
			error: {
				code: 'capability_denied',
				message: 'Gateway runtime backend is not available in this implementation slice.',
				safeDiagnostic: {
					code: 'capability_denied',
					level: 'error',
					safeMessage: 'Gateway runtime backend is unavailable.',
				},
			},
			id: call.id,
			operationId,
			outcome: {
				certainty: 'proven',
				kind: 'not-dispatched',
				retryClass: 'safe-before-dispatch',
			},
			owningGeneration: props.owningGeneration,
			status: 'error',
		})),
		ok: false,
	};
}

function emptyListResult(request: unknown): PortalBackendListResult {
	const parsedRequest = PortalListRequestSchema.parse(request);
	return {
		items: parsedRequest.requests.map((item) => ({
			id: item.id,
			status: 'ok',
			value: { namespaces: [], tools: [] },
		})),
		ok: true,
	};
}

function emptySearchResult(request: unknown): PortalBackendSearchResult {
	const parsedRequest = PortalSearchRequestSchema.parse(request);
	return {
		items: parsedRequest.requests.map((item) => ({
			id: item.id,
			status: 'ok',
			value: { tools: [] },
		})),
		ok: true,
	};
}

function emptyDescribeResult(request: unknown): PortalBackendDescribeResult {
	const parsedRequest = PortalDescribeRequestSchema.parse(request);
	return {
		items: parsedRequest.requests.map((item) => ({
			id: item.id,
			status: 'ok',
			value: { tools: [] },
		})),
		ok: true,
	};
}

export function createGatewayRuntimeUnavailableBackendPort<
	TBackendKind extends Exclude<ToolPortalBackendKind, 'mcp_provider'>,
>(props: {
	readonly backendKind: TBackendKind;
	readonly owningGeneration: string;
}): ToolPortalBackendPort<TBackendKind> {
	return {
		backendKind: props.backendKind,
		call: async (request, options) =>
			unavailableCallResult({
				authority: options.dispatchAuthority,
				owningGeneration: props.owningGeneration,
				request,
			}),
		describe: async (request) => emptyDescribeResult(request),
		list: async (request) => emptyListResult(request),
		search: async (request) => emptySearchResult(request),
	};
}

export function createGatewayRuntimeUnavailableApprovalPort(): ToolPortalApprovalPort {
	return {
		reserveDispatch: async ({ intent }) => ({
			kind: 'not-dispatched',
			operationId: intent.operationId,
			reason: 'stale-authority',
		}),
		armDispatch: async ({ reservation }) => ({
			kind: 'not-dispatched',
			operationId: reservation.operationId,
			reason: 'stale-authority',
		}),
	};
}

export async function rejectUnavailableGatewayRuntimeSandboxDispatch(): Promise<never> {
	throw new GatewayRuntimeUnavailablePortError(
		'Gateway runtime sandbox operations require the live Tool VM binding port.',
	);
}
