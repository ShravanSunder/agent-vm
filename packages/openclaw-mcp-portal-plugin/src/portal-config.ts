import { z } from 'zod';

export const portalPluginConfigSchema = z
	.object({
		configDir: z.string().min(1),
	})
	.strict();

export type PortalPluginConfig = z.infer<typeof portalPluginConfigSchema>;

export function parsePortalConfig(value: unknown): PortalPluginConfig {
	return portalPluginConfigSchema.parse(value ?? {});
}
