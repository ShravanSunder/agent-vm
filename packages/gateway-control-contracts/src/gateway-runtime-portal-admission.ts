import {
	mcpConfigSchema,
	toolPortalConfigSchema,
	type ManagedToolPortalConfig,
} from '@agent-vm/config-contracts';
import { z } from 'zod/v4';

import { GatewayRuntimePortalSemanticSnapshotSchema } from './gateway-runtime-portal-context.js';

export const GATEWAY_RUNTIME_PORTAL_ADMISSION_FILE_NAME = 'gateway-runtime-portal-admission.json';

const GatewayRuntimeManagedToolPortalConfigSchema = toolPortalConfigSchema.transform(
	(config, context): ManagedToolPortalConfig => {
		if (config.mode !== 'managed') {
			context.addIssue({
				code: 'custom',
				message: 'Gateway runtime admission requires managed Tool Portal configuration.',
				path: ['mode'],
			});
			return z.NEVER;
		}
		return config;
	},
);

export const GatewayRuntimePortalAdmissionMaterialSchema = z
	.object({
		effectiveMcpConfig: mcpConfigSchema,
		effectiveToolPortalConfig: GatewayRuntimeManagedToolPortalConfigSchema,
		semanticSnapshot: GatewayRuntimePortalSemanticSnapshotSchema,
	})
	.strict();

export type GatewayRuntimePortalAdmissionMaterial = z.infer<
	typeof GatewayRuntimePortalAdmissionMaterialSchema
>;
