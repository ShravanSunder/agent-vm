import { createPortalAgentIdentity } from '@agent-collaboration/tool-access/authorization';
import {
	type AssessAccessInput,
	assessAccessInput,
} from '@agent-collaboration/tool-access/contracts';
import type {
	DispatchInvocation,
	ResourceResult,
	OperationRecord,
	OperationPort,
	ApprovalPort,
	ToolBackend,
	BackendKind,
} from '@agent-collaboration/tool-engine/dispatch';
import { z } from 'zod';

import { createAgentCatalogViewCache } from '#mcp-gateway/agent-catalog-views/agent-catalog-view-cache';
import type { GatewayApprovalTokens } from '#mcp-gateway/call-approvals/models/call-approval';
import {
	type McpGateway,
	type PreparedGatewayCatalog,
	createMcpGateway,
} from '#mcp-gateway/mcp-gateway';
import type { PortalBatchResult } from '#mcp-gateway/portal-tools/models/portal-tool-contracts';

export const revision = { owner: 'fixture-authority', revision: 'v1' };

export const frozenNames = [
	'alpha__ask__645775a667',
	'alpha__read__151160dc30',
	'beta__ask__7e2e2be604',
	'beta__read__08da93d672',
];

export const inputSchema = {
	type: 'object' as const,
	properties: { value: { type: 'integer' } },
	required: ['value'],
	additionalProperties: false,
};

interface GatewayTestHarness {
	gateway: McpGateway;
	effects: DispatchInvocation[];
	inputDigests: string[];
	setDenyRead: () => void;
	changeBinding: () => void;
	changeDuringAdmission: () => void;
	setPrepared: (transform: (catalog: PreparedGatewayCatalog) => PreparedGatewayCatalog) => void;
	setResult: (result: ResourceResult) => void;
}

export function retainCatalog(catalog: PreparedGatewayCatalog): PreparedGatewayCatalog {
	return catalog;
}

export function createHarness(
	throwAt?: 'access' | 'backend' | 'backend-after-effect',
	discovery: 'complete' | 'incomplete' | 'duplicate' = 'complete',
	options: {
		readonly approvalTokens?: GatewayApprovalTokens;
		readonly toolDescription?: string;
	} = {},
): GatewayTestHarness {
	const effects: DispatchInvocation[] = [];
	const inputDigests: string[] = [];
	let binding = revision;
	let denyRead = false;
	let changeDuringAdmission = false;
	let preparedTransform = retainCatalog;
	let backendResult: ResourceResult = { kind: 'completed', result: { value: 42 } };
	const records = new Map<string, OperationRecord>();
	const operations: OperationPort = {
		createOrRead: async ({ invocation }) => {
			const key = JSON.stringify(invocation.operationKey);
			const old = records.get(key);
			if (old !== undefined)
				return old.intentDigest === invocation.intentDigest
					? { kind: 'existing', record: old }
					: { kind: 'conflict' };
			const record: OperationRecord = {
				version: 'tool-operation-v1',
				key: invocation.operationKey,
				intentDigest: invocation.intentDigest,
				createdAt: '2026-10-20T00:00:00.000Z',
				updatedAt: '2026-10-20T00:00:00.000Z',
				revision: '1',
				state: { kind: 'ready' },
			};
			records.set(key, record);
			return { kind: 'created', record };
		},
		lookup: async () => ({ kind: 'not-found' }),
		transition: async ({ invocation, expectedRevision, next }) => {
			const key = JSON.stringify(invocation.operationKey);
			const old = records.get(key);
			if (old === undefined || old.revision !== expectedRevision) return { kind: 'conflict' };
			const record = { ...old, revision: String(Number(old.revision) + 1), state: next };
			records.set(key, record);
			return { kind: 'found', record };
		},
	};
	const approvals: ApprovalPort = {
		challenge: async (invocation) => ({
			kind: 'pending',
			challenge: {
				authority: invocation.authority,
				approvalId: 'approval:1',
				operationKey: invocation.operationKey,
				intentDigest: invocation.intentDigest,
				callerDisplay: 'Agent A',
				targetDisplay: 'test provider',
				revisions: invocation.admissionRevisions,
				expiresAt: '2026-10-21T00:00:00.000Z',
				permittedDecisions: ['approve', 'deny'],
			},
		}),
		decision: async () => ({ kind: 'denied' }),
		receipt: async () => ({ kind: 'denied' }),
	};
	const backend: ToolBackend<BackendKind> = {
		backendKind: 'mcp_provider',
		list: async () => ({}),
		describe: async () => ({}),
		search: async () => ({}),
		invoke: async (invocation) => {
			if (invocation.arguments.value === 43 && throwAt === 'backend')
				throw new Error('provider failure');
			effects.push(invocation);
			if (invocation.arguments.value === 43 && throwAt === 'backend-after-effect')
				throw new Error('provider reply lost');
			return backendResult;
		},
	};
	const identity = createPortalAgentIdentity({
		agentId: 'agent-a',
		agentScopeId: 'scope-a',
		source: 'mcp-proxy-bearer',
	});
	const sessions = createAgentCatalogViewCache({
		accessPolicy: {
			enabledNamespaces: ['alpha', 'beta'],
			enabledNamespacesByAgent: {},
			hiddenToolsByAgent: {
				'agent-a': [
					{ namespace: 'alpha', toolName: 'hidden' },
					{ namespace: 'beta', toolName: 'hidden' },
				],
			},
		},
		catalogTtlMs: 60000,
		skills: [
			{ title: 'workflow-only-marker', toolRefs: ['mcp:YWxwaGE:cmVhZA', 'mcp:YWxwaGE:aGlkZGVu'] },
		],
		runtime: {
			closeAgentScope: () => {},
			listTools: async ({ namespace }) => {
				if (discovery === 'incomplete' && namespace === 'beta')
					throw new Error('beta discovery unavailable');
				const names =
					discovery === 'duplicate' ? ['read', 'read'] : ['read', 'ask', 'denied', 'hidden'];
				const description =
					options.toolDescription === undefined ? {} : { description: options.toolDescription };
				return names.map((name) =>
					Object.assign(
						{
							name,
							inputSchema,
							outputSchema: {
								type: 'object' as const,
								properties: { result: { type: 'integer' } },
							},
							annotations: { readOnlyHint: true, category: { label: 'original' } },
						},
						description,
					),
				);
			},
		},
		upstreamNamespaces: ['alpha', 'beta'],
	});
	const gateway = createMcpGateway({
		caller: {
			identity,
			authority: 'authority',
			principal: 'agent-a',
			verifiedContextRef: 'verified-a',
		},
		hostBinding: { workspaceLayer: 'not-configured', config: revision },
		sessions,
		operations,
		approvals,
		...(options.approvalTokens === undefined ? {} : { approvalTokens: options.approvalTokens }),
		backends: new Map([['mcp_provider', backend]]),
		now: () => 0,
		prepareCatalog: async (catalog) => preparedTransform(catalog),
		resolveAccess: async ({ capability, call }): Promise<AssessAccessInput> => {
			if (call !== null) {
				if (
					throwAt === 'access' &&
					typeof call.arguments === 'object' &&
					call.arguments !== null &&
					!Array.isArray(call.arguments) &&
					call.arguments.value === 43
				)
					throw new Error('access facts unavailable');
				inputDigests.push(call.digest);
				if (changeDuringAdmission) binding = { ...revision, revision: 'v2' };
			}
			return assessAccessInput.parse({
				capability,
				call,
				surface: 'mcp',
				facts: {
					workspace: { kind: 'not-configured' },
					assignment: {
						profileRevision: revision,
						revision,
						profile: {
							profileId: 'profile-a',
							namespaces: Object.fromEntries(
								['alpha', 'beta'].map((namespace) => [
									namespace,
									{
										backendKind: 'mcp_provider',
										tools: { allow: '*', deny: ['denied', ...(denyRead ? ['read'] : [])] },
										calls: {
											kind: 'selectors',
											withoutApproval: { allow: ['read'], deny: [] },
											requiresApproval: { allow: ['ask'], deny: [] },
										},
										operations: {},
									},
								]),
							),
						},
					},
					surface: { eligible: ['mcp'], snapshot: revision },
					accounts: [],
					upstream: { status: 'available', credentialNeed: 'none', binding },
				},
			});
		},
	});
	return {
		gateway,
		effects,
		inputDigests,
		setDenyRead: () => {
			denyRead = true;
		},
		changeBinding: () => {
			binding = { ...revision, revision: 'v2' };
		},
		changeDuringAdmission: () => {
			changeDuringAdmission = true;
		},
		setPrepared: (transform: typeof preparedTransform) => {
			preparedTransform = transform;
		},
		setResult: (result: ResourceResult) => {
			backendResult = result;
		},
	};
}

export function callInput(
	toolName = 'read',
	id = 'original-item',
	args: unknown = { value: 42 },
): unknown {
	return { calls: [{ id, namespace: 'alpha', toolName, arguments: args }] };
}

export function output(result: PortalBatchResult, id: string): Readonly<Record<string, unknown>> {
	const value = result.results[id];
	if (value === undefined || !value.ok) throw new Error(JSON.stringify(result));
	return value.output;
}

export function identities(value: unknown): readonly string[] {
	return z
		.object({ tools: z.array(z.object({ namespace: z.string(), toolName: z.string() })) })
		.parse(value)
		.tools.map((tool) => `${tool.namespace}.${tool.toolName}`);
}
