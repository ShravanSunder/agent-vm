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
} from '@agent-vm/gateway-control-contracts';

import type { McpPortalEffectiveConfigPlan } from './mcp-portal-effective-config.js';

type EffectivePortalConfigPlan = Pick<
	McpPortalEffectiveConfigPlan,
	'effectiveMcpConfig' | 'effectiveToolPortalConfig'
>;

export interface MaterializeGatewayRuntimePortalAdmissionProps {
	readonly agentProjections: readonly ManagedAgentProjectionInput[];
	readonly effectivePlan: EffectivePortalConfigPlan;
	readonly surfaceEligibilityByProfile: GatewayRuntimePortalSemanticSnapshot['surfaceEligibilityByProfile'];
}

interface GatewayRuntimePortalAdmissionEffectivePlan {
	readonly effectiveMcpConfig: McpConfig;
	readonly effectiveToolPortalConfig: ManagedToolPortalConfig;
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
	const semanticSnapshot = deriveGatewayRuntimePortalSemanticSnapshot({
		agentProjections: props.agentProjections,
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
