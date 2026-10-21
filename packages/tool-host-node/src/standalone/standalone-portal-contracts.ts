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

import type { NodeHostAuthenticatedEnvelope } from '#node-host/ingress/bearer-credentials';

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
