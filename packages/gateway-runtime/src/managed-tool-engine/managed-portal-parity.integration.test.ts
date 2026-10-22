import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { PortalCallRequestSchema, type PortalCallResult } from '@agent-vm/agent-portal-sdk';
import { GatewayRuntimeClient } from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import { gatewayRuntimeManagedToolPortalConfigSchema } from '@agent-vm/config-contracts';
import {
	GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
	createGatewayRuntimeManagedToolPortalComposition,
	createGatewayRuntimePaths,
	createGatewayRuntimePrivateUdsDispatcher,
	createManagedPluginAttachmentState,
	resolveGatewayRuntimeOperationGroup,
	startGatewayRuntimeUdsServer,
} from '@agent-vm/gateway-runtime';
import type {
	ToolPortalApprovalPort,
	ToolPortalBackendPort,
} from '@agent-vm/gateway-runtime/managed-tool-engine/models/managed-portal-ports.js';
import {
	agentATrustedContext,
	createApprovalChallenge,
	mixedBackendConfig,
	semanticSnapshot,
	udsOptions,
} from '@agent-vm/gateway-runtime/managed-tool-engine/test-fixtures/managed-service-test-fixture.js';
import { createManagedToolPortalCapabilityCore as createOldCore } from '@agent-vm/tool-portal';
import { describe, expect, it } from 'vitest';

const cases = [
	{
		namespace: 'controller_execution',
		allowed: 'workspace_git_push',
		protected: 'controller_host_probe',
		hidden: 'hidden_control',
	},
	{ namespace: 'github', allowed: 'get_issue', protected: 'create_issue', hidden: 'hidden_issue' },
	{ namespace: 'sandbox', allowed: 'exec', protected: 'exec_approved', hidden: 'exec_denied' },
] as const;

describe('managed public outcome parity across all backend kinds', () => {
	it('preserves a mixed allowed/refused/pending/failed batch and counts every leaf effect', async () => {
		// Oracle: old managed core body at08f9e426, blob94d9dcdc31e73e3d4e49145cec42798a90f1837a.
		// Only the external leaves and controller decisions are controlled in this finite table;
		// the private socket/real connector and real ledger are observed in their owning suites.
		const config = gatewayRuntimeManagedToolPortalConfigSchema.parse(mixedBackendConfig);
		const sandbox = config.profiles['code-builder']?.namespaces.sandbox;
		if (sandbox?.backend.kind !== 'tool_vm_runner') throw new Error('Missing runner fixture');
		const operation = sandbox.backend.operations.exec;
		if (operation === undefined) throw new Error('Missing inert command');
		sandbox.backend.operations.exec_approved = operation;
		const request = PortalCallRequestSchema.parse({
			calls: cases.flatMap((row) => [
				{
					id: `${row.namespace}:allowed`,
					namespace: row.namespace,
					name: row.allowed,
					arguments: {},
				},
				{
					id: `${row.namespace}:refused`,
					namespace: row.namespace,
					name: row.hidden,
					arguments: {},
				},
				{
					id: `${row.namespace}:pending`,
					namespace: row.namespace,
					name: row.protected,
					arguments: {},
				},
				{
					id: `${row.namespace}:failed`,
					namespace: row.namespace,
					name: row.allowed,
					arguments: { fail: true },
				},
			]),
		});
		function fixture(): {
			readonly backendPorts: {
				readonly controllerExecution: ToolPortalBackendPort<'controller_execution'>;
				readonly mcpProvider: ToolPortalBackendPort<'mcp_provider'>;
				readonly toolVmRunner: ToolPortalBackendPort<'tool_vm_runner'>;
			};
			readonly approvalPort: ToolPortalApprovalPort;
			readonly effects: string[];
		} {
			const effects: string[] = [];
			function backend<TKind extends 'controller_execution' | 'mcp_provider' | 'tool_vm_runner'>(
				backendKind: TKind,
			): ToolPortalBackendPort<TKind> {
				return {
					backendKind,
					call: async (input, options): Promise<PortalCallResult> => {
						const call = input.calls[0];
						if (call === undefined) throw new Error('Expected one leaf call');
						effects.push(call.id);
						if (call.arguments.fail === true)
							throw new Error('PRIVATE_PROVIDER_CANARY_MUST_STAY_HIDDEN');
						if (options.dispatchAuthority.kind !== 'without-approval')
							throw new Error('Pending call reached leaf');
						return {
							ok: true,
							items: [
								{
									id: call.id,
									status: 'ok',
									value: { backendKind },
									operationId: options.dispatchAuthority.operationId,
									owningGeneration: semanticSnapshot.activeRevision,
									outcome: {
										kind: 'completed',
										completion: 'succeeded',
										certainty: 'proven',
										retryClass: 'forbidden',
									},
								},
							],
						};
					},
					list: async () => {
						throw new Error('Unexpected discovery');
					},
					search: async () => {
						throw new Error('Unexpected discovery');
					},
					describe: async () => {
						throw new Error('Unexpected discovery');
					},
				};
			}
			return {
				effects,
				backendPorts: {
					controllerExecution: backend('controller_execution'),
					mcpProvider: backend('mcp_provider'),
					toolVmRunner: backend('tool_vm_runner'),
				},
				approvalPort: {
					reserveDispatch: async ({ intent }) => createApprovalChallenge(intent),
					armDispatch: async () => {
						throw new Error('Pending approval must not arm');
					},
				},
			};
		}
		const old = fixture();
		const current = fixture();
		const oldCore = createOldCore({
			config,
			semanticSnapshot,
			backendPorts: old.backendPorts,
			approvalPort: old.approvalPort,
		});
		const root = await mkdtemp('/tmp/s4a-table-');
		const composition = await createGatewayRuntimeManagedToolPortalComposition({
			toolPortalConfig: config,
			semanticSnapshot,
			approvalPort: current.approvalPort,
			artifactRuntime: {
				artifactsDirectoryPath: path.join(root, 'artifacts'),
				epochId: 'table-epoch',
				now: () => Date.parse('2026-07-13T12:00:00.000Z'),
				limits: {
					maximumArtifactBytes: 1024,
					maximumArtifactCount: 8,
					maximumTotalBytes: 8192,
					maximumLifetimeMs: 60000,
				},
			},
			backendPortFactories: {
				controllerExecution: () => current.backendPorts.controllerExecution,
				mcpProvider: () => current.backendPorts.mcpProvider,
				toolVmRunner: () => current.backendPorts.toolVmRunner,
			},
			authenticatedPrivateUdsOperationGroups:
				GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
			managedPluginAttachment: {
				clientKind: 'hermes-managed-plugin',
				configuredAgentIds: ['agent-a', 'agent-b'],
				gatewayEpoch: 'table-gateway',
				projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
			},
			createPrivateUdsProjection: (props) => props,
		});
		const attachment = {
			attachmentGeneration: 1,
			clientKind: 'hermes-managed-plugin' as const,
			configuredAgentIds: ['agent-a', 'agent-b'],
			frameworkEpoch: 'table-framework',
			gatewayEpoch: 'table-gateway',
			runtimeEpoch: 'table-runtime',
			projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
			protocolVersion: 1 as const,
			schemaVersion: 1 as const,
		};
		const dispatcher = createGatewayRuntimePrivateUdsDispatcher({
			portalOperations: composition.privateUdsProjection.portalOperations,
			artifactOperations: composition.privateUdsProjection.artifactOperations,
			approvalOperations: { decide: async () => ({ kind: 'rejected', reason: 'not-found' }) },
			sandboxDispatch: async () => {
				throw new Error('Unused sandbox route');
			},
		});
		const server = await startGatewayRuntimeUdsServer({
			paths: createGatewayRuntimePaths({ runtimeRoot: root }),
			dispatch: dispatcher.dispatch,
			resolveOperationGroup: resolveGatewayRuntimeOperationGroup,
			attachmentState: createManagedPluginAttachmentState({
				attachmentGeneration: attachment.attachmentGeneration,
				clientKind: attachment.clientKind,
				configuredAgentIds: attachment.configuredAgentIds,
				frameworkEpoch: attachment.frameworkEpoch,
				gatewayEpoch: attachment.gatewayEpoch,
				runtimeEpoch: attachment.runtimeEpoch,
				projectionCohortDigest: attachment.projectionCohortDigest,
				serverAuthority: { allowedOperationGroups: ['portal'], surface: 'managed-plugin' },
			}),
		});
		const client = new GatewayRuntimeClient({
			attachment,
			socketPath: server.readiness.socketPath,
			startupRetryPolicy: { maxAttempts: 1 },
		});
		try {
			await client.connect();
			const expected = await oldCore.call(request, udsOptions(agentATrustedContext));
			let result: PortalCallResult | undefined;
			try {
				result = await client.portal.call(request, { trustedContext: agentATrustedContext });
			} finally {
				expect(
					current.effects.filter((id) => id.endsWith(':refused') || id.endsWith(':pending')),
				).toEqual([]);
			}
			expect(result).toEqual(expected);
			expect(result.items.map((item) => item.status)).toEqual(
				cases.flatMap(() => ['ok', 'error', 'approval_required', 'error']),
			);
			expect(
				result.items.filter((item) => item.id.endsWith(':failed')).map((item) => item.outcome.kind),
			).toEqual(['ambiguous', 'ambiguous', 'ambiguous']);
			expect(current.effects.toSorted()).toEqual(
				cases.flatMap((row) => [`${row.namespace}:allowed`, `${row.namespace}:failed`]).toSorted(),
			);
			expect(current.effects.toSorted()).toEqual(old.effects.toSorted());
			expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_CANARY_MUST_STAY_HIDDEN');
		} finally {
			await client.disconnect();
			await server.retire({ drainTimeoutMs: 100 });
			await composition.retireEpoch();
			await rm(root, { force: true, recursive: true });
		}
	});
});
