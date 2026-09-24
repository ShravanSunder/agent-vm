import { oauthApplicationIdSchema, oauthServiceIdSchema } from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

const permissionGroupIdSchema = z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/u);
export const oauthPermissionGroupModelSchema = z
	.object({
		groupId: permissionGroupIdSchema,
		serviceId: oauthServiceIdSchema,
		effect: z.enum(['read', 'write']),
		label: z.string().min(1).max(160),
		warning: z.string().min(1).max(2000),
		offered: z.boolean(),
	})
	.strict();

export const oauthApplicationChoiceModelSchema = z
	.object({
		applicationId: oauthApplicationIdSchema,
		description: z.string().min(1).max(500),
		label: z.string().min(1).max(160),
		groups: z.array(oauthPermissionGroupModelSchema).min(1).max(64).readonly(),
		recommendedGroupIds: z.array(permissionGroupIdSchema).max(64).readonly(),
		selectedGroupIds: z.array(permissionGroupIdSchema).max(64).readonly(),
		suggestedGroupIds: z.array(permissionGroupIdSchema).max(64).readonly().optional(),
		selectionMode: z.enum(['off', 'recommended', 'custom']).optional(),
	})
	.strict()
	.refine((application) => {
		const known = new Set(application.groups.map((group) => group.groupId));
		const offered = new Set(
			application.groups.filter((group) => group.offered).map((group) => group.groupId),
		);
		return (
			known.size === application.groups.length &&
			application.selectedGroupIds.every((id) => known.has(id)) &&
			application.recommendedGroupIds.every((id) => offered.has(id))
		);
	}, 'Permission groups must be known, unique and recommended within the current maximum.');
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
			agentId: z.string().min(1).max(128),
			ownerLabel: z.string().min(1).max(160),
			accountAlias: z.string().min(1).max(320).optional(),
			applications: z.array(oauthApplicationChoiceModelSchema).min(1).readonly(),
			errors: z.array(oauthPermissionFieldErrorSchema).readonly().optional(),
			kind: z.literal('permission-selection'),
		})
		.strict(),
	z
		.object({
			kind: z.literal('disconnect-confirmation'),
			agentId: z.string().min(1).max(128),
			accountAlias: z.string().min(1).max(320),
			applicationLabel: z.string().min(1).max(160),
		})
		.strict(),
	z
		.object({
			accountLabel: z.string().min(1).max(320),
			applicationLabel: z.string().min(1).max(160),
			previousPermissionLabels: z.array(z.string().min(1).max(200)).readonly().optional(),
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
			kind: z.enum(['expired', 'cancelled', 'failed', 'disconnected', 'pending']),
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
