import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { mcpConfigSchema, type McpConfig } from '@agent-collaboration/tool-access/contracts';
import type {
	GatewayRuntimeAttachmentMetadata,
	GatewayRuntimeClientTrustedInvocationContext,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import {
	createGatewayRuntimeManagedToolPortalConfig,
	effectiveManagedToolPortalConfigSchema,
} from '@agent-vm/config-contracts';
import {
	deriveGatewayRuntimeInputRevision,
	deriveGatewayRuntimePortalSemanticSnapshot,
} from '@agent-vm/gateway-control-contracts';

import type { GatewayRuntimeServiceConfig } from '#gateway-runtime/production/gateway-runtime-service-config';
export async function createCutoverServiceConfig(
	options: {
		readonly mcpConfig?: McpConfig;
		readonly mcpOnly?: boolean;
		readonly mcpAllowedTools?: readonly string[];
		readonly includeControllerExecution?: boolean;
		readonly includeMcpProvider?: boolean;
		readonly includeProcessLogs?: boolean;
		readonly verifierPublicKeyPem?: string;
	} = {},
): Promise<GatewayRuntimeServiceConfig> {
	const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'gr-'));
	const runtimeRoot = temporaryRoot;
	const mcpConfig = mcpConfigSchema.parse(options.mcpConfig ?? { providers: {}, schemaVersion: 1 });
	const toolPortalConfig = effectiveManagedToolPortalConfigSchema.parse({
		agents: {
			'agent-a': { profile: 'profile-a' },
			'agent-b': { profile: 'profile-b' },
		},
		mode: 'managed',
		profiles: {
			'profile-a': {
				namespaces: {
					...(options.includeControllerExecution === true
						? {
								controller: {
									discovery: {},
									backend: {
										kind: 'controller_execution' as const,
										operations: {
											controller_host_probe: { kind: 'registered_action' as const },
											workspace_git_push: { kind: 'registered_action' as const },
										},
									},
									calls: {
										requiresApproval: { allow: [], deny: [] },
										withoutApproval: { allow: ['workspace_git_push'], deny: [] },
									},
									tools: { allow: ['workspace_git_push'], deny: [] },
								},
							}
						: {}),
					...(options.includeMcpProvider === true
						? {
								github: {
									backend: { kind: 'mcp_provider' as const },
									calls: {
										requiresApproval: { allow: [], deny: [] },
										withoutApproval: { allow: options.mcpAllowedTools ?? ['read_thing'], deny: [] },
									},
									discovery: {},
									tools: { allow: options.mcpAllowedTools ?? ['read_thing'], deny: [] },
								},
							}
						: {}),
					sandbox: {
						discovery: {},
						backend: {
							kind: 'tool_vm_runner',
							operations: {
								exec: {
									description: 'Run the fixture command.',
									executable: '/usr/bin/true',
									kind: 'command.fixed',
									mandatoryArgvPrefix: [],
									workingDirectory: '.',
								},
								...(options.includeProcessLogs === true
									? {
											logs: {
												description: 'Read process logs.',
												kind: 'process.logs' as const,
											},
										}
									: {}),
							},
							profile: 'sandbox_ssh',
						},
						calls: {
							requiresApproval: { allow: [], deny: [] },
							withoutApproval: { allow: ['exec'], deny: [] },
						},
						tools: { allow: ['exec'], deny: [] },
					},
				},
			},
			'profile-b': { namespaces: {} },
		},
		schemaVersion: 1,
	});
	if (options.mcpOnly === true) {
		const profile = toolPortalConfig.profiles['profile-a'];
		if (profile !== undefined) delete profile.namespaces.sandbox;
	}
	const derivedSnapshot = deriveGatewayRuntimePortalSemanticSnapshot({
		agentProjections: [
			{
				agentId: 'agent-a',
				frameworkIdentity: { kind: 'hermes', profileName: 'agent-a-profile' },
				toolPortalNamespaces: [
					...(options.includeControllerExecution === true ? [{ namespace: 'controller' }] : []),
					...(options.includeMcpProvider === true ? [{ namespace: 'github' }] : []),
					...(options.mcpOnly === true ? [] : [{ namespace: 'sandbox' }]),
				],
				toolPortalProfileId: 'profile-a',
			},
			{
				agentId: 'agent-b',
				frameworkIdentity: { kind: 'hermes', profileName: 'agent-b-profile' },
				toolPortalNamespaces: [],
				toolPortalProfileId: 'profile-b',
			},
		],
		mcpConfig,
		surfaceEligibilityByProfile: {
			'profile-a': {
				...(options.includeControllerExecution === true
					? { controller: ['protected_uds'] as const }
					: {}),
				...(options.includeMcpProvider === true ? { github: ['protected_uds'] as const } : {}),
				sandbox: ['protected_uds'],
			},
			'profile-b': {},
		},
		toolPortalConfig,
	});
	const semanticSnapshot = {
		...derivedSnapshot,
		activeRevision: 's4a-oracle-active',
		desiredRevision: 's4a-oracle-active',
		bindingRevision: 's4a-oracle-binding',
		catalogRevision: 's4a-oracle-catalog',
		profilePolicyRevision: 's4a-oracle-policy',
		providerRevision: 's4a-oracle-provider',
		schemaRevision: 's4a-oracle-schema',
		agentProjections: Object.fromEntries(
			Object.entries(derivedSnapshot.agentProjections).map(([id, projection]) => [
				id,
				{ ...projection, profileAssignmentRevision: `s4a-assignment:${id}` },
			]),
		),
	};

	await writeFile(path.join(temporaryRoot, 'placeholder'), 'preserve');
	await writeFile(path.join(temporaryRoot, 'mcp.config.json'), JSON.stringify(mcpConfig), {
		mode: 0o600,
	});
	const defaultVerifierPublicKey = generateKeyPairSync('ed25519').publicKey.export({
		format: 'pem',
		type: 'spki',
	});
	const gatewayRuntimeToolPortalConfig =
		createGatewayRuntimeManagedToolPortalConfig(toolPortalConfig);
	return {
		artifactLimits: {
			maximumArtifactBytes: 1_024,
			maximumArtifactCount: 8,
			maximumLifetimeMs: 60_000,
			maximumTotalBytes: 8_192,
		},
		attachment: {
			attachmentGeneration: 1,
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds: ['agent-a', 'agent-b'],
			frameworkEpoch: 'framework-epoch-1',
			gatewayEpoch: 'gateway-epoch-1',
			projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
			runtimeEpoch: 'runtime-epoch-1',
		},
		controlEndpoint: {
			authority: {
				callerContextAgentAuthorityKeys: {
					'agent-a': 'agent-a-authority-key',
					'agent-b': 'agent-b-authority-key',
				},
				callerContextProofKey: 'caller-context-proof-key',
				verifierPublicKeyPem: options.verifierPublicKeyPem ?? defaultVerifierPublicKey,
			},
			identity: {
				bootId: 'boot-1',
				controllerEpoch: 'controller-epoch-1',
				generationId: 'generation-1',
				peerId: 'peer-1',
				processEpoch: 'process-epoch-1',
				zoneId: 'zone-a',
			},
			listen: { host: '127.0.0.1', port: 0 },
		},
		gatewayRuntimeInputRevision: deriveGatewayRuntimeInputRevision({
			mcpConfig,
			toolPortalConfig: gatewayRuntimeToolPortalConfig,
		}),
		mcpConfigPath: path.join(temporaryRoot, 'mcp.config.json'),
		observability: { kind: 'disabled' },
		runtimeRoot,
		schemaVersion: 1,
		semanticSnapshot,
		serviceIdentity: {
			processEpoch: 'process-epoch-1',
			role: 'tool-portal',
			serviceId: 'tool-portal-zone-a',
		},
		toolPortalConfig: gatewayRuntimeToolPortalConfig,
	};
}

export function attachmentForConfig(
	config: GatewayRuntimeServiceConfig,
): GatewayRuntimeAttachmentMetadata {
	return {
		...config.attachment,
		protocolVersion: 1,
		schemaVersion: 1,
	};
}

export function cutoverTrustedContext(
	config: GatewayRuntimeServiceConfig,
): GatewayRuntimeClientTrustedInvocationContext {
	const projection = config.semanticSnapshot.agentProjections['agent-a'];
	if (projection === undefined) throw new Error('Missing agent-a semantic projection.');
	return {
		correlation: {
			runId: 'run-a',
			sessionId: 'session-a',
			toolCallId: 'tool-call-a',
			turnId: 'turn-a',
		},
		principal: {
			agentId: 'agent-a',
			frameworkIdentity: projection.frameworkIdentity,
			profileAssignmentRevision: projection.profileAssignmentRevision,
			toolPortalProfileId: projection.toolPortalProfileId,
		},
		requester: { authenticatedSubjectId: 'subject-a' },
	};
}

export const cutoverPortalRequests = {
	list: { requests: [{ id: 'list', limit: 20, namespaces: ['github'] }] },
	search: {
		requests: [
			{
				id: 'search',
				limit: 20,
				namespaces: ['github'],
				query: 'thing',
				schemaDetail: 'summary' as const,
			},
		],
	},
	describe: {
		requests: [
			{
				id: 'describe',
				includeJsonSchema: true,
				includeRelated: false,
				includeTypescriptHelper: true,
				includeZod: false,
				tools: [{ namespace: 'github', name: 'read_thing' }],
			},
		],
	},
	call: {
		calls: [
			{
				id: 'allowed',
				namespace: 'github',
				name: 'read_thing',
				arguments: { title: 'fixed baseline' },
			},
			{ id: 'hidden', namespace: 'github', name: 'write_thing', arguments: { title: 'hidden' } },
			{ id: 'guessed', namespace: 'github', name: 'guessed_thing', arguments: { title: 'guess' } },
		],
	},
} as const;
