import {
	compareUnicodeCodePointStrings,
	PortalCallRequestSchema,
	type PortalBackendDescribeResult,
	type PortalBackendListResult,
	type PortalBackendSearchResult,
	type PortalCallRequest,
	type PortalCallResult,
	PortalDescribeRequestSchema,
	PortalDescribeResultSchema,
	type PortalDescribeRequest,
	type PortalDescribeResult,
	PortalListRequestSchema,
	PortalListResultSchema,
	type PortalListRequest,
	type PortalListResult,
	PortalSearchRequestSchema,
	PortalSearchResultSchema,
	type PortalSearchRequest,
	type PortalSearchResult,
	type ToolVmAdvisoryHintContext,
} from '@agent-vm/agent-portal-sdk';
import {
	gatewayRuntimeManagedToolPortalConfigSchema,
	type GatewayRuntimeManagedToolPortalConfig,
	type McpConfig,
	type StandaloneToolPortalConfig,
	type ToolPortalBackendBinding,
	type ToolPortalBackendKind,
} from '@agent-vm/config-contracts';
import {
	type GatewayRuntimeApprovalAdmissionResult,
	type GatewayRuntimeApprovalArmDispatchResult,
	type GatewayRuntimeApprovalChallengeIntent,
	type GatewayRuntimeApprovalDispatchGrant,
	type GatewayRuntimeApprovalDispatchReservation,
	type GatewayRuntimeGatewayDispatchReservation,
	type GatewayRuntimeToolPortalDispatchAuthority,
	type GatewayRuntimeToolPortalDispatchAuthorityForBackendKind,
	GatewayRuntimePortalSemanticSnapshotSchema,
	deriveGatewayControlStablePrincipal,
	deriveGatewayRuntimeApprovalFingerprint,
	deriveGatewayRuntimeApprovalId,
	type GatewayRuntimePortalSemanticSnapshot,
	type GatewayRuntimeTrustedInvocationContext,
	type GatewayRuntimeTrustedInvocationPrincipal,
} from '@agent-vm/gateway-control-contracts';
import {
	oauthToolAvailabilityBatchRequestSchema,
	oauthToolAvailabilityBatchResultSchema,
	type OAuthAccountProfileToolRequirement,
	type OAuthToolAvailability,
	type OAuthToolAvailabilityBatchRequest,
	type OAuthToolAvailabilityBatchResult,
	type OAuthToolRequirement,
} from '@agent-vm/oauth-broker-contracts';

import type {
	StandaloneToolPortalApprovalArmResult,
	StandaloneToolPortalApprovalCoordinator,
} from './standalone-entrypoint/standalone-tool-portal-approval.js';
import { createStandaloneV1ToolPortalService } from './standalone-tool-portal-service.js';
import {
	type ToolPortalInvocationOptionsForMode,
	ToolPortalManagedServiceInvocationOptionsSchema,
	type ToolPortalManagedServiceInvocationOptions,
	type ToolPortalSemanticSnapshot,
	type ToolPortalServiceMode,
	type ToolPortalStandaloneSemanticSnapshot,
	type ToolPortalStandaloneServiceInvocationOptions,
} from './tool-portal-invocation-contracts.js';
import {
	mergeToolPortalDescribe,
	mergeToolPortalList,
	mergeToolPortalSearch,
	type ToolPortalBackendEntry,
	type ToolPortalInvocationOptions,
} from './tool-portal-result-router.js';
import {
	ambiguousDispatchItem,
	approvalRequiredItem,
	callPolicyDecision,
	canonicalJson,
	capabilityDiscoveryMetadata,
	capabilityDeniedItem,
	deepFreeze,
	deterministicOperationId,
	directDispatchFingerprint,
	notDispatchedItem,
	toolVmAdvisoryHintDeniedItem,
	type PortalCallItem,
} from './tool-portal-service-common.js';

export type { ToolPortalInvocationOptions } from './tool-portal-result-router.js';
export * from './tool-portal-invocation-contracts.js';
export type ToolPortalTrustedInvocationContext = GatewayRuntimeTrustedInvocationContext;

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

export type ToolPortalStandaloneMcpDispatchAuthority =
	| {
			readonly backendKind: 'mcp_provider';
			readonly fingerprint: `sha256:${string}`;
			readonly kind: 'without-approval';
			readonly operationId: string;
	  }
	| {
			readonly approval: Extract<
				StandaloneToolPortalApprovalArmResult,
				{ readonly kind: 'dispatch-authorized' }
			>['authority'];
			readonly backendKind: 'mcp_provider';
			readonly kind: 'standalone-hmac-batch';
			readonly operationId: string;
	  };

export interface ToolPortalStandaloneMcpBackendInvocationOptions {
	readonly correlation: ToolPortalStandaloneServiceInvocationOptions['correlation'];
	readonly dispatchAuthority: ToolPortalStandaloneMcpDispatchAuthority;
	readonly origin: ToolPortalStandaloneServiceInvocationOptions['origin'];
	readonly signal?: AbortSignal;
	readonly surfaceClass: ToolPortalStandaloneServiceInvocationOptions['surfaceClass'];
}

export interface ToolPortalStandaloneMcpBackendReadOptions {
	readonly correlation: ToolPortalStandaloneServiceInvocationOptions['correlation'];
	readonly origin: ToolPortalStandaloneServiceInvocationOptions['origin'];
	readonly signal?: AbortSignal;
	readonly surfaceClass: ToolPortalStandaloneServiceInvocationOptions['surfaceClass'];
}

export interface ToolPortalStandaloneMcpBackendPort {
	readonly backendKind: 'mcp_provider';
	readonly call: (
		request: PortalCallRequest,
		options: ToolPortalStandaloneMcpBackendInvocationOptions,
	) => Promise<PortalCallResult>;
	readonly describe: (
		request: PortalDescribeRequest,
		options: ToolPortalStandaloneMcpBackendReadOptions,
	) => Promise<PortalBackendDescribeResult>;
	readonly list: (
		request: PortalListRequest,
		options: ToolPortalStandaloneMcpBackendReadOptions,
	) => Promise<PortalBackendListResult>;
	readonly search: (
		request: PortalSearchRequest,
		options: ToolPortalStandaloneMcpBackendReadOptions,
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
	readonly resolve: (props: {
		readonly request: OAuthToolAvailabilityBatchRequest;
		readonly signal?: AbortSignal | undefined;
		readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
	}) => Promise<OAuthToolAvailabilityBatchResult>;
}

export interface ToolPortalCapabilityCore<TMode extends ToolPortalServiceMode = 'managed'> {
	readonly semanticSnapshot: ToolPortalSemanticSnapshot<TMode>;
	readonly call: (
		request: PortalCallRequest,
		options: ToolPortalInvocationOptionsForMode<TMode>,
	) => Promise<PortalCallResult>;
	readonly describe: (
		request: PortalDescribeRequest,
		options: ToolPortalInvocationOptionsForMode<TMode>,
	) => Promise<PortalDescribeResult>;
	readonly list: (
		request: PortalListRequest,
		options: ToolPortalInvocationOptionsForMode<TMode>,
	) => Promise<PortalListResult>;
	readonly search: (
		request: PortalSearchRequest,
		options: ToolPortalInvocationOptionsForMode<TMode>,
	) => Promise<PortalSearchResult>;
}

export interface ToolPortalService<TMode extends ToolPortalServiceMode> {
	readonly capabilityCore: ToolPortalCapabilityCore<TMode>;
	readonly mode: TMode;
}

export interface CreateManagedToolPortalCapabilityCoreProps {
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

interface OAuthDiscoveryCapability {
	readonly oauthAvailability?: OAuthToolAvailability | undefined;
	readonly oauthRequirement?: OAuthToolRequirement | undefined;
}

function oauthRequirementIdentity(requirement: OAuthAccountProfileToolRequirement): string {
	return [requirement.applicationId, requirement.serviceId, requirement.minimumPermission].join(
		'\u0000',
	);
}

async function resolveOAuthAvailabilityByRequirement(props: {
	readonly capabilities: readonly OAuthDiscoveryCapability[];
	readonly operationOptions: ToolPortalInvocationOptions;
	readonly port: ToolPortalOAuthAvailabilityPort | undefined;
}): Promise<ReadonlyMap<string, OAuthToolAvailability>> {
	const requirementsByIdentity = new Map<string, OAuthAccountProfileToolRequirement>();
	for (const capability of props.capabilities) {
		const requirement = capability.oauthRequirement;
		if (requirement?.kind !== 'oauth-account-profile') continue;
		requirementsByIdentity.set(oauthRequirementIdentity(requirement), requirement);
	}
	if (requirementsByIdentity.size === 0) return new Map();
	if (props.port === undefined) return new Map();
	try {
		const request = oauthToolAvailabilityBatchRequestSchema.parse({
			requirements: [...requirementsByIdentity.values()],
		});
		const result = oauthToolAvailabilityBatchResultSchema.parse(
			await props.port.resolve({
				request,
				...(props.operationOptions.signal === undefined
					? {}
					: { signal: props.operationOptions.signal }),
				trustedContext: props.operationOptions.trustedContext,
			}),
		);
		return new Map(
			result.items.map((item) => [oauthRequirementIdentity(item.requirement), item.availability]),
		);
	} catch {
		return new Map();
	}
}

function capabilityWithOAuthAvailability<TCapability extends OAuthDiscoveryCapability>(
	capability: TCapability,
	availabilityByRequirement: ReadonlyMap<string, OAuthToolAvailability>,
): TCapability | (TCapability & { readonly oauthAvailability: OAuthToolAvailability }) {
	const requirement = capability.oauthRequirement;
	if (requirement?.kind !== 'oauth-account-profile') return capability;
	return {
		...capability,
		oauthAvailability: availabilityByRequirement.get(oauthRequirementIdentity(requirement)) ?? {
			kind: 'authorization-status-unavailable',
		},
	};
}

export interface CreateStandaloneV1ToolPortalServiceProps {
	readonly approvalCoordinator: StandaloneToolPortalApprovalCoordinator;
	readonly baseSemanticSnapshot: ToolPortalStandaloneSemanticSnapshot;
	readonly backendPorts: {
		readonly mcpProvider: ToolPortalStandaloneMcpBackendPort;
	};
	readonly config: StandaloneToolPortalConfig;
	readonly mcpConfig: McpConfig;
}

function resolveManagedInvocation(props: {
	readonly config: GatewayRuntimeManagedToolPortalConfig;
	readonly options: ToolPortalManagedServiceInvocationOptions;
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
}): {
	readonly operationOptions: ToolPortalInvocationOptions;
	readonly profileId: string;
	readonly stablePrincipal: string;
} {
	const parsedOptions = ToolPortalManagedServiceInvocationOptionsSchema.parse(props.options);
	const operationOptions: ToolPortalInvocationOptions = {
		...(parsedOptions.signal === undefined ? {} : { signal: parsedOptions.signal }),
		surfaceClass: parsedOptions.surfaceClass,
		trustedContext: parsedOptions.origin.trustedContext,
	};
	if (props.semanticSnapshot.desiredRevision !== props.semanticSnapshot.activeRevision) {
		throw new Error('Tool Portal semantic snapshot is not active.');
	}
	const principal = operationOptions.trustedContext.principal;
	const agentId = principal.agentId;
	const configAssignment = props.config.agents[agentId];
	const snapshotProjection = props.semanticSnapshot.agentProjections[agentId];
	if (configAssignment === undefined || snapshotProjection === undefined) {
		throw new Error(`Tool Portal agent "${agentId}" is not configured.`);
	}
	const projectedPrincipal: GatewayRuntimeTrustedInvocationPrincipal = {
		agentId: snapshotProjection.agentId,
		frameworkIdentity: snapshotProjection.frameworkIdentity,
		profileAssignmentRevision: snapshotProjection.profileAssignmentRevision,
		toolPortalProfileId: snapshotProjection.toolPortalProfileId,
	};
	if (
		configAssignment.profile !== principal.toolPortalProfileId ||
		deriveGatewayControlStablePrincipal({ principal: projectedPrincipal }) !==
			deriveGatewayControlStablePrincipal({ principal })
	) {
		throw new Error(`Tool Portal trusted context does not match agent "${agentId}".`);
	}
	return {
		operationOptions,
		profileId: principal.toolPortalProfileId,
		stablePrincipal: deriveGatewayControlStablePrincipal({ principal }),
	};
}

function backendPortForKind(
	backendPorts: CreateManagedToolPortalCapabilityCoreProps['backendPorts'],
	kind: ToolPortalBackendBinding['kind'],
):
	| ToolPortalBackendPort<'controller_execution'>
	| ToolPortalBackendPort<'mcp_provider'>
	| ToolPortalBackendPort<'tool_vm_runner'> {
	switch (kind) {
		case 'controller_execution':
			return backendPorts.controllerExecution;
		case 'mcp_provider':
			return backendPorts.mcpProvider;
		case 'tool_vm_runner':
			return backendPorts.toolVmRunner;
		default:
			return assertNeverBackendKind(kind);
	}
}

function assertNeverBackendKind(kind: never): never {
	throw new Error(`Unsupported Tool Portal backend kind: ${String(kind)}`);
}

function assertNeverApprovalAdmission(admission: never): never {
	throw new Error(`Unsupported Tool Portal approval admission: ${String(admission)}`);
}

function managedBackendEntriesForInvocation(props: {
	readonly backendPorts: CreateManagedToolPortalCapabilityCoreProps['backendPorts'];
	readonly config: GatewayRuntimeManagedToolPortalConfig;
	readonly operationOptions: ToolPortalInvocationOptions;
	readonly profileId: string;
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
}): readonly ToolPortalBackendEntry<never, ToolPortalInvocationOptions>[] {
	const profileConfig = props.config.profiles[props.profileId];
	if (profileConfig === undefined) {
		throw new Error(`Tool Portal profile "${props.profileId}" is not configured.`);
	}
	const surfaceEligibility =
		props.semanticSnapshot.surfaceEligibilityByProfile[props.profileId] ?? {};
	const namespacesByBackendKind = new Map<ToolPortalBackendBinding['kind'], Set<string>>();
	for (const [namespace, namespacePolicy] of Object.entries(profileConfig.namespaces)) {
		const eligibleSurfaceClasses = surfaceEligibility[namespace] ?? [];
		if (!eligibleSurfaceClasses.includes(props.operationOptions.surfaceClass)) {
			continue;
		}
		const backendKind = namespacePolicy.backend.kind;
		const namespaces = namespacesByBackendKind.get(backendKind) ?? new Set<string>();
		namespaces.add(namespace);
		namespacesByBackendKind.set(backendKind, namespaces);
	}
	return [...namespacesByBackendKind].map(([backendKind, namespaces]) => ({
		backend: backendPortForKind(props.backendPorts, backendKind),
		capabilityMetadata: ({ name, namespace }) => {
			const namespacePolicy = profileConfig.namespaces[namespace];
			return namespacePolicy === undefined
				? undefined
				: capabilityDiscoveryMetadata({ policy: namespacePolicy, toolName: name });
		},
		namespaceDiscovery: [...namespaces]
			.map((namespace) => ({
				...profileConfig.namespaces[namespace]?.discovery,
				namespace,
			}))
			.toSorted((left, right) => compareUnicodeCodePointStrings(left.namespace, right.namespace)),
		namespaces,
	}));
}

function approvalChallengeIntent(props: {
	readonly approvalContext?: ToolVmAdvisoryHintContext;
	readonly backendKind: ToolPortalBackendKind;
	readonly call: PortalCallRequest['calls'][number];
	readonly operationId: string;
	readonly operationOptions: ToolPortalInvocationOptions;
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
}): GatewayRuntimeApprovalChallengeIntent {
	return {
		backendKind: props.backendKind,
		call: props.call,
		...(props.approvalContext === undefined ? {} : { context: props.approvalContext }),
		operationId: props.operationId,
		semanticRevisions: {
			activeRevision: props.semanticSnapshot.activeRevision,
			bindingRevision: props.semanticSnapshot.bindingRevision,
			catalogRevision: props.semanticSnapshot.catalogRevision,
			profilePolicyRevision: props.semanticSnapshot.profilePolicyRevision,
			providerRevision: props.semanticSnapshot.providerRevision,
			schemaRevision: props.semanticSnapshot.schemaRevision,
		},
		surfaceClass: props.operationOptions.surfaceClass,
		trustedContext: props.operationOptions.trustedContext,
	};
}

function approvalGrantDispatchAuthority(
	grant: GatewayRuntimeApprovalDispatchGrant,
): GatewayRuntimeToolPortalDispatchAuthority {
	switch (grant.backendKind) {
		case 'mcp_provider':
			return { backendKind: 'mcp_provider', grant, kind: 'approval-grant' };
		case 'tool_vm_runner':
			return { backendKind: 'tool_vm_runner', grant, kind: 'approval-grant' };
		default:
			return assertNeverBackendKind(grant);
	}
}

function directDispatchAuthority(props: {
	readonly backendKind: ToolPortalBackendKind;
	readonly bindingRevision: string;
	readonly fingerprint: `sha256:${string}`;
	readonly operationId: string;
}): GatewayRuntimeToolPortalDispatchAuthority {
	const common = {
		fingerprint: props.fingerprint,
		kind: 'without-approval' as const,
		operationId: props.operationId,
	};
	switch (props.backendKind) {
		case 'controller_execution':
			return {
				...common,
				backendKind: 'controller_execution',
				bindingRevision: props.bindingRevision,
			};
		case 'mcp_provider':
			return { ...common, backendKind: 'mcp_provider' };
		case 'tool_vm_runner':
			return { ...common, backendKind: 'tool_vm_runner' };
	}
}

function approvalReservationMatchesIntent(
	reservation: GatewayRuntimeApprovalDispatchReservation,
	intent: GatewayRuntimeApprovalChallengeIntent,
): boolean {
	const expectedFingerprint = deriveGatewayRuntimeApprovalFingerprint({
		authorityContext: reservation.authorityContext,
		intent,
	});
	return (
		reservation.backendKind === intent.backendKind &&
		reservation.operationId === intent.operationId &&
		reservation.fingerprint === expectedFingerprint &&
		reservation.approvalId === deriveGatewayRuntimeApprovalId(expectedFingerprint) &&
		reservation.stablePrincipal ===
			deriveGatewayControlStablePrincipal({
				principal: intent.trustedContext.principal,
			})
	);
}

function approvalGrantMatchesReservation(
	grant: GatewayRuntimeApprovalDispatchGrant,
	reservation: GatewayRuntimeGatewayDispatchReservation,
): boolean {
	return (
		grant.approvalId === reservation.approvalId &&
		grant.backendKind === reservation.backendKind &&
		grant.expiresAt === reservation.expiresAt &&
		grant.fingerprint === reservation.fingerprint &&
		grant.operationId === reservation.operationId &&
		grant.stablePrincipal === reservation.stablePrincipal &&
		canonicalJson(grant.authorityContext) === canonicalJson(reservation.authorityContext)
	);
}

function controllerAdmissionItem(props: {
	readonly admission:
		| Exclude<GatewayRuntimeApprovalAdmissionResult, { readonly kind: 'dispatch-reserved' }>
		| Exclude<GatewayRuntimeApprovalArmDispatchResult, { readonly kind: 'dispatch-armed' }>;
	readonly callId: string;
	readonly operationId: string;
	readonly owningGeneration: string;
}): PortalCallItem {
	switch (props.admission.kind) {
		case 'approval-required':
			return approvalRequiredItem({
				challengeId: props.admission.challenge.approvalId,
				...(props.admission.challenge.intent.context === undefined
					? {}
					: { context: props.admission.challenge.intent.context }),
				expiresAt: props.admission.challenge.expiresAt,
				id: props.callId,
				operationId: props.operationId,
				owningGeneration: props.owningGeneration,
			});
		case 'not-dispatched':
			return notDispatchedItem({
				id: props.callId,
				operationId: props.operationId,
				owningGeneration: props.owningGeneration,
				reason: props.admission.reason,
			});
		case 'ambiguous':
			return ambiguousDispatchItem({
				id: props.callId,
				operationId: props.operationId,
				owningGeneration: props.owningGeneration,
			});
		default:
			return assertNeverApprovalAdmission(props.admission);
	}
}

export function createManagedToolPortalCapabilityCore(
	props: CreateManagedToolPortalCapabilityCoreProps,
): ToolPortalCapabilityCore<'managed'> {
	const config = gatewayRuntimeManagedToolPortalConfigSchema.parse(props.config);
	const semanticSnapshot = deepFreeze(
		GatewayRuntimePortalSemanticSnapshotSchema.parse(props.semanticSnapshot),
	);

	function invocationState(options: ToolPortalManagedServiceInvocationOptions): {
		readonly entries: readonly ToolPortalBackendEntry<never, ToolPortalInvocationOptions>[];
		readonly operationOptions: ToolPortalInvocationOptions;
		readonly profileId: string;
		readonly stablePrincipal: string;
	} {
		const invocation = resolveManagedInvocation({ config, options, semanticSnapshot });
		return {
			entries: managedBackendEntriesForInvocation({
				backendPorts: props.backendPorts,
				config,
				operationOptions: invocation.operationOptions,
				profileId: invocation.profileId,
				semanticSnapshot,
			}),
			operationOptions: invocation.operationOptions,
			profileId: invocation.profileId,
			stablePrincipal: invocation.stablePrincipal,
		};
	}

	async function dispatchCall(propsForCall: {
		readonly authority: GatewayRuntimeToolPortalDispatchAuthority;
		readonly call: PortalCallRequest['calls'][number];
		readonly operationOptions: ToolPortalInvocationOptions;
		readonly operationId: string;
	}): Promise<PortalCallItem> {
		try {
			const request = { calls: [propsForCall.call] };
			const result = await (async (): Promise<PortalCallResult> => {
				switch (propsForCall.authority.backendKind) {
					case 'controller_execution':
						return await props.backendPorts.controllerExecution.call(request, {
							...propsForCall.operationOptions,
							dispatchAuthority: propsForCall.authority,
						});
					case 'mcp_provider':
						return await props.backendPorts.mcpProvider.call(request, {
							...propsForCall.operationOptions,
							dispatchAuthority: propsForCall.authority,
						});
					case 'tool_vm_runner':
						return await props.backendPorts.toolVmRunner.call(request, {
							...propsForCall.operationOptions,
							dispatchAuthority: propsForCall.authority,
						});
					default:
						return assertNeverBackendKind(propsForCall.authority);
				}
			})();
			if (
				result.items.length !== 1 ||
				result.items[0]?.id !== propsForCall.call.id ||
				result.items[0].operationId !== propsForCall.operationId
			) {
				return ambiguousDispatchItem({
					id: propsForCall.call.id,
					operationId: propsForCall.operationId,
					owningGeneration: semanticSnapshot.activeRevision,
				});
			}
			return result.items[0];
		} catch {
			return ambiguousDispatchItem({
				id: propsForCall.call.id,
				operationId: propsForCall.operationId,
				owningGeneration: semanticSnapshot.activeRevision,
			});
		}
	}

	async function callOne(propsForCall: {
		readonly call: PortalCallRequest['calls'][number];
		readonly operationOptions: ToolPortalInvocationOptions;
		readonly profileId: string;
		readonly stablePrincipal: string;
	}): Promise<PortalCallItem> {
		const operationId = deterministicOperationId({
			callId: propsForCall.call.id,
			semanticRevision: semanticSnapshot.activeRevision,
			stablePrincipal: propsForCall.stablePrincipal,
			surfaceClass: propsForCall.operationOptions.surfaceClass,
		});
		const policyDecision = callPolicyDecision({
			call: propsForCall.call,
			config,
			profileId: propsForCall.profileId,
			semanticSnapshot,
			surfaceClass: propsForCall.operationOptions.surfaceClass,
		});
		if (policyDecision.kind === 'denied') {
			return capabilityDeniedItem({
				id: propsForCall.call.id,
				operationId,
				owningGeneration: semanticSnapshot.activeRevision,
			});
		}
		if (policyDecision.kind === 'tool-vm-advisory-denied') {
			return toolVmAdvisoryHintDeniedItem({
				id: propsForCall.call.id,
				operationId,
				owningGeneration: semanticSnapshot.activeRevision,
			});
		}
		if (policyDecision.kind === 'without-approval') {
			return await dispatchCall({
				authority: directDispatchAuthority({
					backendKind: policyDecision.backendKind,
					fingerprint: directDispatchFingerprint({
						backendKind: policyDecision.backendKind,
						call: propsForCall.call,
						principal: propsForCall.operationOptions.trustedContext.principal,
						semanticSnapshot,
						surfaceClass: propsForCall.operationOptions.surfaceClass,
					}),
					bindingRevision: semanticSnapshot.bindingRevision,
					operationId,
				}),
				call: propsForCall.call,
				operationId,
				operationOptions: propsForCall.operationOptions,
			});
		}
		const approvalIntent = approvalChallengeIntent({
			...(policyDecision.approvalContext === undefined
				? {}
				: { approvalContext: policyDecision.approvalContext }),
			backendKind: policyDecision.backendKind,
			call: propsForCall.call,
			operationId,
			operationOptions: propsForCall.operationOptions,
			semanticSnapshot,
		});
		const admission = await props.approvalPort.reserveDispatch({ intent: approvalIntent });
		if (admission.kind !== 'dispatch-reserved') {
			return controllerAdmissionItem({
				admission,
				callId: propsForCall.call.id,
				operationId,
				owningGeneration: semanticSnapshot.activeRevision,
			});
		}
		if (!approvalReservationMatchesIntent(admission.reservation, approvalIntent)) {
			return ambiguousDispatchItem({
				id: propsForCall.call.id,
				operationId,
				owningGeneration: semanticSnapshot.activeRevision,
			});
		}
		if (admission.reservation.backendKind === 'controller_execution') {
			return await dispatchCall({
				authority: {
					backendKind: 'controller_execution',
					kind: 'controller-approval-reservation',
					reservation: admission.reservation,
				},
				call: propsForCall.call,
				operationId,
				operationOptions: propsForCall.operationOptions,
			});
		}
		const armResult = await props.approvalPort.armDispatch({
			reservation: admission.reservation,
		});
		if (armResult.kind !== 'dispatch-armed') {
			return controllerAdmissionItem({
				admission: armResult,
				callId: propsForCall.call.id,
				operationId,
				owningGeneration: semanticSnapshot.activeRevision,
			});
		}
		if (!approvalGrantMatchesReservation(armResult.grant, admission.reservation)) {
			return ambiguousDispatchItem({
				id: propsForCall.call.id,
				operationId,
				owningGeneration: semanticSnapshot.activeRevision,
			});
		}
		return await dispatchCall({
			authority: approvalGrantDispatchAuthority(armResult.grant),
			call: propsForCall.call,
			operationId,
			operationOptions: propsForCall.operationOptions,
		});
	}

	return {
		call: async (request, options) => {
			const parsedRequest = PortalCallRequestSchema.parse(request);
			const invocation = invocationState(options);
			const items = await Promise.all(
				parsedRequest.calls.map(
					async (call) =>
						await callOne({
							call,
							operationOptions: invocation.operationOptions,
							profileId: invocation.profileId,
							stablePrincipal: invocation.stablePrincipal,
						}),
				),
			);
			return { items, ok: items.every((item) => item.status === 'ok') };
		},
		describe: async (request, options) => {
			const parsedRequest = PortalDescribeRequestSchema.parse(request);
			const invocation = invocationState(options);
			const result = await mergeToolPortalDescribe({
				entries: invocation.entries,
				operationOptions: invocation.operationOptions,
				request: parsedRequest,
			});
			const availabilityByRequirement = await resolveOAuthAvailabilityByRequirement({
				capabilities: result.items.flatMap((item) =>
					item.status === 'ok' ? item.value.tools : [],
				),
				operationOptions: invocation.operationOptions,
				port: props.oauthAvailabilityPort,
			});
			return PortalDescribeResultSchema.parse({
				...result,
				items: result.items.map((item) =>
					item.status === 'error'
						? item
						: {
								...item,
								value: {
									...item.value,
									tools: item.value.tools.map((tool) =>
										capabilityWithOAuthAvailability(tool, availabilityByRequirement),
									),
								},
							},
				),
			});
		},
		list: async (request, options) => {
			const parsedRequest = PortalListRequestSchema.parse(request);
			const invocation = invocationState(options);
			const result = await mergeToolPortalList({
				entries: invocation.entries,
				operationOptions: invocation.operationOptions,
				request: parsedRequest,
			});
			const availabilityByRequirement = await resolveOAuthAvailabilityByRequirement({
				capabilities: result.items.flatMap((item) =>
					item.status === 'ok' ? item.value.tools : [],
				),
				operationOptions: invocation.operationOptions,
				port: props.oauthAvailabilityPort,
			});
			return PortalListResultSchema.parse({
				...result,
				items: result.items.map((item) =>
					item.status === 'error'
						? item
						: {
								...item,
								value: {
									...item.value,
									tools: item.value.tools.map((tool) =>
										capabilityWithOAuthAvailability(tool, availabilityByRequirement),
									),
								},
							},
				),
			});
		},
		search: async (request, options) => {
			const parsedRequest = PortalSearchRequestSchema.parse(request);
			const invocation = invocationState(options);
			const result = await mergeToolPortalSearch({
				entries: invocation.entries,
				operationOptions: invocation.operationOptions,
				request: parsedRequest,
			});
			const availabilityByRequirement = await resolveOAuthAvailabilityByRequirement({
				capabilities: result.items.flatMap((item) =>
					item.status === 'ok' ? item.value.tools : [],
				),
				operationOptions: invocation.operationOptions,
				port: props.oauthAvailabilityPort,
			});
			return PortalSearchResultSchema.parse({
				...result,
				items: result.items.map((item) =>
					item.status === 'error'
						? item
						: {
								...item,
								value: {
									...item.value,
									tools: item.value.tools.map((tool) =>
										capabilityWithOAuthAvailability(tool, availabilityByRequirement),
									),
								},
							},
				),
			});
		},
		semanticSnapshot,
	};
}

export function createToolPortalService(
	props: CreateStandaloneV1ToolPortalServiceProps,
): ToolPortalService<'standalone-v1'> {
	return createStandaloneV1ToolPortalService(props);
}
