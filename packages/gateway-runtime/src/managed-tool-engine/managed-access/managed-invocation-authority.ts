import type {
	DispatchInvocation,
	DispatchRequest,
} from '@agent-collaboration/tool-engine/capability-dispatch';
import { type GatewayRuntimeManagedToolPortalConfig } from '@agent-vm/config-contracts';
import {
	deriveGatewayControlStablePrincipal,
	type GatewayRuntimePortalSemanticSnapshot,
} from '@agent-vm/gateway-control-contracts';
import type { ManagedEngineInvocationContext } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-access/models/managed-invocation-context.js';
import {
	ToolPortalManagedServiceInvocationOptionsSchema,
	type ToolPortalInvocationOptions,
} from '@agent-vm/gateway-runtime/managed-tool-engine/models/managed-portal-ports.js';

/** Rebuild authority from the controller projection on every resource entry. */
export function resolveManagedEngineInvocation(props: {
	readonly config: GatewayRuntimeManagedToolPortalConfig;
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
	readonly context: ManagedEngineInvocationContext;
}): {
	readonly options: ToolPortalInvocationOptions;
	readonly profileId: string;
	readonly stablePrincipal: string;
} {
	const parsed = ToolPortalManagedServiceInvocationOptionsSchema.parse({
		origin: { kind: 'managed', trustedContext: props.context.trustedContext },
		surfaceClass: props.context.surfaceClass,
		...(props.context.signal === undefined ? {} : { signal: props.context.signal }),
	});
	if (props.semanticSnapshot.activeRevision !== props.semanticSnapshot.desiredRevision)
		throw new Error('Managed semantic snapshot is not active.');
	const principal = parsed.origin.trustedContext.principal;
	const assignment = props.config.agents[principal.agentId];
	const projection = props.semanticSnapshot.agentProjections[principal.agentId];
	if (
		assignment === undefined ||
		projection === undefined ||
		assignment.profile !== principal.toolPortalProfileId
	)
		throw new Error('Managed agent assignment is not current.');
	const projectedPrincipal = {
		agentId: projection.agentId,
		frameworkIdentity: projection.frameworkIdentity,
		profileAssignmentRevision: projection.profileAssignmentRevision,
		toolPortalProfileId: projection.toolPortalProfileId,
	};
	const stablePrincipal = deriveGatewayControlStablePrincipal({ principal });
	if (deriveGatewayControlStablePrincipal({ principal: projectedPrincipal }) !== stablePrincipal)
		throw new Error('Managed principal does not match the controller projection.');
	return {
		profileId: principal.toolPortalProfileId,
		stablePrincipal,
		options: {
			...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
			surfaceClass: parsed.surfaceClass,
			trustedContext: parsed.origin.trustedContext,
		},
	};
}
export function assertManagedNeutralBinding(props: {
	readonly authority: string;
	readonly invocation: DispatchInvocation;
	readonly request: DispatchRequest;
}): void {
	if (
		props.invocation.authority !== props.authority ||
		props.invocation.operationKey.authority !== props.authority ||
		props.invocation.operationKey.principal !== props.request.principal ||
		props.invocation.operationKey.item !== props.request.item ||
		props.invocation.surface !== props.request.access.surface ||
		props.invocation.bindingRevision.revision !==
			props.request.access.facts.upstream.binding.revision ||
		props.invocation.bindingRevision.owner !== props.request.access.facts.upstream.binding.owner
	)
		throw new Error('Neutral reference does not match managed authority.');
}
