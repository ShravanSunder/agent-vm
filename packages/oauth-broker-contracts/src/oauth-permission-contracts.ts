import { z } from 'zod';

import { oauthApplicationIdSchema, oauthServiceIdSchema } from './oauth-identifiers.js';

export const oauthPermissionChoiceSchema = z.enum(['none', 'read', 'write']);
export type OAuthPermissionChoice = z.infer<typeof oauthPermissionChoiceSchema>;

export const oauthMinimumPermissionSchema = z.enum(['read', 'write']);
export type OAuthMinimumPermission = z.infer<typeof oauthMinimumPermissionSchema>;

export const oauthPermissionSelectionsSchema = z
	.record(oauthApplicationIdSchema, z.record(oauthServiceIdSchema, oauthPermissionChoiceSchema))
	.readonly();
export type OAuthPermissionSelections = z.infer<typeof oauthPermissionSelectionsSchema>;
