import {
	effectiveManagedToolPortalConfigSchema,
	mcpConfigSchema,
} from '@agent-vm/config-contracts';
import { z } from 'zod/v4';

import { GatewayRuntimePortalSemanticSnapshotSchema } from './gateway-runtime-portal-context.js';

export const GATEWAY_RUNTIME_PORTAL_ADMISSION_FILE_NAME = 'gateway-runtime-portal-admission.json';

export const GatewayRuntimePortalAdmissionMaterialSchema = z
	.object({
		effectiveMcpConfig: mcpConfigSchema,
		effectiveToolPortalConfig: effectiveManagedToolPortalConfigSchema,
		semanticSnapshot: GatewayRuntimePortalSemanticSnapshotSchema,
	})
	.strict();

export type GatewayRuntimePortalAdmissionMaterial = z.infer<
	typeof GatewayRuntimePortalAdmissionMaterialSchema
>;
