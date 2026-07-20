import { constants, type Stats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
	mcpConfigSchema,
	toolPortalConfigSchema,
	type ManagedToolPortalConfig,
	type McpConfig,
} from '@agent-vm/config-contracts';
import {
	GatewayRuntimePortalSemanticSnapshotSchema,
	GatewayRuntimeToolPortalProductionControlEndpointSchema,
} from '@agent-vm/gateway-control-contracts';
import { z } from 'zod/v4';

const ProtectedAbsolutePathSchema = z
	.string()
	.min(1)
	.refine((value) => path.isAbsolute(value) && !value.includes('\0'), {
		message: 'Runtime input paths must be absolute and contain no NUL bytes.',
	});

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const RuntimeIdentityValueSchema = z.string().min(1).max(256);

const GatewayRuntimeOtlpHttpEndpointSchema = z
	.string()
	.min(1)
	.max(2_048)
	.url()
	.superRefine((value, context) => {
		const endpoint = new URL(value);
		if (endpoint.protocol !== 'http:') {
			context.addIssue({
				code: 'custom',
				message: 'Managed Tool Portal telemetry requires a mediated HTTP collector endpoint.',
			});
		}
		if (
			endpoint.username !== '' ||
			endpoint.password !== '' ||
			endpoint.search !== '' ||
			endpoint.hash !== '' ||
			(endpoint.pathname !== '' && endpoint.pathname !== '/')
		) {
			context.addIssue({
				code: 'custom',
				message: 'Managed Tool Portal telemetry endpoint must not contain credentials or a path.',
			});
		}
	});

export const GatewayRuntimeToolPortalObservabilityConfigSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('disabled') }).strict(),
	z
		.object({
			admissionLimits: z
				.object({
					maxExportBatchRecords: z.literal(64),
					maxQueuedRecordsPerSignal: z.literal(256),
					maxRecordBytes: z.literal(65_536),
				})
				.strict(),
			endpoint: GatewayRuntimeOtlpHttpEndpointSchema,
			flushIntervalMs: PositiveSafeIntegerSchema,
			kind: z.literal('otlp-http'),
			logs: z.boolean(),
			metrics: z.boolean(),
			sampleRate: z.number().min(0).max(1),
			serviceName: z.literal('agent-vm-tool-portal'),
			sourcePolicy: z
				.object({
					admitBaggage: z.literal(false),
					captureContent: z.literal(false),
				})
				.strict(),
			traces: z.boolean(),
		})
		.strict(),
]);

export type GatewayRuntimeToolPortalObservabilityConfig = z.infer<
	typeof GatewayRuntimeToolPortalObservabilityConfigSchema
>;

const GatewayRuntimeManagedToolPortalConfigSchema = toolPortalConfigSchema.transform(
	(config, context): ManagedToolPortalConfig => {
		if (config.mode !== 'managed') {
			context.addIssue({
				code: 'custom',
				message: 'Gateway runtime service requires managed Tool Portal configuration.',
				path: ['mode'],
			});
			return z.NEVER;
		}
		return config;
	},
);

export const GatewayRuntimeServiceConfigSchema = z
	.object({
		artifactLimits: z
			.object({
				maximumArtifactBytes: PositiveSafeIntegerSchema,
				maximumArtifactCount: PositiveSafeIntegerSchema,
				maximumLifetimeMs: PositiveSafeIntegerSchema,
				maximumTotalBytes: PositiveSafeIntegerSchema,
			})
			.strict(),
		attachment: z
			.object({
				attachmentGeneration: PositiveSafeIntegerSchema,
				clientKind: z.enum(['openclaw-managed-plugin', 'hermes-managed-plugin']),
				configuredAgentIds: z.array(z.string().min(1).max(256)).min(1).max(128),
				frameworkEpoch: z.string().min(1).max(256),
				gatewayEpoch: z.string().min(1).max(256),
				projectionCohortDigest: z.string().regex(/^projection-cohort:[a-f0-9]{64}$/u),
				runtimeEpoch: z.string().min(1).max(256),
			})
			.strict(),
		controlEndpoint: z
			.object({
				authority: z
					.object({
						callerContextAgentAuthorityKeys: z.record(
							z.string().min(1).max(256),
							z.string().min(1).max(16_384),
						),
						callerContextProofKey: z.string().min(1).max(16_384),
						verifierPublicKeyPem: z.string().min(1).max(16_384),
					})
					.strict(),
				identity: z
					.object({
						bootId: RuntimeIdentityValueSchema,
						controllerEpoch: RuntimeIdentityValueSchema,
						generationId: RuntimeIdentityValueSchema,
						peerId: RuntimeIdentityValueSchema,
						processEpoch: RuntimeIdentityValueSchema,
						zoneId: RuntimeIdentityValueSchema,
					})
					.strict(),
				listen: z
					.object({
						host: z.string().min(1).max(253),
						port: z.number().int().min(0).max(65_535),
					})
					.strict(),
			})
			.strict(),
		mcpConfigPath: ProtectedAbsolutePathSchema,
		observability: GatewayRuntimeToolPortalObservabilityConfigSchema,
		runtimeRoot: ProtectedAbsolutePathSchema,
		schemaVersion: z.literal(1),
		semanticSnapshot: GatewayRuntimePortalSemanticSnapshotSchema,
		serviceIdentity: z
			.object({
				processEpoch: z.string().min(1).max(256),
				role: z.literal('tool-portal'),
				serviceId: z.string().min(1).max(256),
			})
			.strict(),
		toolPortalConfig: GatewayRuntimeManagedToolPortalConfigSchema,
	})
	.strict()
	.superRefine((config, context) => {
		const configuredAgentIds = config.attachment.configuredAgentIds;
		if (new Set(configuredAgentIds).size !== configuredAgentIds.length) {
			context.addIssue({
				code: 'custom',
				message: 'Gateway runtime configured agent ids must be unique.',
				path: ['attachment', 'configuredAgentIds'],
			});
		}

		const expectedFrameworkKind =
			config.attachment.clientKind === 'openclaw-managed-plugin' ? 'openclaw' : 'hermes';
		const snapshotAgentIds = Object.keys(config.semanticSnapshot.agentProjections).toSorted();
		const toolPortalAgentIds = Object.keys(config.toolPortalConfig.agents).toSorted();
		const expectedAgentIds = [...new Set(configuredAgentIds)].toSorted();
		for (const [fieldPath, observedAgentIds] of [
			[['semanticSnapshot', 'agentProjections'], snapshotAgentIds],
			[['toolPortalConfig', 'agents'], toolPortalAgentIds],
			[
				['controlEndpoint', 'authority', 'callerContextAgentAuthorityKeys'],
				Object.keys(config.controlEndpoint.authority.callerContextAgentAuthorityKeys).toSorted(),
			],
		] as const) {
			if (
				observedAgentIds.length !== expectedAgentIds.length ||
				observedAgentIds.some((agentId, index) => agentId !== expectedAgentIds[index])
			) {
				context.addIssue({
					code: 'custom',
					message: 'Gateway runtime agent sets must match exactly.',
					path: [...fieldPath],
				});
			}
		}

		for (const agentId of expectedAgentIds) {
			const projection = config.semanticSnapshot.agentProjections[agentId];
			const toolPortalAgent = config.toolPortalConfig.agents[agentId];
			if (projection === undefined || toolPortalAgent === undefined) continue;
			if (projection.frameworkIdentity.kind !== expectedFrameworkKind) {
				context.addIssue({
					code: 'custom',
					message: 'Gateway runtime framework projection does not match the selected client kind.',
					path: ['semanticSnapshot', 'agentProjections', agentId, 'frameworkIdentity'],
				});
			}
			if (projection.toolPortalProfileId !== toolPortalAgent.profile) {
				context.addIssue({
					code: 'custom',
					message: 'Gateway runtime profile assignment does not match Tool Portal policy.',
					path: ['semanticSnapshot', 'agentProjections', agentId, 'toolPortalProfileId'],
				});
			}
		}

		if (
			config.attachment.projectionCohortDigest !== config.semanticSnapshot.projectionCohortDigest
		) {
			context.addIssue({
				code: 'custom',
				message: 'Gateway runtime attachment projection cohort digest does not match.',
				path: ['attachment', 'projectionCohortDigest'],
			});
		}

		if (config.semanticSnapshot.activeRevision !== config.semanticSnapshot.desiredRevision) {
			context.addIssue({
				code: 'custom',
				message: 'Gateway runtime immutable semantic snapshot must be active before service boot.',
				path: ['semanticSnapshot', 'activeRevision'],
			});
		}

		if (config.controlEndpoint.identity.processEpoch !== config.serviceIdentity.processEpoch) {
			context.addIssue({
				code: 'custom',
				message: 'Gateway control endpoint and Tool Portal service must share one process epoch.',
				path: ['controlEndpoint', 'identity', 'processEpoch'],
			});
		}
	});

export type GatewayRuntimeServiceConfig = z.infer<typeof GatewayRuntimeServiceConfigSchema>;

function assertProtectedRuntimeInputStatus(fileStatus: Stats): void {
	if (!fileStatus.isFile()) {
		throw new Error('Gateway runtime input must be a regular non-symlink file.');
	}
	if ((fileStatus.mode & 0o077) !== 0) {
		throw new Error('Gateway runtime input must not grant group or other permissions.');
	}
	if (process.getuid !== undefined && fileStatus.uid !== process.getuid()) {
		throw new Error('Gateway runtime input must be owned by the service process user.');
	}
}

async function openProtectedRuntimeInputFile(filePath: string): Promise<FileHandle> {
	if (!path.isAbsolute(filePath) || filePath.includes('\0')) {
		throw new Error('Gateway runtime input path must be absolute and contain no NUL bytes.');
	}
	let fileHandle: FileHandle;
	try {
		fileHandle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error: unknown) {
		throw new Error('Gateway runtime input must be a regular non-symlink file.', {
			cause: error,
		});
	}
	try {
		assertProtectedRuntimeInputStatus(await fileHandle.stat());
		return fileHandle;
	} catch (error: unknown) {
		await fileHandle.close();
		throw error;
	}
}

export async function assertProtectedRuntimeInputFile(filePath: string): Promise<void> {
	const fileHandle = await openProtectedRuntimeInputFile(filePath);
	await fileHandle.close();
}

async function readProtectedRuntimeInputFile(filePath: string): Promise<string> {
	const fileHandle = await openProtectedRuntimeInputFile(filePath);
	try {
		return await fileHandle.readFile('utf8');
	} finally {
		await fileHandle.close();
	}
}

function parseProtectedJson(fileContents: string, inputName: string): unknown {
	try {
		return JSON.parse(fileContents);
	} catch (error: unknown) {
		throw new Error(`${inputName} is not valid JSON.`, { cause: error });
	}
}

export async function loadGatewayRuntimeServiceConfig(
	configPath: string,
): Promise<GatewayRuntimeServiceConfig> {
	const serializedConfig = await readProtectedRuntimeInputFile(configPath);
	const untrustedConfig = parseProtectedJson(serializedConfig, 'Gateway runtime service config');
	const config = GatewayRuntimeServiceConfigSchema.parse(untrustedConfig);
	GatewayRuntimeToolPortalProductionControlEndpointSchema.parse(config.controlEndpoint.listen);
	return config;
}

export async function loadGatewayRuntimeMcpConfig(configPath: string): Promise<McpConfig> {
	const serializedConfig = await readProtectedRuntimeInputFile(configPath);
	const untrustedConfig = parseProtectedJson(serializedConfig, 'Gateway runtime MCP config');
	return mcpConfigSchema.parse(untrustedConfig);
}
