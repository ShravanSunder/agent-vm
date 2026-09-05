import crypto from 'node:crypto';
import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { CONTROL_SESSION_TIMING_MS } from '@agent-vm/control-protocol-contracts';
import {
	GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	GatewayRuntimePortalSurfaceClassSchema,
} from '@agent-vm/gateway-control-contracts';
import { targetsAudience, vmAudienceValues } from '@agent-vm/gateway-lifecycle';
import type {
	EgressHostConfig,
	VmAudience,
	WebSocketUpgradeConfig,
} from '@agent-vm/gateway-lifecycle';
import {
	isReservedHermesProfileProjectionSourceName,
	isReservedHermesProfileProjectionTargetName,
} from '@agent-vm/hermes-gateway';
import { z } from 'zod';

import { loadJsonConfigFile } from './json-config-file.js';
import { resolveConfigPath } from './path-resolver.js';
import { zoneResourcesPolicySchema } from './resource-contracts/index.js';
import {
	agentIdSchema,
	projectNamespaceSchema,
	zoneIdSchema,
} from './system-config-identifier-schemas.js';

export { agentIdSchema, projectNamespaceSchema, zoneIdSchema };

const gatewayTypeValues = ['hermes', 'worker'] as const;

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

const zoneApprovalAuthoritySchema = z
	.object({
		approverId: z.string().min(1).max(1024),
		kind: z.literal('managed_gateway'),
	})
	.strict();

const zoneApprovalAccessSchema = z
	.object({
		approvers: z.array(zoneApprovalAuthoritySchema).length(1),
		audience: z.literal(GATEWAY_RUNTIME_APPROVAL_AUDIENCE),
	})
	.strict();

export const gitBranchNameSchema = z
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

const workspaceGitRemoteSchema = z
	.object({
		repoUrl: z.string().min(1),
		branch: gitBranchNameSchema.default('agent/workspace'),
		defaultBranch: gitBranchNameSchema.default('main'),
	})
	.strict()
	.superRefine((remote, context) => {
		if (remote.branch === remote.defaultBranch) {
			context.addIssue({
				code: 'custom',
				message: 'workspaceGit.remote.branch must differ from defaultBranch',
				path: ['branch'],
			});
		}
	});

const workspaceGitSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('local') }).strict(),
	z.object({ mode: z.literal('remote'), remote: workspaceGitRemoteSchema }).strict(),
]);

function normalizeWorkspaceGitRepositoryIdentity(repoUrl: string): string | undefined {
	const cleaned = repoUrl.trim().replace(/\.git$/u, '');
	const qualifiedMatch = /^(?:https?:\/\/)?github\.com\/([^/?#]+)\/([^/?#]+)$/iu.exec(cleaned);
	const shortMatch = /^([^\s/?#]+)\/([^\s/?#]+)$/u.exec(cleaned);
	const match = qualifiedMatch ?? shortMatch;
	if (match?.[1] === undefined || match[2] === undefined) {
		return undefined;
	}
	return `github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
}

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
	runtimeRootfsSize: z.string().min(1).optional(),
	backupDir: z.string().min(1).optional(),
	backupIdentity: hostSecretReferenceSchema.optional(),
});

const hermesProfileNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

// These are non-credential Discord controls that Hermes reads from the active
// profile environment while authorizing inbound bot messages. Keep this
// allowlist explicit: arbitrary profile environment injection would turn the
// projection map into an unbounded process-environment escape hatch.
const hermesProfileEnvironmentInjectionTargetNames = new Set([
	'DISCORD_ALLOW_BOTS',
	'DISCORD_BOTS_REQUIRE_INLINE_MENTION',
]);

function normalizeHermesProfileName(profileName: string): string {
	return profileName.trim().toLowerCase();
}

const hermesProfilesByAgentSchema = z
	.record(agentIdSchema, z.string().min(1))
	.refine(
		(profilesByAgent) => Object.keys(profilesByAgent).length > 0,
		'gateway.profilesByAgent must declare at least one Hermes profile assignment',
	)
	.superRefine((profilesByAgent, context) => {
		const agentByNormalizedProfileName = new Map<string, string>();
		for (const [agentId, profileName] of Object.entries(profilesByAgent)) {
			const normalizedProfileName = normalizeHermesProfileName(profileName);
			if (profileName !== normalizedProfileName || !hermesProfileNamePattern.test(profileName)) {
				context.addIssue({
					code: 'custom',
					message: `Hermes profile '${profileName}' must already be normalized and match [a-z0-9][a-z0-9_-]{0,63}`,
					path: [agentId],
				});
			}
			if (normalizedProfileName === 'default') {
				context.addIssue({
					code: 'custom',
					message: "Hermes profile 'default' is not admitted in managed mode",
					path: [agentId],
				});
			}
			const existingAgentId = agentByNormalizedProfileName.get(normalizedProfileName);
			if (existingAgentId !== undefined) {
				context.addIssue({
					code: 'custom',
					message: `Hermes profile '${normalizedProfileName}' is assigned to multiple agents '${existingAgentId}' and '${agentId}'`,
					path: [agentId],
				});
			} else {
				agentByNormalizedProfileName.set(normalizedProfileName, agentId);
			}
		}
	});

const hermesZoneGatewaySchema = zoneGatewayBaseSchema
	.extend({
		type: z.literal('hermes'),
		profileSecretProjectionsByAgent: z.record(
			agentIdSchema,
			z.record(secretNameSchema, secretNameSchema),
		),
		profilesByAgent: hermesProfilesByAgentSchema,
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
	hermesZoneGatewaySchema,
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
				base: z.enum(['worker-gateway', 'tool-vm']),
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

const zoneAgentSchema = z
	.object({
		id: agentIdSchema,
		toolVmProfile: z.string().min(1).optional(),
		workspaceGit: workspaceGitSchema.optional(),
	})
	.strict();

const zoneToolPortalConfigSchema = z
	.object({
		configDir: z.string().min(1),
		surfaceEligibilityByProfile: z.record(
			z.string().min(1),
			z.record(z.string().min(1), z.array(GatewayRuntimePortalSurfaceClassSchema).min(1)),
		),
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

const zoneTelemetryProducerSchema = z
	.object({
		traces: z.boolean().default(true),
		metrics: z.boolean().default(true),
		logs: z.boolean().default(true),
		sampleRate: z.number().min(0).max(1).default(1),
		flushIntervalMs: z.number().int().positive().default(10_000),
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
			services: z
				.object({
					framework: zoneTelemetryProducerSchema,
					toolPortal: zoneTelemetryProducerSchema,
				})
				.strict(),
		})
		.strict(),
]);

const systemConfigSchema = z
	.object({
		$schema: z.string().min(1).optional(),
		schemaVersion: z.literal(2).default(2),
		host: z.object({
			controllerPort: z.number().int().positive(),
			projectNamespace: projectNamespaceSchema,
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
		storageRootDir: z.string().min(1),
		imageProfiles: imageProfilesSchema,
		zones: z
			.array(
				z
					.object({
						id: zoneIdSchema,
						agents: z.array(zoneAgentSchema).optional(),
						adminAccess: zoneAdminAccessSchema.optional(),
						approvalAccess: zoneApprovalAccessSchema.optional(),
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
				zone.gateway.backupIdentity?.source === '1password' ||
				(zone.adminAccess?.mode === 'secret' && zone.adminAccess.secret.source === '1password'),
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
			if (profile.type === 'hermes') {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Gateway image profile '${profileName}' type 'hermes' must not declare a managed base.`,
					path: ['imageProfiles', 'gateways', profileName, 'source'],
				});
				continue;
			}
			const expectedManagedBase = 'worker-gateway';
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

		const remoteWorkspaceOwnersByRepositoryBranch = new Map<
			string,
			{ readonly agentId: string; readonly zoneId: string }
		>();
		for (const [zoneIndex, zone] of config.zones.entries()) {
			if (
				zone.gateway.type !== 'hermes' &&
				zone.approvalAccess?.approvers.some((approver) => approver.kind === 'managed_gateway') ===
					true
			) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message:
						'managed_gateway approval authority requires a Gateway lifecycle with native approval presentation; only Hermes supports it.',
					path: ['zones', zoneIndex, 'approvalAccess', 'approvers'],
				});
			}
			const zoneAgents = zone.agents ?? [];
			const zoneAgentIds = new Set(zoneAgents.map((agent) => agent.id));
			const isManagedAgentGateway = zone.gateway.type !== 'worker';
			if (zone.observability?.enabled === true && config.host.observability?.enabled !== true) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Zone '${zone.id}' observability requires host.observability.enabled to be true.`,
					path: ['zones', zoneIndex, 'observability'],
				});
			}
			if (zone.observability?.enabled === true && zone.gateway.type === 'worker') {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Zone '${zone.id}' observability is supported only for managed Hermes gateways.`,
					path: ['zones', zoneIndex, 'observability'],
				});
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
				if (!isManagedAgentGateway) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Worker zone '${zone.id}' secret '${secretName}' must not declare agentAccess because worker zones do not boot managed-agent Tool VMs.`,
						path: ['zones', zoneIndex, 'secrets', secretName, 'agentAccess'],
					});
					continue;
				}
				if (zoneAgentIds.size === 0) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Managed-agent zone '${zone.id}' secret '${secretName}' uses Tool VM agentAccess but zones[].agents is empty. Declare at least one zone agent so agentAccess can be evaluated.`,
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
			// a worker lifecycle from accidentally booting a Hermes image, or vice versa.
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

			if (!isManagedAgentGateway && zone.defaultToolVmProfile !== undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Worker zone '${zone.id}' must not declare defaultToolVmProfile.`,
					path: ['zones', zoneIndex, 'defaultToolVmProfile'],
				});
			}
			if (!isManagedAgentGateway && (zoneAgents.length > 0 || zone.toolPortal !== undefined)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Worker zone '${zone.id}' must not declare agents or toolPortal.`,
					path: ['zones', zoneIndex],
				});
			}
			if (!isManagedAgentGateway && zone.agentToolVmProfiles !== undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Worker zone '${zone.id}' must not declare agentToolVmProfiles.`,
					path: ['zones', zoneIndex, 'agentToolVmProfiles'],
				});
			}
			if (isManagedAgentGateway && zone.defaultToolVmProfile === undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Managed-agent zone '${zone.id}' must declare a defaultToolVmProfile.`,
					path: ['zones', zoneIndex, 'defaultToolVmProfile'],
				});
			}
			if (isManagedAgentGateway && zone.agentToolVmProfiles === undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Managed-agent zone '${zone.id}' must declare agentToolVmProfiles, even when it is empty.`,
					path: ['zones', zoneIndex, 'agentToolVmProfiles'],
				});
			}
			if (isManagedAgentGateway && zoneAgentIds.size === 0) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Managed-agent zone '${zone.id}' must declare at least one trusted agent.`,
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
				if (zone.gateway.type === 'worker' && agent.workspaceGit !== undefined) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Worker zone '${zone.id}' agent '${agent.id}' must not declare workspaceGit.`,
						path: ['zones', zoneIndex, 'agents', agentIndex, 'workspaceGit'],
					});
				}
				if (agent.workspaceGit?.mode === 'remote') {
					const repositoryIdentity = normalizeWorkspaceGitRepositoryIdentity(
						agent.workspaceGit.remote.repoUrl,
					);
					if (repositoryIdentity === undefined) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Zone '${zone.id}' agent '${agent.id}' workspaceGit.remote.repoUrl must name a credential-free GitHub repository.`,
							path: ['zones', zoneIndex, 'agents', agentIndex, 'workspaceGit', 'remote', 'repoUrl'],
						});
					} else {
						const repositoryBranchIdentity = `${repositoryIdentity}\0${agent.workspaceGit.remote.branch}`;
						const existingOwner =
							remoteWorkspaceOwnersByRepositoryBranch.get(repositoryBranchIdentity);
						if (existingOwner !== undefined) {
							context.addIssue({
								code: z.ZodIssueCode.custom,
								message: `Zone '${zone.id}' agent '${agent.id}' workspaceGit duplicates normalized repository and branch owned by zone '${existingOwner.zoneId}' agent '${existingOwner.agentId}'.`,
								path: ['zones', zoneIndex, 'agents', agentIndex, 'workspaceGit'],
							});
						} else {
							remoteWorkspaceOwnersByRepositoryBranch.set(repositoryBranchIdentity, {
								agentId: agent.id,
								zoneId: zone.id,
							});
						}
					}
				}
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
			if (zone.gateway.type === 'hermes') {
				const configuredProfileAgentIds = new Set(Object.keys(zone.gateway.profilesByAgent));
				for (const agentId of zoneAgentIds) {
					if (!configuredProfileAgentIds.has(agentId)) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Hermes zone '${zone.id}' profilesByAgent is missing configured agent '${agentId}'.`,
							path: ['zones', zoneIndex, 'gateway', 'profilesByAgent'],
						});
					}
				}
				for (const agentId of configuredProfileAgentIds) {
					if (!zoneAgentIds.has(agentId)) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Hermes zone '${zone.id}' profilesByAgent references undeclared agent '${agentId}'.`,
							path: ['zones', zoneIndex, 'gateway', 'profilesByAgent', agentId],
						});
					}
				}
				const projectionsByAgent = zone.gateway.profileSecretProjectionsByAgent;
				const projectionAgentIds = new Set(Object.keys(projectionsByAgent));
				for (const agentId of configuredProfileAgentIds) {
					if (!projectionAgentIds.has(agentId)) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Hermes zone '${zone.id}' profileSecretProjectionsByAgent is missing configured agent '${agentId}'.`,
							path: ['zones', zoneIndex, 'gateway', 'profileSecretProjectionsByAgent'],
						});
					}
				}
				for (const agentId of projectionAgentIds) {
					if (!configuredProfileAgentIds.has(agentId)) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Hermes zone '${zone.id}' profileSecretProjectionsByAgent references undeclared agent '${agentId}'.`,
							path: ['zones', zoneIndex, 'gateway', 'profileSecretProjectionsByAgent', agentId],
						});
					}
				}
				const apiServerKeySourceNames: string[] = [];
				const discordSourceNames: string[] = [];
				const profileEnvironmentInjectionSourceNames: string[] = [];
				const assignedSourceNames = new Set<string>();
				for (const [agentId, projections] of Object.entries(projectionsByAgent)) {
					const apiServerKeySourceName = projections.API_SERVER_KEY;
					if (apiServerKeySourceName === undefined) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Hermes zone '${zone.id}' agent '${agentId}' must project exactly one API_SERVER_KEY target.`,
							path: ['zones', zoneIndex, 'gateway', 'profileSecretProjectionsByAgent', agentId],
						});
					} else {
						apiServerKeySourceNames.push(apiServerKeySourceName);
					}
					const discordSourceName = projections.DISCORD_BOT_TOKEN;
					if (discordSourceName === undefined) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Hermes zone '${zone.id}' agent '${agentId}' must project exactly one DISCORD_BOT_TOKEN target.`,
							path: ['zones', zoneIndex, 'gateway', 'profileSecretProjectionsByAgent', agentId],
						});
					} else {
						discordSourceNames.push(discordSourceName);
					}
					for (const [targetName, sourceName] of Object.entries(projections)) {
						assignedSourceNames.add(sourceName);
						const projectionPath = [
							'zones',
							zoneIndex,
							'gateway',
							'profileSecretProjectionsByAgent',
							agentId,
							targetName,
						];
						if (isReservedHermesProfileProjectionTargetName(targetName)) {
							context.addIssue({
								code: z.ZodIssueCode.custom,
								message: `Hermes zone '${zone.id}' profile projection target '${targetName}' is reserved.`,
								path: projectionPath,
							});
						}
						if (isReservedHermesProfileProjectionSourceName(sourceName)) {
							context.addIssue({
								code: z.ZodIssueCode.custom,
								message: `Hermes zone '${zone.id}' profile projection source '${sourceName}' is reserved.`,
								path: projectionPath,
							});
						}
						const secret = zone.secrets[sourceName];
						if (secret === undefined) {
							context.addIssue({
								code: z.ZodIssueCode.custom,
								message: `Hermes zone '${zone.id}' profile projection references unknown source '${sourceName}'.`,
								path: projectionPath,
							});
							continue;
						}
						if (secret.source === 'config') {
							context.addIssue({
								code: z.ZodIssueCode.custom,
								message: `Hermes zone '${zone.id}' profile projection source '${sourceName}' must not use source 'config'.`,
								path: projectionPath,
							});
						}
						if (targetName === 'API_SERVER_KEY' || targetName === 'DISCORD_BOT_TOKEN') {
							if (secret.injection !== 'env' || secret.audience !== 'gateway') {
								context.addIssue({
									code: z.ZodIssueCode.custom,
									message: `Hermes zone '${zone.id}' profile target '${targetName}' source '${sourceName}' must use injection 'env' and audience 'gateway'.`,
									path: projectionPath,
								});
							}
						} else if (hermesProfileEnvironmentInjectionTargetNames.has(targetName)) {
							profileEnvironmentInjectionSourceNames.push(sourceName);
							if (secret.injection !== 'env' || secret.audience !== 'gateway') {
								context.addIssue({
									code: z.ZodIssueCode.custom,
									message: `Hermes zone '${zone.id}' profile target '${targetName}' source '${sourceName}' must use env injection and gateway audience.`,
									path: projectionPath,
								});
							}
						} else if (
							secret.injection !== 'http-mediation' ||
							!targetsAudience(secret.audience, 'gateway')
						) {
							context.addIssue({
								code: z.ZodIssueCode.custom,
								message: `Hermes zone '${zone.id}' profile target '${targetName}' source '${sourceName}' must use Gateway-reaching http-mediation.`,
								path: projectionPath,
							});
						}
					}
				}
				if (new Set(apiServerKeySourceNames).size !== apiServerKeySourceNames.length) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Hermes zone '${zone.id}' API_SERVER_KEY projections must assign one distinct source per agent.`,
						path: ['zones', zoneIndex, 'gateway', 'profileSecretProjectionsByAgent'],
					});
				}
				if (new Set(discordSourceNames).size !== discordSourceNames.length) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Hermes zone '${zone.id}' DISCORD_BOT_TOKEN projections must assign one distinct source per agent.`,
						path: ['zones', zoneIndex, 'gateway', 'profileSecretProjectionsByAgent'],
					});
				}
				for (const [secretName, secret] of Object.entries(zone.secrets)) {
					if (
						secret.injection === 'http-mediation' &&
						targetsAudience(secret.audience, 'gateway') &&
						!assignedSourceNames.has(secretName)
					) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Hermes zone '${zone.id}' Gateway-reaching mediated source '${secretName}' must be assigned to at least one Hermes profile.`,
							path: ['zones', zoneIndex, 'secrets', secretName],
						});
					}
				}
				const allowedRawSecretNames = new Set([
					'API_SERVER_KEY',
					...apiServerKeySourceNames,
					...discordSourceNames,
					...profileEnvironmentInjectionSourceNames,
				]);
				for (const [secretName, secret] of Object.entries(zone.secrets)) {
					if (secret.injection === 'env' && !allowedRawSecretNames.has(secretName)) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							message: `Hermes zone '${zone.id}' env secret '${secretName}' must be the root API_SERVER_KEY, assigned to a profile API_SERVER_KEY or DISCORD_BOT_TOKEN target, or use injection 'http-mediation'.`,
							path: ['zones', zoneIndex, 'secrets', secretName],
						});
					}
				}
			}
			if (
				isManagedAgentGateway &&
				zone.defaultToolVmProfile !== undefined &&
				config.toolVmProfiles[zone.defaultToolVmProfile] === undefined
			) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Zone '${zone.id}' references unknown defaultToolVmProfile '${zone.defaultToolVmProfile}'.`,
					path: ['zones', zoneIndex, 'defaultToolVmProfile'],
				});
			}
			if (isManagedAgentGateway) {
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

			if (zone.gateway.type !== 'worker' && zone.runtimeAuthHints !== undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Managed-agent zone '${zone.id}' must not declare runtimeAuthHints because they are consumed only by worker gateway runtime instructions.`,
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

type ParsedSystemZone = ParsedSystemConfig['zones'][number];
type ParsedZoneGateway = ParsedSystemZone['gateway'];
type ResolvedZoneGateway = ParsedZoneGateway extends infer TGateway
	? TGateway extends { readonly type: 'hermes' }
		? TGateway & {
				readonly stateDir: string;
				readonly zoneFilesDir: string;
				readonly zoneRuntimeDir: string;
			}
		: TGateway extends { readonly type: 'worker' }
			? TGateway & {
					readonly stateDir: string;
					readonly zoneRuntimeDir: string;
				}
			: never
	: never;
type ResolvedSystemZone = Omit<ParsedSystemZone, 'gateway'> & {
	readonly gateway: ResolvedZoneGateway;
};

export type SystemConfig = Omit<ParsedSystemConfig, 'controller' | 'zones'> & {
	readonly cacheDir: string;
	readonly controller?: ParsedSystemConfig['controller'];
	readonly controllerRuntimeDir: string;
	readonly controllerStateDir: string;
	readonly zones: ResolvedSystemZone[];
};
export type SystemConfigInput = z.input<typeof systemConfigSchema>;

export const systemConfigSchemaId = 'agent-vm:system:2';

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

export function sharedImageCacheDirForStorageRoot(storageRootDir: string): string {
	return path.join(path.dirname(storageRootDir), 'cache', 'vm-images');
}

export function sharedImageCacheDirForSystemConfig(config: Pick<SystemConfig, 'cacheDir'>): string {
	return path.join(config.cacheDir, 'vm-images');
}

export function deploymentGeneratedDirForStorageRoot(storageRootDir: string): string {
	return path.join(storageRootDir, 'generated');
}

export function deploymentCacheKeyForStorageRoot(storageRootDir: string): string {
	return crypto.createHash('sha256').update(path.resolve(storageRootDir)).digest('hex');
}

export function deploymentCacheDirForSystemConfig(
	config: Pick<SystemConfig, 'cacheDir' | 'storageRootDir'>,
): string {
	return path.join(
		config.cacheDir,
		'deployments',
		deploymentCacheKeyForStorageRoot(config.storageRootDir),
	);
}

export function gatewayFrameworkCacheDirForSystemConfig(
	config: Pick<SystemConfig, 'cacheDir' | 'storageRootDir'>,
	zoneId: string,
): string {
	return path.join(deploymentCacheDirForSystemConfig(config), 'zones', zoneId, 'framework-cache');
}

function isManagedHostObservabilityConfig(
	observability: HostObservabilityConfig,
): observability is ManagedHostObservabilityConfig {
	return observability?.enabled === true && observability.stack.mode === 'managed';
}

interface ControllerStateProtectedPath {
	readonly label: string;
	readonly path: string;
}

type ControllerStateProtectedPathConfig = Pick<
	SystemConfig,
	'cacheDir' | 'controllerRuntimeDir' | 'host' | 'zones'
>;

function collectControllerStateProtectedPaths(
	config: ControllerStateProtectedPathConfig,
	systemConfigPath: string,
): readonly ControllerStateProtectedPath[] {
	const protectedPaths: ControllerStateProtectedPath[] = [
		{ label: 'system config file', path: systemConfigPath },
		{ label: 'system config parent directory', path: path.dirname(systemConfigPath) },
		{ label: 'cacheDir', path: config.cacheDir },
		{ label: 'controllerRuntimeDir', path: config.controllerRuntimeDir },
	];
	const observability = config.host.observability;
	if (isManagedHostObservabilityConfig(observability)) {
		protectedPaths.push({ label: 'observability dataDir', path: observability.dataDir });
	}
	for (const zone of config.zones) {
		protectedPaths.push(
			{ label: `stateDir for zone '${zone.id}'`, path: zone.gateway.stateDir },
			{
				label: `backup output for zone '${zone.id}'`,
				path: zone.gateway.backupDir ?? path.join(zone.gateway.stateDir, 'backups'),
			},
		);
		if (zone.gateway.type !== 'worker') {
			protectedPaths.push(
				{ label: `zoneFilesDir for zone '${zone.id}'`, path: zone.gateway.zoneFilesDir },
				{
					label: `mounted gateway config directory for zone '${zone.id}'`,
					path: path.dirname(zone.gateway.config),
				},
			);
		}
	}
	return protectedPaths;
}

function assertControllerStatePathIsolation(options: {
	readonly controllerStateDir: string;
	readonly protectedPaths: readonly ControllerStateProtectedPath[];
}): void {
	for (const protectedPath of options.protectedPaths) {
		if (pathsOverlap(options.controllerStateDir, protectedPath.path)) {
			throw new Error(`controllerStateDir must not overlap ${protectedPath.label}.`);
		}
	}
}

function assertResolvedRuntimePathIsolation(config: SystemConfig, systemConfigPath: string): void {
	const cacheProtectedPaths: readonly ControllerStateProtectedPath[] = [
		{ label: 'deployment storageRootDir', path: config.storageRootDir },
		{ label: 'system config file', path: systemConfigPath },
		{ label: 'controllerStateDir', path: config.controllerStateDir },
		{ label: 'controllerRuntimeDir', path: config.controllerRuntimeDir },
		...config.zones.flatMap((zone): readonly ControllerStateProtectedPath[] => [
			{ label: `stateDir for zone '${zone.id}'`, path: zone.gateway.stateDir },
			{
				label: `backup output for zone '${zone.id}'`,
				path: zone.gateway.backupDir ?? path.join(zone.gateway.stateDir, 'backups'),
			},
			...(zone.gateway.type === 'worker'
				? []
				: [
						{
							label: `zoneFilesDir for zone '${zone.id}'`,
							path: zone.gateway.zoneFilesDir,
						},
					]),
		]),
	];
	for (const protectedPath of cacheProtectedPaths) {
		if (pathsOverlap(config.cacheDir, protectedPath.path)) {
			throw new Error(`cacheDir must not overlap ${protectedPath.label}.`);
		}
	}
	assertControllerStatePathIsolation({
		controllerStateDir: config.controllerStateDir,
		protectedPaths: collectControllerStateProtectedPaths(config, systemConfigPath),
	});
	if (pathsOverlap(config.controllerRuntimeDir, config.cacheDir)) {
		throw new Error('controllerRuntimeDir must not overlap cacheDir.');
	}
	const observability = config.host.observability;
	if (isManagedHostObservabilityConfig(observability)) {
		const { dataDir } = observability;
		if (pathsOverlap(dataDir, config.cacheDir)) {
			throw new Error('observability dataDir must not overlap cacheDir.');
		}
		if (pathsOverlap(dataDir, config.controllerRuntimeDir)) {
			throw new Error('observability dataDir must not overlap controllerRuntimeDir.');
		}
	}
	for (const zone of config.zones) {
		if (pathsOverlap(config.controllerRuntimeDir, zone.gateway.stateDir)) {
			throw new Error(`controllerRuntimeDir must not overlap stateDir for zone '${zone.id}'.`);
		}
		if (pathsOverlap(config.cacheDir, zone.gateway.stateDir)) {
			throw new Error(`cacheDir must not overlap stateDir for zone '${zone.id}'.`);
		}
		if (
			zone.gateway.backupDir !== undefined &&
			pathsOverlap(zone.gateway.backupDir, zone.gateway.stateDir)
		) {
			throw new Error(`backupDir must not overlap stateDir for zone '${zone.id}'.`);
		}
		if (
			zone.gateway.type !== 'worker' &&
			pathsOverlap(config.controllerRuntimeDir, zone.gateway.zoneFilesDir)
		) {
			throw new Error(`controllerRuntimeDir must not overlap zoneFilesDir for zone '${zone.id}'.`);
		}
		if (
			zone.gateway.type !== 'worker' &&
			pathsOverlap(config.cacheDir, zone.gateway.zoneFilesDir)
		) {
			throw new Error(`cacheDir must not overlap zoneFilesDir for zone '${zone.id}'.`);
		}
		if (
			zone.gateway.type !== 'worker' &&
			zone.gateway.backupDir !== undefined &&
			pathsOverlap(zone.gateway.backupDir, zone.gateway.zoneFilesDir)
		) {
			throw new Error(`backupDir must not overlap zoneFilesDir for zone '${zone.id}'.`);
		}
		if (isManagedHostObservabilityConfig(observability)) {
			const { dataDir } = observability;
			if (pathsOverlap(dataDir, zone.gateway.stateDir)) {
				throw new Error(`observability dataDir must not overlap stateDir for zone '${zone.id}'.`);
			}
			if (zone.gateway.type !== 'worker' && pathsOverlap(dataDir, zone.gateway.zoneFilesDir)) {
				throw new Error(
					`observability dataDir must not overlap zoneFilesDir for zone '${zone.id}'.`,
				);
			}
		}
	}
}

function deriveResolvedStorage(
	config: ParsedSystemConfig | SystemConfig,
	storageRootDir: string = config.storageRootDir,
): SystemConfig {
	const zones: ResolvedSystemZone[] = config.zones.map((zone): ResolvedSystemZone => {
		const zoneRootDir = path.join(storageRootDir, zone.id);
		const stateDir = path.join(zoneRootDir, 'state');
		const zoneRuntimeDir = path.join(zoneRootDir, 'runtime');
		switch (zone.gateway.type) {
			case 'hermes':
				return {
					...zone,
					gateway: {
						...zone.gateway,
						stateDir,
						zoneFilesDir: path.join(zoneRootDir, 'zone-files'),
						zoneRuntimeDir,
					},
				};
			case 'worker':
				return {
					...zone,
					gateway: {
						...zone.gateway,
						stateDir,
						zoneRuntimeDir,
					},
				};
			default: {
				const exhaustiveGateway: never = zone.gateway;
				throw new Error(`Unhandled gateway type: ${String(exhaustiveGateway)}`);
			}
		}
	});
	return {
		...config,
		storageRootDir,
		cacheDir: path.join(path.dirname(storageRootDir), 'cache'),
		controllerStateDir: path.join(storageRootDir, 'controller-state'),
		controllerRuntimeDir: path.join(storageRootDir, 'controller-runtime'),
		zones,
	};
}

export function createLoadedSystemConfig(
	config: SystemConfigInput,
	options: { readonly systemConfigPath: string },
): LoadedSystemConfig {
	const parsedConfig = systemConfigSchema.parse(config);
	const resolvedConfig = deriveResolvedStorage(parsedConfig);
	assertResolvedRuntimePathIsolation(resolvedConfig, options.systemConfigPath);
	return {
		...resolvedConfig,
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
			case 'hermes':
				return {
					...gateway,
					config: resolvePath(gateway.config),
					...(gateway.backupDir ? { backupDir: resolvePath(gateway.backupDir) } : {}),
				};
			case 'worker':
				return {
					...gateway,
					config: resolvePath(gateway.config),
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
		storageRootDir: resolvePath(config.storageRootDir),
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
				: {
						toolPortal: {
							...zone.toolPortal,
							configDir: resolvePath(zone.toolPortal.configDir),
						},
					}),
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

function isMissingPathComponentError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error.code === 'ENOENT' || error.code === 'ENOTDIR')
	);
}

async function resolveCanonicalPathFromExistingAncestor(options: {
	readonly inputPath: string;
	readonly candidatePath: string;
	readonly missingPathSegments: readonly string[];
}): Promise<string> {
	try {
		const canonicalExistingPath = await realpath(options.candidatePath);
		return path.resolve(canonicalExistingPath, ...options.missingPathSegments);
	} catch (error) {
		if (!isMissingPathComponentError(error)) {
			throw new Error(`Failed to canonicalize path '${options.inputPath}'.`, { cause: error });
		}
	}

	try {
		const candidateStatus = await lstat(options.candidatePath);
		if (candidateStatus.isSymbolicLink()) {
			throw new Error(
				`Failed to canonicalize path '${options.inputPath}' through a broken symlink.`,
			);
		}
	} catch (error) {
		if (!isMissingPathComponentError(error)) {
			throw error;
		}
	}

	const parentPath = path.dirname(options.candidatePath);
	if (parentPath === options.candidatePath) {
		throw new Error(
			`Failed to find an existing ancestor while canonicalizing path '${options.inputPath}'.`,
		);
	}
	return resolveCanonicalPathFromExistingAncestor({
		inputPath: options.inputPath,
		candidatePath: parentPath,
		missingPathSegments: [path.basename(options.candidatePath), ...options.missingPathSegments],
	});
}

async function resolveCanonicalPathIdentity(inputPath: string): Promise<string> {
	return resolveCanonicalPathFromExistingAncestor({
		inputPath,
		candidatePath: path.resolve(inputPath),
		missingPathSegments: [],
	});
}

async function canonicalizeStorageRootPath(
	config: LoadedSystemConfig,
): Promise<LoadedSystemConfig> {
	const storageRootDir = await resolveCanonicalPathIdentity(config.storageRootDir);
	const resolvedConfig = deriveResolvedStorage(config, storageRootDir);
	const canonicalCacheDir = await resolveCanonicalPathIdentity(resolvedConfig.cacheDir);
	if (canonicalCacheDir !== path.resolve(resolvedConfig.cacheDir)) {
		throw new Error(
			`cacheDir must not traverse symlinks: '${resolvedConfig.cacheDir}' resolves to '${canonicalCacheDir}'.`,
		);
	}
	const protectedPaths = await Promise.all(
		collectControllerStateProtectedPaths(resolvedConfig, config.systemConfigPath).map(
			async (protectedPath): Promise<ControllerStateProtectedPath> => ({
				label: protectedPath.label,
				path: await resolveCanonicalPathIdentity(protectedPath.path),
			}),
		),
	);
	assertControllerStatePathIsolation({
		controllerStateDir: resolvedConfig.controllerStateDir,
		protectedPaths,
	});
	const cacheProtectedPaths = await Promise.all(
		[
			...protectedPaths.filter(
				({ label }) => label !== 'cacheDir' && label !== 'system config parent directory',
			),
			{ label: 'deployment storageRootDir', path: storageRootDir },
			{ label: 'controllerStateDir', path: resolvedConfig.controllerStateDir },
			...resolvedConfig.zones.map((zone) => ({
				label: `zoneRuntimeDir for zone '${zone.id}'`,
				path: zone.gateway.zoneRuntimeDir,
			})),
		].map(
			async (protectedPath): Promise<ControllerStateProtectedPath> => ({
				label: protectedPath.label,
				path: await resolveCanonicalPathIdentity(protectedPath.path),
			}),
		),
	);
	for (const protectedPath of cacheProtectedPaths) {
		if (pathsOverlap(canonicalCacheDir, protectedPath.path)) {
			throw new Error(`cacheDir must not overlap ${protectedPath.label}.`);
		}
	}
	return { ...resolvedConfig, systemConfigPath: config.systemConfigPath };
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
	const loadedConfig = createLoadedSystemConfig(resolveRelativePaths(config, configDir), {
		systemConfigPath: absoluteConfigPath,
	});
	return await canonicalizeStorageRootPath(loadedConfig);
}
