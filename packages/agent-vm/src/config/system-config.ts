import { access } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { loadJsonConfigFile } from './json-config-file.js';
import { resolveConfigPath } from './path-resolver.js';
import { zoneResourcesPolicySchema } from './resource-contracts/index.js';
import { resolveSystemCacheIdentifierPath } from './system-cache-identifier.js';

const gatewayTypeValues = ['openclaw', 'worker'] as const;
const agentIdSchema = z
	.string()
	.min(1)
	.regex(
		/^[a-z0-9][a-z0-9._-]*$/u,
		'agent id must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, or hyphens',
	);

function pathContainsParentTraversal(inputPath: string): boolean {
	return inputPath.split(/[\\/]+/u).includes('..');
}

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

const agentSandboxSeedSchema = z
	.object({
		source: authProfilesSecretSchema,
		target: z.string().min(1),
		mode: z.number().int().min(0).max(0o777).default(0o600),
	})
	.strict()
	.superRefine((seed, context) => {
		if (path.posix.isAbsolute(seed.target) || pathContainsParentTraversal(seed.target)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'agent sandbox seed target must be a relative path without parent traversal.',
				path: ['target'],
			});
		}
	});

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

const zoneAdminAccessSchema = z.discriminatedUnion('mode', [
	z
		.object({
			mode: z.literal('none'),
		})
		.strict(),
	z
		.object({
			mode: z.literal('secret'),
			secret: hostSecretReferenceSchema,
		})
		.strict(),
]);

const gatewaySshSecretEnvSchema = z.enum(['never', 'explicit']);

const gatewaySshSchema = z
	.object({
		secretEnv: gatewaySshSecretEnvSchema.default('explicit'),
	})
	.strict();

const zoneGatewayBaseSchema = z.object({
	imageProfile: z.string().min(1),
	memory: z.string().min(1),
	cpus: z.number().int().positive(),
	port: z.number().int().positive(),
	config: z.string().min(1),
	stateDir: z.string().min(1),
	backupDir: z.string().min(1).optional(),
	authProfilesRef: authProfilesSecretSchema.optional(),
	ssh: gatewaySshSchema.optional(),
});

const openClawZoneGatewaySchema = zoneGatewayBaseSchema
	.extend({
		type: z.literal('openclaw'),
		zoneFilesDir: z.string().min(1),
		authProfilesByAgent: z.record(agentIdSchema, authProfilesSecretSchema).optional(),
	})
	.strict();

const workerZoneGatewaySchema = zoneGatewayBaseSchema
	.extend({
		type: z.literal('worker'),
	})
	.strict();

const zoneGatewaySchema = z.discriminatedUnion('type', [
	openClawZoneGatewaySchema,
	workerZoneGatewaySchema,
]);

const toolVmProfileSchema = z
	.object({
		memory: z.string().min(1),
		cpus: z.number().int().positive(),
		imageProfile: z.string().min(1),
	})
	.strict();

const leaseScopeKindSchema = z.enum([
	'agent',
	'discord',
	'project',
	'session',
	'shared',
	'workspace',
]);

const leaseIdleTtlSchema = z
	.object({
		defaultMs: z
			.number()
			.int()
			.positive()
			.default(30 * 60 * 1000),
		byScopeKind: z.partialRecord(leaseScopeKindSchema, z.number().int().positive()).default({}),
		byScopePrefix: z.record(z.string().min(1), z.number().int().positive()).default({}),
	})
	.strict();

const imageConfigSchema = z
	.object({
		buildConfig: z.string().min(1),
		dockerfile: z.string().min(1).optional(),
		source: z
			.object({
				kind: z.literal('managedBase'),
				base: z.enum(['openclaw-gateway', 'worker-gateway', 'tool-vm']),
				overlay: z.string().min(1).optional(),
			})
			.strict()
			.optional(),
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
				z
					.object({
						id: z.string().min(1),
						adminAccess: zoneAdminAccessSchema.optional(),
						gateway: zoneGatewaySchema,
						resources: zoneResourcesPolicySchema.optional(),
						secrets: z.record(z.string(), secretReferenceSchema),
						runtimeAuthHints: z.array(runtimeAuthHintSchema).optional(),
						allowedHosts: z.array(z.string().min(1)).min(1),
						websocketBypass: z.array(z.string().min(1)).default([]),
						defaultToolVmProfile: z.string().min(1).optional(),
						agentToolVmProfiles: z.record(agentIdSchema, z.string().min(1)).optional(),
						agentSandboxSeeds: z.record(agentIdSchema, z.array(agentSandboxSeedSchema)).optional(),
					})
					.strict(),
			)
			.min(1, 'system config must define at least one zone'),
		toolVmProfiles: z.record(z.string().min(1), toolVmProfileSchema).default({}),
		tcpPool: z.object({
			basePort: z.number().int().positive(),
			size: z.number().int().positive(),
		}),
		leaseIdleTtl: leaseIdleTtlSchema.optional(),
	})
	.strict()
	.superRefine((config, context) => {
		const hasOnePasswordSecrets = config.zones.some(
			(zone) =>
				Object.values(zone.secrets).some((secret) => secret.source === '1password') ||
				(zone.adminAccess?.mode === 'secret' && zone.adminAccess.secret.source === '1password') ||
				zone.gateway.authProfilesRef?.source === '1password' ||
				(zone.gateway.type === 'openclaw' &&
					Object.values(zone.gateway.authProfilesByAgent ?? {}).some(
						(secret) => secret.source === '1password',
					)) ||
				Object.values(zone.agentSandboxSeeds ?? {}).some((seeds) =>
					seeds.some((seed) => seed.source.source === '1password'),
				),
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

		for (const [profileName, profile] of Object.entries(config.imageProfiles.gateways)) {
			if (!profile.source) {
				continue;
			}
			const expectedManagedBase =
				profile.type === 'openclaw' ? 'openclaw-gateway' : 'worker-gateway';
			if (profile.source.base !== expectedManagedBase) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Gateway image profile '${profileName}' type '${profile.type}' must use managed base '${expectedManagedBase}'.`,
					path: ['imageProfiles', 'gateways', profileName, 'source', 'base'],
				});
			}
		}

		for (const [profileName, profile] of Object.entries(config.imageProfiles.toolVms)) {
			if (profile.source && profile.source.base !== 'tool-vm') {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Tool VM image profile '${profileName}' must use managed base 'tool-vm'.`,
					path: ['imageProfiles', 'toolVms', profileName, 'source', 'base'],
				});
			}
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

			if (zone.gateway.type !== 'openclaw' && zone.defaultToolVmProfile !== undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Worker zone '${zone.id}' must not declare defaultToolVmProfile.`,
					path: ['zones', zoneIndex, 'defaultToolVmProfile'],
				});
			}
			if (zone.gateway.type !== 'openclaw' && zone.agentToolVmProfiles !== undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Worker zone '${zone.id}' must not declare agentToolVmProfiles.`,
					path: ['zones', zoneIndex, 'agentToolVmProfiles'],
				});
			}
			if (
				zone.gateway.type !== 'openclaw' &&
				Object.keys(zone.agentSandboxSeeds ?? {}).length > 0
			) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Worker zone '${zone.id}' must not declare agentSandboxSeeds.`,
					path: ['zones', zoneIndex, 'agentSandboxSeeds'],
				});
			}
			if (zone.gateway.type === 'openclaw' && zone.defaultToolVmProfile === undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `OpenClaw zone '${zone.id}' must declare a defaultToolVmProfile.`,
					path: ['zones', zoneIndex, 'defaultToolVmProfile'],
				});
			}
			if (zone.gateway.type === 'openclaw' && zone.agentToolVmProfiles === undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `OpenClaw zone '${zone.id}' must declare agentToolVmProfiles, even when it is empty.`,
					path: ['zones', zoneIndex, 'agentToolVmProfiles'],
				});
			}
			if (
				zone.defaultToolVmProfile !== undefined &&
				!config.toolVmProfiles[zone.defaultToolVmProfile]
			) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Zone '${zone.id}' references unknown defaultToolVmProfile '${zone.defaultToolVmProfile}'.`,
					path: ['zones', zoneIndex, 'defaultToolVmProfile'],
				});
			}
			for (const [agentId, toolVmProfileId] of Object.entries(zone.agentToolVmProfiles ?? {})) {
				if (config.toolVmProfiles[toolVmProfileId]) {
					continue;
				}
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Zone '${zone.id}' agentToolVmProfiles['${agentId}'] references unknown toolVmProfile '${toolVmProfileId}'.`,
					path: ['zones', zoneIndex, 'agentToolVmProfiles', agentId],
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

		for (const [profileId, profile] of Object.entries(config.toolVmProfiles)) {
			if (config.imageProfiles.toolVms[profile.imageProfile]) {
				continue;
			}
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Tool VM profile '${profileId}' references unknown tool VM imageProfile '${profile.imageProfile}'.`,
				path: ['toolVmProfiles', profileId, 'imageProfile'],
			});
		}
	});

export type SystemConfig = z.infer<typeof systemConfigSchema>;
export type SystemConfigInput = z.input<typeof systemConfigSchema>;

export type LoadedSystemConfig = SystemConfig & {
	readonly systemConfigPath: string;
	readonly systemCacheIdentifierPath: string;
};

function pathsOverlap(firstPath: string, secondPath: string): boolean {
	const firstResolved = path.resolve(firstPath);
	const secondResolved = path.resolve(secondPath);
	const firstToSecond = path.relative(firstResolved, secondResolved);
	const secondToFirst = path.relative(secondResolved, firstResolved);
	return (
		firstToSecond === '' ||
		secondToFirst === '' ||
		(!firstToSecond.startsWith('..') && !path.isAbsolute(firstToSecond)) ||
		(!secondToFirst.startsWith('..') && !path.isAbsolute(secondToFirst))
	);
}

function assertResolvedRuntimePathIsolation(config: z.infer<typeof systemConfigSchema>): void {
	if (pathsOverlap(config.runtimeDir, config.cacheDir)) {
		throw new Error('runtimeDir must not overlap cacheDir.');
	}
	for (const zone of config.zones) {
		if (pathsOverlap(config.runtimeDir, zone.gateway.stateDir)) {
			throw new Error(`runtimeDir must not overlap stateDir for zone '${zone.id}'.`);
		}
		if (
			zone.gateway.type === 'openclaw' &&
			pathsOverlap(config.runtimeDir, zone.gateway.zoneFilesDir)
		) {
			throw new Error(`runtimeDir must not overlap zoneFilesDir for zone '${zone.id}'.`);
		}
	}
}

export function createLoadedSystemConfig(
	config: SystemConfigInput,
	options: { readonly systemConfigPath: string },
): LoadedSystemConfig {
	const parsedConfig = systemConfigSchema.parse(config);
	assertResolvedRuntimePathIsolation(parsedConfig);
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
						...(profile.source?.overlay
							? { source: { ...profile.source, overlay: resolvePath(profile.source.overlay) } }
							: {}),
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
						...(profile.source?.overlay
							? { source: { ...profile.source, overlay: resolvePath(profile.source.overlay) } }
							: {}),
					},
				]),
			),
		},
		zones: config.zones.map((zone) => ({
			...zone,
			gateway: resolveZoneGatewayPaths(zone.gateway),
		})),
		toolVmProfiles: Object.fromEntries(
			Object.entries(config.toolVmProfiles).map(([profileId, profile]) => [
				profileId,
				{ ...profile },
			]),
		),
	};
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function resolveExistingSystemConfigPath(configPath: string): Promise<string> {
	const absoluteConfigPath = path.resolve(configPath);
	try {
		await access(absoluteConfigPath);
		return absoluteConfigPath;
	} catch (error) {
		if (!isMissingFileError(error) || path.basename(absoluteConfigPath) !== 'system.json') {
			throw error;
		}
	}

	const jsoncConfigPath = path.join(path.dirname(absoluteConfigPath), 'system.jsonc');
	await access(jsoncConfigPath);
	return jsoncConfigPath;
}

export async function loadSystemConfig(configPath: string): Promise<LoadedSystemConfig> {
	const absoluteConfigPath = await resolveExistingSystemConfigPath(configPath);
	const configDir = path.dirname(absoluteConfigPath);
	const parsedConfig = await loadJsonConfigFile(absoluteConfigPath);
	const config = systemConfigSchema.parse(parsedConfig);
	return createLoadedSystemConfig(resolveRelativePaths(config, configDir), {
		systemConfigPath: absoluteConfigPath,
	});
}
