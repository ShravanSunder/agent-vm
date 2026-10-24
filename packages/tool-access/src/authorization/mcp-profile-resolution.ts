import {
	portalApprovalConfigSchema,
	resolvedMcpPortalProfileSchema,
	type McpPortalProfileDefinition,
	type NamespaceToolRef,
	type PortalApprovalConfig,
	type PortalToolSelector,
	type ResolvedMcpPortalProfile,
} from '@agent-collaboration/tool-access/contracts';
type PortalNamespacePolicy = McpPortalProfileDefinition['namespaces'][string];
const defaultProfile: ResolvedMcpPortalProfile = {
	approval: portalApprovalConfigSchema.parse({}),
	cache: { catalogTtlMs: 60_000 },
	enabledNamespaces: [],
	enabledToolsByNamespace: {},
	hiddenToolsByNamespace: {},
	logging: { enabled: false },
	promptContext: { enabled: true, maxNamespaces: 12 },
};

type AuthoredPortalNamespaces = McpPortalProfileDefinition['namespaces'];

function namespaceToolRefs(
	namespaces: Readonly<Record<string, PortalNamespacePolicy>>,
	selector: (policy: PortalNamespacePolicy) => readonly string[],
): readonly NamespaceToolRef[] {
	return Object.entries(namespaces).flatMap(([namespace, policy]) =>
		selector(policy).map((toolName) => ({ namespace, toolName })),
	);
}

function selectorAllowList(selector: PortalToolSelector): readonly string[] {
	return selector.allow === '*' ? [] : selector.allow;
}

function selectorHasVisibleTools(selector: PortalToolSelector): boolean {
	return selector.allow === '*' || selector.allow.length > 0;
}

function activeNamespaces(
	namespaces: Readonly<Record<string, PortalNamespacePolicy>>,
): Readonly<Record<string, PortalNamespacePolicy>> {
	return Object.fromEntries(
		Object.entries(namespaces).filter(([, policy]) => selectorHasVisibleTools(policy.tools)),
	);
}

function compileNamespaceApproval(
	namespaces: Readonly<Record<string, PortalNamespacePolicy>>,
	annotationPolicy: PortalApprovalConfig['annotationPolicy'],
): PortalApprovalConfig {
	return portalApprovalConfigSchema.parse({
		allowWithoutApprovalTools: namespaceToolRefs(namespaces, (policy) => [
			...selectorAllowList(policy.calls.withoutApproval),
			...(policy.approval?.allowWithoutApproval ?? []),
		]),
		annotationPolicy,
		alwaysAskTools: namespaceToolRefs(namespaces, (policy) => [
			...selectorAllowList(policy.calls.requiresApproval),
			...(policy.approval?.alwaysAsk ?? []),
		]),
		callPoliciesByNamespace: Object.fromEntries(
			Object.entries(namespaces).map(([namespace, policy]) => [namespace, policy.calls]),
		),
		trustedAnnotationNamespaces: Object.entries(namespaces)
			.filter(([, policy]) => policy.approval?.trustedAnnotations)
			.map(([namespace]) => namespace),
		writeTools: namespaceToolRefs(namespaces, (policy) => policy.approval?.write ?? []),
	});
}

function compileEnabledToolsByNamespace(
	namespaces: Readonly<Record<string, PortalNamespacePolicy>>,
): Record<string, readonly string[]> {
	return Object.fromEntries(
		Object.entries(namespaces)
			.filter(([, policy]) => policy.tools.allow !== '*')
			.map(([namespace, policy]) => [namespace, selectorAllowList(policy.tools)]),
	);
}

function compileHiddenToolsByNamespace(
	namespaces: Readonly<Record<string, PortalNamespacePolicy>>,
): Record<string, readonly string[]> {
	return Object.fromEntries(
		Object.entries(namespaces)
			.filter(([, policy]) => (policy.tools.deny ?? []).length > 0)
			.map(([namespace, policy]) => [namespace, policy.tools.deny ?? []]),
	);
}

function compileProfileFromNamespaces(
	namespaces: AuthoredPortalNamespaces,
	profile: McpPortalProfileDefinition,
): ResolvedMcpPortalProfile {
	const annotationPolicy =
		profile.approval?.annotationPolicy ?? defaultProfile.approval.annotationPolicy;
	const activeNamespacePolicies = activeNamespaces(namespaces);
	return resolvedMcpPortalProfileSchema.parse({
		approval: compileNamespaceApproval(activeNamespacePolicies, annotationPolicy),
		cache: profile.cache ?? defaultProfile.cache,
		enabledNamespaces: Object.keys(activeNamespacePolicies),
		enabledToolsByNamespace: compileEnabledToolsByNamespace(activeNamespacePolicies),
		hiddenToolsByNamespace: compileHiddenToolsByNamespace(activeNamespacePolicies),
		logging: profile.logging ?? defaultProfile.logging,
		promptContext: profile.promptContext ?? defaultProfile.promptContext,
	});
}

export function resolveMcpPortalProfile(
	config: { readonly profiles: Readonly<Record<string, McpPortalProfileDefinition>> },
	profileName: string,
): ResolvedMcpPortalProfile {
	const profile = config.profiles[profileName];
	if (profile === undefined) {
		throw new Error(`unknown MCP profile '${profileName}'`);
	}
	return compileProfileFromNamespaces(profile.namespaces, profile);
}
