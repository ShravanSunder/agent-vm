import { googleCatalogFamilyIdSchema } from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import { loadJsonConfigFile } from './json-config-file.js';

export const googleOAuthApplicationIds = ['workspace-app', 'gmail-app', 'youtube-app'] as const;
export const googleOAuthApplicationIdSchema = z.enum(googleOAuthApplicationIds);
export type GoogleOAuthApplicationId = z.infer<typeof googleOAuthApplicationIdSchema>;

const namedIdSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-z0-9][a-z0-9._-]*$/u);
const groupIdSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-z][a-z0-9.-]*$/u);
const uniqueAgentIdsSchema = z
	.array(namedIdSchema)
	.min(1)
	.max(128)
	.readonly()
	.refine((ids) => new Set(ids).size === ids.length, 'Agent identifiers must be unique.');
const onePasswordOAuthSecretSchema = z
	.object({
		ref: z
			.string()
			.min(6)
			.max(4096)
			.regex(/^op:\/\//u),
		source: z.literal('1password'),
	})
	.strict();

function canonicalHttpsOriginSchema(
	label: string,
): z.ZodPipe<z.ZodString, z.ZodTransform<string, string>> {
	return z
		.string()
		.min(1)
		.max(2048)
		.refine((value) => {
			if (!/^https:\/\/[^/?#\\\s]+\/?$/iu.test(value)) return false;
			try {
				const url = new URL(value);
				return (
					url.protocol === 'https:' &&
					url.hostname.length > 0 &&
					url.username.length === 0 &&
					url.password.length === 0 &&
					url.port === '' &&
					url.pathname === '/' &&
					url.search.length === 0 &&
					url.hash.length === 0
				);
			} catch {
				return false;
			}
		}, `${label} must be a standard HTTPS origin without credentials, path, query, fragment, or nondefault port.`)
		.transform((value) => new URL(value).origin);
}

export const oauthBrowserPublicBaseUrlSchema = canonicalHttpsOriginSchema('OAuth publicBaseUrl');
export const cloudflareAccessIssuerSchema = canonicalHttpsOriginSchema('Cloudflare Access issuer');
export const cloudflareAccessBrowserIdentityConfigSchema = z
	.object({
		kind: z.literal('cloudflare-access'),
		issuer: cloudflareAccessIssuerSchema,
		audience: z.string().min(1).max(2048),
	})
	.strict();

export const googleOAuthApplicationConfigSchema = z
	.object({
		catalogFamilyId: googleCatalogFamilyIdSchema,
		clientCredentials: onePasswordOAuthSecretSchema,
		clientKind: z.literal('web'),
		description: z.string().min(1).max(500),
		label: z.string().min(1).max(160),
		projectId: namedIdSchema,
	})
	.strict();
export type GoogleOAuthApplicationConfig = z.infer<typeof googleOAuthApplicationConfigSchema>;

export const googleOAuthCeilingSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('catalog-preset'), presetId: namedIdSchema }).strict(),
	z
		.object({
			kind: z.literal('explicit'),
			groupIds: z
				.array(groupIdSchema)
				.max(128)
				.readonly()
				.refine(
					(groups) => new Set(groups).size === groups.length,
					'Ceiling groups must be unique.',
				),
		})
		.strict(),
]);
export const resolvedOAuthAgentConfigSchema = z
	.object({
		applications: z.partialRecord(
			googleOAuthApplicationIdSchema,
			z.object({ ceiling: googleOAuthCeilingSchema }).strict(),
		),
	})
	.strict();

export const oauthOwnerConfigSchema = z
	.object({
		label: z.string().min(1).max(160),
		subject: z.string().min(1).max(256),
		allowedAgentIds: uniqueAgentIdsSchema,
	})
	.strict();
export const oauthPolicyEditorConfigSchema = z
	.object({
		subject: z.string().min(1).max(256),
		editableAgentIds: uniqueAgentIdsSchema,
	})
	.strict();

export const oauthConfigSchema = z
	.object({
		browser: z
			.object({
				identity: cloudflareAccessBrowserIdentityConfigSchema,
				listener: z
					.object({
						kind: z.literal('loopback_http'),
						port: z.number().int().min(1).max(65_535),
					})
					.strict(),
				publicBaseUrl: oauthBrowserPublicBaseUrlSchema,
			})
			.strict(),
		owners: z
			.record(namedIdSchema, oauthOwnerConfigSchema)
			.refine(
				(owners) => Object.keys(owners).length > 0,
				'At least one account owner must be admitted.',
			),
		policyEditors: z.record(namedIdSchema, oauthPolicyEditorConfigSchema),
		providers: z
			.object({
				google: z
					.object({
						applications: z
							.object({
								'gmail-app': googleOAuthApplicationConfigSchema,
								'workspace-app': googleOAuthApplicationConfigSchema,
								'youtube-app': googleOAuthApplicationConfigSchema,
							})
							.strict(),
						catalogVersion: z.string().min(1).max(256),
						gogBuildIdentity: z
							.object({
								version: z.string().min(1).max(64),
								commit: z.string().regex(/^[a-f0-9]{40}$/u),
							})
							.strict(),
						kind: z.literal('google'),
						projects: z.record(
							namedIdSchema,
							z.object({ publishingStatus: z.enum(['testing', 'production']) }).strict(),
						),
					})
					.strict(),
			})
			.strict(),
		schemaVersion: z.literal(3),
		storage: z.object({ keyEncryptionKey: onePasswordOAuthSecretSchema }).strict(),
		zoneId: namedIdSchema,
	})
	.strict()
	.superRefine((config, context) => {
		const clientReferences = new Set<string>();
		const families = new Set<string>();
		for (const applicationId of googleOAuthApplicationIds) {
			const application = config.providers.google.applications[applicationId];
			if (clientReferences.has(application.clientCredentials.ref)) {
				context.addIssue({
					code: 'custom',
					message: 'Google applications must use distinct client credential references.',
					path: ['providers', 'google', 'applications', applicationId, 'clientCredentials'],
				});
			}
			clientReferences.add(application.clientCredentials.ref);
			if (families.has(application.catalogFamilyId)) {
				context.addIssue({
					code: 'custom',
					message: 'Each Google catalog family must have exactly one application binding.',
					path: ['providers', 'google', 'applications', applicationId, 'catalogFamilyId'],
				});
			}
			families.add(application.catalogFamilyId);
			if (config.providers.google.projects[application.projectId] === undefined) {
				context.addIssue({
					code: 'custom',
					message: 'Google application references an unregistered project.',
					path: ['providers', 'google', 'applications', applicationId, 'projectId'],
				});
			}
		}
		const ownerIdentities = new Set<string>();
		for (const [ownerId, owner] of Object.entries(config.owners)) {
			if (ownerIdentities.has(owner.subject))
				context.addIssue({
					code: 'custom',
					message: 'Browser owner subjects must be unique.',
					path: ['owners', ownerId, 'subject'],
				});
			ownerIdentities.add(owner.subject);
		}
		const editorIdentities = new Set<string>();
		for (const [editorId, editor] of Object.entries(config.policyEditors)) {
			if (editorIdentities.has(editor.subject))
				context.addIssue({
					code: 'custom',
					message: 'Browser editor subjects must be unique.',
					path: ['policyEditors', editorId, 'subject'],
				});
			editorIdentities.add(editor.subject);
		}
	});
export type OAuthConfig = z.infer<typeof oauthConfigSchema>;

export const resolvedOAuthConfigSchema = oauthConfigSchema
	.extend({
		agents: z.record(namedIdSchema, resolvedOAuthAgentConfigSchema),
	})
	.strict()
	.superRefine((config, context) => {
		for (const [ownerId, owner] of Object.entries(config.owners)) {
			for (const agentId of owner.allowedAgentIds) {
				if (config.agents[agentId] === undefined)
					context.addIssue({
						code: 'custom',
						message: 'Owner admission references an unconfigured agent.',
						path: ['owners', ownerId, 'allowedAgentIds'],
					});
			}
		}
		for (const [editorId, editor] of Object.entries(config.policyEditors)) {
			for (const agentId of editor.editableAgentIds) {
				if (config.agents[agentId] === undefined)
					context.addIssue({
						code: 'custom',
						message: 'Editor admission references an unconfigured agent.',
						path: ['policyEditors', editorId, 'editableAgentIds'],
					});
			}
		}
	});
export type ResolvedOAuthConfig = z.infer<typeof resolvedOAuthConfigSchema>;

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
