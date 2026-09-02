import {
	oauthApplicationIdSchema,
	oauthPermissionChoiceSchema,
	oauthServiceIdSchema,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

export const oauthServiceChoiceModelSchema = z
	.object({
		allowedChoices: z.array(oauthPermissionChoiceSchema).min(1).readonly(),
		label: z.string().min(1).max(160),
		selectedChoice: oauthPermissionChoiceSchema,
		serviceId: oauthServiceIdSchema,
		suggestedChoice: oauthPermissionChoiceSchema.optional(),
	})
	.strict()
	.superRefine((service, context) => {
		if (service.allowedChoices.includes(service.selectedChoice)) return;
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: 'Selected OAuth permission is not an allowed choice.',
			path: ['selectedChoice'],
		});
	});

export const oauthApplicationChoiceModelSchema = z
	.object({
		applicationId: oauthApplicationIdSchema,
		description: z.string().min(1).max(500),
		label: z.string().min(1).max(160),
		services: z.array(oauthServiceChoiceModelSchema).min(1).readonly(),
	})
	.strict();
export type OAuthApplicationChoiceModel = z.infer<typeof oauthApplicationChoiceModelSchema>;

export const oauthApplicationProgressModelSchema = z
	.object({
		applicationId: oauthApplicationIdSchema,
		label: z.string().min(1).max(160),
		status: z.enum(['pending', 'authorizing', 'completed', 'failed']),
	})
	.strict();

export const oauthPermissionFieldErrorSchema = z
	.object({
		applicationId: oauthApplicationIdSchema,
		message: z.string().min(1).max(500),
		serviceId: oauthServiceIdSchema,
	})
	.strict();
export type OAuthPermissionFieldError = z.infer<typeof oauthPermissionFieldErrorSchema>;

export const oauthApprovalPageModelSchema = z.discriminatedUnion('kind', [
	z
		.object({
			accountProfileLabel: z.string().min(1).max(160),
			applications: z.array(oauthApplicationChoiceModelSchema).min(1).readonly(),
			errors: z.array(oauthPermissionFieldErrorSchema).readonly().optional(),
			kind: z.literal('permission-selection'),
		})
		.strict(),
	z
		.object({
			accountLabel: z.string().min(1).max(320),
			applicationLabel: z.string().min(1).max(160),
			grantedPermissionLabels: z.array(z.string().min(1).max(200)).readonly(),
			kind: z.literal('account-confirmation'),
		})
		.strict(),
	z
		.object({
			applications: z.array(oauthApplicationProgressModelSchema).min(1).readonly(),
			kind: z.literal('application-progress'),
		})
		.strict(),
	z
		.object({
			completed: z.array(z.string().min(1).max(160)).readonly(),
			kind: z.literal('partial-completion'),
			retryable: z.array(z.string().min(1).max(160)).readonly(),
		})
		.strict(),
	z
		.object({
			accountLabel: z.string().min(1).max(320),
			kind: z.literal('completed'),
		})
		.strict(),
	z
		.object({
			kind: z.enum(['expired', 'cancelled', 'failed']),
			message: z.string().min(1).max(500),
		})
		.strict(),
]);
export type OAuthApprovalPageModel = z.infer<typeof oauthApprovalPageModelSchema>;

export const oauthApprovalAssetManifestSchema = z
	.object({
		css: z.string().regex(/^oauth\.[a-f0-9]{16}\.css$/u),
		javascript: z.string().regex(/^oauth\.[a-f0-9]{16}\.js$/u),
	})
	.strict();
export type OAuthApprovalAssetManifest = z.infer<typeof oauthApprovalAssetManifestSchema>;
