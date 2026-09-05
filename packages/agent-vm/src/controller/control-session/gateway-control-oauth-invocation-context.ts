import { jsonObjectSchema } from '@agent-vm/config-contracts';
import {
	OAuthAuthorizationBeginArgumentsSchema,
	OAuthAuthorizationCancelArgumentsSchema,
	OAuthAuthorizationListArgumentsSchema,
	OAuthAuthorizationReauthorizeArgumentsSchema,
	OAuthAuthorizationRevokeArgumentsSchema,
	OAuthAuthorizationStatusArgumentsSchema,
} from '@agent-vm/controller-execution-contracts';
import type { GatewayControlToolPortalControllerExecutionPayload } from '@agent-vm/gateway-control-contracts';

type ConfiguredControllerExecutionPayload = Extract<
	GatewayControlToolPortalControllerExecutionPayload,
	{ readonly kind: 'configured_cli' }
>;

export interface RegisteredOAuthInvocationContext {
	readonly arguments: ReturnType<typeof jsonObjectSchema.parse>;
	readonly authority: ConfiguredControllerExecutionPayload['authority'];
	readonly invocation: ConfiguredControllerExecutionPayload['invocation'];
}

export function resolveRegisteredOAuthInvocationContext(
	payload: GatewayControlToolPortalControllerExecutionPayload,
): RegisteredOAuthInvocationContext | undefined {
	if (payload.kind !== 'registered_action') return undefined;
	const action = payload.action;
	switch (action.actionId) {
		case 'oauth_authorization.list':
			return {
				arguments: jsonObjectSchema.parse(OAuthAuthorizationListArgumentsSchema.parse({})),
				authority: action.authority,
				invocation: action.invocation,
			};
		case 'oauth_authorization.begin':
			return {
				arguments: jsonObjectSchema.parse(
					OAuthAuthorizationBeginArgumentsSchema.parse({
						accountProfileId: action.accountProfileId,
						...(action.suggestedSelections === undefined
							? {}
							: { suggestedSelections: action.suggestedSelections }),
					}),
				),
				authority: action.authority,
				invocation: action.invocation,
			};
		case 'oauth_authorization.status':
			return {
				arguments: jsonObjectSchema.parse(
					OAuthAuthorizationStatusArgumentsSchema.parse({
						transactionId: action.transactionId,
					}),
				),
				authority: action.authority,
				invocation: action.invocation,
			};
		case 'oauth_authorization.cancel':
			return {
				arguments: jsonObjectSchema.parse(
					OAuthAuthorizationCancelArgumentsSchema.parse({
						transactionId: action.transactionId,
					}),
				),
				authority: action.authority,
				invocation: action.invocation,
			};
		case 'oauth_authorization.reauthorize':
			return {
				arguments: jsonObjectSchema.parse(
					OAuthAuthorizationReauthorizeArgumentsSchema.parse({
						accountProfileId: action.accountProfileId,
						applicationId: action.applicationId,
						...(action.suggestedSelections === undefined
							? {}
							: { suggestedSelections: action.suggestedSelections }),
					}),
				),
				authority: action.authority,
				invocation: action.invocation,
			};
		case 'oauth_authorization.revoke':
			return {
				arguments: jsonObjectSchema.parse(
					OAuthAuthorizationRevokeArgumentsSchema.parse({
						accountProfileId: action.accountProfileId,
						applicationId: action.applicationId,
					}),
				),
				authority: action.authority,
				invocation: action.invocation,
			};
		case 'controller_host_probe':
		case 'workspace_git_push':
			return undefined;
	}
}
