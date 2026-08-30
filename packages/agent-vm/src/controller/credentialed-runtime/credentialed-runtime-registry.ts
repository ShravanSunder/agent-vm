import { createHash } from 'node:crypto';

import { encodeCanonicalJson, JsonObjectSchema } from '@agent-vm/agent-portal-sdk';
import {
	createEffectiveManagedToolPortalConfig,
	type ConfiguredCliCredentialProjection,
	type ConfiguredCliCredentialEnvironmentValue,
	type ConfiguredCliCredentialFileMapping,
	type EffectiveManagedToolPortalConfig,
	type PreparedManagedToolPortalConfig,
	type SecretValue,
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

export type CredentialedRuntimeProjection =
	| {
			readonly credentialBinding: CredentialedRuntimeBindingDefinition;
			readonly credentialEnvironment: Readonly<
				Record<string, ConfiguredCliCredentialEnvironmentValue>
			>;
			readonly fileMappings: readonly ConfiguredCliCredentialFileMapping[];
			readonly kind: 'file_binding';
	  }
	| {
			readonly environment: Readonly<
				Record<
					string,
					{
						readonly hosts: readonly string[];
						readonly secret: SecretRef;
					}
				>
			>;
			readonly kind: 'http_mediation';
	  };

export interface CredentialedRuntimeResolution {
	readonly agentRuntimeRevision: string;
	readonly agentId: string;
	readonly cohortRevision: string;
	readonly namespaceId: string;
	readonly operation: PreparedConfiguredCliOperation;
	readonly operationName: string;
	readonly profileId: string;
	readonly projection: CredentialedRuntimeProjection;
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

type PreparedNamespacePolicy =
	PreparedManagedToolPortalConfig['profiles'][string]['namespaces'][string];

function selectorAllowsOperation(
	selector: PreparedNamespacePolicy['tools'],
	operationName: string,
): boolean {
	return (
		!selector.deny.includes(operationName) &&
		(selector.allow === '*' || selector.allow.includes(operationName))
	);
}

function namespaceAllowsOperation(
	namespacePolicy: PreparedNamespacePolicy,
	operationName: string,
): boolean {
	return (
		selectorAllowsOperation(namespacePolicy.tools, operationName) &&
		(selectorAllowsOperation(namespacePolicy.calls.requiresApproval, operationName) ||
			selectorAllowsOperation(namespacePolicy.calls.withoutApproval, operationName))
	);
}

function canonicalCredentialProjection(
	projection: ConfiguredCliCredentialProjection,
): ConfiguredCliCredentialProjection {
	if (projection.kind === 'file_binding') {
		return {
			credentialBinding: projection.credentialBinding,
			credentialEnvironment: Object.fromEntries(
				Object.entries(projection.credentialEnvironment).toSorted(([left], [right]) =>
					left.localeCompare(right),
				),
			),
			credentialFiles: [...projection.credentialFiles].toSorted(
				(left, right) =>
					left.source.localeCompare(right.source) || left.path.localeCompare(right.path),
			),
			kind: 'file_binding',
		};
	}
	return {
		environment: Object.fromEntries(
			Object.entries(projection.environment)
				.toSorted(([left], [right]) => left.localeCompare(right))
				.map(([environmentName, source]) => [
					environmentName,
					{
						hosts: [...new Set(source.hosts)].toSorted(),
						secret: source.secret,
					},
				]),
		),
		kind: 'http_mediation',
	};
}

function runtimeGroupMaterial(operation: PreparedConfiguredCliOperation): unknown {
	if (operation.executionTarget.kind !== 'ephemeral_managed_vm') {
		throw new Error('Credentialed runtime groups require an ephemeral Managed VM target.');
	}
	const target = operation.executionTarget;
	const preparedImage = decodeConfiguredCliPreparedImageIdentity(target.imageReference);
	return {
		allowedHosts: [...new Set(target.allowedHosts)].toSorted(),
		credentialProjection: canonicalCredentialProjection(target.credentialProjection),
		environment:
			target.environment.kind === 'inherit_allowlist'
				? {
						kind: 'inherit_allowlist',
						names: [...new Set(target.environment.names)].toSorted(),
					}
				: target.environment,
		imageFingerprint: preparedImage.fingerprint,
		imageReference: preparedImage.imageReference,
		rootfsMode: 'cow',
	};
}

function secretValueToRef(secret: SecretValue): SecretRef {
	return secret.source === '1password'
		? { ref: secret.ref, source: '1password' }
		: { ref: secret.name, source: 'environment' };
}

function credentialedRegistryRevisionMaterial(
	preparedConfig: PreparedManagedToolPortalConfig,
): unknown {
	const operations: Record<string, unknown> = {};
	for (const [profileId, profile] of Object.entries(preparedConfig.profiles)) {
		for (const [namespaceId, namespacePolicy] of Object.entries(profile.namespaces)) {
			if (namespacePolicy.backend.kind !== 'controller_execution') continue;
			for (const [operationName, operation] of Object.entries(namespacePolicy.backend.operations)) {
				if (!namespaceAllowsOperation(namespacePolicy, operationName)) continue;
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
				Object.entries(namespacePolicy.backend.operations).some(
					([operationName, operation]) =>
						namespaceAllowsOperation(namespacePolicy, operationName) &&
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
		let agentRuntimeMaterialDigest: string | undefined;
		for (const namespacePolicy of Object.values(profile.namespaces)) {
			if (namespacePolicy.backend.kind !== 'controller_execution') continue;
			for (const [operationName, operation] of Object.entries(namespacePolicy.backend.operations)) {
				if (!namespaceAllowsOperation(namespacePolicy, operationName)) continue;
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
				if (
					agentRuntimeMaterialDigest !== undefined &&
					agentRuntimeMaterialDigest !== materialDigest
				) {
					throw new Error(
						`Credentialed runtime operations have conflicting VM-shaping policy in profile '${profileId}'.`,
					);
				}
				agentRuntimeMaterialDigest = materialDigest;
			}
		}

		for (const [agentId, agent] of Object.entries(props.preparedConfig.agents)) {
			if (agent.profile !== profileId) continue;
			for (const [namespaceId, namespacePolicy] of Object.entries(profile.namespaces)) {
				if (namespacePolicy.backend.kind !== 'controller_execution') continue;
				for (const [operationName, operation] of Object.entries(
					namespacePolicy.backend.operations,
				)) {
					if (!namespaceAllowsOperation(namespacePolicy, operationName)) continue;
					if (
						operation.kind !== 'configured_cli' ||
						operation.executionTarget.kind !== 'ephemeral_managed_vm'
					) {
						continue;
					}
					const target = operation.executionTarget;
					if (agentRuntimeMaterialDigest === undefined) {
						throw new Error('Credentialed agent runtime definition was not compiled.');
					}
					const projection: CredentialedRuntimeProjection = (() => {
						const configuredProjection = canonicalCredentialProjection(target.credentialProjection);
						if (configuredProjection.kind === 'http_mediation') {
							return Object.freeze({
								environment: Object.freeze(
									Object.fromEntries(
										Object.entries(configuredProjection.environment).map(
											([environmentName, source]) => [
												environmentName,
												Object.freeze({
													hosts: Object.freeze([...source.hosts]),
													secret: secretValueToRef(source.secret),
												}),
											],
										),
									),
								),
								kind: 'http_mediation' as const,
							});
						}
						const binding = agent.credentialBindings?.[configuredProjection.credentialBinding];
						if (binding === undefined) {
							throw new Error(
								`Credentialed runtime binding '${configuredProjection.credentialBinding}' is missing for agent '${agentId}'.`,
							);
						}
						return Object.freeze({
							credentialBinding: Object.freeze({ files: Object.freeze({ ...binding.files }) }),
							credentialEnvironment: Object.freeze({
								...configuredProjection.credentialEnvironment,
							}),
							fileMappings: Object.freeze([...configuredProjection.credentialFiles]),
							kind: 'file_binding' as const,
						});
					})();
					const resolution: CredentialedRuntimeResolution = Object.freeze({
						agentRuntimeRevision: digestJson('credentialed-agent-runtime', {
							agentId,
							agentRuntimeMaterialDigest,
							projection,
							zoneId: props.zoneId,
						}),
						agentId,
						cohortRevision,
						namespaceId,
						operation,
						operationName,
						profileId,
						projection,
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
