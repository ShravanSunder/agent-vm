import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
	createPortalAgentIdentity,
	portalAgentScopeKey,
} from '@agent-collaboration/tool-access/authorization';
import {
	assessAccessInput,
	hashCallArguments,
	type PortalArtifactReadRequest,
	type JsonObject,
	type PortalCallRequest,
} from '@agent-collaboration/tool-access/contracts';
import { createUpstreamMcpClientRuntime } from '@agent-collaboration/tool-engine/connectors';
import {
	createOrganizationToolCatalog,
	createPortalSessionManager,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import { ToolSchema } from '@modelcontextprotocol/core';

import {
	NodeHostAuthenticatedEnvelopeSchema,
	type NodeHostBearerCredentialSet,
} from '#node-host/ingress/bearer-credentials';
import {
	createStandaloneToolPortalApprovalCoordinator,
	type StandaloneToolPortalApprovalBatchIntent,
} from '#node-host/standalone/standalone-batch-approval';
import {
	deriveStandaloneOperationId,
	type StandaloneSemanticRevisions,
} from '#node-host/standalone/standalone-dispatch-identity';
import { createStandaloneMcpProviderBackend } from '#node-host/standalone/standalone-mcp-provider';
import type { StandaloneToolPortalArtifactReader } from '#node-host/standalone/standalone-portal-contracts';
import { createNodeStandaloneToolPortalService } from '#node-host/standalone/standalone-service-adapter';
import {
	headerCanary,
	secretCanary,
	type ControlledProvider,
} from '#node-host/test-fixtures/node-host-fixture';
import { createNodeHttpUpstreamTransport } from '#node-host/upstream/node-upstream-transports';

export const standaloneKey = 'standalone-fixture-signing-key';
export const standaloneRevision = { owner: 'standalone-fixture', revision: '1' };
export const standaloneSemanticRevisions = {
	activeRevision: 'semantic:1',
	bindingRevision: 'binding:1',
	catalogRevision: 'catalog:1',
	profilePolicyRevision: 'profile:1',
	providerRevision: 'provider:1',
	schemaRevision: 'schema:1',
};
export const standaloneCredentials: NodeHostBearerCredentialSet = {
	audience: 'tool-portal:mcp',
	serviceGeneration: 'standalone-process:1',
	credentials: ['agent-a', 'agent-b'].map((agentId) => ({
		bearerToken: `credential-${agentId}`,
		credentialVersion: 1,
		principal: {
			agentId,
			toolPortalProfileId: 'builder',
			profileAssignmentRevision: 'assignment:1',
		},
	})),
};

export async function createStandaloneHostFixture(
	provider: Pick<ControlledProvider, 'url'>,
	namespace = 'example',
	semanticRevisions: StandaloneSemanticRevisions = standaloneSemanticRevisions,
	getCredentialSet: () => NodeHostBearerCredentialSet = () => standaloneCredentials,
	projectAccessArguments: (argumentsValue: JsonObject) => JsonObject = (value) => value,
): Promise<{
	readonly service: ReturnType<typeof createNodeStandaloneToolPortalService>;
	readonly artifactReader: StandaloneToolPortalArtifactReader;
	readonly coordinator: ReturnType<typeof createStandaloneToolPortalApprovalCoordinator>;
	readonly approvalIntents: StandaloneToolPortalApprovalBatchIntent[];
	readonly reference: PortalArtifactReadRequest['reference'];
	readonly artifactBytes: Buffer;
	readonly now: () => number;
	readonly setNow: (timestamp: number) => void;
	readonly close: () => Promise<void>;
}> {
	let timestamp = Date.parse('2026-10-21T00:00:00.000Z');
	const now = (): number => timestamp;
	const runtime = createUpstreamMcpClientRuntime({
		servers: [{ namespace, transport: 'streamable-http', url: provider.url }],
		additionalRedactionValues: [secretCanary, headerCanary],
		createUpstreamMcpTransport: createNodeHttpUpstreamTransport,
	});
	const scopes = new Set<string>(['standalone-startup']);
	const catalog = createOrganizationToolCatalog({
		namespaces: [namespace],
		runtime: {
			...runtime,
			listTools: async (request) =>
				(await runtime.listTools(request)).map((tool) => ToolSchema.parse(tool)),
		},
		discoveryScope: 'standalone-startup',
		catalogTtlMs: 60_000,
		now,
	});
	await catalog.read();
	const sessions = createPortalSessionManager({
		accessPolicy: {
			enabledNamespaces: [namespace],
			enabledNamespacesByAgent: {},
			hiddenToolsByAgent: Object.fromEntries(
				['agent-a', 'agent-b'].map((agent) => [
					agent,
					[
						{ namespace, toolName: 'hidden' },
						{ namespace, toolName: 'blocked' },
					],
				]),
			),
		},
		upstreamNamespaces: [namespace],
		catalogTtlMs: 60_000,
		organizationCatalog: catalog,
		runtime: {
			...runtime,
			listTools: async (request) =>
				(await runtime.listTools(request)).map((tool) => ToolSchema.parse(tool)),
		},
		now,
	});
	const coordinator = createStandaloneToolPortalApprovalCoordinator({
		credentials: getCredentialSet().credentials.map(({ principal }) => ({
			agentId: principal.agentId,
			hmacKey: standaloneKey,
			keyVersion: 1,
		})),
		serviceGeneration: getCredentialSet().serviceGeneration,
		now: () => new Date(now()),
	});
	const approvalIntents: StandaloneToolPortalApprovalBatchIntent[] = [];
	const observedCoordinator = {
		...coordinator,
		reserveDispatch: (intent: StandaloneToolPortalApprovalBatchIntent, token?: string) => {
			approvalIntents.push(intent);
			return coordinator.reserveDispatch(intent, token);
		},
	};
	const artifactBytes = Buffer.from([0, 255, 10, 13, 127, 65, 66, 67]);
	const reference = {
		id: 'binary-artifact',
		byteLength: artifactBytes.length,
		expiresAt: new Date(now() + 60_000).toISOString(),
		fingerprint: `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`,
		mediaType: 'application/octet-stream',
	};
	let artifactOwner: string | undefined;
	const artifactReader: StandaloneToolPortalArtifactReader = {
		read: async ({ caller, request }) => {
			if (
				caller.authenticatedEnvelope.principal.agentId !== artifactOwner ||
				!isDeepStrictEqual(request.reference, reference) ||
				Date.parse(reference.expiresAt) <= now() ||
				request.offsetBytes > artifactBytes.length
			)
				throw new Error('Artifact unavailable.');
			const bytes = artifactBytes.subarray(
				request.offsetBytes,
				request.offsetBytes + request.maxBytes,
			);
			return {
				reference,
				contentBase64: bytes.toString('base64'),
				mediaType: reference.mediaType,
				offsetBytes: request.offsetBytes,
				truncated: request.offsetBytes + bytes.length < artifactBytes.length,
			};
		},
	};
	const service = createNodeStandaloneToolPortalService({
		binding: { workspaceLayer: 'not-configured', config: standaloneRevision },
		now,
		approvalCoordinator: observedCoordinator,
		resolveInvocation: async (options) => {
			const envelope = NodeHostAuthenticatedEnvelopeSchema.parse(options.authenticatedEnvelope);
			const credential = getCredentialSet().credentials.find(
				(entry) =>
					entry.principal.agentId === envelope.principal.agentId &&
					entry.credentialVersion === envelope.principal.credentialVersion &&
					entry.principal.toolPortalProfileId === envelope.principal.toolPortalProfileId &&
					entry.principal.profileAssignmentRevision ===
						envelope.principal.profileAssignmentRevision,
			);
			if (
				credential === undefined ||
				envelope.serviceGeneration !== getCredentialSet().serviceGeneration
			)
				throw new Error('Unknown standalone caller.');
			const identity = createPortalAgentIdentity({
				agentId: credential.principal.agentId,
				agentScopeId: credential.principal.agentId,
				source: 'mcp-proxy-bearer',
			});
			scopes.add(portalAgentScopeKey(identity));
			const session = await sessions.getSession(identity);
			const names = session.catalog.tools.map((tool) => tool.toolName);
			const principal = [
				'standalone-v1',
				envelope.principal.agentId,
				envelope.principal.toolPortalProfileId,
				envelope.principal.profileAssignmentRevision,
				envelope.principal.credentialVersion,
			].join('\0');
			const providerBackend = createStandaloneMcpProviderBackend({
				identity,
				runtime,
				getSession: async () => sessions.getSession(identity),
				owningGeneration: 'controlled-resource-generation',
			});
			const accessForCall = async (
				call: PortalCallRequest['calls'][number],
			): Promise<ReturnType<typeof assessAccessInput.parse>> =>
				assessAccessInput.parse({
					capability: { namespace: call.namespace, tool: call.name },
					call: {
						arguments: projectAccessArguments(call.arguments),
						account: null,
						digest: Buffer.from(
							(await hashCallArguments(call.arguments)).replaceAll('-', '+').replaceAll('_', '/'),
							'base64',
						).toString('hex'),
					},
					surface: 'mcp',
					facts: {
						workspace: { kind: 'not-configured' },
						assignment: {
							profileRevision: standaloneRevision,
							revision: standaloneRevision,
							profile: {
								profileId: 'builder',
								namespaces: {
									[namespace]: {
										backendKind: 'mcp_provider',
										tools: { allow: names, deny: ['hidden', 'blocked'] },
										calls: {
											kind: 'selectors',
											withoutApproval: { allow: names.filter((name) => name !== 'ask'), deny: [] },
											requiresApproval: { allow: ['ask'], deny: [] },
										},
										operations: {},
									},
								},
							},
						},
						surface: { eligible: ['mcp'], snapshot: standaloneRevision },
						accounts: [],
						upstream: { status: 'available', credentialNeed: 'none', binding: standaloneRevision },
					},
				});
			return {
				authority: 'standalone-fixture',
				principal,
				verifiedContextRef: `${envelope.serviceGeneration}:${credential.principal.agentId}`,
				owningGeneration: semanticRevisions.activeRevision,
				correlation: {},
				readOptions: options,
				semanticRevisions,
				entries: [
					{
						backend: providerBackend.discovery,
						namespaces: new Set([namespace]),
						namespaceDiscovery: [{ namespace, summary: 'Controlled provider tools.' }],
						capabilityMetadata: ({ name }) => ({
							callDisposition: { kind: name === 'ask' ? 'requires-approval' : 'without-approval' },
						}),
					},
				],
				accessForCall,
				operationId: (callId) =>
					deriveStandaloneOperationId({
						callId,
						semanticRevision: semanticRevisions.activeRevision,
						stablePrincipal: principal,
						surfaceClass: options.surfaceClass,
					}),
				invoke: async ({ call, invocation, options: invokeOptions }) => {
					const result = await providerBackend.invoke(
						call,
						invocation.operationKey.item,
						invokeOptions,
					);
					if (call.name === 'binary' && result.status === 'ok') {
						artifactOwner = envelope.principal.agentId;
						return { ...result, artifacts: [reference] };
					}
					return result;
				},
			};
		},
	});
	return {
		service,
		artifactReader,
		coordinator,
		approvalIntents,
		reference,
		artifactBytes,
		now,
		setNow: (value) => {
			timestamp = value;
		},
		close: async () => {
			await Promise.all([...scopes].map(async (scope) => runtime.closeSession(scope)));
		},
	};
}
