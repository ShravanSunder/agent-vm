import type {
	PortalArtifactReadRequest,
	PortalArtifactReadResult,
	PortalCallRequest,
	PortalCallResult,
	PortalDescribeRequest,
	PortalDescribeResult,
	PortalListRequest,
	PortalListResult,
	PortalSearchRequest,
	PortalSearchResult,
} from '@agent-collaboration/tool-access/contracts';
import type { DispatchInvocation } from '@agent-collaboration/tool-engine/capability-dispatch';
import type {
	StandalonePortalInvocation,
	StandalonePortalCallItem,
} from '@agent-collaboration/tool-engine/standalone-tool-portal';

import type { NodeHostAuthenticatedEnvelope } from '#node-host/mcp-proxy-server/models/bearer-credentials';

export interface StandaloneToolPortalInvocationOptions {
	readonly approvalToken?: string;
	readonly authenticatedEnvelope: NodeHostAuthenticatedEnvelope;
	readonly correlation: { readonly sessionId: string };
	readonly signal?: AbortSignal;
	readonly surfaceClass: 'http' | 'mcp';
}

export interface StandaloneToolPortalProjectionService {
	readonly call: (
		request: PortalCallRequest,
		options: StandaloneToolPortalInvocationOptions,
	) => Promise<PortalCallResult>;
	readonly list: (
		request: PortalListRequest,
		options: StandaloneToolPortalInvocationOptions,
	) => Promise<PortalListResult>;
	readonly search: (
		request: PortalSearchRequest,
		options: StandaloneToolPortalInvocationOptions,
	) => Promise<PortalSearchResult>;
	readonly describe: (
		request: PortalDescribeRequest,
		options: StandaloneToolPortalInvocationOptions,
	) => Promise<PortalDescribeResult>;
}

export interface StandaloneToolPortalArtifactReader {
	readonly read: (props: {
		readonly caller: {
			readonly authenticatedEnvelope: NodeHostAuthenticatedEnvelope;
			readonly surfaceClass: 'mcp';
		};
		readonly request: PortalArtifactReadRequest;
	}) => Promise<PortalArtifactReadResult>;
}

export interface StandaloneSemanticRevisions {
	readonly activeRevision: string;
	readonly bindingRevision: string;
	readonly catalogRevision: string;
	readonly profilePolicyRevision: string;
	readonly providerRevision: string;
	readonly schemaRevision: string;
}

/** The embedding resource supplies current facts; it retains managed context, CLI and OAuth ownership. */
export interface NodeStandaloneInvocation extends Omit<
	StandalonePortalInvocation<StandaloneToolPortalInvocationOptions>,
	'prepareBatch'
> {
	readonly semanticRevisions: StandaloneSemanticRevisions;
	readonly invoke: (props: {
		readonly call: PortalCallRequest['calls'][number];
		readonly invocation: DispatchInvocation;
		readonly options: StandaloneToolPortalInvocationOptions;
	}) => Promise<StandalonePortalCallItem>;
}
