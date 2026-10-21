import { accessProfileProjection, revisionRef } from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import { mcpConfigSchema } from '#node-host/host-configuration/models/mcp-config';
import { NodeHostBearerCredentialSetSchema } from '#node-host/mcp-proxy-server/models/bearer-credentials';
export const nodeHostConfigSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		authority: z.string().min(1).max(256),
		revision: revisionRef,
		workspaceLayer: z.literal('not-configured'),
		storeDirectory: z.string().min(1),
		auth: NodeHostBearerCredentialSetSchema,
		profiles: z.record(
			z.string().min(1),
			z.strictObject({ profile: accessProfileProjection, revision: revisionRef }),
		),
		mcp: mcpConfigSchema,
		listener: z.discriminatedUnion('kind', [
			z.strictObject({
				kind: z.literal('http'),
				hostname: z.enum(['127.0.0.1', '::1', 'localhost']).default('127.0.0.1'),
				port: z.number().int().min(0).max(65535),
				routePath: z.string().regex(/^\/(?!\/)[^?#]+$/u),
				allowedHosts: z.array(z.string().min(1)).min(1),
				allowedOrigins: z.array(z.url()),
			}),
			z.strictObject({ kind: z.literal('stdio'), agentId: z.string().min(1) }),
		]),
		exposure: z.enum(['catalog', 'compact']),
	})
	.superRefine((config, context) => {
		const namespaces = new Set<string>();
		for (const provider of Object.values(config.mcp.providers)) {
			if (namespaces.has(provider.namespace))
				context.addIssue({
					code: 'custom',
					message: 'Provider namespaces must be unique.',
					path: ['mcp', 'providers'],
				});
			namespaces.add(provider.namespace);
		}
		for (const [profileId, entry] of Object.entries(config.profiles)) {
			if (entry.profile.profileId !== profileId)
				context.addIssue({
					code: 'custom',
					message: 'Profile identity must match its configured key.',
					path: ['profiles', profileId],
				});
			for (const [namespace, policy] of Object.entries(entry.profile.namespaces)) {
				if (!namespaces.has(namespace) || policy.backendKind !== 'mcp_provider')
					context.addIssue({
						code: 'custom',
						message: 'Unsupported or missing provider binding.',
						path: ['profiles', profileId, 'profile', 'namespaces', namespace],
					});
			}
		}
		for (const credential of config.auth.credentials) {
			if (config.profiles[credential.principal.toolPortalProfileId] === undefined)
				context.addIssue({
					code: 'custom',
					message: 'Every credential requires an explicit complete profile assignment.',
					path: ['auth', 'credentials'],
				});
		}
		const listener = config.listener;
		if (
			listener.kind === 'stdio' &&
			!config.auth.credentials.some(
				(credential) => credential.principal.agentId === listener.agentId,
			)
		)
			context.addIssue({
				code: 'custom',
				message: 'Stdio requires one configured host-bound agent.',
				path: ['listener', 'agentId'],
			});
	});

export type NodeHostConfig = z.infer<typeof nodeHostConfigSchema>;
