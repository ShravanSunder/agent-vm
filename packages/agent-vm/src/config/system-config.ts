import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { resolveConfigPath } from './path-resolver.js';
import { zoneResourcesPolicySchema } from './resource-contracts/index.js';
import { resolveSystemCacheIdentifierPath } from './system-cache-identifier.js';

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

const runtimeAuthHintSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('service-token'),
			secret: z.string().min(1),
			service: z.string().min(1),
			hosts: z.array(z.string().min(1)).min(1),
			tools: z.array(z.string().min(1)).default([]),
		})
		.strict(),
]);

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

const zoneGatewayBaseSchema = z.object({
	imageProfile: z.string().min(1),
	memory: z.string().min(1),
	cpus: z.number().int().positive(),
	port: z.number().int().positive(),
	config: z.string().min(1),
	stateDir: z.string().min(1),
	backupDir: z.string().min(1).optional(),
	authProfilesRef: authProfilesSecretSchema.optional(),
});

const openClawZoneGatewaySchema = zoneGatewayBaseSchema
	.extend({
		type: z.literal('openclaw').default('openclaw'),
		zoneFilesDir: z.string().min(1),
	})
	.strict();

const workerZoneGatewaySchema = zoneGatewayBaseSchema
	.extend({
		type: z.literal('worker'),
	})
	.strict();

const zoneGatewaySchema = z.union([openClawZoneGatewaySchema, workerZoneGatewaySchema]);

const toolProfileSchema = z.object({
	memory: z.string().min(1),
	cpus: z.number().int().positive(),
	workspaceRoot: z.string().min(1),
	imageProfile: z.string().min(1),
});

const imageConfigSchema = z
	.object({
		buildConfig: z.string().min(1),
		dockerfile: z.string().min(1).optional(),
	})
	.strict();

const gatewayImageProfileSchema = imageConfigSchema.extend({
	type: z.enum(gatewayTypeValues),
});

const toolVmImageProfileSchema = imageConfigSchema.extend({
	type: z.literal('toolVm'),
});

const imageProfilesSchema = z.object({
	gateways: z.record(z.string().min(1), gatewayImageProfileSchema),
	toolVms: z.record(z.string().min(1), toolVmImageProfileSchema).default({}),
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
		runtimeDir: z.string().min(1).default('./runtime'),
		imageProfiles: imageProfilesSchema,
		zones: z
			.array(
				z.object({
					id: z.string().min(1),
					gateway: zoneGatewaySchema,
					resources: zoneResourcesPolicySchema.optional(),
					secrets: z.record(z.string(), secretReferenceSchema),
					runtimeAuthHints: z.array(runtimeAuthHintSchema).optional(),
					allowedHosts: z.array(z.string().min(1)).min(1),
					websocketBypass: z.array(z.string().min(1)).default([]),
					toolProfile: z.string().min(1).optional(),
				}),
			)
			.min(1, 'system config must define at least one zone'),
		toolProfiles: z.record(z.string(), toolProfileSchema).default({}),
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

		if (Object.keys(config.imageProfiles.gateways).length === 0) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'system config must define at least one gateway image profile.',
				path: ['imageProfiles', 'gateways'],
			});
		}

		for (const [zoneIndex, zone] of config.zones.entries()) {
			// Keep zone gateway type readable at the use site while image profiles
			// remain the source of boot-image details. This cross-check prevents
			// a worker lifecycle from accidentally booting an OpenClaw image, or
			// vice versa.
			const gatewayImageProfile = config.imageProfiles.gateways[zone.gateway.imageProfile];
			if (!gatewayImageProfile) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Zone '${zone.id}' references unknown gateway imageProfile '${zone.gateway.imageProfile}'.`,
					path: ['zones', zoneIndex, 'gateway', 'imageProfile'],
				});
			} else if (gatewayImageProfile.type !== zone.gateway.type) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Zone '${zone.id}' gateway type '${zone.gateway.type}' does not match imageProfile '${zone.gateway.imageProfile}' type '${gatewayImageProfile.type}'.`,
					path: ['zones', zoneIndex, 'gateway', 'imageProfile'],
				});
			}

			if (zone.gateway.type === 'openclaw' && zone.toolProfile === undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `OpenClaw zone '${zone.id}' must declare a toolProfile.`,
					path: ['zones', zoneIndex, 'toolProfile'],
				});
				continue;
			}
			if (zone.toolProfile !== undefined && !config.toolProfiles[zone.toolProfile]) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Zone '${zone.id}' references unknown toolProfile '${zone.toolProfile}'.`,
					path: ['zones', zoneIndex, 'toolProfile'],
				});
			}

			for (const [hintIndex, hint] of (zone.runtimeAuthHints ?? []).entries()) {
				const secret = zone.secrets[hint.secret];
				if (!secret) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Zone '${zone.id}' runtimeAuthHints[${String(hintIndex)}] references unknown secret '${hint.secret}'.`,
						path: ['zones', zoneIndex, 'runtimeAuthHints', hintIndex, 'secret'],
					});
					continue;
				}
				if (secret.injection !== 'http-mediation') {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Zone '${zone.id}' runtimeAuthHints[${String(hintIndex)}] secret '${hint.secret}' must use injection 'http-mediation'.`,
						path: ['zones', zoneIndex, 'runtimeAuthHints', hintIndex, 'secret'],
					});
				}
				const missingHosts = hint.hosts.filter((host) => !secret.hosts?.includes(host));
				for (const missingHost of missingHosts) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Zone '${zone.id}' service token hint host '${missingHost}' must be listed in secret '${hint.secret}' hosts.`,
						path: ['zones', zoneIndex, 'runtimeAuthHints', hintIndex, 'hosts'],
					});
				}
			}
		}

		for (const [profileId, profile] of Object.entries(config.toolProfiles)) {
			if (config.imageProfiles.toolVms[profile.imageProfile]) {
				continue;
			}
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Tool profile '${profileId}' references unknown tool VM imageProfile '${profile.imageProfile}'.`,
				path: ['toolProfiles', profileId, 'imageProfile'],
			});
		}
	});

export type SystemConfig = z.infer<typeof systemConfigSchema>;
export type SystemConfigInput = z.input<typeof systemConfigSchema>;

export type LoadedSystemConfig = SystemConfig & {
	readonly systemConfigPath: string;
	readonly systemCacheIdentifierPath: string;
};

export function createLoadedSystemConfig(
	config: SystemConfigInput,
	options: { readonly systemConfigPath: string },
): LoadedSystemConfig {
	const parsedConfig = systemConfigSchema.parse(config);
	return {
		...parsedConfig,
		systemConfigPath: options.systemConfigPath,
		systemCacheIdentifierPath: resolveSystemCacheIdentifierPath(options.systemConfigPath),
	};
}

/**
 * Resolve all relative paths in a system config relative to the config file's directory.
 * This ensures paths like "./state/shravan" work regardless of the process CWD.
 */
function resolveRelativePaths(
	config: z.infer<typeof systemConfigSchema>,
	configDir: string,
): z.infer<typeof systemConfigSchema> {
	const resolvePath = (relativePath: string): string => resolveConfigPath(relativePath, configDir);
	const resolveZoneGatewayPaths = (
		gateway: z.infer<typeof zoneGatewaySchema>,
	): z.infer<typeof zoneGatewaySchema> => {
		switch (gateway.type) {
			case 'openclaw':
				return {
					...gateway,
					config: resolvePath(gateway.config),
					stateDir: resolvePath(gateway.stateDir),
					...(gateway.backupDir ? { backupDir: resolvePath(gateway.backupDir) } : {}),
					zoneFilesDir: resolvePath(gateway.zoneFilesDir),
				};
			case 'worker':
				return {
					...gateway,
					config: resolvePath(gateway.config),
					stateDir: resolvePath(gateway.stateDir),
					...(gateway.backupDir ? { backupDir: resolvePath(gateway.backupDir) } : {}),
				};
			default: {
				const exhaustiveGateway: never = gateway;
				throw new Error(`Unhandled gateway type: ${String(exhaustiveGateway)}`);
			}
		}
	};

	return {
		...config,
		cacheDir: resolvePath(config.cacheDir),
		runtimeDir: resolvePath(config.runtimeDir),
		imageProfiles: {
			gateways: Object.fromEntries(
				Object.entries(config.imageProfiles.gateways).map(([profileId, profile]) => [
					profileId,
					{
						...profile,
						buildConfig: resolvePath(profile.buildConfig),
						...(profile.dockerfile ? { dockerfile: resolvePath(profile.dockerfile) } : {}),
					},
				]),
			),
			toolVms: Object.fromEntries(
				Object.entries(config.imageProfiles.toolVms).map(([profileId, profile]) => [
					profileId,
					{
						...profile,
						buildConfig: resolvePath(profile.buildConfig),
						...(profile.dockerfile ? { dockerfile: resolvePath(profile.dockerfile) } : {}),
					},
				]),
			),
		},
		zones: config.zones.map((zone) => ({
			...zone,
			gateway: resolveZoneGatewayPaths(zone.gateway),
		})),
		toolProfiles: Object.fromEntries(
			Object.entries(config.toolProfiles).map(([profileId, profile]) => [
				profileId,
				{ ...profile, workspaceRoot: resolvePath(profile.workspaceRoot) },
			]),
		),
	};
}

export async function loadSystemConfig(configPath: string): Promise<LoadedSystemConfig> {
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
	return createLoadedSystemConfig(resolveRelativePaths(config, configDir), {
		systemConfigPath: absoluteConfigPath,
	});
}
