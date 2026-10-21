import { mcpPortalProfileDefinitionSchema } from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import { mcpConfigSchema } from '#tool-host-core/hosted-configuration/models/mcp-configuration';
import { secretValueSchema } from '#tool-host-core/hosted-configuration/models/secret-values';

// Proxy policy wire format. The HTTP listener and bearer-master-key fields have no authority here.
export const hostedPortalConfigurationSchema = z.strictObject({
	$schema: z.string().min(1).optional(),
	schemaVersion: z.literal(1),
	externalAuth: z.strictObject({ masterKey: secretValueSchema }).optional(),
	mcpProxy: z.unknown().optional(),
	agents: z
		.record(
			z.string().min(1),
			z.strictObject({
				credentialVersion: z.number().int().positive().default(1),
				profile: z.string().min(1),
				hmacKey: secretValueSchema.optional(),
			}),
		)
		.default({}),
	profiles: z.record(z.string().min(1), mcpPortalProfileDefinitionSchema),
});
export const organizationConfigurationSchema = z.strictObject({
	organizationName: z.string().min(1),
	mcp: mcpConfigSchema,
	portal: hostedPortalConfigurationSchema,
	approvalKeyBinding: z.string().min(1),
});
export type OrganizationConfiguration = z.infer<typeof organizationConfigurationSchema>;
export interface OrganizationConfigurationSource {
	readonly read: (organizationId: string) => Promise<OrganizationConfiguration>;
}

export interface SecretSource {
	readonly read: (name: string) => string;
}
