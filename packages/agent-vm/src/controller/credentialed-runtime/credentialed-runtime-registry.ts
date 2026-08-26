import { createHash } from 'node:crypto';

import { encodeCanonicalJson, JsonObjectSchema } from '@agent-vm/agent-portal-sdk';
import {
	createEffectiveManagedToolPortalConfig,
	type ConfiguredCliCredentialEnvironmentValue,
	type ConfiguredCliCredentialFileMapping,
	type EffectiveManagedToolPortalConfig,
	type PreparedManagedToolPortalConfig,
} from '@agent-vm/config-contracts';
import {
	decodeConfiguredCliPreparedImageIdentity,
	type EffectiveControllerExecutionOperation,
} from '@agent-vm/config-contracts';
import { deriveGatewayRuntimePortalBindingRevision } from '@agent-vm/gateway-control-contracts';
import type { SecretRef } from '@agent-vm/secret-management';

type PreparedConfiguredCliOperation = Extract<
	EffectiveControllerExecutionOperation,
	{ readonly kind: 'configured_cli' }
>;

export interface CredentialedRuntimeBindingDefinition {
	readonly files: Readonly<Record<string, Extract<SecretRef, { readonly source: '1password' }>>>;
}

export interface CredentialedRuntimeResolution {
	readonly agentId: string;
	readonly cohortRevision: string;
	readonly credentialBinding: CredentialedRuntimeBindingDefinition;
	readonly credentialEnvironment: Readonly<Record<string, ConfiguredCliCredentialEnvironmentValue>>;
	readonly fileMappings: readonly ConfiguredCliCredentialFileMapping[];
	readonly groupRevision: string;
	readonly namespaceId: string;
	readonly operation: PreparedConfiguredCliOperation;
	readonly operationName: string;
	readonly profileId: string;
	readonly runtimeId: string;
	readonly zoneId: string;
}

export interface ControllerCredentialedRuntimeRegistrySnapshot {
	readonly cohortRevision: string;
	readonly resolve: (request: {
		readonly agentId: string;
		readonly cohortRevision: string;
		readonly namespaceId: string;
		readonly operationName: string;
		readonly profileId: string;
	}) => CredentialedRuntimeResolution;
	readonly zoneId: string;
}

export interface ControllerCredentialedRuntimeRegistryPublisher {
	activate(snapshot: ControllerCredentialedRuntimeRegistrySnapshot): void;
	resolve(request: {
		readonly agentId: string;
		readonly cohortRevision: string;
		readonly namespaceId: string;
		readonly operationName: string;
		readonly profileId: string;
		readonly zoneId: string;
	}): CredentialedRuntimeResolution;
	withdraw(zoneId: string): void;
}

export interface CompiledCredentialedRuntimeConfig {
	readonly effectiveToolPortalConfig: EffectiveManagedToolPortalConfig;
	readonly registrySnapshot: ControllerCredentialedRuntimeRegistrySnapshot;
}

function digestJson(domain: string, value: unknown): string {
	const jsonValue = JsonObjectSchema.parse(value);
	return `sha256:${createHash('sha256')
		.update(domain)
		.update('\0')
		.update(encodeCanonicalJson(jsonValue))
		.digest('hex')}`;
}

function operationEntryKey(props: {
	readonly agentId: string;
	readonly namespaceId: string;
	readonly operationName: string;
	readonly profileId: string;
}): string {
	return [props.agentId, props.profileId, props.namespaceId, props.operationName].join('\0');
}

function runtimeGroupMaterial(operation: PreparedConfiguredCliOperation): unknown {
	if (operation.executionTarget.kind !== 'ephemeral_managed_vm') {
		throw new Error('Credentialed runtime groups require an ephemeral Managed VM target.');
	}
	const target = operation.executionTarget;
	const preparedImage = decodeConfiguredCliPreparedImageIdentity(target.imageReference);
	return {
		allowedHosts: target.allowedHosts.toSorted(),
		credentialBinding: target.credentialBinding,
		credentialEnvironment: target.credentialEnvironment,
		credentialFiles: [...target.credentialFiles].toSorted((left, right) =>
			left.source.localeCompare(right.source),
		),
		environment: target.environment,
		imageFingerprint: preparedImage.fingerprint,
		imageReference: preparedImage.imageReference,
		rootfsMode: 'cow',
		runtimeId: target.runtimeId,
	};
}

function credentialedRegistryRevisionMaterial(
	preparedConfig: PreparedManagedToolPortalConfig,
): unknown {
	const operations: Record<string, unknown> = {};
	for (const [profileId, profile] of Object.entries(preparedConfig.profiles)) {
		for (const [namespaceId, namespacePolicy] of Object.entries(profile.namespaces)) {
			if (namespacePolicy.backend.kind !== 'controller_execution') continue;
			for (const [operationName, operation] of Object.entries(namespacePolicy.backend.operations)) {
				if (
					operation.kind !== 'configured_cli' ||
					operation.executionTarget.kind !== 'ephemeral_managed_vm'
				) {
					continue;
				}
				operations[[profileId, namespaceId, operationName].join('\0')] =
					runtimeGroupMaterial(operation);
			}
		}
	}
	return {
		agents: Object.fromEntries(
			Object.entries(preparedConfig.agents).map(([agentId, agent]) => [
				agentId,
				{
					credentialBindings: agent.credentialBindings ?? {},
					profile: agent.profile,
				},
			]),
		),
		operations,
	};
}

function hasCredentialedRuntime(config: PreparedManagedToolPortalConfig): boolean {
	return Object.values(config.profiles).some((profile) =>
		Object.values(profile.namespaces).some(
			(namespacePolicy) =>
				namespacePolicy.backend.kind === 'controller_execution' &&
				Object.values(namespacePolicy.backend.operations).some(
					(operation) =>
						operation.kind === 'configured_cli' &&
						operation.executionTarget.kind === 'ephemeral_managed_vm',
				),
		),
	);
}

export function compileCredentialedRuntimeConfig(props: {
	readonly preparedConfig: PreparedManagedToolPortalConfig;
	readonly zoneId: string;
}): CompiledCredentialedRuntimeConfig {
	const credentialedRuntimeRevision = digestJson(
		'credentialed-runtime-registry',
		credentialedRegistryRevisionMaterial(props.preparedConfig),
	);
	const effectiveToolPortalConfig = createEffectiveManagedToolPortalConfig(
		props.preparedConfig,
		hasCredentialedRuntime(props.preparedConfig) ? { credentialedRuntimeRevision } : {},
	);
	const cohortRevision = deriveGatewayRuntimePortalBindingRevision(effectiveToolPortalConfig);
	const entries = new Map<string, CredentialedRuntimeResolution>();

	for (const [profileId, profile] of Object.entries(props.preparedConfig.profiles)) {
		const groupMaterials = new Map<string, string>();
		for (const namespacePolicy of Object.values(profile.namespaces)) {
			if (namespacePolicy.backend.kind !== 'controller_execution') continue;
			for (const operation of Object.values(namespacePolicy.backend.operations)) {
				if (
					operation.kind !== 'configured_cli' ||
					operation.executionTarget.kind !== 'ephemeral_managed_vm'
				) {
					continue;
				}
				const materialDigest = digestJson(
					'credentialed-runtime-group-material',
					runtimeGroupMaterial(operation),
				);
				const priorDigest = groupMaterials.get(operation.executionTarget.runtimeId);
				if (priorDigest !== undefined && priorDigest !== materialDigest) {
					throw new Error(
						`Credentialed runtime '${operation.executionTarget.runtimeId}' has conflicting runtime-shaping policy in profile '${profileId}'.`,
					);
				}
				groupMaterials.set(operation.executionTarget.runtimeId, materialDigest);
			}
		}

		for (const [agentId, agent] of Object.entries(props.preparedConfig.agents)) {
			if (agent.profile !== profileId) continue;
			for (const [namespaceId, namespacePolicy] of Object.entries(profile.namespaces)) {
				if (namespacePolicy.backend.kind !== 'controller_execution') continue;
				for (const [operationName, operation] of Object.entries(
					namespacePolicy.backend.operations,
				)) {
					if (
						operation.kind !== 'configured_cli' ||
						operation.executionTarget.kind !== 'ephemeral_managed_vm'
					) {
						continue;
					}
					const target = operation.executionTarget;
					const binding = agent.credentialBindings?.[target.credentialBinding];
					if (binding === undefined) {
						throw new Error(
							`Credentialed runtime binding '${target.credentialBinding}' is missing for agent '${agentId}'.`,
						);
					}
					const groupMaterialDigest = groupMaterials.get(target.runtimeId);
					if (groupMaterialDigest === undefined) {
						throw new Error(`Credentialed runtime group '${target.runtimeId}' was not compiled.`);
					}
					const resolution: CredentialedRuntimeResolution = Object.freeze({
						agentId,
						cohortRevision,
						credentialBinding: Object.freeze({ files: Object.freeze({ ...binding.files }) }),
						credentialEnvironment: Object.freeze({ ...target.credentialEnvironment }),
						fileMappings: Object.freeze([...target.credentialFiles]),
						groupRevision: digestJson('credentialed-runtime-group', {
							agentId,
							binding: binding.files,
							groupMaterialDigest,
							zoneId: props.zoneId,
						}),
						namespaceId,
						operation,
						operationName,
						profileId,
						runtimeId: target.runtimeId,
						zoneId: props.zoneId,
					});
					entries.set(
						operationEntryKey({ agentId, namespaceId, operationName, profileId }),
						resolution,
					);
				}
			}
		}
	}

	const registrySnapshot: ControllerCredentialedRuntimeRegistrySnapshot = Object.freeze({
		cohortRevision,
		resolve: (
			request: Parameters<ControllerCredentialedRuntimeRegistrySnapshot['resolve']>[0],
		): CredentialedRuntimeResolution => {
			if (request.cohortRevision !== cohortRevision) {
				throw new Error('Credentialed runtime registry cohort is stale.');
			}
			const resolution = entries.get(operationEntryKey(request));
			if (resolution === undefined) {
				throw new Error('Credentialed runtime registry denied the requested operation.');
			}
			return resolution;
		},
		zoneId: props.zoneId,
	});
	return { effectiveToolPortalConfig, registrySnapshot };
}

export function createControllerCredentialedRuntimeRegistryPublisher(): ControllerCredentialedRuntimeRegistryPublisher {
	const snapshotsByZoneId = new Map<string, ControllerCredentialedRuntimeRegistrySnapshot>();
	return {
		activate: (snapshot): void => {
			snapshotsByZoneId.set(snapshot.zoneId, snapshot);
		},
		resolve: (request): CredentialedRuntimeResolution => {
			const snapshot = snapshotsByZoneId.get(request.zoneId);
			if (snapshot === undefined) {
				throw new Error('Credentialed runtime registry is unavailable for this zone.');
			}
			return snapshot.resolve(request);
		},
		withdraw: (zoneId): void => {
			snapshotsByZoneId.delete(zoneId);
		},
	};
}
