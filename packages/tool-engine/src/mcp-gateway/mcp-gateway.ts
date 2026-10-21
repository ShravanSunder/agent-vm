import {
	type PortalAgentIdentity,
	createAccessAssessor,
	portalAgentScopeKey,
} from '@agent-collaboration/tool-access/authorization';
import {
	type AssessAccessInput,
	type HostAccessBinding,
	type JsonObject,
	assessAccessInput,
	hashCallArguments,
} from '@agent-collaboration/tool-access/contracts';
import {
	type OperationPort,
	type ApprovalPort,
	type BackendKind,
	type ToolBackend,
	type ResourceResult,
	createCapabilityDispatcher,
} from '@agent-collaboration/tool-engine/dispatch';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { PortalCatalogPreparationError } from '#mcp-gateway/agent-catalog-views/agent-catalog-view-cache';
import { createCatalogToolPresentationName } from '#mcp-gateway/agent-catalog-views/catalog-tool-presentation-name';
import type {
	AgentCatalogViewCache,
	AgentCatalogView,
} from '#mcp-gateway/agent-catalog-views/models/agent-catalog-view';
import {
	type McpToolListPage,
	paginateMcpTools,
} from '#mcp-gateway/agent-catalog-views/tool-list-pagination';
import type { McpToolMode } from '#mcp-gateway/agent-catalog-views/tool-loading';
import {
	approvedTokenPort,
	authorizeGatewayCalls,
} from '#mcp-gateway/call-approvals/gateway-call-approval';
import type {
	GatewayApprovalTokens,
	VerifiedCallApproval,
} from '#mcp-gateway/call-approvals/models/call-approval';
import type { PortalBatchResult } from '#mcp-gateway/portal-tools/models/portal-tool-contracts';
import { createPortalToolHandlers } from '#mcp-gateway/portal-tools/portal-tool-handlers';
import { listPortalCoreToolDescriptors } from '#mcp-gateway/tool-search/indirect-tool-descriptors';
import { createSearchIndex } from '#mcp-gateway/tool-search/search-index';
import { buildToolGraph } from '#mcp-gateway/tool-search/tool-graph';

export interface PreparedCatalogTool {
	readonly namespace: string;
	readonly toolName: string;
	readonly descriptor: Tool;
	readonly bindingRevision: AssessAccessInput['facts']['upstream']['binding'];
}

export interface PreparedGatewayCatalog {
	readonly agentScopeId: string;
	readonly sourceHash: string;
	readonly tools: readonly PreparedCatalogTool[];
}

export interface McpGatewayOptions {
	readonly caller: {
		readonly identity: PortalAgentIdentity;
		readonly authority: string;
		readonly principal: string;
		readonly verifiedContextRef: string;
	};
	readonly hostBinding: HostAccessBinding;
	readonly sessions: AgentCatalogViewCache;
	readonly resolveAccess: (input: {
		readonly capability: AssessAccessInput['capability'];
		readonly call: AssessAccessInput['call'];
	}) => Promise<AssessAccessInput>;
	readonly prepareCatalog: (input: PreparedGatewayCatalog) => Promise<PreparedGatewayCatalog>;
	readonly operations: OperationPort;
	readonly approvals: ApprovalPort;
	readonly approvalTokens?: GatewayApprovalTokens;
	readonly backends: ReadonlyMap<BackendKind, ToolBackend<BackendKind>>;
	readonly now: () => number;
}

export interface McpGateway {
	readonly listTools: (mode: McpToolMode, cursor?: string) => Promise<McpToolListPage>;
	readonly list: (input: unknown) => Promise<PortalBatchResult>;
	readonly search: (input: unknown) => Promise<PortalBatchResult>;
	readonly describe: (input: unknown) => Promise<PortalBatchResult>;
	readonly call: (input: unknown) => Promise<PortalBatchResult>;
	readonly callDirect: (input: {
		readonly name: string;
		readonly arguments: JsonObject;
		readonly item: string;
		readonly _meta?: JsonObject;
		readonly catalog: PreparedGatewayCatalog;
	}) => Promise<PortalBatchResult>;
	readonly prepareCatalog: () => Promise<PreparedGatewayCatalog>;
}

function sameRevision(
	left: PreparedCatalogTool['bindingRevision'],
	right: PreparedCatalogTool['bindingRevision'],
): boolean {
	return left.owner === right.owner && left.revision === right.revision;
}

function refused(): ResourceResult {
	return { kind: 'denied', state: { kind: 'not-usable', firstUnmet: 'not-given-to-agent' } };
}

function refusedBatch(): PortalBatchResult {
	return {
		ok: false,
		diagnostics: [],
		errors: [
			{
				kind: 'unknown_or_denied_tool',
				message: 'The requested tool is unknown or denied for this caller.',
			},
		],
		results: {},
	};
}

function requireCatalogBinding(
	bindings: ReadonlyMap<string, PreparedCatalogTool['bindingRevision']>,
	namespace: string,
	toolName: string,
): PreparedCatalogTool['bindingRevision'] {
	const binding = bindings.get(JSON.stringify([namespace, toolName]));
	if (binding === undefined) throw new Error('Missing assessed catalog binding');
	return binding;
}

function digestAsHex(base64url: string): string {
	return Array.from(atob(base64url.replaceAll('-', '+').replaceAll('_', '/')), (byte) =>
		byte.charCodeAt(0).toString(16).padStart(2, '0'),
	).join('');
}

/** A host binds one verified caller; protocol inputs never select that caller. */
export function createMcpGateway(options: McpGatewayOptions): McpGateway {
	const assessAccess = createAccessAssessor(options.hostBinding);
	const dispatcher = createCapabilityDispatcher({
		assessAccess,
		operations: options.operations,
		approvals: options.approvals,
		backends: options.backends,
		now: options.now,
	});
	const identity = options.caller.identity;
	async function accessFor(
		capability: AssessAccessInput['capability'],
		call: AssessAccessInput['call'],
	): Promise<AssessAccessInput> {
		const input = assessAccessInput.parse(await options.resolveAccess({ capability, call }));
		// The resolver supplies current facts and the selected account, never caller-controlled intent.
		return assessAccessInput.parse({
			...input,
			capability,
			surface: 'mcp',
			call: call === null ? null : { ...call, account: input.call?.account ?? null },
		});
	}
	async function visibleSession(): Promise<
		AgentCatalogView & {
			readonly bindings: ReadonlyMap<string, PreparedCatalogTool['bindingRevision']>;
		}
	> {
		const bindings = new Map<string, PreparedCatalogTool['bindingRevision']>();
		const session = await options.sessions.getView(identity);
		const selected = await Promise.all(
			session.catalog.tools.map(async (tool) => {
				try {
					const access = await accessFor({ namespace: tool.namespace, tool: tool.toolName }, null);
					const assessed = assessAccess(access);
					bindings.set(
						JSON.stringify([tool.namespace, tool.toolName]),
						access.facts.upstream.binding,
					);
					if (assessed.kind !== 'assessed') return [];
					const states =
						assessed.assessment.kind === 'fixed'
							? [assessed.assessment.state]
							: assessed.assessment.entries.map((entry) => entry.state);
					return states.some(
						(state) => state.kind === 'usable' || state.kind === 'approval-each-call',
					)
						? [tool]
						: [];
				} catch {
					return [];
				}
			}),
		);
		const tools = selected.flat();
		const graph = buildToolGraph({ tools, skills: session.graph.skills });
		return {
			...session,
			bindings,
			catalog: { ...session.catalog, tools },
			graph,
			searchIndex: createSearchIndex(tools, graph),
		};
	}
	async function dispatchCall(
		call: {
			readonly approval?: VerifiedCallApproval;
			readonly namespace: string;
			readonly toolName: string;
			readonly arguments: JsonObject;
			readonly requestId: string;
		},
		expectedBinding?: PreparedCatalogTool['bindingRevision'],
	): Promise<ResourceResult> {
		let enteredDispatcher = false;
		try {
			const digest = await hashCallArguments(call.arguments);
			const access = await accessFor(
				{ namespace: call.namespace, tool: call.toolName },
				{ arguments: call.arguments, account: null, digest: digestAsHex(digest) },
			);
			if (
				expectedBinding !== undefined &&
				!sameRevision(expectedBinding, access.facts.upstream.binding)
			)
				return refused();
			enteredDispatcher = true;
			const selectedDispatcher =
				call.approval === undefined
					? dispatcher
					: createCapabilityDispatcher({
							assessAccess,
							operations: options.operations,
							approvals: approvedTokenPort(call.approval),
							backends: options.backends,
							now: options.now,
						});
			return await selectedDispatcher.dispatch({
				authority: options.caller.authority,
				principal: options.caller.principal,
				item: call.requestId,
				verifiedContextRef: options.caller.verifiedContextRef,
				correlation: {},
				access,
			});
		} catch {
			return enteredDispatcher
				? { kind: 'ambiguous', reason: 'dispatch-unconfirmed' }
				: { kind: 'not-dispatched', reason: 'admission-failed' };
		}
	}
	const handlers = createPortalToolHandlers({ getView: visibleSession, dispatchCall });
	async function callBound(
		input: unknown,
		expectedBinding?: PreparedCatalogTool['bindingRevision'],
	): Promise<PortalBatchResult> {
		let session: Awaited<ReturnType<typeof visibleSession>> | undefined;
		const boundHandlers = createPortalToolHandlers({
			getView: async () => {
				session = await visibleSession();
				return session;
			},
			authorizeCalls: async (calls, token) =>
				authorizeGatewayCalls({
					calls,
					token,
					tokens: options.approvalTokens,
					agentId: identity.agentId,
					now: options.now,
					accessFor,
					assessAccess,
				}),
			dispatchCall: async (call) => {
				const binding = session?.bindings.get(JSON.stringify([call.namespace, call.toolName]));
				return binding === undefined ||
					(expectedBinding !== undefined && !sameRevision(expectedBinding, binding))
					? refused()
					: dispatchCall(call, binding);
			},
		});
		return boundHandlers.call({ identity, input });
	}
	async function currentCatalog(): Promise<PreparedGatewayCatalog> {
		const session = await visibleSession();
		if (session.catalog.discoveryFailures.length > 0)
			throw new PortalCatalogPreparationError(session.catalog.discoveryFailures);
		const tools = await Promise.all(
			session.catalog.tools.map(
				async (tool): Promise<PreparedCatalogTool> => ({
					namespace: tool.namespace,
					toolName: tool.toolName,
					bindingRevision: requireCatalogBinding(session.bindings, tool.namespace, tool.toolName),
					descriptor: {
						name: await createCatalogToolPresentationName(tool.namespace, tool.toolName),
						inputSchema: { ...structuredClone(tool.inputSchema), type: 'object' },
						...(tool.description === undefined ? {} : { description: tool.description }),
						...(tool.annotations === undefined
							? {}
							: { annotations: structuredClone(tool.annotations) }),
						...(tool.title === undefined ? {} : { title: tool.title }),
					},
				}),
			),
		);
		const exportedNames = new Set<string>();
		for (const tool of tools) {
			const exportedName = tool.descriptor.name;
			if (exportedNames.has(exportedName)) {
				throw new PortalCatalogPreparationError([
					{
						kind: 'catalog_tool_name_collision',
						message: 'Authorized catalog contains duplicate exported MCP tool names.',
						namespace: tool.namespace,
						toolName: tool.toolName,
					},
				]);
			}
			exportedNames.add(exportedName);
		}
		return {
			agentScopeId: portalAgentScopeKey(identity),
			sourceHash: session.catalog.sourceHash,
			tools,
		};
	}
	async function checkedCatalog(prepared: PreparedGatewayCatalog): Promise<PreparedGatewayCatalog> {
		const current = await currentCatalog();
		if (
			prepared.agentScopeId !== current.agentScopeId ||
			prepared.sourceHash !== current.sourceHash
		)
			return { ...current, tools: [] };
		return {
			...current,

			tools: current.tools.filter((tool) =>
				prepared.tools.some(
					(entry) =>
						entry.namespace === tool.namespace &&
						entry.toolName === tool.toolName &&
						entry.descriptor.name === tool.descriptor.name &&
						sameRevision(entry.bindingRevision, tool.bindingRevision),
				),
			),
		};
	}
	async function prepareCatalog(): Promise<PreparedGatewayCatalog> {
		return checkedCatalog(await options.prepareCatalog(await currentCatalog()));
	}
	return {
		prepareCatalog,
		listTools: async (mode, cursor) => {
			z.enum(['direct', 'indirect']).parse(mode);
			const session = await visibleSession();
			const searchTools = listPortalCoreToolDescriptors(
				[...new Set(session.catalog.tools.map((tool) => tool.namespace))].toSorted(),
			);
			if (mode === 'indirect') {
				if (cursor !== undefined) throw new Error('Indirect tools/list has no cursor.');
				return { tools: [...searchTools] };
			}
			return paginateMcpTools(
				[...(await prepareCatalog()).tools.map((tool) => tool.descriptor), ...searchTools],
				cursor,
			);
		},
		list: async (input) => handlers.list({ identity, input }),
		search: async (input) => handlers.search({ identity, input }),
		describe: async (input) => handlers.describe({ identity, input }),
		call: callBound,
		callDirect: async (input) => {
			const envelope = z
				.strictObject({
					name: z.string().min(1),
					arguments: z.record(z.string(), z.unknown()),
					item: z.string().min(1),
					_meta: z.record(z.string(), z.unknown()).optional(),
					catalog: z.unknown(),
				})
				.safeParse(input);
			if (!envelope.success) return refusedBatch();
			// Search tools keep their handlers even in the direct projection.
			switch (input.name) {
				case 'mcp_portal_list':
					return handlers.list({ identity, input: input.arguments });
				case 'mcp_portal_search':
					return handlers.search({ identity, input: input.arguments });
				case 'mcp_portal_describe':
					return handlers.describe({ identity, input: input.arguments });
				case 'mcp_portal_call':
					return callBound(input.arguments);
			}
			let enteredHandler = false;
			try {
				const catalog = await checkedCatalog(input.catalog);
				const selected = catalog.tools.find((tool) => tool.descriptor.name === input.name);
				if (selected === undefined) return refusedBatch();

				enteredHandler = true;
				return await callBound(
					{
						...(typeof input['_meta']?.['agent-vm/tool-portal-approval-token'] === 'string'
							? { portalApprovalToken: input['_meta']['agent-vm/tool-portal-approval-token'] }
							: {}),
						calls: [
							{
								id: input.item,
								namespace: selected.namespace,
								toolName: selected.toolName,
								arguments: input.arguments,
							},
						],
					},
					selected.bindingRevision,
				);
			} catch {
				return {
					ok: false,
					diagnostics: [],
					errors: [],
					results: Object.fromEntries([
						[
							input.item,
							{
								ok: false,
								input: { id: input.item, name: input.name, arguments: input.arguments },
								error: enteredHandler
									? { kind: 'ambiguous', reason: 'handler-unconfirmed' }
									: { kind: 'not-dispatched', reason: 'catalog-unavailable' },
							},
						],
					]),
				};
			}
		},
	};
}
