import { mcpPortalProfileDefinitionSchema } from '@agent-collaboration/tool-access/contracts';
import { mcpConfigSchema } from '@agent-collaboration/tool-access/contracts';
import { secretValueSchema } from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

// Proxy policy wire format. The HTTP listener and bearer-master-key fields have no authority here.
export const hostedPortalConfigurationSchema = z.strictObject({
	$schema: z.string().min(1).optional(),
	schemaVersion: z.literal(1),
	sessionDefaultProfile: z.string().min(1),
	externalAuth: z.strictObject({ masterKey: secretValueSchema }).optional(),
	mcpProxy: z.unknown().optional(),
	agents: z
		.record(
			z.string().min(1),
			z.strictObject({
				credentialVersion: z.number().int().positive().default(1),
				hmacKey: secretValueSchema.optional(),
			}),
		)
		.default({}),
	profiles: z.record(z.string().min(1), mcpPortalProfileDefinitionSchema),
});
export const workspaceConfigurationSchema = z.strictObject({
	organizationId: z.uuid(),
	workspaceName: z.string().min(1),
	mcp: mcpConfigSchema,
	portal: hostedPortalConfigurationSchema,
	approvalKeyBinding: z.string().min(1),
});
export type WorkspaceConfiguration = z.infer<typeof workspaceConfigurationSchema>;
export interface WorkspaceConfigurationSource {
	readonly workspaceIdsForOrganization: (organizationId: string) => Promise<readonly string[]>;
	readonly read: (workspaceId: string) => Promise<WorkspaceConfiguration>;
}

export interface SecretSource {
	readonly read: (name: string) => string;
}
