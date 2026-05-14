import { resolveMcpPortalProfile } from '@agent-vm/config-contracts';

import type {
	OpenClawBeforePromptBuildEvent,
	OpenClawPluginHookContext,
	OpenClawPromptHookResult,
} from './openclaw-plugin-api.js';
import type { PortalPluginRuntimeState } from './portal-plugin-runtime-state.js';

export interface CreateBeforePromptBuildHandlerProps {
	readonly runtimeState: PortalPluginRuntimeState;
}

export function createBeforePromptBuildHandler(
	props: CreateBeforePromptBuildHandlerProps,
): (
	event: OpenClawBeforePromptBuildEvent,
	context: OpenClawPluginHookContext,
) => Promise<OpenClawPromptHookResult | undefined> {
	return async (_event, context) => {
		const agentId = context.agentId;
		if (agentId === undefined) {
			return undefined;
		}
		const portalConfig = await props.runtimeState.loadPortalConfig();
		const agent = portalConfig.agents[agentId];
		if (agent === undefined) {
			return undefined;
		}
		const profile = resolveMcpPortalProfile(portalConfig, agent.profile);
		if (!profile.promptContext.enabled) {
			return undefined;
		}
		const namespaces = profile.enabledNamespaces
			.toSorted()
			.slice(0, profile.promptContext.maxNamespaces);
		const namespaceText =
			namespaces.length === 0
				? '  (none in your profile)'
				: namespaces.map((name) => `  ${name}`).join('\n');
		return {
			appendSystemContext: [
				'MCP Portal namespaces available to this agent:',
				namespaceText,
				'Use mcp_portal_search to find tools by intent, then mcp_portal_describe before mcp_portal_call.',
			].join('\n'),
		};
	};
}
