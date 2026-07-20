import { z } from 'zod';

import { SandboxStreamHandleSchema, SandboxTerminalHandleSchema } from './contract-foundations.js';
import { SandboxOperationIdentitySchema } from './operation-contracts.js';
import { SandboxTerminalSizeSchema } from './sandbox-execution-contracts.js';

export const SandboxTerminalAttachRequestSchema = z
	.object({
		operation: SandboxOperationIdentitySchema,
		size: SandboxTerminalSizeSchema,
	})
	.strict();

export const SandboxTerminalAttachResultSchema = z
	.object({
		input: SandboxStreamHandleSchema,
		kind: z.literal('attached'),
		output: SandboxStreamHandleSchema,
		terminal: SandboxTerminalHandleSchema,
	})
	.strict();

export const SandboxTerminalResizeRequestSchema = z
	.object({
		size: SandboxTerminalSizeSchema,
		terminal: SandboxTerminalHandleSchema,
	})
	.strict();

export const SandboxTerminalResizeResultSchema = z
	.object({
		kind: z.literal('resized'),
		size: SandboxTerminalSizeSchema,
		terminal: SandboxTerminalHandleSchema,
	})
	.strict();

export type SandboxTerminalAttachRequest = z.infer<typeof SandboxTerminalAttachRequestSchema>;
export type SandboxTerminalAttachResult = z.infer<typeof SandboxTerminalAttachResultSchema>;
export type SandboxTerminalResizeRequest = z.infer<typeof SandboxTerminalResizeRequestSchema>;
export type SandboxTerminalResizeResult = z.infer<typeof SandboxTerminalResizeResultSchema>;
