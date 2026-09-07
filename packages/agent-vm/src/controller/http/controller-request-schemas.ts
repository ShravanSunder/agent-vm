import { isToolVmActiveUseId } from '@agent-vm/gateway-lifecycle';
import { z } from 'zod';

export const controllerToolVmSshFailureKindSchema = z.enum([
	'active-use-refreshable-failure',
	'ssh-command-failed',
	'ssh-command-timed-out',
	'ssh-probe-failed',
]);

export const controllerToolVmActiveUseOperationReportSchema = z.strictObject({
	observedAtMs: z.number().int().nonnegative(),
	phase: z.enum(['starting', 'probe-succeeded', 'running', 'completed', 'failed']),
	ssh: z
		.strictObject({
			failure: z
				.strictObject({
					kind: controllerToolVmSshFailureKindSchema,
					message: z.string().trim().min(1).max(500),
				})
				.optional(),
			probeSucceeded: z.boolean().optional(),
		})
		.optional(),
});

export const controllerStartActiveUseRequestSchema = z.strictObject({
	correlation: z
		.strictObject({
			messageId: z.string().min(1).optional(),
			requestId: z.string().min(1).optional(),
			runId: z.string().min(1).optional(),
			sessionKeyDigest: z.string().min(1).optional(),
			toolCallId: z.string().min(1).optional(),
			traceId: z.string().min(1).optional(),
		})
		.optional(),
	report: controllerToolVmActiveUseOperationReportSchema.optional(),
	useId: z.string().refine((value) => isToolVmActiveUseId(value), {
		message: 'useId must be a UUIDv7.',
	}),
});

export const controllerHeartbeatToolVmActiveUseRequestSchema = z.strictObject({
	report: controllerToolVmActiveUseOperationReportSchema.optional(),
});

export const controllerEndActiveUseRequestSchema = z.strictObject({
	outcome: z.enum(['abandoned', 'cancelled', 'completed', 'failed', 'timed-out']),
	report: controllerToolVmActiveUseOperationReportSchema.optional(),
});

export const controllerDestroyZoneRequestSchema = z.object({
	purge: z.boolean().optional(),
});

export const controllerEnableSshRequestSchema = z
	.object({
		adminToken: z.string().min(1).optional(),
	})
	.strict();

export const controllerExecuteCommandRequestSchema = z
	.object({
		adminToken: z.string().min(1).optional(),
		command: z.string().min(1),
	})
	.strict();

export const controllerRetireCredentialedRuntimeRequestSchema = z
	.object({
		adminToken: z.string().min(1).optional(),
		agentId: z.string().min(1),
		force: z.boolean(),
	})
	.strict();
