import { CapabilityReferenceSchema } from '@agent-vm/agent-portal-sdk';
import {
	ArtifactPolicySchema,
	CancellationPolicySchema,
	CwdPolicySchema,
	EgressPolicySchema,
	EnvironmentPolicySchema,
	OutputPolicySchema,
} from '@agent-vm/controller-execution-contracts';
import { z } from 'zod';

export const CliArgvTokenSchema = z.string().min(1);

export const CliFlagRuleSchema = z
	.object({
		allowedValues: z.array(z.string()).optional(),
		flag: CliArgvTokenSchema,
		value: z.enum(['none', 'string', 'number', 'enum', 'path', 'host']).default('none'),
	})
	.strict()
	.superRefine((rule, context) => {
		if (rule.value === 'enum' && (rule.allowedValues ?? []).length === 0) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Enum CLI flags must define allowedValues.',
				path: ['allowedValues'],
			});
		}
	});

export type CliFlagRule = z.infer<typeof CliFlagRuleSchema>;

export const CliAllowanceSchema = z
	.object({
		allowedFlags: z.array(CliFlagRuleSchema).default([]),
		allowedSubcommands: z.array(z.array(CliArgvTokenSchema).min(1)).min(1),
		approval: z.enum(['required', 'conditional']),
		artifacts: ArtifactPolicySchema,
		capability: CapabilityReferenceSchema,
		cancellation: CancellationPolicySchema,
		credentialProfileId: z.string().min(1),
		custodyMode: z.enum(['ephemeral_material', 'controller_durable_state']),
		cwd: CwdPolicySchema,
		deniedFlags: z.array(CliArgvTokenSchema),
		deniedPatterns: z.array(z.string()),
		egress: EgressPolicySchema,
		environment: EnvironmentPolicySchema,
		executablePath: z.string().startsWith('/'),
		inputSchemaId: z.string().min(1),
		output: OutputPolicySchema,
		safeHelp: z.string().max(4_000),
	})
	.strict();

export type CliAllowance = z.infer<typeof CliAllowanceSchema>;

export const CliAllowanceInputSchema = z
	.object({
		argv: z.array(CliArgvTokenSchema).max(100),
		reason: z.string().min(1),
	})
	.strict();

export type CliAllowanceInput = z.infer<typeof CliAllowanceInputSchema>;
