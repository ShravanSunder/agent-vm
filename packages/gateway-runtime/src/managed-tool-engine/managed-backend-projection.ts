import { jsonValueSchema } from '@agent-collaboration/tool-access/contracts';
import type {
	BackendKind,
	DispatchRequest,
	ToolBackend,
} from '@agent-collaboration/tool-engine/dispatch';
import {
	PortalBackendDescribeResultSchema,
	PortalBackendListResultSchema,
	PortalBackendSearchResultSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
} from '@agent-vm/agent-portal-sdk';
import type { GatewayRuntimeManagedToolPortalConfig } from '@agent-vm/config-contracts';
import type { GatewayRuntimePortalSemanticSnapshot } from '@agent-vm/gateway-control-contracts';
import { resolveManagedEngineInvocation } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-access/managed-invocation-authority.js';
import type { ManagedEngineInvocationContext } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-access/models/managed-invocation-context.js';
import type { ToolPortalBackendPort } from '@agent-vm/tool-portal';
export interface ManagedBackendPorts {
	readonly controllerExecution: ToolPortalBackendPort<'controller_execution'>;
	readonly mcpProvider: ToolPortalBackendPort<'mcp_provider'>;
	readonly toolVmRunner: ToolPortalBackendPort<'tool_vm_runner'>;
}
function assertNever(value: never): never {
	throw new Error(`Unknown backend: ${String(value)}`);
}
export function createManagedEngineBackends(props: {
	readonly config: GatewayRuntimeManagedToolPortalConfig;
	readonly snapshot: GatewayRuntimePortalSemanticSnapshot;
	readonly request: (reference: string) => DispatchRequest;
	readonly context: (reference: string) => ManagedEngineInvocationContext;
	readonly invoke: ToolBackend<BackendKind>['invoke'];
	readonly backendPorts: ManagedBackendPorts;
}): ReadonlyMap<BackendKind, ToolBackend<BackendKind>> {
	const { config, snapshot, request, invoke } = props;
	function entry(reference: string): { readonly context: ManagedEngineInvocationContext } {
		return { context: props.context(reference) };
	}

	function backendFor(kind: BackendKind): ManagedBackendPorts[keyof ManagedBackendPorts] {
		switch (kind) {
			case 'controller_execution':
				return props.backendPorts.controllerExecution;
			case 'mcp_provider':
				return props.backendPorts.mcpProvider;
			case 'tool_vm_runner':
				return props.backendPorts.toolVmRunner;
			default:
				return assertNever(kind);
		}
	}
	function visible(
		reference: string,
		kind: BackendKind,
		capability: { readonly namespace: string; readonly name: string },
	): boolean {
		const current = request(reference);
		const policy = current.access.facts.assignment.profile.namespaces[capability.namespace];
		const surfaces =
			snapshot.surfaceEligibilityByProfile[current.access.facts.assignment.profile.profileId]?.[
				capability.namespace
			] ?? [];
		return (
			policy?.backendKind === kind &&
			surfaces.includes(current.access.surface) &&
			(policy.tools.allow === '*' || policy.tools.allow.includes(capability.name)) &&
			!policy.tools.deny.includes(capability.name)
		);
	}
	const backends = new Map<BackendKind, ToolBackend<BackendKind>>();
	for (const kind of ['controller_execution', 'mcp_provider', 'tool_vm_runner'] as const) {
		const backend = backendFor(kind);
		backends.set(kind, {
			backendKind: kind,
			invoke,
			list: async ({ request: query, verifiedContextRef }) => {
				const selected = entry(verifiedContextRef);
				const resolved = resolveManagedEngineInvocation({
					config,
					semanticSnapshot: snapshot,
					context: selected.context,
				});
				const response = PortalBackendListResultSchema.parse(
					await backend.list(PortalListRequestSchema.parse(query), resolved.options),
				);
				for (const item of response.items) {
					if (item.status !== 'ok') continue;
					item.value.namespaces = item.value.namespaces.filter((namespace) =>
						Object.entries(config.profiles[resolved.profileId]?.namespaces ?? {}).some(
							([name, policy]) =>
								name === namespace &&
								policy.backend.kind === kind &&
								(snapshot.surfaceEligibilityByProfile[resolved.profileId]?.[name] ?? []).includes(
									selected.context.surfaceClass,
								),
						),
					);
					item.value.tools = item.value.tools.filter((tool) =>
						visible(verifiedContextRef, kind, tool),
					);
				}
				return jsonValueSchema.parse(response);
			},
			describe: async ({ request: query, verifiedContextRef }) => {
				const selected = entry(verifiedContextRef);
				const resolved = resolveManagedEngineInvocation({
					config,
					semanticSnapshot: snapshot,
					context: selected.context,
				});
				const response = PortalBackendDescribeResultSchema.parse(
					await backend.describe(PortalDescribeRequestSchema.parse(query), resolved.options),
				);
				for (const item of response.items) {
					if (item.status === 'ok')
						item.value.tools = item.value.tools.filter((tool) =>
							visible(verifiedContextRef, kind, tool),
						);
				}
				return jsonValueSchema.parse(response);
			},
			search: async ({ request: query, verifiedContextRef }) => {
				const selected = entry(verifiedContextRef);
				const resolved = resolveManagedEngineInvocation({
					config,
					semanticSnapshot: snapshot,
					context: selected.context,
				});
				const response = PortalBackendSearchResultSchema.parse(
					await backend.search(PortalSearchRequestSchema.parse(query), resolved.options),
				);
				for (const item of response.items) {
					if (item.status === 'ok')
						item.value.tools = item.value.tools.filter((tool) =>
							visible(verifiedContextRef, kind, tool),
						);
				}
				return jsonValueSchema.parse(response);
			},
		});
	}
	return backends;
}
