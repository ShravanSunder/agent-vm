import type {
	DispatchInvocation,
	ResourceResult,
} from '@agent-collaboration/tool-engine/capability-dispatch';
import type {
	ConsumeApprovalTokenId,
	McpGateway,
	WorkspaceToolCatalogSnapshot,
} from '@agent-collaboration/tool-engine/mcp-gateway';

import type { OrganizationConfiguration } from '#tool-host-core/hosted-configuration/models/hosted-configuration';

/** Settled plain data only; never a discovery promise, runtime or client. */
export interface SettledOrganizationCatalog {
	readonly snapshot: WorkspaceToolCatalogSnapshot;
	/** Discovery start controls publication order and conservative cache expiry. */
	readonly discoveryStartedAt: number;
}

export interface OrganizationEngine {
	readonly configuration: OrganizationConfiguration;
	readonly settledCatalog: () => SettledOrganizationCatalog | undefined;
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
