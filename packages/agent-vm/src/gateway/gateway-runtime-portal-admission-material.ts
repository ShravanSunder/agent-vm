import { compareUnicodeCodePointStrings } from '@agent-vm/agent-portal-sdk';
import {
	managedToolPortalConfigSchema,
	toolPortalConfigSchema,
	type McpConfig,
	type ManagedToolPortalConfig,
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
	readonly effectiveToolPortalConfig: ManagedToolPortalConfig;
}

function deriveManagedAgentProjectionInput(props: {
	readonly effectiveToolPortalConfig: ManagedToolPortalConfig;
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
	const toolPortalNamespaceNames = Object.keys(profile.namespaces)
		.filter((namespaceName) => profileSurfaceEligibility[namespaceName]?.includes('protected_uds'))
		.toSorted(compareUnicodeCodePointStrings);
	return {
		...props.frameworkAgentProjection,
		toolPortalNamespaceNames,
	};
}

export function materializeGatewayRuntimePortalAdmission(
	props: MaterializeGatewayRuntimePortalAdmissionProps,
): GatewayRuntimePortalAdmissionMaterial {
	const effectivePlan: GatewayRuntimePortalAdmissionEffectivePlan = {
		effectiveMcpConfig: props.effectivePlan.effectiveMcpConfig,
		effectiveToolPortalConfig: managedToolPortalConfigSchema.parse(
			toolPortalConfigSchema.parse(props.effectivePlan.effectiveToolPortalConfig),
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
