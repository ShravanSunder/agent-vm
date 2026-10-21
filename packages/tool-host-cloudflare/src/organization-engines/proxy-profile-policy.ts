import { mcpPortalCallPolicyDecision } from '@agent-collaboration/tool-access/authorization';
import {
	resolvedMcpPortalProfileSchema,
	type McpPortalProfileDefinition,
	type ResolvedMcpPortalProfile,
	type AssessAccessInput,
} from '@agent-collaboration/tool-access/contracts';
import type { PortalToolRecord } from '@agent-collaboration/tool-engine/mcp-gateway';

export function resolveWorkerProxyProfile(
	profile: McpPortalProfileDefinition,
): ResolvedMcpPortalProfile {
	const entries = Object.entries(profile.namespaces).filter(
		([, policy]) => policy.tools.allow === '*' || policy.tools.allow.length > 0,
	);
	return resolvedMcpPortalProfileSchema.parse({
		enabledNamespaces: entries.map(([namespace]) => namespace),
		enabledToolsByNamespace: Object.fromEntries(
			entries
				.filter(([, policy]) => policy.tools.allow !== '*')
				.map(([namespace, policy]) => [namespace, policy.tools.allow]),
		),
		hiddenToolsByNamespace: Object.fromEntries(
			entries.map(([namespace, policy]) => [namespace, policy.tools.deny]),
		),
		logging: profile.logging ?? { enabled: false },
		promptContext: profile.promptContext ?? { enabled: true, maxNamespaces: 12 },
		cache: profile.cache ?? { catalogTtlMs: 60_000 },
		approval: {
			annotationPolicy: profile.approval?.annotationPolicy ?? 'destructive-requires-approval',
			callPoliciesByNamespace: Object.fromEntries(
				entries.map(([namespace, policy]) => [namespace, policy.calls]),
			),
			allowWithoutApprovalTools: entries.flatMap(([namespace, policy]) =>
				(policy.approval?.allowWithoutApproval ?? []).map((toolName) => ({ namespace, toolName })),
			),
			alwaysAskTools: entries.flatMap(([namespace, policy]) =>
				(policy.approval?.alwaysAsk ?? []).map((toolName) => ({ namespace, toolName })),
			),
			writeTools: entries.flatMap(([namespace, policy]) =>
				(policy.approval?.write ?? []).map((toolName) => ({ namespace, toolName })),
			),
			trustedAnnotationNamespaces: entries
				.filter(([, policy]) => policy.approval?.trustedAnnotations)
				.map(([namespace]) => namespace),
		},
	});
}

/** Translate today's proxy policy to dispatcher facts for the exact tool being assessed. */
export function assessedProxyProfile(props: {
	readonly profileId: string;
	readonly profile: McpPortalProfileDefinition;
	readonly resolved: ResolvedMcpPortalProfile;
	readonly tool: PortalToolRecord | undefined;
	readonly capability: AssessAccessInput['capability'];
}): AssessAccessInput['facts']['assignment']['profile'] {
	const namespace = props.profile.namespaces[props.capability.namespace];
	if (namespace === undefined || props.tool === undefined)
		return { profileId: props.profileId, namespaces: {} };
	const decision = mcpPortalCallPolicyDecision(props.resolved, {
		namespace: props.tool.namespace,
		toolName: props.tool.toolName,
		...(props.tool.annotations === undefined ? {} : { annotations: props.tool.annotations }),
	});
	return {
		profileId: props.profileId,
		namespaces: {
			[props.capability.namespace]: {
				backendKind: 'mcp_provider',
				tools: namespace.tools,
				calls: {
					kind: 'selectors',
					withoutApproval: {
						allow: decision.kind === 'allow_without_approval' ? [props.capability.tool] : [],
						deny: [],
					},
					requiresApproval: {
						allow: decision.kind === 'requires_approval' ? [props.capability.tool] : [],
						deny: [],
					},
				},
				operations: {},
			},
		},
	};
}
