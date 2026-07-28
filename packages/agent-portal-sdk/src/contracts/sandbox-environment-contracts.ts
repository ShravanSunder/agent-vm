import { z } from 'zod';

import {
	SandboxEnvironmentHandleSchema,
	SandboxWorkRelativePathSchema,
} from './contract-foundations.js';

// Omission denotes the server-selected /work root; a present value is a strict child path.
const SandboxEnvironmentLogicalCwdSchema = SandboxWorkRelativePathSchema.optional();

export const SandboxEnvironmentOpenRequestSchema = z
	.object({ logicalCwd: SandboxEnvironmentLogicalCwdSchema })
	.strict();

export const SandboxEnvironmentOpenResultSchema = z
	.object({
		environment: SandboxEnvironmentHandleSchema,
		kind: z.literal('opened'),
		logicalCwd: SandboxEnvironmentLogicalCwdSchema,
	})
	.strict();

export const SandboxEnvironmentHandleRequestSchema = z
	.object({ environment: SandboxEnvironmentHandleSchema })
	.strict();

export const SandboxEnvironmentCloseResultSchema = z.discriminatedUnion('kind', [
	z.object({ environment: SandboxEnvironmentHandleSchema, kind: z.literal('closed') }).strict(),
	z
		.object({ environment: SandboxEnvironmentHandleSchema, kind: z.literal('already-closed') })
		.strict(),
]);

export const SandboxEnvironmentStatusResultSchema = z.discriminatedUnion('kind', [
	z
		.object({
			environment: SandboxEnvironmentHandleSchema,
			kind: z.literal('active'),
			logicalCwd: SandboxEnvironmentLogicalCwdSchema,
		})
		.strict(),
	z.object({ environment: SandboxEnvironmentHandleSchema, kind: z.literal('closed') }).strict(),
	z.object({ environment: SandboxEnvironmentHandleSchema, kind: z.literal('replaced') }).strict(),
]);

export type SandboxEnvironmentOpenRequest = z.infer<typeof SandboxEnvironmentOpenRequestSchema>;
export type SandboxEnvironmentOpenResult = z.infer<typeof SandboxEnvironmentOpenResultSchema>;
export type SandboxEnvironmentCloseRequest = z.infer<typeof SandboxEnvironmentHandleRequestSchema>;
export type SandboxEnvironmentCloseResult = z.infer<typeof SandboxEnvironmentCloseResultSchema>;
export type SandboxEnvironmentStatusRequest = z.infer<typeof SandboxEnvironmentHandleRequestSchema>;
export type SandboxEnvironmentStatusResult = z.infer<typeof SandboxEnvironmentStatusResultSchema>;
