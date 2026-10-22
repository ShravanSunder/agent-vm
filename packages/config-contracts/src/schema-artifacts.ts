import { toJSONSchema } from 'zod';

import { toolPortalConfigSchema } from './tool-portal-config.js';

export function createToolPortalConfigSchemaArtifact(): Record<string, unknown> {
	return {
		$id: 'agent-vm:tool-portal:1',
		...toJSONSchema(toolPortalConfigSchema, { target: 'draft-07' }),
	};
}
