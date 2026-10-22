import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeUpstreamMcpServer } from '@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server';
import { type PortalCallRequest, type PortalCallResult } from '@agent-vm/agent-portal-sdk';
import { GatewayRuntimeClient } from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import { createToolPortalMcpProjection } from '@agent-vm/config-contracts';
import { createControllerApprovalLedger } from '@agent-vm/controller-test-support/approval/controller-approval-ledger.js';
import { createControlSessionDispatcher } from '@agent-vm/controller-test-support/control-session/control-session-dispatcher.js';
import { createGatewayControlCallerContextRegistry } from '@agent-vm/controller-test-support/control-session/gateway-control-caller-context.js';
import { createGatewayControlDomainHandler } from '@agent-vm/controller-test-support/control-session/gateway-control-domain-handler.js';
import {
	GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	deriveGatewayControlStablePrincipal,
	type GatewayRuntimeApprovalDispatchGrant,
} from '@agent-vm/gateway-control-contracts';
import { createGatewayRuntimeApprovalPort } from '@agent-vm/gateway-runtime';
import {
	BASE_TIME_MS,
	acceptedSession,
	authorityContext,
	createInboundEnvelope,
	gateway,
} from '@agent-vm/gateway-runtime/managed-tool-engine/test-fixtures/managed-approval-dispatch-test-fixture.js';
import {
	attachmentForConfig,
	createCutoverServiceConfig,
	cutoverTrustedContext,
} from '@agent-vm/gateway-runtime/managed-tool-engine/test-fixtures/production-private-cutover-test-fixture.js';
import { expect, it, vi } from 'vitest';

import { createGatewayRuntimeProductionControlRuntime } from '#gateway-runtime/production/gateway-runtime-production-control-runtime';
import { startGatewayRuntimeProductionService } from '#gateway-runtime/production/gateway-runtime-production-service';

function writeRequest(id: string, title: string): PortalCallRequest {
	return { calls: [{ id, namespace: 'github', name: 'write_thing', arguments: { title } }] };
}

function singleItem(result: PortalCallResult): PortalCallResult['items'][number] {
	const item = result.items[0];
	if (result.items.length !== 1 || item === undefined) throw new Error('Expected one call result');
	return item;
}

const grantCases = [
	'exact',
	'wrong-operation',
	'wrong-fingerprint',
	'wrong-principal',
	'wrong-authority',
	'wrong-expiry',
] as const;

type ManagedMcpDispatchGrant = Extract<
	GatewayRuntimeApprovalDispatchGrant,
	{ readonly backendKind: 'mcp_provider' }
>;

function substituteGrant(
	grant: ManagedMcpDispatchGrant,
	scenario: (typeof grantCases)[number],
): ManagedMcpDispatchGrant {
	switch (scenario) {
		case 'exact':
			return grant;
		case 'wrong-operation':
			return { ...grant, operationId: randomUUID() };
		case 'wrong-fingerprint':
			return { ...grant, fingerprint: `sha256:${'0'.repeat(64)}` };
		case 'wrong-principal':
			return {
				...grant,
				stablePrincipal: deriveGatewayControlStablePrincipal({
					principal: {
						agentId: 'agent-b',
						frameworkIdentity: { kind: 'hermes', profileName: 'agent-b' },
						profileAssignmentRevision: 'other-assignment',
						toolPortalProfileId: 'profile-a',
					},
				}),
			};
		case 'wrong-authority':
			return {
				...grant,
				authorityContext: { ...grant.authorityContext, runtimeEpoch: 'other-runtime' },
			};
		case 'wrong-expiry':
			return { ...grant, expiresAt: new Date(BASE_TIME_MS - 1).toISOString() };
	}
	const unsupportedScenario: never = scenario;
	throw new Error(`Unsupported grant substitution: ${String(unsupportedScenario)}`);
}

it.each(grantCases)(
	'keeps the real managed MCP dispatch bound to the controller grant: %s',
	async (scenario) => {
		// Arrange: only the upstream server and control wire are controlled. The UDS,
		// composition, S2 dispatcher, approval port, controller domain/ledger and provider are real.
		const upstream = await startFakeUpstreamMcpServer();
		const recordsDirectory = await mkdtemp(path.join(tmpdir(), 'managed-mcp-approval-'));
		const config = await createCutoverServiceConfig({
			includeMcpProvider: true,
			mcpOnly: true,
			mcpAllowedTools: ['read_thing', 'write_thing'],
			mcpRequiresApprovalTools: ['write_thing'],
			mcpShareProfileWithAgentB: true,
			mcpConfig: {
				schemaVersion: 1,
				providers: {
					fixture: {
						kind: 'mcp',
						namespace: 'github',
						discovery: {},
						secretPolicies: {},
						transport: {
							kind: 'streamable-http',
							url: upstream.url,
							headers: {},
							requiredEgressHosts: [],
						},
					},
				},
			},
		});
		const context = cutoverTrustedContext(config);
		const recordsTarget = {
			kind: 'controller-approval-records' as const,
			zoneId: gateway.zoneId,
			directoryPath: recordsDirectory,
		};
		const ledgerProps = {
			challengeTtlMs: 300_000,
			currentControllerEpoch: gateway.controllerEpoch,
			now: () => BASE_TIME_MS,
			recordsTarget,
		};
		const ledger = createControllerApprovalLedger(ledgerProps);
		const dispatcher = createControlSessionDispatcher({
			sessionFence: { ...acceptedSession, domain: 'gateway_control' },
		});
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				approvalLedger: ledger,
				callerContexts: createGatewayControlCallerContextRegistry({
					agentAuthorityKeys: {},
					callerContextProofKey: 'managed-mcp-test-proof',
				}),
				gateway,
				session: acceptedSession,
			}),
		);
		let sequence = 0;
		let issuedGrant: ManagedMcpDispatchGrant | undefined;
		let overlap = false;
		let arrivals = 0;
		let completions = 0;
		const bothArrived = Promise.withResolvers<void>();
		const bothCompleted = Promise.withResolvers<void>();
		const approvalPort = createGatewayRuntimeApprovalPort({
			zoneId: gateway.zoneId,
			controlCommandPort: {
				sendCommand: async ({ message }) => {
					if (overlap && message.operation === 'tool_portal_admission_reserve') {
						arrivals += 1;
						if (arrivals === 2) bothArrived.resolve();
						await bothArrived.promise;
					}
					if (overlap && message.operation === 'tool_portal_dispatch_arm')
						await bothCompleted.promise;
					sequence += 1;
					const messageId = randomUUID();
					const response = await dispatcher.dispatch({
						envelope: createInboundEnvelope({ messageId, operation: message.operation, sequence }),
						payload: message,
					});
					if (overlap && message.operation === 'tool_portal_admission_reserve') {
						completions += 1;
						if (completions === 2) bothCompleted.resolve();
					}
					return { messageId, response };
				},
			},
		});
		const service = await startGatewayRuntimeProductionService({
			config,
			dependencies: {
				now: () => BASE_TIME_MS,
				createControlRuntime: async (props) =>
					await createGatewayRuntimeProductionControlRuntime(props, {
						createApprovalPort: () => ({
							reserveDispatch: approvalPort.reserveDispatch,
							armDispatch: async (request) => {
								const armed = await approvalPort.armDispatch(request);
								if (armed.kind !== 'dispatch-armed' || armed.grant.backendKind !== 'mcp_provider')
									return armed;
								issuedGrant = armed.grant;
								// Fault injection after the real controller arms; S2 must reject any substituted field.
								return { kind: 'dispatch-armed', grant: substituteGrant(armed.grant, scenario) };
							},
						}),
					}),
			},
		});
		const client = new GatewayRuntimeClient({
			attachment: attachmentForConfig(config),
			socketPath: service.udsServer.readiness.socketPath,
			startupRetryPolicy: { maxAttempts: 1 },
		});
		const options = { trustedContext: context };
		const request = writeRequest('approved-write', 'approved exact arguments');
		const backendCreations = vi.spyOn(service.providerFactory, 'createBackend');
		try {
			await client.connect();
			const control = await client.portal.call(
				{
					calls: [
						{
							id: 'read-control',
							namespace: 'github',
							name: 'read_thing',
							arguments: { title: 'permitted control' },
						},
					],
				},
				options,
			);
			expect(singleItem(control).status).toBe('ok');
			expect(upstream.calls).toEqual([
				{ name: 'read_thing', argumentsValue: { title: 'permitted control' } },
			]);
			const managedBackendResult = backendCreations.mock.results[0];
			if (managedBackendResult?.type !== 'return') throw new Error('Missing real managed backend');
			// Observe the real backend without replacing its implementation.
			const managedCalls = vi.spyOn(managedBackendResult.value, 'call');
			const projection = createToolPortalMcpProjection({
				agentId: context.principal.agentId,
				config: config.toolPortalConfig,
			});
			const directBackend = service.providerFactory.createBackend(projection);
			const noGrant = await directBackend.call(
				writeRequest('no-grant', 'provider must require a managed grant'),
			);
			expect(upstream.calls.filter((call) => call.name === 'write_thing')).toHaveLength(0);
			expect(singleItem(noGrant)).toMatchObject({
				status: 'error',
				error: { code: 'approval_required' },
			});
			const injection = writeRequest('model-grant', 'model cannot approve itself');
			const injectionCall = injection.calls[0];
			if (injectionCall === undefined) throw new Error('Missing injection call');
			const modelGrant = await client.portal.call(
				{
					calls: [
						{
							...injectionCall,
							arguments: {
								managedDispatchAuthority: { kind: 'approval-grant', operationId: randomUUID() },
								approved: true,
							},
						},
					],
				},
				options,
			);
			expect(upstream.calls.filter((call) => call.name === 'write_thing')).toHaveLength(0);
			expect(singleItem(modelGrant).status).toBe('approval_required');
			const pending = singleItem(await client.portal.call(request, options));
			expect(upstream.calls.filter((call) => call.name === 'write_thing')).toHaveLength(0);
			if (pending.status !== 'approval_required')
				throw new Error('Expected public approval challenge');
			const approvalId = pending.approvalChallenge.challengeId;
			expect(await ledger.read(approvalId)).toMatchObject({
				kind: 'pending',
				challenge: {
					intent: {
						call: request.calls[0],
						operationId: pending.operationId,
						trustedContext: { principal: context.principal },
					},
				},
			});
			expect(
				await ledger.decide({
					approvalId,
					authorityContext,
					decision: 'approve',
					operator: {
						approverId: 'controlled-operator',
						audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
						provenance: 'managed-gateway',
						stablePrincipal: deriveGatewayControlStablePrincipal({ principal: context.principal }),
					},
				}),
			).toMatchObject({ kind: 'recorded', decision: 'approve' });
			expect(await ledger.read(approvalId)).toMatchObject({ kind: 'approved' });

			// A recorded decision authorizes neither another id nor changed arguments.
			const mismatches = await Promise.all(
				[
					writeRequest('another-write', 'approved exact arguments'),
					writeRequest('approved-write', 'changed arguments'),
				].map(async (mismatch) => await client.portal.call(mismatch, options)),
			);
			expect(upstream.calls.filter((call) => call.name === 'write_thing')).toHaveLength(0);
			expect(mismatches.map((result) => singleItem(result).status)).toEqual([
				'approval_required',
				'approval_required',
			]);
			// Act: explicit reserve barriers make the two approved successors overlap.
			overlap = true;
			const successors = await Promise.all([
				client.portal.call(request, options),
				client.portal.call(request, options),
			]);
			overlap = false;
			const after = await ledger.read(approvalId);
			if (scenario !== 'exact') {
				expect(
					upstream.calls.filter((call) => call.name === 'write_thing'),
					JSON.stringify({ scenario, successors, ledger: after }),
				).toHaveLength(0);
				expect(after).toMatchObject({ kind: 'dispatch-armed' });
				expect(
					successors.flatMap((result) => result.items).every((item) => item.status === 'error'),
				).toBe(true);
				return;
			}
			// Effect assertion comes first: the old provider fails here with zero writes,
			// even though the actual durable controller record is already dispatch-armed.
			expect(
				upstream.calls.filter((call) => call.name === 'write_thing'),
				JSON.stringify({ successors, ledger: after }),
			).toEqual([{ name: 'write_thing', argumentsValue: { title: 'approved exact arguments' } }]);
			expect(after).toMatchObject({
				kind: 'dispatch-armed',
				challenge: { intent: { operationId: pending.operationId, call: request.calls[0] } },
			});
			expect(managedCalls.mock.calls).toMatchObject([
				[
					request,
					{
						managedDispatchAuthority: {
							kind: 'approval-grant',
							backendKind: 'mcp_provider',
							grant: issuedGrant,
						},
						operationIdsByCallId: { 'approved-write': pending.operationId },
					},
				],
			]);
			expect(
				successors.flatMap((result) => result.items).filter((item) => item.status === 'ok'),
			).toMatchObject([
				{
					operationId: pending.operationId,
					outcome: { kind: 'completed', completion: 'succeeded' },
				},
			]);
			const replay = singleItem(await client.portal.call(request, options));
			expect(upstream.calls.filter((call) => call.name === 'write_thing')).toHaveLength(1);
			expect(replay).toMatchObject({
				status: 'error',
				operationId: pending.operationId,
				outcome: { kind: 'ambiguous', retryClass: 'forbidden' },
			});
			expect(await createControllerApprovalLedger(ledgerProps).read(approvalId)).toEqual(after);
			const unapproved = singleItem(
				await client.portal.call(writeRequest('later-unapproved', 'no sticky approval'), options),
			);
			expect(upstream.calls.filter((call) => call.name === 'write_thing')).toHaveLength(1);
			expect(unapproved.status).toBe('approval_required');
			const agentB = config.semanticSnapshot.agentProjections['agent-b'];
			if (agentB === undefined) throw new Error('Missing second-agent projection');
			const otherAgent = await client.portal.call(request, {
				trustedContext: {
					...context,
					principal: {
						agentId: agentB.agentId,
						frameworkIdentity: agentB.frameworkIdentity,
						profileAssignmentRevision: agentB.profileAssignmentRevision,
						toolPortalProfileId: agentB.toolPortalProfileId,
					},
					requester: { authenticatedSubjectId: 'subject-b' },
				},
			});
			expect(upstream.calls.filter((call) => call.name === 'write_thing')).toHaveLength(1);
			expect(singleItem(otherAgent).status).toBe('approval_required');
			// A successful managed handoff cannot make either retained agent view sticky.
			const freshProviderCalls = await Promise.all(
				['agent-a', 'agent-b'].map(async (agentId) => {
					const anotherBackend = service.providerFactory.createBackend({ ...projection, agentId });
					return await anotherBackend.call(
						writeRequest('fresh-provider-call', `unapproved ${agentId}`),
					);
				}),
			);
			expect(upstream.calls.filter((call) => call.name === 'write_thing')).toHaveLength(1);
			expect(freshProviderCalls.map(singleItem)).toMatchObject([
				{ status: 'error', error: { code: 'approval_required' } },
				{
					status: 'error',
					error: { code: 'approval_required' },
				},
			]);
			if (issuedGrant === undefined) throw new Error('Missing actual controller grant');
			const blockedProjection = createToolPortalMcpProjection({
				agentId: context.principal.agentId,
				config: config.toolPortalConfig,
			});
			const blockedPolicy = blockedProjection.namespaces.github;
			if (blockedPolicy === undefined) throw new Error('Missing provider policy');
			blockedPolicy.tools.deny = ['write_thing'];
			const blocked = await service.providerFactory.createBackend(blockedProjection).call(request, {
				managedDispatchAuthority: {
					kind: 'approval-grant',
					backendKind: 'mcp_provider',
					grant: issuedGrant,
				},
				operationIdsByCallId: { 'approved-write': issuedGrant.operationId },
			});
			expect(upstream.calls.filter((call) => call.name === 'write_thing')).toHaveLength(1);
			expect(singleItem(blocked)).toMatchObject({
				status: 'error',
				error: { code: 'capability_denied' },
			});
			const hidden = singleItem(
				await client.portal.call(
					{ calls: [{ id: 'hidden', namespace: 'github', name: 'hidden_thing', arguments: {} }] },
					options,
				),
			);
			expect(upstream.calls).toHaveLength(2);
			expect(hidden.status).toBe('error');
		} finally {
			vi.restoreAllMocks();
			await client.disconnect();
			await service.retire({ drainTimeoutMs: 100 });
			await upstream.close();
			await rm(config.runtimeRoot, { recursive: true, force: true });
			await rm(recordsDirectory, { recursive: true, force: true });
		}
	},
);
