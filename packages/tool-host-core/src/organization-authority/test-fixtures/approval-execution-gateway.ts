import { createPortalAgentIdentity } from '@agent-collaboration/tool-access/authorization';
import { assessAccessInput } from '@agent-collaboration/tool-access/contracts';
import type {
	BackendKind,
	OperationPort,
	OperationRecord,
	ToolBackend,
} from '@agent-collaboration/tool-engine/capability-dispatch';
import {
	createAgentCatalogViewCache,
	createMcpGateway,
	type ConsumeApprovalTokenId,
	type McpGateway,
} from '@agent-collaboration/tool-engine/mcp-gateway';

/** Real gateway/dispatcher, with an effect-counting provider and an in-memory operation ledger. */
export function createApprovalExecutionGateway(props: {
	readonly key: Uint8Array;
	readonly consumeTokenId: ConsumeApprovalTokenId;
	readonly nowMs: () => number;
}): { readonly gateway: McpGateway; readonly effects: unknown[] } {
	const effects: unknown[] = [];
	const records = new Map<string, OperationRecord>();
	const revision = { owner: 'fixture-configuration', revision: 'v1' };
	const operations: OperationPort = {
		createOrRead: async ({ invocation }) => {
			const key = JSON.stringify(invocation.operationKey);
			const old = records.get(key);
			if (old !== undefined)
				return old.intentDigest === invocation.intentDigest
					? { kind: 'existing', record: old }
					: { kind: 'conflict' };
			const timestamp = new Date(props.nowMs()).toISOString();
			const record: OperationRecord = {
				version: 'tool-operation-v1',
				key: invocation.operationKey,
				intentDigest: invocation.intentDigest,
				createdAt: timestamp,
				updatedAt: timestamp,
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
	const backend: ToolBackend<BackendKind> = {
		backendKind: 'mcp_provider',
		list: async () => ({}),
		describe: async () => ({}),
		search: async () => ({}),
		invoke: async (invocation) => {
			effects.push(invocation.arguments);
			return { kind: 'completed', result: { accepted: true } };
		},
	};
	const sessions = createAgentCatalogViewCache({
		accessPolicy: {
			enabledNamespaces: ['fixture'],
			enabledNamespacesByAgent: {},
			hiddenToolsByAgent: {},
		},
		catalogTtlMs: 60000,
		upstreamNamespaces: ['fixture'],
		runtime: {
			closeAgentScope: () => {},
			listTools: async () => [
				{
					name: 'protected-call',
					inputSchema: {
						type: 'object',
						properties: { value: { type: 'integer' } },
						required: ['value'],
						additionalProperties: false,
					},
				},
			],
		},
	});
	return {
		effects,
		gateway: createMcpGateway({
			caller: {
				identity: createPortalAgentIdentity({
					agentId: 'agent-a',
					agentScopeId: 'scope-a',
					source: 'mcp-proxy-bearer',
				}),
				authority: 'fixture-organization',
				principal: 'agent-a',
				verifiedContextRef: 'fixture-verified-agent',
			},
			hostBinding: { workspaceLayer: 'not-configured', config: revision },
			sessions,
			operations,
			approvals: {
				challenge: async () => ({ kind: 'denied' }),
				decision: async () => ({ kind: 'denied' }),
				receipt: async () => ({ kind: 'denied' }),
			},
			approvalTokens: { key: props.key, consumeTokenId: props.consumeTokenId },
			backends: new Map([['mcp_provider', backend]]),
			now: props.nowMs,
			prepareCatalog: async (catalog) => catalog,
			resolveAccess: async ({ capability, call }) =>
				assessAccessInput.parse({
					capability,
					call,
					surface: 'mcp',
					facts: {
						workspace: { kind: 'not-configured' },
						assignment: {
							profileRevision: revision,
							revision,
							profile: {
								profileId: 'fixture-profile',
								namespaces: {
									fixture: {
										backendKind: 'mcp_provider',
										tools: { allow: '*', deny: [] },
										calls: {
											kind: 'selectors',
											withoutApproval: { allow: [], deny: [] },
											requiresApproval: { allow: '*', deny: [] },
										},
										operations: {},
									},
								},
							},
						},
						surface: { eligible: ['mcp'], snapshot: revision },
						accounts: [],
						upstream: { status: 'available', credentialNeed: 'none', binding: revision },
					},
				}),
		}),
	};
}
