import { z } from 'zod';

import { oauthApplicationIdSchema } from './oauth-identifiers.js';

export const oauthPermissionChoiceSchema = z.enum(['none', 'read', 'write']);
export type OAuthPermissionChoice = z.infer<typeof oauthPermissionChoiceSchema>;

export const oauthMinimumPermissionSchema = z.enum(['read', 'write']);
export type OAuthMinimumPermission = z.infer<typeof oauthMinimumPermissionSchema>;

export const oauthPermissionSelectionsSchema = z
	.record(
		oauthApplicationIdSchema,
		z
			.array(
				z
					.string()
					.min(1)
					.max(128)
					.regex(/^[a-z][a-z0-9.-]*$/u),
			)
			.max(64)
			.readonly()
			.refine(
				(groups) => new Set(groups).size === groups.length,
				'Google permission selections must be unique.',
			),
	)
	.readonly();
export type OAuthPermissionSelections = z.infer<typeof oauthPermissionSelectionsSchema>;
