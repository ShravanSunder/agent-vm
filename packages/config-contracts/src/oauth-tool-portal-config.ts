import path from 'node:path';

import { z } from 'zod';

import { type ConfiguredCliInvocationMatcher } from './controller-configured-cli.js';
import { googleOAuthApplicationIdSchema, oauthConfigSchema } from './oauth-config.js';
import {
	toolPortalConfigSchema,
	toolPortalNamespaceAllowsOperation,
} from './tool-portal-config.js';

function pathIdentity(pathTokens: readonly string[]): string {
	return JSON.stringify(pathTokens);
}

function matcherClassifiesExactPath(
	matcher: ConfiguredCliInvocationMatcher,
	commandPath: readonly string[],
): boolean {
	return matcher.flags.length === 0 && pathIdentity(matcher.path) === pathIdentity(commandPath);
}

function permissionSatisfies(
	maximumPermission: 'read' | 'write' | undefined,
	minimumPermission: 'read' | 'write',
): boolean {
	return (
		maximumPermission === 'write' || (maximumPermission === 'read' && minimumPermission === 'read')
	);
}

function selectorIncludesTool(
	selector: { readonly allow: '*' | readonly string[]; readonly deny: readonly string[] },
	toolName: string,
): boolean {
	return (
		!selector.deny.includes(toolName) &&
		(selector.allow === '*' || selector.allow.includes(toolName))
	);
}

const oauthAuthorizationToolNames = [
	'begin',
	'cancel',
	'list',
	'reauthorize',
	'revoke',
	'status',
] as const;

export const oauthToolPortalConfigPairSchema = z
	.object({
		oauthConfig: oauthConfigSchema,
		toolPortalConfig: toolPortalConfigSchema,
	})
	.strict()
	.superRefine(({ oauthConfig, toolPortalConfig }, context) => {
		if (toolPortalConfig.mode !== 'managed') {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'OAuth configuration requires Managed Tool Portal mode.',
				path: ['toolPortalConfig', 'mode'],
			});
			return;
		}

		for (const oauthAgentId of Object.keys(oauthConfig.agents)) {
			if (toolPortalConfig.agents[oauthAgentId] !== undefined) continue;
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `OAuth agent "${oauthAgentId}" is not configured in Tool Portal.`,
				path: ['oauthConfig', 'agents', oauthAgentId],
			});
		}

		for (const [agentId, toolPortalAgent] of Object.entries(toolPortalConfig.agents)) {
			const profile = toolPortalConfig.profiles[toolPortalAgent.profile];
			if (profile === undefined) continue;
			if (oauthConfig.agents[agentId] !== undefined) {
				const authorizationNamespace = profile.namespaces.oauth_authorization;
				for (const toolName of oauthAuthorizationToolNames) {
					const operation =
						authorizationNamespace?.backend.kind === 'controller_execution'
							? authorizationNamespace.backend.operations[toolName]
							: undefined;
					if (
						operation?.kind !== 'registered_action' ||
						!selectorIncludesTool(
							authorizationNamespace?.tools ?? { allow: [], deny: [] },
							toolName,
						)
					) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `OAuth agent "${agentId}" must expose oauth_authorization.${toolName} as a registered controller action.`,
							path: [
								'toolPortalConfig',
								'profiles',
								toolPortalAgent.profile,
								'namespaces',
								'oauth_authorization',
							],
						});
						continue;
					}
					if (authorizationNamespace === undefined) continue;
					const requiresApproval = selectorIncludesTool(
						authorizationNamespace.calls.requiresApproval,
						toolName,
					);
					const withoutApproval = selectorIncludesTool(
						authorizationNamespace.calls.withoutApproval,
						toolName,
					);
					if (
						toolName === 'reauthorize' || toolName === 'revoke'
							? !requiresApproval || withoutApproval
							: requiresApproval === withoutApproval
					) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message:
								toolName === 'reauthorize' || toolName === 'revoke'
									? `oauth_authorization.${toolName} must require Tool Portal approval.`
									: `oauth_authorization.${toolName} must have exactly one call disposition.`,
							path: [
								'toolPortalConfig',
								'profiles',
								toolPortalAgent.profile,
								'namespaces',
								'oauth_authorization',
								'calls',
							],
						});
					}
				}
			}
			for (const [namespaceId, namespacePolicy] of Object.entries(profile.namespaces)) {
				if (namespacePolicy.backend.kind !== 'controller_execution') continue;
				for (const [operationName, operation] of Object.entries(
					namespacePolicy.backend.operations,
				)) {
					if (!toolPortalNamespaceAllowsOperation(namespacePolicy, operationName)) continue;
					if (
						operation.kind !== 'configured_cli' ||
						operation.authorization?.kind !== 'oauth_account_profile'
					) {
						continue;
					}
					const operationPath = [
						'toolPortalConfig',
						'profiles',
						toolPortalAgent.profile,
						'namespaces',
						namespaceId,
						'backend',
						'operations',
						operationName,
					];
					if (path.basename(operation.executablePath) !== 'gog') {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: 'OAuth account-profile authorization is supported only for Gog.',
							path: [...operationPath, 'executablePath'],
						});
					}
					const oauthAgent = oauthConfig.agents[agentId];
					if (oauthAgent === undefined) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Tool Portal agent "${agentId}" can reach OAuth operation "${operationName}" but has no OAuth account profiles.`,
							path: ['oauthConfig', 'agents', agentId],
						});
						continue;
					}

					for (const [ruleIndex, rule] of operation.authorization.rules.entries()) {
						if (rule.requirement.kind === 'no_oauth') continue;
						const requirement = rule.requirement;
						const rulePath = [...operationPath, 'authorization', 'rules', ruleIndex, 'requirement'];
						const parsedApplicationId = googleOAuthApplicationIdSchema.safeParse(
							requirement.applicationId,
						);
						if (!parsedApplicationId.success) {
							context.addIssue({
								code: z.ZodIssueCode.custom,
								message: `OAuth rule references unknown application "${requirement.applicationId}".`,
								path: [...rulePath, 'applicationId'],
							});
							continue;
						}
						const application = oauthConfig.providers.google.applications[parsedApplicationId.data];
						const service = application.services[requirement.serviceId];
						if (service === undefined) {
							context.addIssue({
								code: z.ZodIssueCode.custom,
								message: `OAuth rule references unknown service "${requirement.serviceId}".`,
								path: [...rulePath, 'serviceId'],
							});
							continue;
						}
						const hasEligibleAccountProfile = Object.values(oauthAgent.accountProfiles).some(
							(accountProfile) =>
								permissionSatisfies(
									accountProfile.applications[parsedApplicationId.data]?.maximumPermissions[
										requirement.serviceId
									],
									requirement.minimumPermission,
								),
						);
						if (!hasEligibleAccountProfile) {
							context.addIssue({
								code: z.ZodIssueCode.custom,
								message: `OAuth agent "${agentId}" has no account profile satisfying ${requirement.applicationId}/${requirement.serviceId}/${requirement.minimumPermission}.`,
								path: ['oauthConfig', 'agents', agentId, 'accountProfiles'],
							});
						}
						if (
							requirement.minimumPermission === 'write' &&
							!operation.calls.requiresApproval.some((matcher) =>
								matcherClassifiesExactPath(matcher, rule.match.path),
							)
						) {
							context.addIssue({
								code: z.ZodIssueCode.custom,
								message: 'Every OAuth write command must require Tool Portal approval.',
								path: [...operationPath, 'calls', 'requiresApproval'],
							});
						}
					}
				}
			}
		}
	});

export type OAuthToolPortalConfigPair = z.infer<typeof oauthToolPortalConfigPairSchema>;

export function validateOAuthToolPortalConfigPair(props: OAuthToolPortalConfigPair): void {
	oauthToolPortalConfigPairSchema.parse(props);
}
