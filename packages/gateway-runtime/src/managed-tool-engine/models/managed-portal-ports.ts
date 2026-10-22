import { type ToolPortalBackendKind } from '@agent-collaboration/tool-access/contracts';
import {
	type PortalBackendDescribeResult,
	type PortalBackendListResult,
	type PortalBackendSearchResult,
	type PortalCallRequest,
	type PortalCallResult,
	type PortalDescribeRequest,
	type PortalDescribeResult,
	type PortalListRequest,
	type PortalListResult,
	type PortalSearchRequest,
	type PortalSearchResult,
	type SafeDiagnostic,
} from '@agent-vm/agent-portal-sdk';
import { type GatewayRuntimeManagedToolPortalConfig } from '@agent-vm/config-contracts';
import {
	GatewayRuntimePortalSurfaceClassSchema,
	GatewayRuntimeTrustedInvocationContextSchema,
	type GatewayRuntimeApprovalAdmissionResult,
	type GatewayRuntimeApprovalArmDispatchResult,
	type GatewayRuntimeApprovalChallengeIntent,
	type GatewayRuntimeGatewayDispatchReservation,
	type GatewayRuntimePortalSemanticSnapshot,
	type GatewayRuntimeToolPortalDispatchAuthorityForBackendKind,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import {
	type OAuthToolAvailabilityBatchRequest,
	type OAuthToolAvailabilityBatchResult,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';
export interface ToolPortalBackendCallOptions<
	TBackendKind extends ToolPortalBackendKind,
> extends ToolPortalInvocationOptions {
	readonly dispatchAuthority: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<TBackendKind>;
}

export interface ToolPortalBackendPort<TBackendKind extends ToolPortalBackendKind> {
	readonly backendKind: TBackendKind;
	readonly call: (
		request: PortalCallRequest,
		options: ToolPortalBackendCallOptions<TBackendKind>,
	) => Promise<PortalCallResult>;
	readonly describe: (
		request: PortalDescribeRequest,
		options: ToolPortalInvocationOptions,
	) => Promise<PortalBackendDescribeResult>;
	readonly list: (
		request: PortalListRequest,
		options: ToolPortalInvocationOptions,
	) => Promise<PortalBackendListResult>;
	readonly search: (
		request: PortalSearchRequest,
		options: ToolPortalInvocationOptions,
	) => Promise<PortalBackendSearchResult>;
}

export interface ToolPortalApprovalPort {
	readonly armDispatch: (props: {
		readonly reservation: GatewayRuntimeGatewayDispatchReservation;
	}) => Promise<GatewayRuntimeApprovalArmDispatchResult>;
	readonly reserveDispatch: (props: {
		readonly intent: GatewayRuntimeApprovalChallengeIntent;
	}) => Promise<GatewayRuntimeApprovalAdmissionResult>;
}

export interface ToolPortalOAuthAvailabilityPort {
	readonly preflight?: (props: {
		readonly request: import('@agent-vm/gateway-control-contracts').GatewayControlGooglePreflightRequest;
		readonly signal?: AbortSignal | undefined;
		readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
	}) => Promise<import('@agent-vm/oauth-broker-contracts').ManagedGooglePreflightResult>;
	readonly resolve: (props: {
		readonly request: OAuthToolAvailabilityBatchRequest;
		readonly signal?: AbortSignal | undefined;
		readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
	}) => Promise<OAuthToolAvailabilityBatchResult>;
}

export interface ToolPortalCatalogDefinition {
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, import('@agent-vm/agent-portal-sdk').JsonValue>>;
	readonly name: string;
	readonly namespace: string;
}

export type ToolPortalCatalogPreparationResult =
	| { readonly kind: 'complete'; readonly tools: readonly ToolPortalCatalogDefinition[] }
	| { readonly diagnostics: readonly SafeDiagnostic[]; readonly kind: 'incomplete' };

export interface CreateManagedToolPortalCapabilityCoreProps {
	readonly now?: () => number;
	readonly approvalPort: ToolPortalApprovalPort;
	readonly backendPorts: {
		readonly controllerExecution: ToolPortalBackendPort<'controller_execution'>;
		readonly mcpProvider: ToolPortalBackendPort<'mcp_provider'>;
		readonly toolVmRunner: ToolPortalBackendPort<'tool_vm_runner'>;
	};
	readonly config: GatewayRuntimeManagedToolPortalConfig;
	readonly oauthAvailabilityPort?: ToolPortalOAuthAvailabilityPort | undefined;
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
}

export interface ToolPortalInvocationOptions {
	readonly signal?: AbortSignal;
	readonly surfaceClass: import('@agent-vm/gateway-control-contracts').GatewayRuntimePortalSurfaceClass;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}
export const ToolPortalManagedServiceInvocationOptionsSchema = z
	.object({
		origin: z
			.object({
				kind: z.literal('managed'),
				trustedContext: GatewayRuntimeTrustedInvocationContextSchema,
			})
			.strict(),
		signal: z
			.custom<AbortSignal>(
				(value: unknown): value is AbortSignal =>
					typeof value === 'object' &&
					value !== null &&
					'aborted' in value &&
					typeof value.aborted === 'boolean' &&
					'addEventListener' in value &&
					typeof value.addEventListener === 'function',
			)
			.optional(),
		surfaceClass: GatewayRuntimePortalSurfaceClassSchema,
	})
	.strict();
export type ToolPortalManagedServiceInvocationOptions = z.infer<
	typeof ToolPortalManagedServiceInvocationOptionsSchema
>;
export type ToolPortalCapabilityCore = {
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
	readonly call: (
		request: PortalCallRequest,
		options: ToolPortalManagedServiceInvocationOptions,
	) => Promise<PortalCallResult>;
	readonly describe: (
		request: PortalDescribeRequest,
		options: ToolPortalManagedServiceInvocationOptions,
	) => Promise<PortalDescribeResult>;
	readonly list: (
		request: PortalListRequest,
		options: ToolPortalManagedServiceInvocationOptions,
	) => Promise<PortalListResult>;
	readonly search: (
		request: PortalSearchRequest,
		options: ToolPortalManagedServiceInvocationOptions,
	) => Promise<PortalSearchResult>;
	readonly prepareCatalog: (
		options: ToolPortalManagedServiceInvocationOptions,
	) => Promise<ToolPortalCatalogPreparationResult>;
};

export type ToolPortalTrustedInvocationContext = GatewayRuntimeTrustedInvocationContext;
