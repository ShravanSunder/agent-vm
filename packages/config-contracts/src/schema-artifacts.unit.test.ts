import { describe, expect, it } from 'vitest';

import {
	createConfigContractSchemaArtifacts,
	mcpPortalConfigSchemaIds,
	mcpPortalConfigSchemaPaths,
	mcpPortalConfigSchemaVersions,
} from './schema-artifacts.js';

describe('schema artifacts', () => {
	it('exposes schema ids, versions, paths, and JSON Schema artifacts', () => {
		const schemas = createConfigContractSchemaArtifacts();

		expect(mcpPortalConfigSchemaIds.mcp).toBe('agent-vm:mcp:1');
		expect(mcpPortalConfigSchemaIds.mcpPortal).toBe('agent-vm:mcp-portal:1');
		expect(mcpPortalConfigSchemaIds.toolPortal).toBe('agent-vm:tool-portal:1');
		expect(mcpPortalConfigSchemaPaths.mcpFromGatewayConfig).toBe('../../schemas/mcp.schema.json');
		expect(mcpPortalConfigSchemaPaths.mcpPortalFromGatewayConfig).toBe(
			'../../schemas/mcp-portal.schema.json',
		);
		expect(mcpPortalConfigSchemaPaths.toolPortalFromGatewayConfig).toBe(
			'../../schemas/tool-portal.schema.json',
		);
		expect(mcpPortalConfigSchemaVersions.mcp).toBe(1);
		expect(mcpPortalConfigSchemaVersions.mcpPortal).toBe(1);
		expect(mcpPortalConfigSchemaVersions.toolPortal).toBe(1);
		expect(schemas.mcp.$id).toBe('agent-vm:mcp:1');
		expect(schemas.mcpPortal.$id).toBe('agent-vm:mcp-portal:1');
		expect(schemas.toolPortal.$id).toBe('agent-vm:tool-portal:1');
	});
});
