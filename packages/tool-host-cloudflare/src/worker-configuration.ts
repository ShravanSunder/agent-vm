import { mcpPortalProfileDefinitionSchema } from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import { mcpConfigSchema } from '#worker-host/worker-mcp-configuration';
import { secretValueSchema } from '#worker-host/worker-secret-values';

// Proxy policy wire format. The HTTP listener and bearer-master-key fields have no authority here.
export const workerPortalConfigurationSchema = z.strictObject({
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
	portal: workerPortalConfigurationSchema,
	approvalKeyBinding: z.string().min(1),
});
export type OrganizationConfiguration = z.infer<typeof organizationConfigurationSchema>;
export interface OrganizationConfigurationSource {
	readonly read: (organizationId: string) => Promise<OrganizationConfiguration>;
}

/** S6 source: configuration deployed with the Worker. Versioned database configuration is deferred. */
export function deployedConfigurationSource(
	configurations: unknown,
): OrganizationConfigurationSource {
	const parsed = z.record(z.uuid(), organizationConfigurationSchema).parse(configurations);
	return {
		read: async (organizationId) => {
			const configuration = parsed[organizationId];
			if (configuration === undefined) throw new Error('Organization configuration unavailable.');
			return configuration;
		},
	};
}

export interface WorkerSecretBindings {
	readonly read: (name: string) => string;
}
export function workerSecretBindings(
	bindings: Readonly<Record<string, unknown>>,
): WorkerSecretBindings {
	return { read: (name) => z.string().min(1).parse(bindings[name]) };
}
