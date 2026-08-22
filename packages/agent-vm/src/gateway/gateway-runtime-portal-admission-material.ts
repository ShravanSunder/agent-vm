import { compareUnicodeCodePointStrings } from '@agent-vm/agent-portal-sdk';
import {
	effectiveManagedToolPortalConfigSchema,
	type EffectiveManagedToolPortalConfig,
	type McpConfig,
} from '@agent-vm/config-contracts';
import {
	deriveGatewayRuntimePortalSemanticSnapshot,
	type GatewayRuntimePortalAdmissionMaterial,
	type GatewayRuntimePortalSemanticSnapshot,
	type ManagedAgentProjectionInput,
	type ManagedFrameworkAgentProjectionInput,
} from '@agent-vm/gateway-control-contracts';

import type { McpPortalEffectiveConfigPlan } from './mcp-portal-effective-config.js';

type EffectivePortalConfigPlan = Pick<
	McpPortalEffectiveConfigPlan,
	'effectiveMcpConfig' | 'effectiveToolPortalConfig'
>;

export interface MaterializeGatewayRuntimePortalAdmissionProps {
	readonly agentProjections: readonly ManagedFrameworkAgentProjectionInput[];
	readonly effectivePlan: EffectivePortalConfigPlan;
	readonly surfaceEligibilityByProfile: GatewayRuntimePortalSemanticSnapshot['surfaceEligibilityByProfile'];
}

interface GatewayRuntimePortalAdmissionEffectivePlan {
	readonly effectiveMcpConfig: McpConfig;
	readonly effectiveToolPortalConfig: EffectiveManagedToolPortalConfig;
}

function deriveManagedAgentProjectionInput(props: {
	readonly effectiveToolPortalConfig: EffectiveManagedToolPortalConfig;
	readonly frameworkAgentProjection: ManagedFrameworkAgentProjectionInput;
	readonly surfaceEligibilityByProfile: GatewayRuntimePortalSemanticSnapshot['surfaceEligibilityByProfile'];
}): ManagedAgentProjectionInput {
	const profile =
		props.effectiveToolPortalConfig.profiles[props.frameworkAgentProjection.toolPortalProfileId];
	if (profile === undefined) {
		throw new Error(
			`Managed Agent Projection Tool Portal profile '${props.frameworkAgentProjection.toolPortalProfileId}' is missing.`,
		);
	}
	const profileSurfaceEligibility =
		props.surfaceEligibilityByProfile[props.frameworkAgentProjection.toolPortalProfileId];
	if (profileSurfaceEligibility === undefined) {
		throw new Error(
			`Managed Agent Projection surface eligibility is missing for profile '${props.frameworkAgentProjection.toolPortalProfileId}'.`,
		);
	}
	const toolPortalNamespaces = Object.entries(profile.namespaces)
		.filter(([namespaceName]) =>
			profileSurfaceEligibility[namespaceName]?.includes('protected_uds'),
		)
		.map(([namespace, namespacePolicy]) => ({ namespace, ...namespacePolicy.discovery }))
		.toSorted((left, right) =>
			compareUnicodeCodePointStrings(left.namespace, right.namespace),
		);
	return {
		...props.frameworkAgentProjection,
		toolPortalNamespaces,
	};
}

export function materializeGatewayRuntimePortalAdmission(
	props: MaterializeGatewayRuntimePortalAdmissionProps,
): GatewayRuntimePortalAdmissionMaterial {
	const effectivePlan: GatewayRuntimePortalAdmissionEffectivePlan = {
		effectiveMcpConfig: props.effectivePlan.effectiveMcpConfig,
		effectiveToolPortalConfig: effectiveManagedToolPortalConfigSchema.parse(
			props.effectivePlan.effectiveToolPortalConfig,
		),
	};
	const agentProjections = props.agentProjections.map((frameworkAgentProjection) =>
		deriveManagedAgentProjectionInput({
			effectiveToolPortalConfig: effectivePlan.effectiveToolPortalConfig,
			frameworkAgentProjection,
			surfaceEligibilityByProfile: props.surfaceEligibilityByProfile,
		}),
	);
	const semanticSnapshot = deriveGatewayRuntimePortalSemanticSnapshot({
		agentProjections,
		mcpConfig: effectivePlan.effectiveMcpConfig,
		surfaceEligibilityByProfile: props.surfaceEligibilityByProfile,
		toolPortalConfig: effectivePlan.effectiveToolPortalConfig,
	});
	return {
		effectiveMcpConfig: effectivePlan.effectiveMcpConfig,
		effectiveToolPortalConfig: effectivePlan.effectiveToolPortalConfig,
		semanticSnapshot,
	};
}
