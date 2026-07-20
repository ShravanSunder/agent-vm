import { GatewayRuntimeAttachmentMetadataSchema } from '@agent-vm/agent-portal-sdk';
import {
	ManagedAgentProjectionSchema,
	type ManagedAgentProjection,
} from '@agent-vm/agent-portal-sdk/contracts';
import type { GatewayRuntimeAttachmentMetadata } from '@agent-vm/agent-portal-sdk/gateway-runtime-client';

export interface ResolvedAgentVmPluginConfig {
	readonly toolPortal?: {
		readonly agentProjections: Readonly<Record<string, ManagedAgentProjection>>;
		readonly attachment: GatewayRuntimeAttachmentMetadata;
	};
	readonly zoneId: string;
}

export type AgentVmPluginConfigJsonValue =
	| boolean
	| null
	| number
	| string
	| AgentVmPluginConfigJsonObject
	| readonly AgentVmPluginConfigJsonValue[];

export interface AgentVmPluginConfigJsonObject {
	readonly [fieldName: string]: AgentVmPluginConfigJsonValue;
}

export type AgentVmPluginConfigInput = AgentVmPluginConfigJsonObject;

function isConfigObject(
	value: AgentVmPluginConfigJsonValue | undefined,
): value is AgentVmPluginConfigJsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalConfigObject(options: {
	readonly fieldName: string;
	readonly record: AgentVmPluginConfigInput;
}): AgentVmPluginConfigJsonObject | undefined {
	if (!Object.hasOwn(options.record, options.fieldName)) {
		return undefined;
	}
	const value = options.record[options.fieldName];
	if (!isConfigObject(value)) {
		throw new Error(`Gondolin plugin ${options.fieldName} must be an object when present.`);
	}
	return value;
}

function assertNoUnknownFields(options: {
	readonly allowedFields: ReadonlySet<string>;
	readonly label: string;
	readonly record: AgentVmPluginConfigJsonObject;
}): void {
	for (const fieldName of Object.keys(options.record)) {
		if (!options.allowedFields.has(fieldName)) {
			throw new Error(`Gondolin plugin ${options.label} does not accept field '${fieldName}'.`);
		}
	}
}

const rootConfigFields = new Set([
	'controllerUrl',
	'toolPortal',
	'zoneGitToken',
	'zoneGitTokenEnv',
	'zoneId',
]);

const toolPortalConfigFields = new Set(['agentProjections', 'attachment']);

function resolveToolPortalConfig(
	config: AgentVmPluginConfigInput,
): ResolvedAgentVmPluginConfig['toolPortal'] {
	const rawToolPortalConfig = optionalConfigObject({
		fieldName: 'toolPortal',
		record: config,
	});
	if (rawToolPortalConfig === undefined) {
		return undefined;
	}
	assertNoUnknownFields({
		allowedFields: toolPortalConfigFields,
		label: 'toolPortal',
		record: rawToolPortalConfig,
	});
	const rawAttachment = optionalConfigObject({
		fieldName: 'attachment',
		record: rawToolPortalConfig,
	});
	if (rawAttachment === undefined) {
		throw new Error('Gondolin plugin toolPortal requires attachment.');
	}
	const parsedAttachment = GatewayRuntimeAttachmentMetadataSchema.safeParse(rawAttachment);
	if (!parsedAttachment.success) {
		throw new Error('Gondolin plugin toolPortal attachment is invalid.', {
			cause: parsedAttachment.error,
		});
	}
	if (parsedAttachment.data.clientKind !== 'openclaw-managed-plugin') {
		throw new Error('Gondolin plugin toolPortal requires openclaw-managed-plugin clientKind.');
	}
	const rawAgentProjections = optionalConfigObject({
		fieldName: 'agentProjections',
		record: rawToolPortalConfig,
	});
	if (rawAgentProjections === undefined) {
		throw new Error('Gondolin plugin toolPortal requires agentProjections.');
	}
	const agentProjectionEntries = Object.entries(rawAgentProjections).map(
		([agentId, rawProjection]) => {
			if (agentId.length === 0) {
				throw new Error(
					'Gondolin plugin toolPortal agentProjections requires non-empty agent ids.',
				);
			}
			const parsedProjection = ManagedAgentProjectionSchema.safeParse(rawProjection);
			if (!parsedProjection.success) {
				throw new Error(
					`Gondolin plugin toolPortal agentProjections requires a valid projection for agent '${agentId}'.`,
					{ cause: parsedProjection.error },
				);
			}
			const projection = parsedProjection.data;
			if (
				projection.agentId !== agentId ||
				projection.frameworkIdentity.kind !== 'openclaw' ||
				projection.frameworkIdentity.agentId !== agentId
			) {
				throw new Error(
					`Gondolin plugin toolPortal agentProjections identity does not match agent '${agentId}'.`,
				);
			}
			return [agentId, projection] as const;
		},
	);
	const configuredAgentIds = [...parsedAttachment.data.configuredAgentIds].toSorted();
	const projectionAgentIds = agentProjectionEntries.map(([agentId]) => agentId).toSorted();
	if (
		configuredAgentIds.length !== projectionAgentIds.length ||
		configuredAgentIds.some((agentId, index) => projectionAgentIds[index] !== agentId)
	) {
		throw new Error('Gondolin plugin toolPortal agent sets must match exactly.');
	}
	const attachment = Object.freeze({
		...parsedAttachment.data,
		configuredAgentIds: Object.freeze([...parsedAttachment.data.configuredAgentIds]),
	});
	const agentProjections = Object.freeze(Object.fromEntries(agentProjectionEntries));
	return Object.freeze({
		agentProjections,
		attachment,
	});
}

export function resolveAgentVmPluginConfig(
	config: AgentVmPluginConfigInput,
): ResolvedAgentVmPluginConfig {
	if (typeof config.zoneId !== 'string') {
		throw new Error('Gondolin plugin config requires zoneId.');
	}
	if (config.zoneId.trim() === '') {
		throw new Error('Gondolin plugin config requires non-empty zoneId.');
	}
	if (Object.hasOwn(config, 'controllerUrl')) {
		throw new Error('Gondolin plugin config no longer accepts controllerUrl.');
	}
	if (Object.hasOwn(config, 'zoneGitToken') || Object.hasOwn(config, 'zoneGitTokenEnv')) {
		throw new Error('Gondolin plugin config no longer accepts zone git token fields.');
	}
	assertNoUnknownFields({
		allowedFields: rootConfigFields,
		label: 'config',
		record: config,
	});
	const toolPortal = resolveToolPortalConfig(config);

	return {
		...(toolPortal === undefined ? {} : { toolPortal }),
		zoneId: config.zoneId,
	};
}
