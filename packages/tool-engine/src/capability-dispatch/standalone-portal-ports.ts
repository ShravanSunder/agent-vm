import type {
	AssessAccessInput,
	HostAccessBinding,
	PortalCallRequest,
	PortalCallResult,
	PortalDescribeRequest,
	PortalDescribeResult,
	PortalListRequest,
	PortalListResult,
	PortalSearchRequest,
	PortalSearchResult,
} from '@agent-collaboration/tool-access/contracts';

import type {
	ApprovalPort,
	BackendKind,
	DispatchRequest,
	OperationPort,
	ToolBackend,
} from '#capability-dispatch/models/dispatch-contracts';
import type { ToolPortalDiscoveryEntry } from '#capability-dispatch/portal-discovery-merger';

export type StandalonePortalCallItem = PortalCallResult['items'][number];
export interface StandalonePortalCallPlan {
	readonly call: PortalCallRequest['calls'][number];
	readonly operationId: string;
	readonly requiresApproval: boolean;
	readonly request: DispatchRequest;
}

/** Resource-owned authority for one exact batch; the core never creates approval decisions. */
export interface StandalonePortalPreparedBatch {
	readonly approvals: ApprovalPort;
	readonly operations: OperationPort;
	readonly backends: ReadonlyMap<BackendKind, ToolBackend<BackendKind>>;
	readonly admissionItem: (operationId: string) => StandalonePortalCallItem | undefined;
	readonly backendItem: (operationId: string) => StandalonePortalCallItem | undefined;
	readonly release: () => void;
}

/** All fields come from a host-authenticated invocation, never from model arguments. */
export interface StandalonePortalInvocation<TReadOptions> {
	readonly authority: string;
	readonly principal: string;
	readonly verifiedContextRef: string;
	readonly owningGeneration: string;
	readonly correlation: DispatchRequest['correlation'];
	readonly entries: readonly ToolPortalDiscoveryEntry<TReadOptions>[];
	readonly readOptions: TReadOptions;
	readonly accessForCall: (call: PortalCallRequest['calls'][number]) => Promise<AssessAccessInput>;
	readonly operationId: (callId: string) => string;
	readonly prepareBatch: (
		plans: readonly StandalonePortalCallPlan[],
	) => Promise<StandalonePortalPreparedBatch>;
}

export interface StandaloneToolPortalCore<TOptions> {
	readonly call: (request: PortalCallRequest, options: TOptions) => Promise<PortalCallResult>;
	readonly list: (request: PortalListRequest, options: TOptions) => Promise<PortalListResult>;
	readonly search: (request: PortalSearchRequest, options: TOptions) => Promise<PortalSearchResult>;
	readonly describe: (
		request: PortalDescribeRequest,
		options: TOptions,
	) => Promise<PortalDescribeResult>;
}

export interface CreateStandaloneToolPortalCoreProps<TOptions, TReadOptions> {
	readonly binding: HostAccessBinding;
	readonly now: () => number;
	readonly resolveInvocation: (
		options: TOptions,
	) => Promise<StandalonePortalInvocation<TReadOptions>>;
}
