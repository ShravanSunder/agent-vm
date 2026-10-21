import { toJSONSchema } from 'zod';

import { mcpConfigSchema } from '#node-host/host-configuration/models/mcp-config';

export function createMcpConfigSchemaArtifact(): Record<string, unknown> {
	return { $id: 'agent-vm:mcp:1', ...toJSONSchema(mcpConfigSchema, { target: 'draft-07' }) };
}
