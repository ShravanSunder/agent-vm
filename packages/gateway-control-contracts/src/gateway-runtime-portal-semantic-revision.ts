import { createHash } from 'node:crypto';

import type {
	FormattedSecretValue,
	ManagedToolPortalConfig,
	McpConfig,
} from '@agent-vm/config-contracts';

import {
	GatewayRuntimePortalSemanticSnapshotSchema,
	ManagedAgentProjectionSchema,
	type GatewayRuntimeFrameworkIdentity,
	type GatewayRuntimePortalSemanticSnapshot,
	type GatewayRuntimePortalSurfaceClass,
	type ManagedAgentProjection,
} from './gateway-runtime-portal-context.js';

interface ToolSelector {
	readonly allow: '*' | readonly string[];
	readonly deny: readonly string[];
}

interface NormalizedToolSelector {
	readonly allow: '*' | readonly string[];
	readonly deny: readonly string[];
}

type NormalizedMcpTransport =
	| {
			readonly args: readonly string[];
			readonly command: string;
			readonly connectionTimeoutMs?: number;
			readonly cwd?: string;
			readonly env: Readonly<Record<string, FormattedSecretValue>>;
			readonly kind: 'stdio';
			readonly networkAccess?: 'declared' | 'none';
			readonly requiredEgressHosts: readonly string[];
	  }
	| {
			readonly connectionTimeoutMs?: number;
			readonly headers: Readonly<Record<string, FormattedSecretValue>>;
			readonly kind: 'sse' | 'streamable-http';
			readonly requiredEgressHosts: readonly string[];
			readonly url: string;
	  };

interface NormalizedMcpProvider {
	readonly discovery: McpConfig['providers'][string]['discovery'];
	readonly kind: 'mcp';
	readonly namespace: string;
	readonly secretPolicies: Readonly<
		Record<
			string,
			{
				readonly hosts: readonly string[];
				readonly injection: 'env' | 'http-mediation';
			}
		>
	>;
	readonly transport: NormalizedMcpTransport;
}

type NormalizedMcpProviders = Readonly<Record<string, NormalizedMcpProvider>>;
type NormalizedSurfaceEligibility = Readonly<
	Record<string, Readonly<Record<string, readonly GatewayRuntimePortalSurfaceClass[]>>>
>;

interface NormalizedCatalogInputs {
	readonly profiles: Readonly<
		Record<
			string,
			Readonly<
				Record<
					string,
					{
						readonly operations?: Readonly<
							Record<
								string,
								{
									readonly description: string;
									readonly kind:
										| 'command.fixed'
										| 'filesystem.read'
										| 'filesystem.write'
										| 'process.cancel'
										| 'process.logs'
										| 'process.start'
										| 'process.status'
										| 'process.wait';
								}
							>
						>;
						readonly tools: NormalizedToolSelector;
					}
				>
			>
		>
	>;
	readonly providers: NormalizedMcpProviders;
}

interface NormalizedProfilePolicyInputs {
	readonly profiles: Readonly<
		Record<
			string,
			Readonly<
				Record<
					string,
					{
						readonly calls: {
							readonly requiresApproval: NormalizedToolSelector;
							readonly withoutApproval: NormalizedToolSelector;
						};
						readonly tools: NormalizedToolSelector;
					}
				>
			>
		>
	>;
	readonly surfaceEligibilityByProfile: NormalizedSurfaceEligibility;
}

type NormalizedBindingInputs = Readonly<
	Record<
		string,
		Readonly<
			Record<
				string,
				| { readonly kind: 'controller_host_action' | 'mcp_provider' }
				| {
						readonly kind: 'tool_vm_runner';
						readonly operations: Readonly<
							Record<
								string,
								| {
										readonly executable: string;
										readonly kind: 'command.fixed';
										readonly mandatoryArgvPrefix: readonly string[];
										readonly workingDirectory: string;
								  }
								| {
										readonly kind:
											| 'filesystem.read'
											| 'filesystem.write'
											| 'process.cancel'
											| 'process.logs'
											| 'process.status';
								  }
								| {
										readonly executable: string;
										readonly kind: 'process.start';
										readonly mandatoryArgvPrefix: readonly string[];
										readonly maxRuntimeMs: number;
										readonly retainOutputBytes: number;
										readonly workingDirectory: string;
								  }
								| {
										readonly kind: 'process.wait';
										readonly timeoutMs: number;
								  }
							>
						>;
						readonly profile: 'sandbox_ssh';
				  }
			>
		>
	>
>;

type CanonicalJsonValue =
	| boolean
	| null
	| number
	| string
	| undefined
	| readonly CanonicalJsonValue[]
	| { readonly [key: string]: CanonicalJsonValue };

export interface DeriveGatewayRuntimePortalSemanticSnapshotProps {
	readonly agentProjections: readonly ManagedAgentProjectionInput[];
	readonly mcpConfig: McpConfig;
	readonly surfaceEligibilityByProfile: GatewayRuntimePortalSemanticSnapshot['surfaceEligibilityByProfile'];
	readonly toolPortalConfig: ManagedToolPortalConfig;
}

export interface ManagedAgentProjectionInput {
	readonly agentId: string;
	readonly frameworkIdentity: GatewayRuntimeFrameworkIdentity;
	readonly toolPortalProfileId: string;
}

export interface AssertGatewayRuntimePortalSemanticSnapshotMatchesInputsProps {
	readonly mcpConfig: McpConfig;
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
	readonly toolPortalConfig: ManagedToolPortalConfig;
}

function sortedStrings<TString extends string>(values: readonly TString[]): readonly TString[] {
	return [...values].toSorted();
}

function normalizedToolSelector(selector: ToolSelector): NormalizedToolSelector {
	return {
		allow: selector.allow === '*' ? '*' : sortedStrings(selector.allow),
		deny: sortedStrings(selector.deny),
	};
}

function normalizedMcpProviders(providers: McpConfig['providers']): NormalizedMcpProviders {
	return Object.fromEntries(
		Object.entries(providers).map(([providerId, provider]) => {
			const secretPolicies = Object.fromEntries(
				Object.entries(provider.secretPolicies).map(([secretName, policy]) => [
					secretName,
					{
						hosts: sortedStrings(policy.hosts),
						injection: policy.injection,
					},
				]),
			);
			const transport =
				provider.transport.kind === 'stdio'
					? {
							args: provider.transport.args,
							command: provider.transport.command,
							...(provider.transport.connectionTimeoutMs === undefined
								? {}
								: { connectionTimeoutMs: provider.transport.connectionTimeoutMs }),
							...(provider.transport.cwd === undefined ? {} : { cwd: provider.transport.cwd }),
							env: provider.transport.env,
							kind: provider.transport.kind,
							...(provider.transport.networkAccess === undefined
								? {}
								: { networkAccess: provider.transport.networkAccess }),
							requiredEgressHosts: sortedStrings(provider.transport.requiredEgressHosts),
						}
					: {
							...(provider.transport.connectionTimeoutMs === undefined
								? {}
								: { connectionTimeoutMs: provider.transport.connectionTimeoutMs }),
							headers: provider.transport.headers,
							kind: provider.transport.kind,
							requiredEgressHosts: sortedStrings(provider.transport.requiredEgressHosts),
							url: provider.transport.url,
						};
			return [
				providerId,
				{
					discovery: provider.discovery,
					kind: provider.kind,
					namespace: provider.namespace,
					secretPolicies,
					transport,
				},
			];
		}),
	);
}

function normalizedSurfaceEligibility(
	surfaceEligibilityByProfile: GatewayRuntimePortalSemanticSnapshot['surfaceEligibilityByProfile'],
): NormalizedSurfaceEligibility {
	return Object.fromEntries(
		Object.entries(surfaceEligibilityByProfile).map(([profileId, capabilities]) => [
			profileId,
			Object.fromEntries(
				Object.entries(capabilities).map(([capabilityId, surfaceClasses]) => [
					capabilityId,
					sortedStrings(surfaceClasses),
				]),
			),
		]),
	);
}

function normalizedCatalogInputs(props: {
	readonly mcpConfig: McpConfig;
	readonly toolPortalConfig: ManagedToolPortalConfig;
}): NormalizedCatalogInputs {
	return {
		profiles: Object.fromEntries(
			Object.entries(props.toolPortalConfig.profiles).map(([profileId, profile]) => [
				profileId,
				Object.fromEntries(
					Object.entries(profile.namespaces).map(([namespaceId, namespacePolicy]) => [
						namespaceId,
						{
							...(namespacePolicy.backend.kind === 'tool_vm_runner'
								? {
										operations: Object.fromEntries(
											Object.entries(namespacePolicy.backend.operations).map(
												([operationName, operation]) => [
													operationName,
													{ description: operation.description, kind: operation.kind },
												],
											),
										),
									}
								: {}),
							tools: normalizedToolSelector(namespacePolicy.tools),
						},
					]),
				),
			]),
		),
		providers: normalizedMcpProviders(props.mcpConfig.providers),
	};
}

function normalizedProfilePolicyInputs(props: {
	readonly surfaceEligibilityByProfile: GatewayRuntimePortalSemanticSnapshot['surfaceEligibilityByProfile'];
	readonly toolPortalConfig: ManagedToolPortalConfig;
}): NormalizedProfilePolicyInputs {
	return {
		profiles: Object.fromEntries(
			Object.entries(props.toolPortalConfig.profiles).map(([profileId, profile]) => [
				profileId,
				Object.fromEntries(
					Object.entries(profile.namespaces).map(([namespaceId, namespacePolicy]) => [
						namespaceId,
						{
							calls: {
								requiresApproval: normalizedToolSelector(namespacePolicy.calls.requiresApproval),
								withoutApproval: normalizedToolSelector(namespacePolicy.calls.withoutApproval),
							},
							tools: normalizedToolSelector(namespacePolicy.tools),
						},
					]),
				),
			]),
		),
		surfaceEligibilityByProfile: normalizedSurfaceEligibility(props.surfaceEligibilityByProfile),
	};
}

function normalizedBindingInputs(config: ManagedToolPortalConfig): NormalizedBindingInputs {
	return Object.fromEntries(
		Object.entries(config.profiles).map(([profileId, profile]) => [
			profileId,
			Object.fromEntries(
				Object.entries(profile.namespaces).map(([namespaceId, namespacePolicy]) => [
					namespaceId,
					namespacePolicy.backend.kind === 'tool_vm_runner'
						? {
								kind: namespacePolicy.backend.kind,
								operations: Object.fromEntries(
									Object.entries(namespacePolicy.backend.operations).map(
										([operationName, operation]) => [
											operationName,
											operation.kind === 'command.fixed'
												? {
														executable: operation.executable,
														kind: operation.kind,
														mandatoryArgvPrefix: operation.mandatoryArgvPrefix,
														workingDirectory: operation.workingDirectory,
													}
												: operation.kind === 'process.start'
													? {
															executable: operation.executable,
															kind: operation.kind,
															mandatoryArgvPrefix: operation.mandatoryArgvPrefix,
															maxRuntimeMs: operation.maxRuntimeMs,
															retainOutputBytes: operation.retainOutputBytes,
															workingDirectory: operation.workingDirectory,
														}
													: operation.kind === 'process.wait'
														? { kind: operation.kind, timeoutMs: operation.timeoutMs }
														: { kind: operation.kind },
										],
									),
								),
								profile: namespacePolicy.backend.profile,
							}
						: { kind: namespacePolicy.backend.kind },
				]),
			),
		]),
	);
}

function canonicalJson(value: object): string {
	return JSON.stringify(value, (_key, nestedValue: CanonicalJsonValue) => {
		if (typeof nestedValue !== 'object' || nestedValue === null || Array.isArray(nestedValue)) {
			return nestedValue;
		}
		return Object.fromEntries(
			Object.entries(nestedValue).toSorted(([leftKey], [rightKey]) =>
				leftKey.localeCompare(rightKey),
			),
		);
	});
}

function revision(domain: string, material: object): string {
	const digest = createHash('sha256')
		.update(`${domain}\0`, 'utf8')
		.update(canonicalJson(material), 'utf8')
		.digest('hex');
	return `${domain}:${digest}`;
}

function frameworkIdentityKey(identity: GatewayRuntimeFrameworkIdentity): string {
	return identity.kind === 'openclaw'
		? `openclaw:${identity.agentId}`
		: `hermes:${identity.profileName}`;
}

function assertExactManagedAgentProjectionInputs(props: {
	readonly agentProjections: readonly ManagedAgentProjectionInput[];
	readonly configuredAgents: ManagedToolPortalConfig['agents'];
}): void {
	const projectionAgentIds = props.agentProjections.map((projection) => projection.agentId);
	if (new Set(projectionAgentIds).size !== projectionAgentIds.length) {
		throw new Error('Managed Agent Projection agent ids must be unique.');
	}
	const configuredAgentIds = sortedStrings(Object.keys(props.configuredAgents));
	const sortedProjectionAgentIds = sortedStrings(projectionAgentIds);
	if (
		configuredAgentIds.length !== sortedProjectionAgentIds.length ||
		configuredAgentIds.some((agentId, index) => agentId !== sortedProjectionAgentIds[index])
	) {
		throw new Error(
			'Managed Agent Projection agent ids must exactly match configured Tool Portal agent ids.',
		);
	}
	const frameworkKinds = new Set(
		props.agentProjections.map((projection) => projection.frameworkIdentity.kind),
	);
	if (frameworkKinds.size !== 1) {
		throw new Error('Managed Agent Projections must share one framework kind.');
	}
	const frameworkIdentityKeys = props.agentProjections.map((projection) =>
		frameworkIdentityKey(projection.frameworkIdentity),
	);
	if (new Set(frameworkIdentityKeys).size !== frameworkIdentityKeys.length) {
		throw new Error('Managed Agent Projection framework identities must be unique.');
	}
	for (const projection of props.agentProjections) {
		if (
			projection.frameworkIdentity.kind === 'openclaw' &&
			projection.frameworkIdentity.agentId !== projection.agentId
		) {
			throw new Error(`OpenClaw projection identity must match agent '${projection.agentId}'.`);
		}
		const configuredAgent = props.configuredAgents[projection.agentId];
		if (configuredAgent?.profile !== projection.toolPortalProfileId) {
			throw new Error(
				`Managed Agent Projection Tool Portal profile does not match for agent '${projection.agentId}'.`,
			);
		}
	}
}

export function deriveManagedAgentProjection(
	input: ManagedAgentProjectionInput,
): ManagedAgentProjection {
	return ManagedAgentProjectionSchema.parse({
		...input,
		profileAssignmentRevision: revision('profile-assignment', input),
	});
}

function deriveManagedAgentProjectionCohortDigest(
	agentProjections: readonly ManagedAgentProjection[],
): string {
	return revision('projection-cohort', {
		agentProjections: [...agentProjections].toSorted((leftProjection, rightProjection) =>
			leftProjection.agentId.localeCompare(rightProjection.agentId),
		),
	});
}

export function deriveGatewayRuntimePortalSemanticSnapshot(
	props: DeriveGatewayRuntimePortalSemanticSnapshotProps,
): GatewayRuntimePortalSemanticSnapshot {
	assertExactManagedAgentProjectionInputs({
		agentProjections: props.agentProjections,
		configuredAgents: props.toolPortalConfig.agents,
	});
	const projections = props.agentProjections
		.map((projection) => deriveManagedAgentProjection(projection))
		.toSorted((leftProjection, rightProjection) =>
			leftProjection.agentId.localeCompare(rightProjection.agentId),
		);
	const agentProjections = Object.fromEntries(
		projections.map((projection) => [projection.agentId, projection]),
	);
	const projectionCohortDigest = deriveManagedAgentProjectionCohortDigest(projections);
	const providerRevision = revision('provider', normalizedMcpProviders(props.mcpConfig.providers));
	const catalogRevision = revision(
		'catalog',
		normalizedCatalogInputs({
			mcpConfig: props.mcpConfig,
			toolPortalConfig: props.toolPortalConfig,
		}),
	);
	const profilePolicyRevision = revision(
		'profile-policy',
		normalizedProfilePolicyInputs({
			surfaceEligibilityByProfile: props.surfaceEligibilityByProfile,
			toolPortalConfig: props.toolPortalConfig,
		}),
	);
	const bindingRevision = revision('binding', normalizedBindingInputs(props.toolPortalConfig));
	const schemaRevision = revision('schema', {
		mcpConfigSchemaVersion: props.mcpConfig.schemaVersion,
		toolPortalConfigSchemaVersion: props.toolPortalConfig.schemaVersion,
	});
	const desiredRevision = revision('portal-admission', {
		agentProjections,
		bindingRevision,
		catalogRevision,
		profilePolicyRevision,
		projectionCohortDigest,
		providerRevision,
		schemaRevision,
		surfaceEligibilityByProfile: normalizedSurfaceEligibility(props.surfaceEligibilityByProfile),
	});
	return GatewayRuntimePortalSemanticSnapshotSchema.parse({
		activeRevision: desiredRevision,
		agentProjections,
		bindingRevision,
		catalogRevision,
		desiredRevision,
		profilePolicyRevision,
		projectionCohortDigest,
		providerRevision,
		schemaRevision,
		schemaVersion: 1,
		surfaceEligibilityByProfile: normalizedSurfaceEligibility(props.surfaceEligibilityByProfile),
	});
}

export function assertGatewayRuntimePortalSemanticSnapshotMatchesInputs(
	props: AssertGatewayRuntimePortalSemanticSnapshotMatchesInputsProps,
): void {
	const expectedSnapshot = deriveGatewayRuntimePortalSemanticSnapshot({
		agentProjections: Object.values(props.semanticSnapshot.agentProjections).map((projection) => ({
			agentId: projection.agentId,
			frameworkIdentity: projection.frameworkIdentity,
			toolPortalProfileId: projection.toolPortalProfileId,
		})),
		mcpConfig: props.mcpConfig,
		surfaceEligibilityByProfile: props.semanticSnapshot.surfaceEligibilityByProfile,
		toolPortalConfig: props.toolPortalConfig,
	});
	if (canonicalJson(expectedSnapshot) !== canonicalJson(props.semanticSnapshot)) {
		throw new Error(
			'Gateway runtime semantic snapshot does not match the protected Tool Portal and MCP inputs.',
		);
	}
}
