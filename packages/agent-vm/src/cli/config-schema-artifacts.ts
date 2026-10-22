import {
	createMcpConfigSchemaArtifact,
	createMcpPortalConfigSchemaArtifact,
} from '@agent-collaboration/tool-host-node';
import { createToolPortalConfigSchemaArtifact } from '@agent-vm/config-contracts';
export interface ConfigContractSchemaArtifacts {
	readonly mcp: Record<string, unknown>;
	readonly mcpPortal: Record<string, unknown>;
	readonly toolPortal: Record<string, unknown>;
}
export function createConfigContractSchemaArtifacts(): ConfigContractSchemaArtifacts {
	return {
		mcp: createMcpConfigSchemaArtifact(),
		mcpPortal: createMcpPortalConfigSchemaArtifact(),
		toolPortal: createToolPortalConfigSchemaArtifact(),
	};
}
