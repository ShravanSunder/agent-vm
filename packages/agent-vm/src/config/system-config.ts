import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

const gatewayTypeValues = ['openclaw', 'worker'] as const;

const secretInjectionSchema = z.enum(['env', 'http-mediation']);

const onePasswordSecretSchema = z.object({
	source: z.literal('1password'),
	ref: z.string().min(1),
	injection: secretInjectionSchema.default('http-mediation'),
	hosts: z.array(z.string().min(1)).optional(),
});

const environmentSecretSchema = z.object({
	source: z.literal('environment'),
	envVar: z.string().min(1),
	injection: secretInjectionSchema.default('http-mediation'),
	hosts: z.array(z.string().min(1)).optional(),
});

const secretReferenceSchema = z
	.discriminatedUnion('source', [onePasswordSecretSchema, environmentSecretSchema])
	.superRefine((secret, context) => {
		if (secret.injection === 'http-mediation' && (!secret.hosts || secret.hosts.length === 0)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Injection 'http-mediation' requires at least one host.",
				path: ['hosts'],
			});
		}
	});

const tokenSourceSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('op-cli'),
		ref: z.string().min(1),
	}),
	z.object({
		type: z.literal('env'),
		envVar: z.string().min(1).optional(),
	}),
	z.object({
		type: z.literal('keychain'),
		service: z.string().min(1),
		account: z.string().min(1),
	}),
]);

const authProfilesSecretSchema = z.discriminatedUnion('source', [
	z.object({
		source: z.literal('1password'),
		ref: z.string().min(1),
	}),
	z.object({
		source: z.literal('environment'),
		envVar: z.string().min(1),
	}),
]);

const hostSecretReferenceSchema = z.discriminatedUnion('source', [
	z.object({
		source: z.literal('1password'),
		ref: z.string().min(1),
	}),
	z.object({
		source: z.literal('environment'),
		envVar: z.string().min(1),
	}),
]);

const zoneGatewaySchema = z.object({
	type: z.enum(gatewayTypeValues).default('openclaw'),
	memory: z.string().min(1),
	cpus: z.number().int().positive(),
	port: z.number().int().positive(),
	gatewayConfig: z.string().min(1),
	stateDir: z.string().min(1),
	workspaceDir: z.string().min(1),
	authProfilesRef: authProfilesSecretSchema.optional(),
});

const toolProfileSchema = z.object({
	memory: z.string().min(1),
	cpus: z.number().int().positive(),
	workspaceRoot: z.string().min(1),
});

const imageConfigSchema = z.object({
	buildConfig: z.string().min(1),
	dockerfile: z.string().min(1).optional(),
});

const systemConfigSchema = z
	.object({
		host: z.object({
			controllerPort: z.number().int().positive(),
			projectNamespace: z
				.string()
				.min(1)
				.regex(
					/^[a-z0-9][a-z0-9-]*$/u,
					'projectNamespace must use lowercase letters, numbers, and hyphens only',
				),
			secretsProvider: z
				.object({
					type: z.literal('1password'),
					tokenSource: tokenSourceSchema,
				})
				.optional(),
			githubToken: hostSecretReferenceSchema.optional(),
		}),
		cacheDir: z.string().min(1).default('./cache'),
		images: z.object({
			gateway: imageConfigSchema,
			tool: imageConfigSchema,
		}),
		zones: z
			.array(
				z.object({
					id: z.string().min(1),
					gateway: zoneGatewaySchema,
					secrets: z.record(z.string(), secretReferenceSchema),
					allowedHosts: z.array(z.string().min(1)).min(1),
					websocketBypass: z.array(z.string().min(1)).default([]),
					toolProfile: z.string().min(1),
				}),
			)
			.min(1, 'system config must define at least one zone'),
		toolProfiles: z.record(z.string(), toolProfileSchema),
		tcpPool: z.object({
			basePort: z.number().int().positive(),
			size: z.number().int().positive(),
		}),
	})
	.superRefine((config, context) => {
		const hasOnePasswordSecrets = config.zones.some(
			(zone) =>
				Object.values(zone.secrets).some((secret) => secret.source === '1password') ||
				zone.gateway.authProfilesRef?.source === '1password',
		);
		const hasOnePasswordGithubToken = config.host.githubToken?.source === '1password';
		if ((hasOnePasswordSecrets || hasOnePasswordGithubToken) && !config.host.secretsProvider) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"host.secretsProvider is required when any zone secret or host credential uses source '1password'.",
				path: ['host', 'secretsProvider'],
			});
		}

		for (const [zoneIndex, zone] of config.zones.entries()) {
			if (config.toolProfiles[zone.toolProfile]) {
				continue;
			}
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Zone '${zone.id}' references unknown toolProfile '${zone.toolProfile}'.`,
				path: ['zones', zoneIndex, 'toolProfile'],
			});
		}
	});

export type SystemConfig = z.infer<typeof systemConfigSchema>;

/**
 * Resolve all relative paths in a system config relative to the config file's directory.
 * This ensures paths like "./state/shravan" work regardless of the process CWD.
 */
function resolveRelativePaths(config: SystemConfig, configDir: string): SystemConfig {
	const resolvePath = (relativePath: string): string =>
		path.isAbsolute(relativePath) ? relativePath : path.resolve(configDir, relativePath);

	return {
		...config,
		cacheDir: resolvePath(config.cacheDir),
		images: {
			gateway: {
				...config.images.gateway,
				buildConfig: resolvePath(config.images.gateway.buildConfig),
				...(config.images.gateway.dockerfile
					? { dockerfile: resolvePath(config.images.gateway.dockerfile) }
					: {}),
			},
			tool: {
				...config.images.tool,
				buildConfig: resolvePath(config.images.tool.buildConfig),
				...(config.images.tool.dockerfile
					? { dockerfile: resolvePath(config.images.tool.dockerfile) }
					: {}),
			},
		},
		zones: config.zones.map((zone) => ({
			...zone,
			gateway: {
				...zone.gateway,
				gatewayConfig: resolvePath(zone.gateway.gatewayConfig),
				stateDir: resolvePath(zone.gateway.stateDir),
				workspaceDir: resolvePath(zone.gateway.workspaceDir),
			},
		})),
		toolProfiles: Object.fromEntries(
			Object.entries(config.toolProfiles).map(([profileId, profile]) => [
				profileId,
				{ ...profile, workspaceRoot: resolvePath(profile.workspaceRoot) },
			]),
		),
	};
}

export async function loadSystemConfig(configPath: string): Promise<SystemConfig> {
	const absoluteConfigPath = path.resolve(configPath);
	const configDir = path.dirname(absoluteConfigPath);
	const rawConfig = await fs.readFile(absoluteConfigPath, 'utf8');
	let parsedConfig: unknown;
	try {
		parsedConfig = JSON.parse(rawConfig) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse system config '${absoluteConfigPath}': ${message}`, {
			cause: error,
		});
	}
	const config = systemConfigSchema.parse(parsedConfig);
	return resolveRelativePaths(config, configDir);
}
