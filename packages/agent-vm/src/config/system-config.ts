import { access } from 'node:fs/promises';
import path from 'node:path';

import { CONTROL_SESSION_TIMING_MS } from '@agent-vm/control-protocol-contracts';
import { targetsAudience, vmAudienceValues } from '@agent-vm/gateway-interface';
import type {
	EgressHostConfig,
	VmAudience,
	WebSocketUpgradeConfig,
} from '@agent-vm/gateway-interface';
import { z } from 'zod';

import { loadJsonConfigFile } from './json-config-file.js';
import { resolveConfigPath } from './path-resolver.js';
import { zoneResourcesPolicySchema } from './resource-contracts/index.js';

const gatewayTypeValues = ['openclaw', 'worker'] as const;
export const agentIdSchema = z
	.string()
	.min(1)
	.max(1024)
	.regex(
		/^[a-z0-9][a-z0-9._-]*$/u,
		'agent id must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, or hyphens',
	);
export const zoneIdSchema = z
	.string()
	.min(1)
	.max(1024)
	.regex(
		/^[a-z0-9][a-z0-9._-]*$/u,
		'zone id must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, or hyphens',
	);

function pathContainsParentTraversal(inputPath: string): boolean {
	return inputPath.split(/[\\/]+/u).includes('..');
}

function escapeRegExpLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function hostMatchesPattern(host: string, pattern: string): boolean {
	const normalizedPattern = pattern.trim().toLowerCase();
	if (normalizedPattern === '') {
		return false;
	}
	if (normalizedPattern === '*') {
		return true;
	}

	const patternRegex = new RegExp(
		`^${normalizedPattern.split('*').map(escapeRegExpLiteral).join('.*')}$`,
		'iu',
	);
	return patternRegex.test(host.toLowerCase());
}

const vmAudienceSchema = z.enum(vmAudienceValues);
const toolVmReachableAudienceSchema = z.enum(['tool-vm', 'both']);
const agentAccessSchema = z.union([z.literal('all'), z.array(agentIdSchema).min(1)]);
const secretNameSchema = z
	.string()
	.min(1)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'secret names must be valid shell environment variable names')
	.refine(
		(secretName) => !['__proto__', 'constructor', 'prototype'].includes(secretName),
		'secret names must not use JavaScript prototype property names',
	);

const egressHostSchema = z
	.object({
		host: z.string().min(1),
		audience: vmAudienceSchema,
	})
	.strict();

const websocketUpgradeSchema = z
	.object({
		audience: vmAudienceSchema,
		scheme: z.enum(['ws', 'wss']),
		host: z.string().min(1),
		port: z.number().int().positive().max(65535).optional(),
		path: z.string().min(1).regex(/^\//u, 'websocket upgrade path must start with /').optional(),
	})
	.strict() satisfies z.ZodType<WebSocketUpgradeConfig>;

const onePasswordEnvSecretSchema = z
	.object({
		source: z.literal('1password'),
		ref: z.string().min(1),
		injection: z.literal('env'),
		audience: z.literal('gateway'),
	})
	.strict();

const environmentEnvSecretSchema = z
	.object({
		source: z.literal('environment'),
		envVar: z.string().min(1),
		injection: z.literal('env'),
		audience: z.literal('gateway'),
	})
	.strict();

const configEnvSecretSchema = z
	.object({
		source: z.literal('config'),
		value: z.string().min(1),
		injection: z.literal('env'),
		audience: z.literal('gateway'),
	})
	.strict();

const onePasswordGatewayMediatedSecretSchema = z
	.object({
		source: z.literal('1password'),
		ref: z.string().min(1),
		injection: z.literal('http-mediation'),
		audience: z.literal('gateway'),
		hosts: z.array(z.string().min(1)).min(1),
	})
	.strict();

const onePasswordToolVmMediatedSecretSchema = z
	.object({
		source: z.literal('1password'),
		ref: z.string().min(1),
		injection: z.literal('http-mediation'),
		audience: toolVmReachableAudienceSchema,
		hosts: z.array(z.string().min(1)).min(1),
		agentAccess: agentAccessSchema,
	})
	.strict();

const environmentGatewayMediatedSecretSchema = z
	.object({
		source: z.literal('environment'),
		envVar: z.string().min(1),
		injection: z.literal('http-mediation'),
		audience: z.literal('gateway'),
		hosts: z.array(z.string().min(1)).min(1),
	})
	.strict();

const environmentToolVmMediatedSecretSchema = z
	.object({
		source: z.literal('environment'),
		envVar: z.string().min(1),
		injection: z.literal('http-mediation'),
		audience: toolVmReachableAudienceSchema,
		hosts: z.array(z.string().min(1)).min(1),
		agentAccess: agentAccessSchema,
	})
	.strict();

const configGatewayMediatedSecretSchema = z
	.object({
		source: z.literal('config'),
		value: z.string().min(1),
		injection: z.literal('http-mediation'),
		audience: z.literal('gateway'),
		hosts: z.array(z.string().min(1)).min(1),
	})
	.strict();

const configToolVmMediatedSecretSchema = z
	.object({
		source: z.literal('config'),
		value: z.string().min(1),
		injection: z.literal('http-mediation'),
		audience: toolVmReachableAudienceSchema,
		hosts: z.array(z.string().min(1)).min(1),
		agentAccess: agentAccessSchema,
	})
	.strict();

const secretReferenceSchema = z.union([
	onePasswordEnvSecretSchema,
	environmentEnvSecretSchema,
	configEnvSecretSchema,
	onePasswordGatewayMediatedSecretSchema,
	onePasswordToolVmMediatedSecretSchema,
	environmentGatewayMediatedSecretSchema,
	environmentToolVmMediatedSecretSchema,
	configGatewayMediatedSecretSchema,
	configToolVmMediatedSecretSchema,
]);

const runtimeAuthHintSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('service-token'),
			secret: secretNameSchema,
			service: z.string().min(1),
			hosts: z.array(z.string().min(1)).min(1),
			tools: z.array(z.string().min(1)).default([]),
		})
		.strict(),
]);

const tokenSourceSchema = z.discriminatedUnion('type', [
	z
		.object({
			type: z.literal('env'),
			envVar: z.string().min(1).optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal('keychain'),
			service: z.string().min(1),
			account: z.string().min(1),
		})
		.strict(),
]);

const authProfilesSecretSchema = z.discriminatedUnion('source', [
	z
		.object({
			source: z.literal('1password'),
			ref: z.string().min(1),
		})
		.strict(),
	z
		.object({
			source: z.literal('environment'),
			envVar: z.string().min(1),
		})
		.strict(),
	z
		.object({
			source: z.literal('config'),
			value: z.string().min(1),
		})
		.strict(),
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
	z
		.object({
			source: z.literal('1password'),
			ref: z.string().min(1),
		})
		.strict(),
	z
		.object({
			source: z.literal('environment'),
			envVar: z.string().min(1),
		})
		.strict(),
	z
		.object({
			source: z.literal('config'),
			value: z.string().min(1),
		})
		.strict(),
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

const gitBranchNameSchema = z
	.string()
	.min(1)
	.regex(
		/^(?!\/)(?!.*(?:^|\/)\.)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*[\\\s~^:?*[])(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]+$/u,
		'git branch must be a safe branch name without spaces, control characters, traversal, refspec, or glob metacharacters',
	);

const gitBranchPatternSchema = z
	.string()
	.min(1)
	.regex(
		/^(?!\/)(?!.*(?:^|\/)\.)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*[\\\s~^:?[])(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/*-]+$/u,
		'git branch pattern must be a safe branch pattern without spaces, control characters, traversal, refspec, or glob metacharacters',
	);

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function gitBranchPatternMatches(pattern: string, branch: string): boolean {
	const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'u');
	return regex.test(branch);
}

const zoneGitRemoteSchema = z
	.object({
		repoUrl: z.string().min(1),
		branch: gitBranchNameSchema.default('agent/zone-files'),
		defaultBranch: gitBranchNameSchema.default('main'),
		protectedBranches: z.array(gitBranchNameSchema).default([]),
		protectedBranchPatterns: z.array(gitBranchPatternSchema).default([]),
	})
	.strict()
	.superRefine((remote, context) => {
		const protectedBranches = new Set([
			'main',
			'master',
			remote.defaultBranch,
			...remote.protectedBranches,
		]);
		if (
			protectedBranches.has(remote.branch) ||
			remote.protectedBranchPatterns.some((pattern) =>
				gitBranchPatternMatches(pattern, remote.branch),
			)
		) {
			context.addIssue({
				code: 'custom',
				message:
					'zoneGit.remote.branch must be a non-protected branch; choose a branch outside defaultBranch, protectedBranches, and protectedBranchPatterns',
				path: ['branch'],
			});
		}
	});

const zoneGitSchema = z
	.object({
		remote: zoneGitRemoteSchema,
	})
	.strict();

const openClawGatewayControlAuthSchema = z.discriminatedUnion('mode', [
	z
		.object({
			mode: z.literal('token'),
			secret: secretNameSchema,
		})
		.strict(),
]);

const openClawAuthLoginProviderSchema = z
	.object({
		profileIds: z.array(z.string().min(1)).min(1),
	})
	.strict();

const openClawAuthLoginSchema = z
	.object({
		defaultAgent: agentIdSchema.optional(),
		providers: z.record(z.string().min(1), openClawAuthLoginProviderSchema),
	})
	.strict();

const zoneGatewayBaseSchema = z.object({
	imageProfile: z.string().min(1),
	memory: z.string().min(1),
	cpus: z.number().int().positive(),
	port: z.number().int().positive(),
	ingress: z
		.object({
			upstreamHeaderTimeoutMs: z.number().int().positive().optional(),
			upstreamResponseTimeoutMs: z.number().int().positive().optional(),
		})
		.strict()
		.optional(),
	config: z.string().min(1),
	stateDir: z.string().min(1),
	runtimeRootfsSize: z.string().min(1).optional(),
	backupDir: z.string().min(1).optional(),
	authProfilesRef: authProfilesSecretSchema.optional(),
	ssh: gatewaySshSchema.optional(),
});

const openClawZoneGatewaySchema = zoneGatewayBaseSchema
	.extend({
		type: z.literal('openclaw'),
		controlAuth: openClawGatewayControlAuthSchema,
		zoneFilesDir: z.string().min(1),
		authProfilesByAgent: z.record(agentIdSchema, authProfilesSecretSchema).optional(),
		authLogin: openClawAuthLoginSchema.optional(),
		rawEnvSecrets: z.array(secretNameSchema).optional(),
		zoneGit: zoneGitSchema.optional(),
	})
	.strict();

const workerRepoPushPolicySchema = z
	.object({
		repoUrl: z.string().min(1),
		defaultBranch: gitBranchNameSchema.default('main'),
		protectedBranches: z.array(gitBranchNameSchema).default([]),
		protectedBranchPatterns: z.array(gitBranchPatternSchema).default([]),
	})
	.strict();

const workerZoneGatewaySchema = zoneGatewayBaseSchema
	.extend({
		type: z.literal('worker'),
		repoPushPolicies: z.array(workerRepoPushPolicySchema).optional(),
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
		runtimeRootfsSize: z.string().min(1).optional(),
	})
	.strict();

const leaseIdleTtlSchema = z
	.object({
		defaultMs: z
			.number()
			.int()
			.positive()
			.default(100 * 60 * 1000),
		maxRequestedMs: z
			.number()
			.int()
			.positive()
			.default(24 * 60 * 60 * 1000),
		minRequestedMs: z.number().int().positive().default(1_000),
	})
	.strict();

const defaultControllerHealthConfig = {
	controlSessionDeathGraceMs: CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace,
	enabled: true,
	eventHistoryLimit: 500,
	gatewayServiceAutoRestart: {
		channelProviderHealth: {
			consecutiveFailureThreshold: 3,
			enabled: true,
			restartGatewayOnRecoverable: false,
			restartGatewayOnUnrecoverable: false,
			transitioningTimeoutMs: 120_000,
		},
		cooldownMs: 61 * 60 * 1000,
		consecutiveFailureThreshold: 10,
		enabled: true,
		failedRecoveryResetMs: 24 * 60 * 60 * 1000,
		maxConsecutiveFailedRecoveries: 3,
		restartTimeoutMs: 10 * 60 * 1000,
	},
	gatewayServiceIntervalMs: 10_000,
	staleAfterMs: 30_000,
} as const;

const gatewayServiceAutoRestartSchema = z
	.object({
		channelProviderHealth: z
			.object({
				consecutiveFailureThreshold: z
					.number()
					.int()
					.positive()
					.default(
						defaultControllerHealthConfig.gatewayServiceAutoRestart.channelProviderHealth
							.consecutiveFailureThreshold,
					),
				enabled: z
					.boolean()
					.default(
						defaultControllerHealthConfig.gatewayServiceAutoRestart.channelProviderHealth.enabled,
					),
				restartGatewayOnRecoverable: z
					.boolean()
					.default(
						defaultControllerHealthConfig.gatewayServiceAutoRestart.channelProviderHealth
							.restartGatewayOnRecoverable,
					),
				restartGatewayOnUnrecoverable: z
					.boolean()
					.default(
						defaultControllerHealthConfig.gatewayServiceAutoRestart.channelProviderHealth
							.restartGatewayOnUnrecoverable,
					),
				transitioningTimeoutMs: z
					.number()
					.int()
					.positive()
					.default(
						defaultControllerHealthConfig.gatewayServiceAutoRestart.channelProviderHealth
							.transitioningTimeoutMs,
					),
			})
			.strict()
			.default(defaultControllerHealthConfig.gatewayServiceAutoRestart.channelProviderHealth),
		cooldownMs: z
			.number()
			.int()
			.positive()
			.default(defaultControllerHealthConfig.gatewayServiceAutoRestart.cooldownMs),
		consecutiveFailureThreshold: z
			.number()
			.int()
			.positive()
			.default(defaultControllerHealthConfig.gatewayServiceAutoRestart.consecutiveFailureThreshold),
		enabled: z.boolean().default(defaultControllerHealthConfig.gatewayServiceAutoRestart.enabled),
		failedRecoveryResetMs: z
			.number()
			.int()
			.positive()
			.default(defaultControllerHealthConfig.gatewayServiceAutoRestart.failedRecoveryResetMs),
		maxConsecutiveFailedRecoveries: z
			.number()
			.int()
			.positive()
			.default(
				defaultControllerHealthConfig.gatewayServiceAutoRestart.maxConsecutiveFailedRecoveries,
			),
		restartTimeoutMs: z
			.number()
			.int()
			.positive()
			.default(defaultControllerHealthConfig.gatewayServiceAutoRestart.restartTimeoutMs),
	})
	.strict();

const controllerHealthSchema = z
	.object({
		controlSessionDeathGraceMs: z
			.number()
			.int()
			.positive()
			.default(defaultControllerHealthConfig.controlSessionDeathGraceMs),
		enabled: z.boolean().default(defaultControllerHealthConfig.enabled),
		eventHistoryLimit: z
			.number()
			.int()
			.positive()
			.default(defaultControllerHealthConfig.eventHistoryLimit),
		gatewayServiceAutoRestart: gatewayServiceAutoRestartSchema.default(
			defaultControllerHealthConfig.gatewayServiceAutoRestart,
		),
		gatewayServiceIntervalMs: z
			.number()
			.int()
			.positive()
			.default(defaultControllerHealthConfig.gatewayServiceIntervalMs),
		staleAfterMs: z.number().int().positive().default(defaultControllerHealthConfig.staleAfterMs),
	})
	.strict();

const controllerConfigSchema = z
	.object({
		health: controllerHealthSchema.default(defaultControllerHealthConfig),
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

type GatewayImageProfileSchemaInput = z.infer<typeof gatewayImageProfileSchema>;

function isManagedOpenClawObservabilityProfile(
	profileName: string,
	profile: GatewayImageProfileSchemaInput | undefined,
): boolean {
	if (!profile || profile.type !== 'openclaw') {
		return false;
	}
	if (profile.source?.base === 'openclaw-gateway') {
		return true;
	}
	return (
		profile.source === undefined &&
		profileName === 'openclaw' &&
		/(?:^|\/)vm-images\/gateways\/openclaw\/build-config\.jsonc?$/u.test(profile.buildConfig)
	);
}

const toolVmImageProfileSchema = imageConfigSchema.extend({
	type: z.literal('toolVm'),
});

const imageProfilesSchema = z.object({
	gateways: z.record(z.string().min(1), gatewayImageProfileSchema),
	toolVms: z.record(z.string().min(1), toolVmImageProfileSchema).default({}),
});

const zoneAgentSchema = z
	.object({
		id: agentIdSchema,
		toolVmProfile: z.string().min(1).optional(),
	})
	.strict();

const zoneToolPortalConfigSchema = z
	.object({
		configDir: z.string().min(1),
	})
	.strict();

const victoriaRetentionPeriodSchema = z
	.string()
	.min(1)
	.regex(
		/^[1-9][0-9]*(?:ms|s|m|h|d|w|M|y)$/u,
		'retention period must be a positive Victoria duration such as 30d, 12h, or 1M',
	);

const victoriaByteSizeSchema = z
	.string()
	.min(1)
	.regex(
		/^[1-9][0-9]*(?:B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/u,
		'retention byte size must be a positive value with a unit such as 5GiB or 50GB',
	);

const observabilityRetentionBaseSchema = z
	.object({
		period: victoriaRetentionPeriodSchema,
		minFreeDiskSpaceBytes: victoriaByteSizeSchema.optional(),
	})
	.strict();

const observabilityByteBoundedRetentionPolicySchema = observabilityRetentionBaseSchema
	.extend({
		maxDiskSpaceUsageBytes: victoriaByteSizeSchema.optional(),
	})
	.strict();

const observabilityDiskBoundedRetentionPolicySchema = observabilityRetentionBaseSchema
	.extend({
		maxDiskSpaceUsageBytes: victoriaByteSizeSchema.optional(),
		maxDiskUsagePercent: z.number().int().min(1).max(100).optional(),
	})
	.strict()
	.refine(
		(value) =>
			value.maxDiskSpaceUsageBytes === undefined || value.maxDiskUsagePercent === undefined,
		'maxDiskSpaceUsageBytes and maxDiskUsagePercent are mutually exclusive',
	);

const hostObservabilityPortSchema = z.number().int().min(1).max(65_535);

const hostObservabilityPortsSchema = z
	.object({
		collectorGrpc: hostObservabilityPortSchema.default(4317),
		collectorHttp: hostObservabilityPortSchema.default(4318),
		collectorHealth: hostObservabilityPortSchema.default(13_133),
		metrics: hostObservabilityPortSchema.default(8428),
		logs: hostObservabilityPortSchema.default(9428),
		traces: hostObservabilityPortSchema.default(10_428),
	})
	.strict()
	.refine((ports) => new Set(Object.values(ports)).size === Object.values(ports).length, {
		message: 'host observability ports must be unique',
	})
	.default({
		collectorGrpc: 4317,
		collectorHttp: 4318,
		collectorHealth: 13_133,
		metrics: 8428,
		logs: 9428,
		traces: 10_428,
	});

const managedHostObservabilityStackSchema = z
	.object({
		mode: z.literal('managed').default('managed'),
		scrubbing: z
			.object({
				responsibility: z
					.literal('agent-vm-managed-collector')
					.default('agent-vm-managed-collector'),
			})
			.strict()
			.default({ responsibility: 'agent-vm-managed-collector' }),
	})
	.strict()
	.default({
		mode: 'managed',
		scrubbing: { responsibility: 'agent-vm-managed-collector' },
	});

const externalHostObservabilityStackSchema = z
	.object({
		mode: z.literal('external'),
		scrubbing: z
			.object({
				responsibility: z.literal('external-collector'),
			})
			.strict(),
	})
	.strict();

const hostObservabilityCommonShape = {
	enabled: z.literal(true),
	mode: z.literal('collector').default('collector'),
	bindAddress: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
	prepareOnBuild: z.boolean().default(true),
	waitOnBuild: z.boolean().default(true),
	startupCheckTimeoutMs: z.number().int().positive().default(30_000),
	ports: hostObservabilityPortsSchema,
	controllerStartPolicy: z.enum(['degraded', 'require-ready', 'off']).default('degraded'),
} as const;

const hostObservabilityRetentionSchema = z
	.object({
		metrics: observabilityRetentionBaseSchema,
		logs: observabilityByteBoundedRetentionPolicySchema,
		traces: observabilityDiskBoundedRetentionPolicySchema,
	})
	.strict();

const managedHostObservabilitySchema = z
	.object({
		...hostObservabilityCommonShape,
		stack: managedHostObservabilityStackSchema,
		runner: z.literal('docker-compose').default('docker-compose'),
		dataDir: z.string().min(1),
		projectName: z
			.string()
			.min(1)
			.regex(
				/^[a-z0-9][a-z0-9_-]*$/u,
				'projectName must use lowercase letters, numbers, hyphens, and underscores, and start with a letter or number',
			)
			.optional(),
		retention: hostObservabilityRetentionSchema,
	})
	.strict();

const externalHostObservabilitySchema = z
	.object({
		...hostObservabilityCommonShape,
		stack: externalHostObservabilityStackSchema,
	})
	.strict();

const hostObservabilitySchema = z.union([
	z
		.object({
			enabled: z.literal(false),
		})
		.strict(),
	managedHostObservabilitySchema,
	externalHostObservabilitySchema,
]);

const zoneOpenClawObservabilitySchema = z
	.object({
		serviceName: z.string().min(1),
		traces: z.boolean().default(true),
		metrics: z.boolean().default(true),
		logs: z.boolean().default(true),
		sampleRate: z.number().min(0).max(1).default(1),
		flushIntervalMs: z.number().int().positive().default(10_000),
		captureContent: z
			.object({
				enabled: z.literal(false).default(false),
			})
			.strict()
			.default({ enabled: false }),
		diagnosticsFlags: z.array(z.string().min(1)).default([]),
	})
	.strict();

const zoneObservabilitySchema = z.discriminatedUnion('enabled', [
	z
		.object({
			enabled: z.literal(false),
		})
		.strict(),
	z
		.object({
			enabled: z.literal(true),
			openclaw: zoneOpenClawObservabilitySchema,
		})
		.strict(),
]);

const systemConfigSchema = z
	.object({
		$schema: z.string().min(1).optional(),
		schemaVersion: z.literal(1).default(1),
		host: z.object({
			controllerPort: z.number().int().positive(),
			projectNamespace: z
				.string()
				.min(1)
				.max(1024)
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
			observability: hostObservabilitySchema.optional(),
		}),
		controller: controllerConfigSchema.default({ health: defaultControllerHealthConfig }),
		cacheDir: z.string().min(1).default('./cache'),
		runtimeDir: z.string().min(1).default('./runtime'),
		imageProfiles: imageProfilesSchema,
		zones: z
			.array(
				z
					.object({
						id: zoneIdSchema,
						agents: z.array(zoneAgentSchema).optional(),
						adminAccess: zoneAdminAccessSchema.optional(),
						gateway: zoneGatewaySchema,
						toolPortal: zoneToolPortalConfigSchema.optional(),
						resources: zoneResourcesPolicySchema.optional(),
						secrets: z.record(secretNameSchema, secretReferenceSchema),
						runtimeAuthHints: z.array(runtimeAuthHintSchema).optional(),
						observability: zoneObservabilitySchema.optional(),
						egressHosts: z.array(egressHostSchema).min(1),
						websocketUpgrades: z.array(websocketUpgradeSchema).optional(),
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
		const egressHostTargetsAudience = (
			egressHosts: readonly EgressHostConfig[],
			host: string,
			audience: VmAudience,
		): boolean => {
			if (audience === 'both') {
				return (
					egressHostTargetsAudience(egressHosts, host, 'gateway') &&
					egressHostTargetsAudience(egressHosts, host, 'tool-vm')
				);
			}
			return egressHosts.some(
				(egressHost) =>
					hostMatchesPattern(host, egressHost.host) &&
					targetsAudience(egressHost.audience, audience),
			);
		};
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
			const zoneAgents = zone.agents ?? [];
			const zoneAgentIds = new Set(zoneAgents.map((agent) => agent.id));
			if (zone.observability?.enabled === true && config.host.observability?.enabled !== true) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Zone '${zone.id}' observability requires host.observability.enabled to be true.`,
					path: ['zones', zoneIndex, 'observability'],
				});
			}
			if (zone.observability?.enabled === true && zone.gateway.type !== 'openclaw') {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Zone '${zone.id}' observability is supported only for OpenClaw gateways in v1.`,
					path: ['zones', zoneIndex, 'observability'],
				});
			}
			if (zone.observability?.enabled === true && zone.gateway.type === 'openclaw') {
				const gatewayImageProfile = config.imageProfiles.gateways[zone.gateway.imageProfile];
				if (
					!isManagedOpenClawObservabilityProfile(zone.gateway.imageProfile, gatewayImageProfile)
				) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Zone '${zone.id}' observability requires OpenClaw gateway image profile '${zone.gateway.imageProfile}' to use managed base 'openclaw-gateway' so @openclaw/diagnostics-otel is installed.`,
						path: ['zones', zoneIndex, 'gateway', 'imageProfile'],
					});
				}
			}
			if (zone.observability?.enabled === true) {
				const forbiddenDiagnosticsFlagPattern =
					/[*=]|^(?:1|all|everything)$|(?:body|content|payload|prompt|secret|token|authorization|cookie|transcript|query|header|url)/iu;
				for (const [
					flagIndex,
					diagnosticsFlag,
				] of zone.observability.openclaw.diagnosticsFlags.entries()) {
					if (forbiddenDiagnosticsFlagPattern.test(diagnosticsFlag)) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Zone '${zone.id}' observability diagnostics flag '${diagnosticsFlag}' is too broad or can capture sensitive content.`,
							path: [
								'zones',
								zoneIndex,
								'observability',
								'openclaw',
								'diagnosticsFlags',
								flagIndex,
							],
						});
					}
				}
				if (
					zone.gateway.type === 'openclaw' &&
					zone.gateway.rawEnvSecrets?.includes('OPENCLAW_DIAGNOSTICS') === true
				) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Zone '${zone.id}' observability owns diagnostics configuration; do not list OPENCLAW_DIAGNOSTICS in gateway.rawEnvSecrets.`,
						path: ['zones', zoneIndex, 'gateway', 'rawEnvSecrets'],
					});
				}
			}
			const openClawControlAuthSecretName =
				zone.gateway.type === 'openclaw' ? zone.gateway.controlAuth.secret : undefined;
			const openClawGatewayToken = openClawControlAuthSecretName
				? zone.secrets[openClawControlAuthSecretName]
				: undefined;
			const allowedOpenClawRawEnvSecrets =
				zone.gateway.type === 'openclaw'
					? new Set([zone.gateway.controlAuth.secret, ...(zone.gateway.rawEnvSecrets ?? [])])
					: new Set<string>();
			if (zone.gateway.type === 'openclaw' && !openClawGatewayToken) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `OpenClaw zone '${zone.id}' must declare control auth secret '${zone.gateway.controlAuth.secret}' as a gateway env secret.`,
					path: ['zones', zoneIndex, 'secrets', zone.gateway.controlAuth.secret],
				});
			}
			if (zone.gateway.type === 'openclaw') {
				if (openClawGatewayToken) {
					if (openClawGatewayToken.injection !== 'env') {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Zone '${zone.id}' OpenClaw control auth secret '${zone.gateway.controlAuth.secret}' must use injection 'env'.`,
							path: ['zones', zoneIndex, 'secrets', zone.gateway.controlAuth.secret, 'injection'],
						});
					}
					if (openClawGatewayToken.audience !== 'gateway') {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Zone '${zone.id}' OpenClaw control auth secret '${zone.gateway.controlAuth.secret}' must target audience 'gateway'.`,
							path: ['zones', zoneIndex, 'secrets', zone.gateway.controlAuth.secret, 'audience'],
						});
					}
					if ('hosts' in openClawGatewayToken) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Zone '${zone.id}' OpenClaw control auth secret '${zone.gateway.controlAuth.secret}' must not declare hosts.`,
							path: ['zones', zoneIndex, 'secrets', zone.gateway.controlAuth.secret, 'hosts'],
						});
					}
				}
				for (const [secretName, secret] of Object.entries(zone.secrets)) {
					if (secret.injection !== 'env' || allowedOpenClawRawEnvSecrets.has(secretName)) {
						continue;
					}
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `OpenClaw zone '${zone.id}' env secret '${secretName}' must be listed in gateway.rawEnvSecrets or use injection 'http-mediation'.`,
						path: ['zones', zoneIndex, 'secrets', secretName, 'injection'],
					});
				}
			}

			for (const [secretName, secret] of Object.entries(zone.secrets)) {
				if (secret.injection !== 'http-mediation') {
					continue;
				}
				for (const [hostIndex, host] of (secret.hosts ?? []).entries()) {
					if (egressHostTargetsAudience(zone.egressHosts, host, secret.audience)) {
						continue;
					}
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Zone '${zone.id}' secret '${secretName}' host '${host}' must be declared in egressHosts for audience '${secret.audience}'.`,
						path: ['zones', zoneIndex, 'secrets', secretName, 'hosts', hostIndex],
					});
				}
			}

			for (const [upgradeIndex, upgrade] of (zone.websocketUpgrades ?? []).entries()) {
				if (egressHostTargetsAudience(zone.egressHosts, upgrade.host, upgrade.audience)) {
					continue;
				}
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Zone '${zone.id}' websocket upgrade host '${upgrade.host}' must be declared in egressHosts for audience '${upgrade.audience}'.`,
					path: ['zones', zoneIndex, 'websocketUpgrades', upgradeIndex, 'host'],
				});
			}

			for (const [secretName, secret] of Object.entries(zone.secrets)) {
				if (
					secret.injection !== 'http-mediation' ||
					!targetsAudience(secret.audience, 'tool-vm') ||
					!('agentAccess' in secret)
				) {
					continue;
				}
				if (zone.gateway.type !== 'openclaw') {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Worker zone '${zone.id}' secret '${secretName}' must not declare agentAccess because worker zones do not boot OpenClaw Tool VMs.`,
						path: ['zones', zoneIndex, 'secrets', secretName, 'agentAccess'],
					});
					continue;
				}
				if (zoneAgentIds.size === 0) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `OpenClaw zone '${zone.id}' secret '${secretName}' uses Tool VM agentAccess but zones[].agents is empty. Declare at least one zone agent so agentAccess can be evaluated.`,
						path: ['zones', zoneIndex, 'agents'],
					});
					continue;
				}
				if (Array.isArray(secret.agentAccess)) {
					for (const [agentAccessIndex, agentId] of secret.agentAccess.entries()) {
						if (zoneAgentIds.has(agentId)) {
							continue;
						}
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Zone '${zone.id}' secret '${secretName}' agentAccess references unknown agent '${agentId}'.`,
							path: ['zones', zoneIndex, 'secrets', secretName, 'agentAccess', agentAccessIndex],
						});
					}
				}
			}

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
			if (
				zone.gateway.type !== 'openclaw' &&
				(zoneAgents.length > 0 || zone.toolPortal !== undefined)
			) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Worker zone '${zone.id}' must not declare agents or toolPortal.`,
					path: ['zones', zoneIndex],
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
			if (zone.gateway.type === 'openclaw' && zoneAgentIds.size === 0) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `OpenClaw zone '${zone.id}' must declare at least one trusted agent.`,
					path: ['zones', zoneIndex, 'agents'],
				});
			}
			const seenAgentIds = new Set<string>();
			for (const [agentIndex, agent] of zoneAgents.entries()) {
				if (seenAgentIds.has(agent.id)) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Zone '${zone.id}' has duplicate agent id '${agent.id}'.`,
						path: ['zones', zoneIndex, 'agents', agentIndex, 'id'],
					});
				}
				seenAgentIds.add(agent.id);
				if (
					agent.toolVmProfile !== undefined &&
					config.toolVmProfiles[agent.toolVmProfile] === undefined
				) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Zone '${zone.id}' agent '${agent.id}' references unknown toolVmProfile '${agent.toolVmProfile}'.`,
						path: ['zones', zoneIndex, 'agents', agentIndex, 'toolVmProfile'],
					});
				}
			}
			if (
				zone.gateway.type === 'openclaw' &&
				zone.defaultToolVmProfile !== undefined &&
				config.toolVmProfiles[zone.defaultToolVmProfile] === undefined
			) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Zone '${zone.id}' references unknown defaultToolVmProfile '${zone.defaultToolVmProfile}'.`,
					path: ['zones', zoneIndex, 'defaultToolVmProfile'],
				});
			}
			if (zone.gateway.type === 'openclaw') {
				for (const [agentId, toolVmProfileId] of Object.entries(zone.agentToolVmProfiles ?? {})) {
					if (!zoneAgentIds.has(agentId)) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Zone '${zone.id}' agentToolVmProfiles['${agentId}'] references undeclared agent '${agentId}'.`,
							path: ['zones', zoneIndex, 'agentToolVmProfiles', agentId],
						});
					}
					if (!config.toolVmProfiles[toolVmProfileId]) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Zone '${zone.id}' agentToolVmProfiles['${agentId}'] references unknown toolVmProfile '${toolVmProfileId}'.`,
							path: ['zones', zoneIndex, 'agentToolVmProfiles', agentId],
						});
					}
				}
			}

			if (zone.gateway.type === 'openclaw' && zone.runtimeAuthHints !== undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `OpenClaw zone '${zone.id}' must not declare runtimeAuthHints because they are consumed only by worker gateway runtime instructions.`,
					path: ['zones', zoneIndex, 'runtimeAuthHints'],
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
				if (zone.gateway.type === 'worker' && secret.audience === 'tool-vm') {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Zone '${zone.id}' runtimeAuthHints[${String(hintIndex)}] secret '${hint.secret}' must target the agent runtime audience for gateway type '${zone.gateway.type}'.`,
						path: ['zones', zoneIndex, 'runtimeAuthHints', hintIndex, 'secret'],
					});
				}
				const secretHosts = secret.injection === 'http-mediation' ? secret.hosts : [];
				const missingHosts = hint.hosts.filter((host) => !secretHosts.includes(host));
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

type ParsedSystemConfig = z.infer<typeof systemConfigSchema>;
type HostObservabilityConfig = ParsedSystemConfig['host']['observability'];
type ManagedHostObservabilityConfig = Extract<
	NonNullable<HostObservabilityConfig>,
	{ readonly enabled: true; readonly stack: { readonly mode: 'managed' } }
>;

export type SystemConfig = Omit<ParsedSystemConfig, 'controller'> & {
	readonly controller?: ParsedSystemConfig['controller'];
};
export type SystemConfigInput = z.input<typeof systemConfigSchema>;

export const systemConfigSchemaId = 'agent-vm:system:1';

export function createSystemConfigSchemaArtifact(): Record<string, unknown> {
	return {
		$id: systemConfigSchemaId,
		...z.toJSONSchema(systemConfigSchema, { io: 'input', target: 'draft-07' }),
	};
}

export type ControllerHealthConfig = ParsedSystemConfig['controller']['health'];

export type LoadedSystemConfig = SystemConfig & {
	readonly systemConfigPath: string;
};

export function resolveControllerHealthConfig(config: {
	readonly controller?: ParsedSystemConfig['controller'];
}): ControllerHealthConfig {
	return config.controller?.health ?? defaultControllerHealthConfig;
}

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

function isManagedHostObservabilityConfig(
	observability: HostObservabilityConfig,
): observability is ManagedHostObservabilityConfig {
	return observability?.enabled === true && observability.stack.mode === 'managed';
}

function assertResolvedRuntimePathIsolation(config: z.infer<typeof systemConfigSchema>): void {
	if (pathsOverlap(config.runtimeDir, config.cacheDir)) {
		throw new Error('runtimeDir must not overlap cacheDir.');
	}
	const observability = config.host.observability;
	if (isManagedHostObservabilityConfig(observability)) {
		const { dataDir } = observability;
		if (pathsOverlap(dataDir, config.cacheDir)) {
			throw new Error('observability dataDir must not overlap cacheDir.');
		}
		if (pathsOverlap(dataDir, config.runtimeDir)) {
			throw new Error('observability dataDir must not overlap runtimeDir.');
		}
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
		if (isManagedHostObservabilityConfig(observability)) {
			const { dataDir } = observability;
			if (pathsOverlap(dataDir, zone.gateway.stateDir)) {
				throw new Error(`observability dataDir must not overlap stateDir for zone '${zone.id}'.`);
			}
			if (zone.gateway.type === 'openclaw' && pathsOverlap(dataDir, zone.gateway.zoneFilesDir)) {
				throw new Error(
					`observability dataDir must not overlap zoneFilesDir for zone '${zone.id}'.`,
				);
			}
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
		host: isManagedHostObservabilityConfig(config.host.observability)
			? {
					...config.host,
					observability: {
						...config.host.observability,
						dataDir: resolvePath(config.host.observability.dataDir),
					},
				}
			: config.host,
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
			...(zone.toolPortal === undefined
				? {}
				: { toolPortal: { configDir: resolvePath(zone.toolPortal.configDir) } }),
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
