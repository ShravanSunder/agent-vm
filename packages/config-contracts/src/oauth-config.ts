import path from 'node:path';

import {
	oauthAccountProfileIdSchema,
	oauthPermissionChoiceSchema,
	oauthProviderIdSchema,
	oauthScopeSchema,
	oauthServiceIdSchema,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import { loadJsonConfigFile } from './json-config-file.js';

export const googleOAuthApplicationIds = ['workspace-app', 'gmail-app', 'youtube-app'] as const;

export const googleOAuthApplicationIdSchema = z.enum(googleOAuthApplicationIds);
export type GoogleOAuthApplicationId = z.infer<typeof googleOAuthApplicationIdSchema>;

const googleOAuthProviderIdSchema = oauthProviderIdSchema.refine(
	(providerId) => providerId === 'google',
	{ message: 'The initial OAuth provider must be Google.' },
);

const controllerOwnedAbsolutePathSchema = z
	.string()
	.min(1)
	.max(4_096)
	.refine((value) => path.isAbsolute(value) && !value.includes('\0'), {
		message: 'OAuth controller paths must be absolute and contain no NUL bytes.',
	});

const onePasswordOAuthSecretSchema = z
	.object({
		ref: z.string().regex(/^op:\/\//u, '1Password refs must start with op://'),
		source: z.literal('1password'),
	})
	.strict();

export const oauthBrowserPublicBaseUrlSchema = z.url().refine((value) => {
	const url = new URL(value);
	return (
		url.protocol === 'https:' &&
		url.hostname === 'auth.claw.askluna.xyz' &&
		url.username.length === 0 &&
		url.password.length === 0 &&
		url.port === '18900' &&
		url.pathname === '/' &&
		url.search.length === 0 &&
		url.hash.length === 0
	);
}, 'OAuth publicBaseUrl must be the auth.claw.askluna.xyz HTTPS origin on port 18900 without credentials, path, query, or fragment.');

export const oauthPermissionScopeMappingSchema = z
	.object({
		label: z.string().min(1).max(160),
		read: z.array(oauthScopeSchema).min(1).readonly(),
		write: z.array(oauthScopeSchema).min(1).readonly().optional(),
	})
	.strict()
	.superRefine((mapping, context) => {
		for (const [fieldName, scopes] of [
			['read', mapping.read],
			['write', mapping.write ?? []],
		] as const) {
			if (new Set(scopes).size === scopes.length) continue;
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `OAuth ${fieldName} scopes must be unique.`,
				path: [fieldName],
			});
		}
	});

export const googleOAuthApplicationConfigSchema = z
	.object({
		clientCredentials: onePasswordOAuthSecretSchema,
		clientKind: z.literal('web'),
		description: z.string().min(1).max(500),
		label: z.string().min(1).max(160),
		services: z
			.record(oauthServiceIdSchema, oauthPermissionScopeMappingSchema)
			.refine((services) => Object.keys(services).length > 0, {
				message: 'Google OAuth applications must configure at least one service.',
			}),
	})
	.strict();
export type GoogleOAuthApplicationConfig = z.infer<typeof googleOAuthApplicationConfigSchema>;

const googleOAuthApplicationsSchema = z
	.object({
		'gmail-app': googleOAuthApplicationConfigSchema,
		'workspace-app': googleOAuthApplicationConfigSchema,
		'youtube-app': googleOAuthApplicationConfigSchema,
	})
	.strict();

function isSafeTailnetLoginCharacter(character: string): boolean {
	const codePoint = character.codePointAt(0);
	return (
		codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f && !/^\s$/u.test(character)
	);
}

export const oauthAccountProfileApplicationMaximumSchema = z
	.object({
		maximumPermissions: z.record(
			oauthServiceIdSchema,
			oauthPermissionChoiceSchema.exclude(['none']),
		),
	})
	.strict()
	.refine((application) => Object.keys(application.maximumPermissions).length > 0, {
		message: 'OAuth account-profile applications must configure at least one service maximum.',
	});

export const oauthAccountProfileConfigSchema = z
	.object({
		applications: z
			.partialRecord(googleOAuthApplicationIdSchema, oauthAccountProfileApplicationMaximumSchema)
			.refine((applications) => Object.keys(applications).length > 0, {
				message: 'OAuth account profiles must configure at least one application.',
			}),
		authorizedTailnetLogins: z
			.array(
				z
					.string()
					.min(1)
					.max(320)
					.refine((login) => Array.from(login).every(isSafeTailnetLoginCharacter), {
						message: 'Authorized tailnet logins must not contain whitespace or control bytes.',
					}),
			)
			.min(1)
			.refine((logins) => new Set(logins).size === logins.length, {
				message: 'Authorized tailnet logins must be unique.',
			}),
		provider: googleOAuthProviderIdSchema,
	})
	.strict();

export const oauthAgentConfigSchema = z
	.object({
		accountProfiles: z
			.record(oauthAccountProfileIdSchema, oauthAccountProfileConfigSchema)
			.refine((profiles) => Object.keys(profiles).length > 0, {
				message: 'OAuth agents must configure at least one account profile.',
			}),
	})
	.strict();

export const oauthConfigSchema = z
	.object({
		agents: z
			.record(z.string().min(1).max(128), oauthAgentConfigSchema)
			.refine((agents) => Object.keys(agents).length > 0, {
				message: 'oauth.config.jsonc must configure at least one agent.',
			}),
		browser: z
			.object({
				listener: z
					.object({
						certificatePath: controllerOwnedAbsolutePathSchema,
						kind: z.literal('tailscale_https'),
						port: z.literal(18_900),
						privateKeyPath: controllerOwnedAbsolutePathSchema,
					})
					.strict(),
				publicBaseUrl: oauthBrowserPublicBaseUrlSchema,
			})
			.strict(),
		providers: z
			.object({
				google: z
					.object({
						applications: googleOAuthApplicationsSchema,
						kind: z.literal('google'),
					})
					.strict(),
			})
			.strict(),
		schemaVersion: z.literal(1),
		storage: z
			.object({
				keyEncryptionKey: onePasswordOAuthSecretSchema,
			})
			.strict(),
	})
	.strict()
	.superRefine((config, context) => {
		const applications = config.providers.google.applications;
		const clientReferenceOwners = new Map<string, GoogleOAuthApplicationId>();
		for (const applicationId of googleOAuthApplicationIds) {
			const reference = applications[applicationId].clientCredentials.ref;
			const existingOwner = clientReferenceOwners.get(reference);
			if (existingOwner === undefined) {
				clientReferenceOwners.set(reference, applicationId);
				continue;
			}
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Google OAuth applications "${existingOwner}" and "${applicationId}" must use distinct client credential references.`,
				path: ['providers', 'google', 'applications', applicationId, 'clientCredentials', 'ref'],
			});
		}
		for (const [agentId, agent] of Object.entries(config.agents)) {
			for (const [accountProfileId, accountProfile] of Object.entries(agent.accountProfiles)) {
				for (const applicationId of googleOAuthApplicationIds) {
					const maximum = accountProfile.applications[applicationId];
					if (maximum === undefined) continue;
					const application = applications[applicationId];
					for (const [serviceId, permission] of Object.entries(maximum.maximumPermissions)) {
						const parsedServiceId = oauthServiceIdSchema.parse(serviceId);
						const service = application.services[parsedServiceId];
						const issuePath = [
							'agents',
							agentId,
							'accountProfiles',
							accountProfileId,
							'applications',
							applicationId,
							'maximumPermissions',
							serviceId,
						];
						if (service === undefined) {
							context.addIssue({
								code: z.ZodIssueCode.custom,
								message: `OAuth account profile references unknown service "${serviceId}" in application "${applicationId}".`,
								path: issuePath,
							});
							continue;
						}
						if (permission === 'write' && service.write === undefined) {
							context.addIssue({
								code: z.ZodIssueCode.custom,
								message: `OAuth service "${serviceId}" does not configure write scopes.`,
								path: issuePath,
							});
						}
					}
				}
			}
		}
	});

export type OAuthConfig = z.infer<typeof oauthConfigSchema>;

export function googleOAuthCallbackUrl(config: OAuthConfig): string {
	return new URL('/oauth/google/callback', config.browser.publicBaseUrl).toString();
}

export async function loadOAuthConfig(configPath: string): Promise<OAuthConfig> {
	return oauthConfigSchema.parse(await loadJsonConfigFile(configPath));
}

export function requireGoogleOAuthApplication(
	config: OAuthConfig,
	applicationId: GoogleOAuthApplicationId,
): GoogleOAuthApplicationConfig {
	return config.providers.google.applications[applicationId];
}
