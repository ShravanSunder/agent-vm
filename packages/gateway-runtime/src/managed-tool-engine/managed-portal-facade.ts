import {
	mergeToolPortalDescribe,
	mergeToolPortalList,
	mergeToolPortalSearch,
	type ToolPortalDiscoveryEntry,
} from '@agent-collaboration/tool-engine/standalone-tool-portal';
import {
	PortalCallRequestSchema,
	PortalCallResultSchema,
	PortalDescribeRequestSchema,
	PortalDescribeResultSchema,
	PortalListRequestSchema,
	PortalListResultSchema,
	PortalSearchRequestSchema,
	PortalSearchResultSchema,
	compareUnicodeCodePointStrings,
} from '@agent-vm/agent-portal-sdk';
import {
	gatewayRuntimeManagedToolPortalConfigSchema,
	type GatewayRuntimeManagedToolPortalConfig,
	type ToolPortalBackendBinding,
} from '@agent-vm/config-contracts';
import {
	GatewayRuntimePortalSemanticSnapshotSchema,
	deriveGatewayControlStablePrincipal,
	type GatewayRuntimePortalSemanticSnapshot,
	type GatewayRuntimeTrustedInvocationPrincipal,
} from '@agent-vm/gateway-control-contracts';
import { prepareManagedGoogleCall } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-access/managed-google-preparation.js';
import { prepareManagedCatalogDefinitions } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-catalog-preparation.js';
import {
	capabilityDiscoveryMetadata,
	deepFreeze,
} from '@agent-vm/gateway-runtime/managed-tool-engine/managed-discovery-policy.js';
import { createManagedToolEngineAdapter } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-dispatch-adapter.js';
import { deterministicOperationId } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-dispatch-identity.js';
import {
	ToolPortalManagedServiceInvocationOptionsSchema,
	type CreateManagedToolPortalCapabilityCoreProps,
	type ToolPortalBackendPort,
	type ToolPortalCapabilityCore,
	type ToolPortalInvocationOptions,
	type ToolPortalManagedServiceInvocationOptions,
	type ToolPortalOAuthAvailabilityPort,
} from '@agent-vm/gateway-runtime/managed-tool-engine/models/managed-portal-ports.js';
import {
	oauthOperationRequirementIdentity,
	oauthToolAvailabilityBatchRequestSchema,
	oauthToolAvailabilityBatchResultSchema,
	type OAuthOperationAvailability,
	type OAuthOperationToolRequirement,
	type OAuthToolAvailability,
	type OAuthToolRequirement,
} from '@agent-vm/oauth-broker-contracts';
interface OAuthDiscoveryCapability {
	readonly oauthAvailability?: OAuthToolAvailability | undefined;
	readonly oauthRequirement?: OAuthToolRequirement | undefined;
}

async function resolveOAuthAvailabilityByRequirement(props: {
	readonly capabilities: readonly OAuthDiscoveryCapability[];
	readonly operationOptions: ToolPortalInvocationOptions;
	readonly port: ToolPortalOAuthAvailabilityPort | undefined;
}): Promise<ReadonlyMap<string, OAuthOperationAvailability>> {
	const requirementsByIdentity = new Map<string, OAuthOperationToolRequirement>();
	for (const capability of props.capabilities) {
		const requirement = capability.oauthRequirement;
		if (requirement?.kind !== 'google-account') continue;
		for (const operation of requirement.operations)
			requirementsByIdentity.set(oauthOperationRequirementIdentity(operation), operation);
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
			result.items.map((item) => [
				oauthOperationRequirementIdentity(item.requirement),
				item.availability,
			]),
		);
	} catch {
		return new Map();
	}
}

function capabilityWithOAuthAvailability<TCapability extends OAuthDiscoveryCapability>(
	capability: TCapability,
	availabilityByRequirement: ReadonlyMap<string, OAuthOperationAvailability>,
): TCapability | (TCapability & { readonly oauthAvailability: OAuthToolAvailability }) {
	const requirement = capability.oauthRequirement;
	if (requirement?.kind !== 'google-account') return capability;
	return {
		...capability,
		oauthAvailability: {
			kind: 'operation-options',
			items: requirement.operations.map((operation) => ({
				requirement: operation,
				availability: availabilityByRequirement.get(
					oauthOperationRequirementIdentity(operation),
				) ?? { kind: 'unavailable' },
			})),
		},
	};
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

function managedBackendEntriesForInvocation(props: {
	readonly backendPorts: CreateManagedToolPortalCapabilityCoreProps['backendPorts'];
	readonly config: GatewayRuntimeManagedToolPortalConfig;
	readonly operationOptions: ToolPortalInvocationOptions;
	readonly profileId: string;
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
}): readonly ToolPortalDiscoveryEntry<ToolPortalInvocationOptions>[] {
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
			.map((namespace) =>
				Object.assign({}, profileConfig.namespaces[namespace]?.discovery, { namespace }),
			)
			.toSorted((left, right) => compareUnicodeCodePointStrings(left.namespace, right.namespace)),
		namespaces,
	}));
}

export function createManagedToolPortalCapabilityCore(
	props: CreateManagedToolPortalCapabilityCoreProps,
): ToolPortalCapabilityCore {
	const config = gatewayRuntimeManagedToolPortalConfigSchema.parse(props.config);
	const semanticSnapshot = deepFreeze(
		GatewayRuntimePortalSemanticSnapshotSchema.parse(props.semanticSnapshot),
	);

	const adapter = createManagedToolEngineAdapter({
		authority: 'agent-vm-managed',
		configuration: {
			config,
			revision: { owner: 'agent-vm-managed', revision: semanticSnapshot.activeRevision },
		},
		semanticSnapshot,
		approvalPort: props.approvalPort,
		backendPorts: props.backendPorts,
		now: props.now ?? Date.now,
	});

	function invocationState(options: ToolPortalManagedServiceInvocationOptions): {
		readonly entries: readonly ToolPortalDiscoveryEntry<ToolPortalInvocationOptions>[];
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

	return {
		call: async (request, options) => {
			const parsed = ToolPortalManagedServiceInvocationOptionsSchema.parse(options);
			const invocation = invocationState(parsed);
			const items = await Promise.all(
				PortalCallRequestSchema.parse(request).calls.map(async (call) => {
					const policy = config.profiles[invocation.profileId]?.namespaces[call.namespace];
					const admitted =
						policy !== undefined &&
						invocation.entries.some((entry) => entry.namespaces.has(call.namespace)) &&
						capabilityDiscoveryMetadata({ policy, toolName: call.name }) !== undefined;
					const prepared = admitted
						? await prepareManagedGoogleCall({
								call,
								config,
								profileId: invocation.profileId,
								options: invocation.operationOptions,
								port: props.oauthAvailabilityPort,
								operationId: deterministicOperationId({
									callId: call.id,
									semanticRevision: semanticSnapshot.activeRevision,
									stablePrincipal: invocation.stablePrincipal,
									surfaceClass: parsed.surfaceClass,
								}),
								owningGeneration: semanticSnapshot.activeRevision,
							})
						: { kind: 'ready' as const, accounts: [] };
					if (prepared.kind === 'refused') return prepared.item;
					const result = await adapter.call(
						{ calls: [call] },
						{
							surfaceClass: parsed.surfaceClass,
							trustedContext: parsed.origin.trustedContext,
							...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
						},
						prepared,
					);
					const item = result.items[0];
					if (item === undefined) throw new Error('Managed dispatcher returned no item.');
					return item;
				}),
			);
			return PortalCallResultSchema.parse({
				items,
				ok: items.every((item) => item.status === 'ok'),
			});
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
						: Object.assign({}, item, {
								value: Object.assign({}, item.value, {
									tools: item.value.tools.map((tool) =>
										capabilityWithOAuthAvailability(tool, availabilityByRequirement),
									),
								}),
							}),
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
						: Object.assign({}, item, {
								value: Object.assign({}, item.value, {
									tools: item.value.tools.map((tool) =>
										capabilityWithOAuthAvailability(tool, availabilityByRequirement),
									),
								}),
							}),
				),
			});
		},
		prepareCatalog: async (options) => {
			const invocation = invocationState(options);
			return await prepareManagedCatalogDefinitions({
				entries: invocation.entries,
				operationOptions: invocation.operationOptions,
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
						: Object.assign({}, item, {
								value: Object.assign({}, item.value, {
									tools: item.value.tools.map((tool) =>
										capabilityWithOAuthAvailability(tool, availabilityByRequirement),
									),
								}),
							}),
				),
			});
		},
		semanticSnapshot,
	};
}
