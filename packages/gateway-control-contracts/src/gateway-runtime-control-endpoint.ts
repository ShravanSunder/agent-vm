import { z } from 'zod/v4';

export const GATEWAY_RUNTIME_TOOL_PORTAL_CONTROL_LISTEN_HOST = '127.0.0.1';
export const GATEWAY_RUNTIME_TOOL_PORTAL_CONTROL_GUEST_PORT = 18_790;

export const GatewayRuntimeToolPortalProductionControlEndpointSchema = z
	.object({
		host: z.literal(GATEWAY_RUNTIME_TOOL_PORTAL_CONTROL_LISTEN_HOST),
		port: z.literal(GATEWAY_RUNTIME_TOOL_PORTAL_CONTROL_GUEST_PORT),
	})
	.strict()
	.readonly();

export type GatewayRuntimeToolPortalProductionControlEndpoint = z.infer<
	typeof GatewayRuntimeToolPortalProductionControlEndpointSchema
>;

export const GATEWAY_RUNTIME_TOOL_PORTAL_PRODUCTION_CONTROL_ENDPOINT =
	GatewayRuntimeToolPortalProductionControlEndpointSchema.parse({
		host: GATEWAY_RUNTIME_TOOL_PORTAL_CONTROL_LISTEN_HOST,
		port: GATEWAY_RUNTIME_TOOL_PORTAL_CONTROL_GUEST_PORT,
	});
