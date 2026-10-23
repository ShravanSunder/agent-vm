import {
	assessAccessInput,
	jsonObjectSchema,
	type AccountFact,
} from '@agent-collaboration/tool-access/contracts';
import type { DispatchRequest } from '@agent-collaboration/tool-engine/capability-dispatch';
import type { PortalCallRequest } from '@agent-vm/agent-portal-sdk';
import type { GatewayRuntimeManagedToolPortalConfig } from '@agent-vm/config-contracts';
import type { GatewayRuntimePortalSemanticSnapshot } from '@agent-vm/gateway-control-contracts';
import { projectManagedAccessProfile } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-access/access-profile-projection.js';
import { resolveManagedEngineInvocation } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-access/managed-invocation-authority.js';
import type { ManagedEngineInvocationContext } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-access/models/managed-invocation-context.js';

export function createManagedAccessRequest(props: {
	readonly authority: string;
	readonly reference: string;
	readonly config: GatewayRuntimeManagedToolPortalConfig;
	readonly snapshot: GatewayRuntimePortalSemanticSnapshot;
	readonly context: ManagedEngineInvocationContext;
	readonly call: PortalCallRequest['calls'][number];
	readonly accounts: readonly AccountFact[];
	readonly argumentDigest: string;
}): DispatchRequest {
	const { config, snapshot, reference } = props;
	const selected = props;

	const resolved = resolveManagedEngineInvocation({
		config,
		semanticSnapshot: snapshot,
		context: selected.context,
	});
	return {
		authority: props.authority,
		principal: selected.context.trustedContext.principal.agentId,
		item: selected.call.id,
		verifiedContextRef: reference,
		correlation: jsonObjectSchema.parse(selected.context.trustedContext.correlation ?? {}),
		access: assessAccessInput.parse({
			capability: { namespace: selected.call.namespace, tool: selected.call.name },
			surface: selected.context.surfaceClass,
			call: {
				arguments: selected.call.arguments,
				account:
					typeof selected.call.arguments.accountId === 'string'
						? { oauthAccountId: selected.call.arguments.accountId }
						: null,
				// Preserve the managed hash bytes while using tool-access's hex digest encoding.
				digest: props.argumentDigest,
			},
			facts: {
				workspace: { kind: 'not-configured' },
				assignment: {
					profile: projectManagedAccessProfile({ config, profileId: resolved.profileId }),
					profileRevision: { owner: props.authority, revision: snapshot.profilePolicyRevision },
					revision: {
						owner: props.authority,
						revision: selected.context.trustedContext.principal.profileAssignmentRevision,
					},
				},
				surface: {
					eligible:
						snapshot.surfaceEligibilityByProfile[resolved.profileId]?.[selected.call.namespace] ??
						[],
					snapshot: { owner: props.authority, revision: snapshot.activeRevision },
				},
				accounts: selected.accounts,
				upstream: {
					status: 'available',
					credentialNeed: 'none',
					binding: { owner: props.authority, revision: snapshot.bindingRevision },
				},
			},
		}),
	};
}
