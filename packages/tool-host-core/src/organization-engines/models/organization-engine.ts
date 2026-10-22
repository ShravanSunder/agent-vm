import type {
	DispatchInvocation,
	ResourceResult,
} from '@agent-collaboration/tool-engine/capability-dispatch';
import type {
	ConsumeApprovalTokenId,
	McpGateway,
} from '@agent-collaboration/tool-engine/mcp-gateway';

import type { OrganizationConfiguration } from '#tool-host-core/hosted-configuration/models/hosted-configuration';

export interface OrganizationEngine {
	readonly configuration: OrganizationConfiguration;
	readonly refresh: () => Promise<void>;
	readonly gatewayFor: (props: {
		readonly agentClientId: string;
		readonly consumeTokenId: ConsumeApprovalTokenId;
		readonly invoke?: (
			invocation: DispatchInvocation,
			call: () => Promise<ResourceResult>,
		) => Promise<ResourceResult>;
	}) => {
		readonly gateway: McpGateway;
		readonly close: () => Promise<void>;
		readonly trustedTool: (namespace: string, toolName: string) => boolean;
		readonly requiresApproval: (namespace: string, toolName: string) => boolean;
	};
}
