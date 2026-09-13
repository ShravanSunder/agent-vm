export {
	oauthAuthorizationBeginRequestSchema,
	oauthAuthorizationCancelRequestSchema,
	oauthAuthorizationListRequestSchema,
	oauthAuthorizationReauthorizeRequestSchema,
	oauthAuthorizationDisconnectRequestSchema,
	oauthAuthorizationStatusRequestSchema,
	oauthAuthorizationActionIdSchema as OAuthAuthorizationControllerActionIdSchema,
	oauthAuthorizationActionRequestSchema as OAuthAuthorizationControllerActionRequestSchema,
	oauthAuthorizationActionResultSchema as OAuthAuthorizationControllerActionResultSchema,
	type OAuthAuthorizationActionId as OAuthAuthorizationControllerActionId,
	type OAuthAuthorizationActionRequest as OAuthAuthorizationControllerActionRequest,
	type OAuthAuthorizationActionResult as OAuthAuthorizationControllerActionResult,
} from '@agent-vm/oauth-broker-contracts';

import {
	oauthAuthorizationBeginRequestSchema,
	oauthAuthorizationCancelRequestSchema,
	oauthAuthorizationListRequestSchema,
	oauthAuthorizationReauthorizeRequestSchema,
	oauthAuthorizationDisconnectRequestSchema,
	oauthAuthorizationStatusRequestSchema,
} from '@agent-vm/oauth-broker-contracts';

export const OAuthAuthorizationListArgumentsSchema = oauthAuthorizationListRequestSchema.omit({
	actionId: true,
});
export const OAuthAuthorizationBeginArgumentsSchema = oauthAuthorizationBeginRequestSchema.omit({
	actionId: true,
});
export const OAuthAuthorizationStatusArgumentsSchema = oauthAuthorizationStatusRequestSchema.omit({
	actionId: true,
});
export const OAuthAuthorizationCancelArgumentsSchema = oauthAuthorizationCancelRequestSchema.omit({
	actionId: true,
});
export const OAuthAuthorizationReauthorizeArgumentsSchema =
	oauthAuthorizationReauthorizeRequestSchema.omit({ actionId: true });
export const OAuthAuthorizationDisconnectArgumentsSchema =
	oauthAuthorizationDisconnectRequestSchema.omit({
		actionId: true,
	});
