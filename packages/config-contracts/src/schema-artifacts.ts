import * as zod from 'zod';

import { mcpConfigSchema } from './mcp-config.js';
import { mcpPortalConfigSchema } from './mcp-portal-config.js';
import { toolPortalConfigSchema } from './tool-portal-config.js';

export const mcpPortalConfigSchemaVersions = {
	mcp: 1,
	mcpPortal: 1,
	toolPortal: 1,
} as const;

export const mcpPortalConfigSchemaIds = {
	mcp: 'agent-vm:mcp:1',
	mcpPortal: 'agent-vm:mcp-portal:1',
	toolPortal: 'agent-vm:tool-portal:1',
} as const;

export const mcpPortalConfigSchemaPaths = {
	mcpFromGatewayConfig: '../../schemas/mcp.schema.json',
	mcpPortalFromGatewayConfig: '../../schemas/mcp-portal.schema.json',
	toolPortalFromGatewayConfig: '../../schemas/tool-portal.schema.json',
} as const;

export interface ConfigContractSchemaArtifacts {
	readonly mcp: Record<string, unknown>;
	readonly mcpPortal: Record<string, unknown>;
	readonly toolPortal: Record<string, unknown>;
}

function withSchemaId(schema: Record<string, unknown>, schemaId: string): Record<string, unknown> {
	return {
		$id: schemaId,
		...schema,
	};
}

export function createConfigContractSchemaArtifacts(): ConfigContractSchemaArtifacts {
	return {
		mcp: withSchemaId(
			zod.toJSONSchema(mcpConfigSchema, { target: 'draft-07' }),
			mcpPortalConfigSchemaIds.mcp,
		),
		mcpPortal: withSchemaId(
			zod.toJSONSchema(mcpPortalConfigSchema, { target: 'draft-07' }),
			mcpPortalConfigSchemaIds.mcpPortal,
		),
		toolPortal: withSchemaId(
			zod.toJSONSchema(toolPortalConfigSchema, { target: 'draft-07' }),
			mcpPortalConfigSchemaIds.toolPortal,
		),
	};
}
