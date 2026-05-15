import { z } from 'zod';

export const defaultPortalBinPath = '/opt/agent-vm/portal/bin/agent-vm-mcp-portal-server';

export const portalPluginConfigSchema = z
	.object({
		binPath: z.string().min(1).default(defaultPortalBinPath),
		configDir: z.string().min(1).optional(),
	})
	.strict();

export type PortalPluginConfig = z.infer<typeof portalPluginConfigSchema>;

export function parsePortalConfig(value: unknown): PortalPluginConfig {
	return portalPluginConfigSchema.parse(value ?? {});
}
