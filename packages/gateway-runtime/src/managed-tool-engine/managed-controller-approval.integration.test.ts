import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GatewayRuntimeClient } from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import { gatewayRuntimeManagedToolPortalConfigSchema } from '@agent-vm/config-contracts';
import { createControllerApprovalLedger } from '@agent-vm/controller-test-support/approval/controller-approval-ledger.js';
import { createControlSessionDispatcher } from '@agent-vm/controller-test-support/control-session/control-session-dispatcher.js';
import { createGatewayControlCallerContextRegistry } from '@agent-vm/controller-test-support/control-session/gateway-control-caller-context.js';
import { createGatewayControlDomainHandler } from '@agent-vm/controller-test-support/control-session/gateway-control-domain-handler.js';
import type { ControllerApprovalRecordsTarget } from '@agent-vm/controller-test-support/durable-state/controller-state-record-paths.js';
import { type GatewayRuntimePortalSemanticSnapshot } from '@agent-vm/gateway-control-contracts';
import {
	GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
	createGatewayControlCallerContextRegistrationClient,
	createGatewayControlControllerExecutionBackendPort,
	createGatewayRuntimeApprovalPort,
	createGatewayRuntimeControlCommandClient,
	createGatewayRuntimeManagedToolPortalComposition,
	createGatewayRuntimePaths,
	createGatewayRuntimePrivateUdsDispatcher,
	createManagedPluginAttachmentState,
	resolveGatewayRuntimeOperationGroup,
	startGatewayRuntimeUdsServer,
	type GatewayControlAcceptedSession,
	type GatewayControlService,
} from '@agent-vm/gateway-runtime';
import { expect, it } from 'vitest';

import {
	BASE_TIME_MS,
	acceptedSession,
	authorityContext,
	gateway,
	managedPluginAttachment,
	operatorIdentity,
	semanticSnapshot,
	singleResultItem,
	trustedInvocationContext,
	unexpectedBackendPort,
} from './test-fixtures/managed-approval-dispatch-test-fixture.js';

it('joins private UDS and the S2 controller reservation to durable approval, one armed effect and replay refusal', async () => {
	// Arrange: the control wire is in-process; production command, registration, backend and domain adapters remain real.
	const directoryPath = await mkdtemp(path.join(tmpdir(), 'agent-vm-controller-approval-'));
	const udsRoot = await mkdtemp('/tmp/agent-vm-controller-uds-');
	const recordsTarget = {
		directoryPath: path.join(directoryPath, 'approvals'),
		kind: 'controller-approval-records',
		zoneId: gateway.zoneId,
	} satisfies ControllerApprovalRecordsTarget;
	const ledger = createControllerApprovalLedger({
		challengeTtlMs: 300_000,
		currentControllerEpoch: gateway.controllerEpoch,
		now: () => BASE_TIME_MS,
		recordsTarget,
	});
	const config = gatewayRuntimeManagedToolPortalConfigSchema.parse({
		schemaVersion: 1,
		mode: 'managed',
		agents: { 'agent-a': { profile: 'code-builder' } },
		profiles: {
			'code-builder': {
				namespaces: {
					controller_execution: {
						backend: {
							kind: 'controller_execution',
							operations: { controller_host_probe: { kind: 'registered_action' } },
						},
						discovery: {},
						tools: { allow: ['controller_host_probe'], deny: [] },
						calls: {
							requiresApproval: { allow: ['controller_host_probe'], deny: [] },
							withoutApproval: { allow: [], deny: [] },
						},
					},
				},
			},
		},
	});
	const snapshot = {
		...semanticSnapshot,
		agentProjections: {
			'agent-a': {
				...semanticSnapshot.agentProjections['agent-a'],
				toolPortalNamespaces: [{ namespace: 'controller_execution' }],
			},
		},
		surfaceEligibilityByProfile: { 'code-builder': { controller_execution: ['protected_uds'] } },
	} satisfies GatewayRuntimePortalSemanticSnapshot;
	const callerContextProofKey = 'controller-approval-proof-key';
	const agentAuthorityKeys = { 'agent-a': 'controller-approval-agent-key' };
	const callerContexts = createGatewayControlCallerContextRegistry({
		agentAuthorityKeys,
		callerContextProofKey,
		validateRegistration: ({ adapterEvidence }) => {
			expect(adapterEvidence.principal).toEqual(trustedInvocationContext.principal);
			expect(adapterEvidence.purpose).toBe('tool_portal_controller_execution');
		},
	});
	const dispatcher = createControlSessionDispatcher({
		sessionFence: { ...acceptedSession, domain: 'gateway_control' },
	});
	const effects: string[] = [];
	const statesAtEffect: string[] = [];
	let approvalId: string | undefined;
	const domainHandler = createGatewayControlDomainHandler({
		approvalLedger: ledger,
		callerContexts,
		gateway,
		session: acceptedSession,
		controllerExecutions: {
			authorizeControllerExecution: async () => ({ authorized: true }),
			executeConfiguredCli: async () => {
				throw new Error('Unexpected configured CLI');
			},
			pushWorkspaceGit: async () => {
				throw new Error('Unexpected Git push');
			},
			runControllerHostProbe: async () => {
				effects.push('controller-host-probe');
				if (approvalId === undefined) throw new Error('Missing public challenge');
				statesAtEffect.push((await ledger.read(approvalId))?.kind ?? 'missing');
				return { entryNames: ['controlled-effect'], probeKind: 'controller_cache_dir_listing' };
			},
		},
	});
	dispatcher.register('gateway_control', domainHandler);
	const controlSession = {
		...acceptedSession,
		attachmentGeneration: 1,
		gatewayEpoch: gateway.gatewayEpochId,
		generationId: gateway.generationId,
		processEpoch: 'controller-approval-process',
	} satisfies GatewayControlAcceptedSession;
	let sequence = 0;
	const commands: string[] = [];

	const controlService = {
		getCurrentAcceptedSession: () => controlSession,
		observeAcceptedSessions: () => ({ unsubscribe: () => undefined }),
		emitApplicationMessage: async (intent, options) => {
			sequence += 1;
			const envelope = intent.buildEnvelope({ acceptedSession: controlSession, sequence });
			if (intent.payload.kind !== 'command') throw new Error('Expected controller command');
			commands.push(intent.payload.operation);
			options?.onAdmissionReceipt?.(controlSession);
			return await dispatcher.dispatch({ envelope, payload: intent.payload });
		},
	} satisfies Pick<
		GatewayControlService,
		'getCurrentAcceptedSession' | 'observeAcceptedSessions' | 'emitApplicationMessage'
	>;
	const commandClient = createGatewayRuntimeControlCommandClient({
		controlService,
		now: () => BASE_TIME_MS,
	});
	const registrationClient = createGatewayControlCallerContextRegistrationClient({
		agentAuthorityKeys,
		callerContextProofKey,
		controlCommandClient: commandClient,
		controlService,
	});
	const approvalPort = createGatewayRuntimeApprovalPort({
		controlCommandPort: commandClient,
		zoneId: gateway.zoneId,
	});
	const composition = await createGatewayRuntimeManagedToolPortalComposition({
		approvalPort,
		toolPortalConfig: config,
		semanticSnapshot: snapshot,
		artifactRuntime: {
			artifactsDirectoryPath: path.join(directoryPath, 'artifacts'),
			epochId: 'controller-approval',
			now: () => BASE_TIME_MS,
			limits: {
				maximumArtifactBytes: 1024,
				maximumArtifactCount: 8,
				maximumLifetimeMs: 60_000,
				maximumTotalBytes: 8192,
			},
		},
		authenticatedPrivateUdsOperationGroups:
			GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
		managedPluginAttachment,
		createPrivateUdsProjection: (props) => props,
		backendPortFactories: {
			controllerExecution: () =>
				createGatewayControlControllerExecutionBackendPort({
					callerContextRegistrationClient: registrationClient,
					controlCommandClient: commandClient,
					createCommandId: randomUUID,
					now: () => BASE_TIME_MS,
					owningGeneration: snapshot.activeRevision,
					toolPortalConfig: config,
				}),
			mcpProvider: () => unexpectedBackendPort('mcp_provider', 'unused provider'),
			toolVmRunner: () => unexpectedBackendPort('tool_vm_runner', 'unused runner'),
		},
	});
	const privateDispatcher = createGatewayRuntimePrivateUdsDispatcher({
		approvalOperations: { decide: async () => ({ kind: 'rejected', reason: 'not-found' }) },
		artifactOperations: {
			read: async () => {
				throw new Error('Unexpected artifact');
			},
		},
		portalOperations: composition.privateUdsProjection.portalOperations,
		sandboxDispatch: async () => {
			throw new Error('Unexpected sandbox');
		},
	});
	const server = await startGatewayRuntimeUdsServer({
		attachmentState: createManagedPluginAttachmentState({
			attachmentGeneration: managedPluginAttachment.attachmentGeneration,
			clientKind: managedPluginAttachment.clientKind,
			configuredAgentIds: managedPluginAttachment.configuredAgentIds,
			frameworkEpoch: managedPluginAttachment.frameworkEpoch,
			gatewayEpoch: managedPluginAttachment.gatewayEpoch,
			projectionCohortDigest: managedPluginAttachment.projectionCohortDigest,
			runtimeEpoch: managedPluginAttachment.runtimeEpoch,
			serverAuthority: { allowedOperationGroups: ['portal'], surface: 'managed-plugin' },
		}),
		dispatch: privateDispatcher.dispatch,
		paths: createGatewayRuntimePaths({ runtimeRoot: udsRoot }),
		resolveOperationGroup: resolveGatewayRuntimeOperationGroup,
	});
	const client = new GatewayRuntimeClient({
		attachment: managedPluginAttachment,
		socketPath: server.readiness.socketPath,
		startupRetryPolicy: { maxAttempts: 1 },
	});
	const request = {
		requestId: 'joined-controller-approval',
		calls: [
			{
				id: 'controller-probe',
				namespace: 'controller_execution',
				name: 'controller_host_probe',
				arguments: {},
			},
		],
	};
	try {
		await client.connect();
		const pending = singleResultItem(
			await client.portal.call(request, { trustedContext: trustedInvocationContext }),
		);
		expect(effects).toEqual([]);
		if (pending.status !== 'approval_required')
			throw new Error('Expected public approval challenge');
		approvalId = pending.approvalChallenge.challengeId;
		expect(await ledger.read(approvalId)).toMatchObject({
			kind: 'pending',
			challenge: {
				intent: { backendKind: 'controller_execution', operationId: pending.operationId },
			},
		});
		const decision = await ledger.decide({
			approvalId,
			authorityContext,
			decision: 'approve',
			operator: operatorIdentity,
		});
		expect(decision).toMatchObject({ kind: 'recorded', decision: 'approve' });
		// Act: the controller owns arm-before-effect; S2 forwards its reservation through the real controller adapter.
		const approved = singleResultItem(
			await client.portal.call(request, { trustedContext: trustedInvocationContext }),
		);
		const replay = singleResultItem(
			await client.portal.call(request, { trustedContext: trustedInvocationContext }),
		);
		// Assert effects and durable state first so a wrong hand-off fails on the real boundary.
		expect(effects, JSON.stringify({ approved, commands })).toEqual(['controller-host-probe']);
		expect(statesAtEffect).toEqual(['dispatch-armed']);
		expect(await ledger.read(approvalId)).toMatchObject({
			kind: 'dispatch-armed',
			challenge: { intent: { operationId: pending.operationId } },
		});
		expect(approved).toMatchObject({
			status: 'ok',
			operationId: pending.operationId,
			outcome: { kind: 'completed', completion: 'succeeded' },
			value: { kind: 'registered_action', action: { actionId: 'controller_host_probe' } },
		});
		expect(replay).toMatchObject({
			status: 'error',
			operationId: pending.operationId,
			outcome: { kind: 'ambiguous', retryClass: 'forbidden' },
		});
		expect(
			commands.filter((operation) => operation === 'tool_portal_controller_execution'),
		).toHaveLength(1);
		expect(
			commands.filter((operation) => operation === 'tool_portal_admission_reserve'),
		).toHaveLength(3);
		expect(commands).not.toContain('tool_portal_dispatch_arm');
		const reopened = createControllerApprovalLedger({
			challengeTtlMs: 300_000,
			currentControllerEpoch: gateway.controllerEpoch,
			now: () => BASE_TIME_MS,
			recordsTarget,
		});
		expect(await reopened.read(approvalId)).toMatchObject({ kind: 'dispatch-armed' });
		expect(effects).toHaveLength(1);
	} finally {
		await client.disconnect();
		await server.retire();
		await composition.retireEpoch();
		await registrationClient.close();
		await Promise.all([
			rm(directoryPath, { recursive: true, force: true }),
			rm(udsRoot, { recursive: true, force: true }),
		]);
	}
});
