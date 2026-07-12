import { z } from 'zod';

import { ExecutionFingerprintSchema } from '../../controller-dispatch-boundary/models/execution-fingerprint-schema.js';

export const ControllerExecutionArgvMaxItems = 100;
export const ControllerExecutionArgvTokenMaxLength = 4096;
export const ControllerExecutionOutputMaxBytes = 16 * 1024 * 1024;
export const ControllerExecutionTimeoutMaxMs = 8 * 60 * 60 * 1000;

const ControllerExecutionArgvTokenSchema = z
	.string()
	.min(1)
	.max(ControllerExecutionArgvTokenMaxLength);

export const CwdPolicySchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('fixed'), path: z.string().startsWith('/') }).strict(),
	z.object({ kind: z.literal('workspace_root') }).strict(),
	z.object({ kind: z.literal('runner_scratch') }).strict(),
]);

export const EnvironmentPolicySchema = z
	.object({
		allowedVariables: z.array(z.string().min(1)).default([]),
		deniedPatterns: z.array(z.string()).default([]),
		mode: z.enum(['empty', 'allowlist', 'controller_materialized']),
	})
	.strict();

export const EgressPolicySchema = z
	.object({
		allowedHosts: z.array(z.string().min(1)),
		allowedPorts: z.array(z.number().int().positive().max(65_535)).optional(),
		denyEndpointOverrides: z.boolean().default(true),
	})
	.strict();

export const OutputPolicySchema = z
	.object({
		modelVisibleStderr: z.enum(['none', 'safe_summary']).default('safe_summary'),
		redactionProfile: z.string().min(1),
		stderrMaxBytes: z.number().int().positive().max(ControllerExecutionOutputMaxBytes),
		stdoutMaxBytes: z.number().int().positive().max(ControllerExecutionOutputMaxBytes),
		truncationMode: z.enum(['fail', 'truncate', 'artifact']).default('truncate'),
	})
	.strict();

export const ArtifactPolicySchema = z
	.object({
		maxArtifacts: z.number().int().nonnegative().max(20).default(0),
		maxBytesPerArtifact: z
			.number()
			.int()
			.positive()
			.max(ControllerExecutionOutputMaxBytes)
			.optional(),
		mode: z.enum(['none', 'controller_written', 'bounded_stream', 'vm_file_read']),
		noFollowRequired: z.boolean().default(true),
	})
	.strict();

export const CancellationPolicySchema = z
	.object({
		onCancel: z.enum(['abort_process', 'close_vm']),
		timeoutMs: z.number().int().positive().max(ControllerExecutionTimeoutMaxMs),
	})
	.strict();

export const ValidatedCliInvocationSchema = z
	.object({
		artifacts: ArtifactPolicySchema,
		argv: z.array(ControllerExecutionArgvTokenSchema).max(ControllerExecutionArgvMaxItems),
		cancellation: CancellationPolicySchema,
		cwd: CwdPolicySchema,
		egress: EgressPolicySchema,
		environment: EnvironmentPolicySchema,
		executablePath: z.string().startsWith('/'),
		fingerprint: ExecutionFingerprintSchema,
		output: OutputPolicySchema,
	})
	.strict();

export type ValidatedCliInvocation = z.infer<typeof ValidatedCliInvocationSchema>;
