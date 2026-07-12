import { z } from 'zod';

import { CwdPolicySchema } from './cli-invocation-policy-schema.js';

export const ManagedVmArgvMaxItems = 100;
export const ManagedVmTokenMaxLength = 4096;
export const ManagedVmEnvironmentMaxEntries = 100;
export const ManagedVmEnvironmentValueMaxLength = 32 * 1024;
export const ManagedVmStdinMaxBytes = 1024 * 1024;
export const ManagedVmStreamMaxBytes = 16 * 1024 * 1024;
export const ManagedVmTimeoutMaxMs = 8 * 60 * 60 * 1000;

const ManagedVmArgvTokenSchema = z.string().min(1).max(ManagedVmTokenMaxLength);
const ManagedVmEnvironmentSchema = z.record(
	z.string().min(1).max(ManagedVmTokenMaxLength),
	z.string().max(ManagedVmEnvironmentValueMaxLength),
);

export const ManagedVmExecRequestSchema = z
	.object({
		abortSignalId: z.string().min(1).optional(),
		argv: z.array(ManagedVmArgvTokenSchema).max(ManagedVmArgvMaxItems),
		cwd: CwdPolicySchema,
		env: ManagedVmEnvironmentSchema.refine(
			(environment) => Object.keys(environment).length <= ManagedVmEnvironmentMaxEntries,
			{ message: 'ManagedVm env exceeds the maximum number of entries.' },
		),
		executablePath: z.string().startsWith('/'),
		pty: z.literal(false),
		shellMode: z.literal('none'),
		stderr: z.enum(['stream', 'discard']),
		stderrMaxBytes: z.number().int().positive().max(ManagedVmStreamMaxBytes),
		stdin: z.string().max(ManagedVmStdinMaxBytes).optional(),
		stdout: z.enum(['stream', 'discard']),
		stdoutMaxBytes: z.number().int().positive().max(ManagedVmStreamMaxBytes),
		timeoutMs: z.number().int().positive().max(ManagedVmTimeoutMaxMs),
	})
	.strict();

export type ManagedVmExecRequest = z.infer<typeof ManagedVmExecRequestSchema>;
