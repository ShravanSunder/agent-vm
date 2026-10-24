import {
	mcpPortalCallPolicyDecision,
	toolPortalSelectorAllowsOperation,
} from '@agent-collaboration/tool-access/authorization';
import {
	resolvedMcpPortalProfileSchema,
	type McpPortalProfileDefinition,
	type ResolvedMcpPortalProfile,
	type AssessAccessInput,
	type Principal,
	type PersonaRef,
} from '@agent-collaboration/tool-access/contracts';
import type { PortalToolRecord } from '@agent-collaboration/tool-engine/mcp-gateway';

export function resolveHostedProxyProfile(
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

export interface ResolvedHostedProxyProfile {
	readonly profile: McpPortalProfileDefinition;
	readonly resolved: ResolvedMcpPortalProfile;
}

export function resolveHostedCallerProfiles(props: {
	readonly principal: Principal;
	readonly persona: PersonaRef;
	readonly sessionDefaultProfile: string;
	readonly profiles: Readonly<Record<string, McpPortalProfileDefinition>>;
}): readonly ResolvedHostedProxyProfile[] | undefined {
	const profileNames =
		props.principal.kind === 'bot'
			? props.persona.kind === 'named'
				? [props.persona.name]
				: []
			: props.persona.kind === 'named'
				? [props.sessionDefaultProfile, props.persona.name]
				: [props.sessionDefaultProfile];
	const profiles = profileNames.map((name) => props.profiles[name]);
	if (profiles.length === 0 || profiles.some((profile) => profile === undefined)) return undefined;
	return profiles.flatMap((profile) =>
		profile === undefined ? [] : [{ profile, resolved: resolveHostedProxyProfile(profile) }],
	);
}

/** Assess each policy independently; intersection makes neither profile more permissive. */
export function assessedProxyProfile(props: {
	readonly profileId: string;
	readonly profiles: readonly ResolvedHostedProxyProfile[];
	readonly tool: PortalToolRecord | undefined;
	readonly capability: AssessAccessInput['capability'];
}): AssessAccessInput['facts']['assignment']['profile'] {
	if (props.tool === undefined || props.profiles.length === 0)
		return { profileId: props.profileId, namespaces: {} };
	const tool = props.tool;
	const decisions = props.profiles.map(({ profile, resolved }) => {
		const namespace = profile.namespaces[props.capability.namespace];
		if (
			namespace === undefined ||
			!toolPortalSelectorAllowsOperation(namespace.tools, tool.toolName)
		)
			return { kind: 'blocked' } as const;
		return mcpPortalCallPolicyDecision(resolved, {
			namespace: tool.namespace,
			toolName: tool.toolName,
			...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
		});
	});
	const available = decisions.every((decision) => decision.kind !== 'blocked');
	const withoutApproval =
		available && decisions.every((decision) => decision.kind === 'allow_without_approval');
	return {
		profileId: props.profileId,
		namespaces: {
			[props.capability.namespace]: {
				backendKind: 'mcp_provider',
				tools: { allow: available ? [props.capability.tool] : [], deny: [] },
				calls: {
					kind: 'selectors',
					withoutApproval: { allow: withoutApproval ? [props.capability.tool] : [], deny: [] },
					requiresApproval: {
						allow: available && !withoutApproval ? [props.capability.tool] : [],
						deny: [],
					},
				},
				operations: {},
			},
		},
	};
}
