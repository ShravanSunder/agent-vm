import {
	type GatewayRuntimePortalSemanticSnapshot,
	GatewayRuntimePortalSurfaceClassSchema,
	GatewayRuntimeTrustedInvocationContextSchema,
} from '@agent-vm/gateway-control-contracts';
import { z } from 'zod';

import type {
	ToolPortalStandaloneSemanticSnapshot,
	ToolPortalStandaloneServiceInvocationOptions,
} from './standalone-tool-portal-invocation-contracts.js';
import { ToolPortalAbortSignalSchema } from './tool-portal-abort-signal-schema.js';

export * from './standalone-tool-portal-invocation-contracts.js';

export const ToolPortalManagedServiceInvocationOptionsSchema = z
	.object({
		origin: z
			.object({
				kind: z.literal('managed'),
				trustedContext: GatewayRuntimeTrustedInvocationContextSchema,
			})
			.strict(),
		signal: ToolPortalAbortSignalSchema.optional(),
		surfaceClass: GatewayRuntimePortalSurfaceClassSchema,
	})
	.strict();

export type ToolPortalManagedServiceInvocationOptions = z.infer<
	typeof ToolPortalManagedServiceInvocationOptionsSchema
>;

export type ToolPortalServiceInvocationOptions =
	| ToolPortalManagedServiceInvocationOptions
	| ToolPortalStandaloneServiceInvocationOptions;

export type ToolPortalServiceMode = 'managed' | 'standalone-v1';

export type ToolPortalSemanticSnapshot<TMode extends ToolPortalServiceMode> =
	TMode extends 'managed'
		? GatewayRuntimePortalSemanticSnapshot
		: ToolPortalStandaloneSemanticSnapshot;

export type ToolPortalInvocationOptionsForMode<TMode extends ToolPortalServiceMode> =
	TMode extends 'managed'
		? ToolPortalManagedServiceInvocationOptions
		: ToolPortalStandaloneServiceInvocationOptions;
