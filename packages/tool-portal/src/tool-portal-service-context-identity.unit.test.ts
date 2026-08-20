import { PortalListRequestSchema, type PortalCallRequest } from '@agent-vm/agent-portal-sdk';
import type { ManagedToolPortalConfig } from '@agent-vm/config-contracts';
import {
	GatewayRuntimeApprovalFingerprintSchema,
	GatewayRuntimeTrustedInvocationContextSchema,
	type GatewayRuntimePortalSemanticSnapshot,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it } from 'vitest';

import {
	type RecordedBackendInvocation,
	type ToolPortalManagedServiceInvocationOptions,
	type ToolPortalTrustedInvocationContext,
	agentATrustedContext,
	agentBTrustedContext,
	createRecordingApprovalPort,
	createServiceFixture,
	mixedBackendConfig,
	semanticSnapshot,
	totalBackendInvocations,
	udsOptions,
} from './tool-portal-service-test-fixture.js';

const directFingerprintConfig = {
	...mixedBackendConfig,
	profiles: {
		...mixedBackendConfig.profiles,
		'code-builder': {
			...mixedBackendConfig.profiles['code-builder'],
			namespaces: {
				...mixedBackendConfig.profiles['code-builder'].namespaces,
				github: {
					...mixedBackendConfig.profiles['code-builder'].namespaces.github,
					calls: {
						...mixedBackendConfig.profiles['code-builder'].namespaces.github.calls,
						withoutApproval: {
							allow: ['get_issue', 'get_issue_details'],
							deny: [],
						},
					},
					tools: {
						allow: ['create_issue', 'get_issue', 'get_issue_details', 'update_issue'],
						deny: [],
					},
				},
				github_alias: {
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['get_issue'], deny: [] },
				},
			},
		},
	},
} satisfies ManagedToolPortalConfig;

const directFingerprintSemanticSnapshot = {
	...semanticSnapshot,
	surfaceEligibilityByProfile: {
		...semanticSnapshot.surfaceEligibilityByProfile,
		'code-builder': {
			...semanticSnapshot.surfaceEligibilityByProfile['code-builder'],
			github_alias: ['mcp', 'protected_uds'],
		},
	},
} satisfies GatewayRuntimePortalSemanticSnapshot;

interface CapturedDirectDispatch {
	readonly authority: unknown;
	readonly operationId: string;
}

async function captureDirectDispatch(props: {
	readonly call: PortalCallRequest['calls'][number];
	readonly options: ToolPortalManagedServiceInvocationOptions;
	readonly semanticSnapshot?: GatewayRuntimePortalSemanticSnapshot;
}): Promise<CapturedDirectDispatch> {
	const fixture = createServiceFixture({
		config: directFingerprintConfig,
		semanticSnapshot: props.semanticSnapshot ?? directFingerprintSemanticSnapshot,
	});
	const result = await fixture.capabilityCore.call({ calls: [props.call] }, props.options);
	const callInvocation = [
		...fixture.controllerExecution.invocations,
		...fixture.mcpProvider.invocations,
		...fixture.toolVmRunner.invocations,
	].find(
		(
			invocation,
		): invocation is Extract<RecordedBackendInvocation, { readonly operation: 'call' }> =>
			invocation.operation === 'call',
	);
	const operationId = result.items[0]?.operationId;
	if (callInvocation === undefined || operationId === undefined) {
		throw new Error('Expected one direct backend dispatch with an operation identity.');
	}
	return { authority: callInvocation.options.dispatchAuthority, operationId };
}

function requireDirectDispatchFingerprint(authority: unknown): string {
	const fingerprintCandidate =
		typeof authority === 'object' && authority !== null
			? Reflect.get(authority, 'fingerprint')
			: undefined;
	const parsedFingerprint = GatewayRuntimeApprovalFingerprintSchema.safeParse(fingerprintCandidate);
	expect(parsedFingerprint.success).toBe(true);
	if (!parsedFingerprint.success) {
		throw new Error('Direct dispatch authority must carry an exact-intent fingerprint.');
	}
	return parsedFingerprint.data;
}

describe('ToolPortalCapabilityCore context identity', () => {
	it('binds each invocation to its complete context without leaking state between configured agents', async () => {
		// Arrange
		const fixture = createServiceFixture();
		const contexts = [
			agentATrustedContext,
			{ ...agentATrustedContext, requester: { authenticatedSubjectId: 'subject-b' } },
			{
				...agentATrustedContext,
				correlation: { ...agentATrustedContext.correlation, sessionId: 'session-b' },
			},
			{ ...agentATrustedContext, correlation: { runId: 'run-b' } },
			{ ...agentATrustedContext, correlation: { toolCallId: 'tool-call-b' } },
			agentBTrustedContext,
		] satisfies readonly ToolPortalTrustedInvocationContext[];

		// Act
		await Promise.all(
			contexts.map(async (trustedContext, index) => {
				await fixture.capabilityCore.call(
					{
						calls: [
							{
								arguments: {},
								id: `context-call-${index}`,
								namespace: 'github',
								name: 'get_issue',
							},
						],
					},
					udsOptions(trustedContext),
				);
			}),
		);

		// Assert
		expect(fixture.mcpProvider.invocations.map(({ options }) => options.trustedContext)).toEqual(
			contexts,
		);
	});

	it('rejects unconfigured agents, stale profile assignments, and incomplete trusted context before visibility', async () => {
		// Arrange
		const fixture = createServiceFixture();
		const invalidContexts: unknown[] = [
			{
				...agentATrustedContext,
				principal: { ...agentATrustedContext.principal, agentId: 'agent-unknown' },
			},
			{
				...agentATrustedContext,
				principal: {
					...agentATrustedContext.principal,
					profileAssignmentRevision: 'profile-assignment:agent-a:stale',
				},
			},
			{
				...agentATrustedContext,
				principal: { ...agentATrustedContext.principal, toolPortalProfileId: 'admin' },
			},
			{
				...agentATrustedContext,
				principal: {
					...agentATrustedContext.principal,
					frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
				},
			},
			{
				...agentATrustedContext,
				principal: {
					...agentATrustedContext.principal,
					frameworkIdentity: { kind: 'hermes', profileName: 'agent-a-profile' },
				},
			},
			...['agentId', 'frameworkIdentity', 'profileAssignmentRevision', 'toolPortalProfileId'].map(
				(fieldName) => ({
					...agentATrustedContext,
					principal: Object.fromEntries(
						Object.entries(agentATrustedContext.principal).filter(([key]) => key !== fieldName),
					),
				}),
			),
		];

		// Act / Assert
		await Promise.all(
			invalidContexts.map(async (trustedContext) => {
				await expect(
					Promise.resolve()
						.then(() => GatewayRuntimeTrustedInvocationContextSchema.parse(trustedContext))
						.then(
							async (parsedTrustedContext) =>
								await fixture.capabilityCore.list(
									PortalListRequestSchema.parse({ requests: [{ id: 'private-list' }] }),
									{
										origin: { kind: 'managed', trustedContext: parsedTrustedContext },
										surfaceClass: 'protected_uds',
									},
								),
						),
				).rejects.toThrow();
			}),
		);
		expect(totalBackendInvocations(fixture)).toBe(0);
	});

	it('checks surface eligibility before admitting a protected backend', async () => {
		// Arrange
		const fixture = createServiceFixture();

		// Act / Assert
		const result = await fixture.capabilityCore.call(
			{ calls: [{ arguments: {}, id: 'vm-call', namespace: 'sandbox', name: 'exec' }] },
			{
				origin: { kind: 'managed', trustedContext: agentATrustedContext },
				surfaceClass: 'mcp',
			},
		);
		expect(result.items).toMatchObject([
			{ error: { code: 'capability_denied' }, id: 'vm-call', status: 'error' },
		]);
		expect(totalBackendInvocations(fixture)).toBe(0);
	});

	it('selects approval, direct dispatch, and denial from the exact namespace tool selector', async () => {
		// Arrange
		const fixture = createServiceFixture();

		// Act
		const result = await fixture.capabilityCore.call(
			{
				calls: [
					{ arguments: {}, id: 'approval', namespace: 'github', name: 'create_issue' },
					{
						arguments: {},
						id: 'near-match',
						namespace: 'github',
						name: 'create_issue_preview',
					},
					{ arguments: {}, id: 'denied', namespace: 'sandbox', name: 'exec_denied' },
				],
			},
			udsOptions(),
		);

		// Assert
		expect(result.items).toMatchObject([
			{ id: 'approval', status: 'approval_required' },
			{ error: { code: 'capability_denied' }, id: 'near-match', status: 'error' },
			{ error: { code: 'capability_denied' }, id: 'denied', status: 'error' },
		]);
		expect(fixture.approval.reserveInvocations.map(({ call }) => call)).toEqual([
			{ arguments: {}, id: 'approval', namespace: 'github', name: 'create_issue' },
		]);
		expect(fixture.approval.armInvocations).toHaveLength(0);
		expect(totalBackendInvocations(fixture)).toBe(0);
	});

	it('derives stable operation identity from principal while preserving requester correlation and call fingerprint intent', async () => {
		// Arrange
		const approval = createRecordingApprovalPort();
		const fixture = createServiceFixture({ approval });
		const approvalCall = async (props: {
			readonly argumentsValue: Readonly<Record<string, string>>;
			readonly callId: string;
			readonly options: ToolPortalManagedServiceInvocationOptions;
		}): Promise<void> => {
			await fixture.capabilityCore.call(
				{
					calls: [
						{
							arguments: props.argumentsValue,
							id: props.callId,
							namespace: 'github',
							name: 'create_issue',
						},
					],
				},
				props.options,
			);
		};

		// Act
		await approvalCall({
			argumentsValue: { title: 'one' },
			callId: 'logical-call',
			options: udsOptions(),
		});
		await approvalCall({
			argumentsValue: { title: 'two' },
			callId: 'logical-call',
			options: udsOptions(),
		});
		await approvalCall({
			argumentsValue: { title: 'one' },
			callId: 'other-call',
			options: udsOptions(),
		});
		await approvalCall({
			argumentsValue: { title: 'one' },
			callId: 'logical-call',
			options: udsOptions({
				...agentATrustedContext,
				requester: { authenticatedSubjectId: 'subject-b' },
			}),
		});
		await approvalCall({
			argumentsValue: { title: 'one' },
			callId: 'logical-call',
			options: udsOptions({
				...agentATrustedContext,
				correlation: { sessionId: 'session-b' },
			}),
		});
		await approvalCall({
			argumentsValue: { title: 'one' },
			callId: 'logical-call',
			options: {
				origin: { kind: 'managed', trustedContext: agentATrustedContext },
				surfaceClass: 'mcp',
			},
		});

		// Assert
		const [
			first,
			changedArguments,
			changedCallId,
			changedRequester,
			changedSession,
			changedSurface,
		] = approval.reserveInvocations;
		expect(approval.reserveInvocations).toHaveLength(6);
		expect(first).toMatchObject({
			backendKind: 'mcp_provider',
			call: {
				arguments: { title: 'one' },
				id: 'logical-call',
				name: 'create_issue',
				namespace: 'github',
			},
			semanticRevisions: {
				activeRevision: semanticSnapshot.activeRevision,
				bindingRevision: semanticSnapshot.bindingRevision,
				catalogRevision: semanticSnapshot.catalogRevision,
				profilePolicyRevision: semanticSnapshot.profilePolicyRevision,
				providerRevision: semanticSnapshot.providerRevision,
				schemaRevision: semanticSnapshot.schemaRevision,
			},
			surfaceClass: 'protected_uds',
			trustedContext: agentATrustedContext,
		});
		expect(changedArguments?.operationId).toBe(first?.operationId);
		expect(changedArguments?.call.arguments).toEqual({ title: 'two' });
		expect(changedCallId?.operationId).not.toBe(first?.operationId);
		expect(changedRequester?.operationId).toBe(first?.operationId);
		expect(changedRequester?.trustedContext.requester?.authenticatedSubjectId).toBe('subject-b');
		expect(changedSession?.operationId).toBe(first?.operationId);
		expect(changedSession?.trustedContext.correlation?.sessionId).toBe('session-b');
		expect(changedSurface?.operationId).not.toBe(first?.operationId);
		expect(changedSurface?.surfaceClass).toBe('mcp');
	});

	it('binds without-approval dispatch authority to the exact call, principal, surface, and semantic generation fingerprint', async () => {
		// Arrange
		const logicalCallId = 'direct-logical-call';
		const baselineCall = {
			arguments: { issueNumber: '1' },
			id: logicalCallId,
			name: 'get_issue',
			namespace: 'github',
		} satisfies PortalCallRequest['calls'][number];
		const nextSemanticGeneration = {
			...directFingerprintSemanticSnapshot,
			activeRevision: 'semantic:13',
			desiredRevision: 'semantic:13',
		} satisfies GatewayRuntimePortalSemanticSnapshot;

		// Act
		const baseline = await captureDirectDispatch({ call: baselineCall, options: udsOptions() });
		const repeated = await captureDirectDispatch({ call: baselineCall, options: udsOptions() });
		const changedArguments = await captureDirectDispatch({
			call: { ...baselineCall, arguments: { issueNumber: '2' } },
			options: udsOptions(),
		});
		const changedCapabilityName = await captureDirectDispatch({
			call: { ...baselineCall, name: 'get_issue_details' },
			options: udsOptions(),
		});
		const changedCapabilityNamespace = await captureDirectDispatch({
			call: { ...baselineCall, namespace: 'github_alias' },
			options: udsOptions(),
		});
		const changedAuthenticatedSubject = await captureDirectDispatch({
			call: baselineCall,
			options: udsOptions({
				...agentATrustedContext,
				requester: { authenticatedSubjectId: 'subject-b' },
			}),
		});
		const changedSession = await captureDirectDispatch({
			call: baselineCall,
			options: udsOptions({ ...agentATrustedContext, correlation: { sessionId: 'session-b' } }),
		});
		const changedPrincipal = await captureDirectDispatch({
			call: baselineCall,
			options: udsOptions(agentBTrustedContext),
		});
		const changedSurface = await captureDirectDispatch({
			call: baselineCall,
			options: {
				origin: { kind: 'managed', trustedContext: agentATrustedContext },
				surfaceClass: 'mcp',
			},
		});
		const changedSemanticGeneration = await captureDirectDispatch({
			call: baselineCall,
			options: udsOptions(),
			semanticSnapshot: nextSemanticGeneration,
		});
		const fingerprints = {
			baseline: requireDirectDispatchFingerprint(baseline.authority),
			changedArguments: requireDirectDispatchFingerprint(changedArguments.authority),
			changedAuthenticatedSubject: requireDirectDispatchFingerprint(
				changedAuthenticatedSubject.authority,
			),
			changedCapabilityName: requireDirectDispatchFingerprint(changedCapabilityName.authority),
			changedCapabilityNamespace: requireDirectDispatchFingerprint(
				changedCapabilityNamespace.authority,
			),
			changedSemanticGeneration: requireDirectDispatchFingerprint(
				changedSemanticGeneration.authority,
			),
			changedSurface: requireDirectDispatchFingerprint(changedSurface.authority),
			changedPrincipal: requireDirectDispatchFingerprint(changedPrincipal.authority),
			changedSession: requireDirectDispatchFingerprint(changedSession.authority),
			repeated: requireDirectDispatchFingerprint(repeated.authority),
		};

		// Assert
		expect(fingerprints.repeated).toBe(fingerprints.baseline);
		expect([
			fingerprints.changedArguments,
			fingerprints.changedCapabilityName,
			fingerprints.changedCapabilityNamespace,
			fingerprints.changedPrincipal,
			fingerprints.changedSurface,
			fingerprints.changedSemanticGeneration,
		]).not.toContain(fingerprints.baseline);
		expect(fingerprints.changedAuthenticatedSubject).toBe(fingerprints.baseline);
		expect(fingerprints.changedSession).toBe(fingerprints.baseline);
		expect(changedArguments.operationId).toBe(baseline.operationId);
		expect(changedCapabilityName.operationId).toBe(baseline.operationId);
		expect(changedCapabilityNamespace.operationId).toBe(baseline.operationId);
		expect(changedAuthenticatedSubject.operationId).toBe(baseline.operationId);
		expect(changedSession.operationId).toBe(baseline.operationId);
		expect(changedPrincipal.operationId).not.toBe(baseline.operationId);
	});
});
