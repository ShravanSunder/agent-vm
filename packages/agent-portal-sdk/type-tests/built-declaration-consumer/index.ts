import { PortalCallResultSchema, type PortalCallResult } from '@agent-vm/agent-portal-sdk';
import {
	PortalAdapterEnvelopeSchema,
	type PortalAdapterEnvelope,
} from '@agent-vm/agent-portal-sdk/adapter-boundary';
import {
	ApprovalRequiredResultSchema,
	type ApprovalRequiredResult,
} from '@agent-vm/agent-portal-sdk/approval-surface';
import {
	PortalArtifactReadRequestSchema,
	type PortalArtifactReadRequest,
} from '@agent-vm/agent-portal-sdk/artifact-surface';
import {
	CapabilityDescriptorSchema,
	type CapabilityDescriptor,
} from '@agent-vm/agent-portal-sdk/capability-description-surface';
import {
	GatewayRuntimeFrameworkIdentitySchema,
	GatewayRuntimeTrustedInvocationPrincipalSchema,
	ManagedAgentProjectionSchema,
	type GatewayRuntimeFrameworkIdentity,
	type GatewayRuntimeTrustedInvocationPrincipal,
	type ManagedAgentProjection,
} from '@agent-vm/agent-portal-sdk/contracts';
import {
	DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH,
	type GatewayRuntimeClientOptions,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import {
	PORTABLE_CONTRACT_ADAPTERS,
	type PortableContractAdapter,
} from '@agent-vm/agent-portal-sdk/portable-contracts';
import {
	PortalListRequestSchema,
	type PortalListRequest,
} from '@agent-vm/agent-portal-sdk/portal-call-surface';
import {
	PortalEventSchema,
	type PortalEvent,
} from '@agent-vm/agent-portal-sdk/portal-event-surface';
import {
	createPortalCallRequestFixture,
	type CreatePortalCallRequestFixtureProps,
} from '@agent-vm/agent-portal-sdk/testing';
import {
	ToolPortalMcpClient,
	type ToolPortalMcpTransport,
} from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client';
import {
	createNodeToolPortalMcpTransport,
	type CreateNodeToolPortalMcpTransportProps,
} from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client/node-transport';

const publicRuntimeExports = [
	PortalCallResultSchema,
	PortalAdapterEnvelopeSchema,
	ApprovalRequiredResultSchema,
	PortalArtifactReadRequestSchema,
	CapabilityDescriptorSchema,
	GatewayRuntimeFrameworkIdentitySchema,
	GatewayRuntimeTrustedInvocationPrincipalSchema,
	ManagedAgentProjectionSchema,
	DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH,
	PortalListRequestSchema,
	PortalEventSchema,
	PORTABLE_CONTRACT_ADAPTERS,
	createPortalCallRequestFixture,
	ToolPortalMcpClient,
	createNodeToolPortalMcpTransport,
] as const;

declare const managedAgentProjection: ManagedAgentProjection;
void managedAgentProjection.toolPortalNamespaceNames;

type PublicTypeExports = readonly [
	PortalCallResult,
	PortalAdapterEnvelope,
	ApprovalRequiredResult,
	PortalArtifactReadRequest,
	CapabilityDescriptor,
	GatewayRuntimeFrameworkIdentity,
	GatewayRuntimeTrustedInvocationPrincipal,
	ManagedAgentProjection,
	GatewayRuntimeClientOptions,
	PortalListRequest,
	PortalEvent,
	PortableContractAdapter,
	CreatePortalCallRequestFixtureProps,
	ToolPortalMcpTransport,
	CreateNodeToolPortalMcpTransportProps,
];

declare const publicTypeExports: PublicTypeExports;

void publicRuntimeExports;
void publicTypeExports;
