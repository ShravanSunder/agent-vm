import { describe, expect, it } from 'vitest';

import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import { stablePrincipalKey } from './tool-vm-lease-authority-state-helpers.js';
import {
	authorizeCurrentToolVmLeafBinding,
	createEmptyToolVmLeaseAuthorityState,
	reduceToolVmLeaseAuthorityState,
	ToolVmLeaseAuthorityTransitionError,
	type StableToolVmLeasePrincipal,
	type ToolVmLeafAuthorityReference,
	type ToolVmLeaseAuthorityState,
	type ToolVmLeaseCompatibility,
	type StartToolVmActiveUseInput,
} from './tool-vm-lease-authority-state.js';

const GATEWAY_ONE = {
	bootId: 'gateway-boot-1',
	controllerEpoch: 'controller-epoch-1',
	gatewayEpochId: 'gateway-epoch-1',
	gatewayVmId: 'gateway-vm-1',
	generationId: 'gateway-generation-1',
	zoneId: 'shravan',
} satisfies GatewayEpochIdentity;

const GATEWAY_TWO = {
	...GATEWAY_ONE,
	bootId: 'gateway-boot-2',
	gatewayEpochId: 'gateway-epoch-2',
	gatewayVmId: 'gateway-vm-2',
	generationId: 'gateway-generation-2',
} satisfies GatewayEpochIdentity;

const PRINCIPAL_MAIN = {
	agentId: 'main',
	frameworkIdentity: { kind: 'hermes', profileName: 'main' },
	profileAssignmentRevision: 'assignment-main',
	toolPortalProfileId: 'standard',
} satisfies StableToolVmLeasePrincipal;

const PRINCIPAL_SIBLING = {
	...PRINCIPAL_MAIN,
	agentId: 'sibling',
	frameworkIdentity: { kind: 'hermes', profileName: 'sibling' },
	profileAssignmentRevision: 'assignment-sibling',
} satisfies StableToolVmLeasePrincipal;

const COMPATIBILITY = {
	policyFingerprint: 'policy-a',
	profileId: 'standard',
	profileAssignmentRevision: 'assignment-main',
	purpose: 'coding',
} satisfies ToolVmLeaseCompatibility;

const AUTHORITY_REFERENCE_EXCLUDES_IDLE_EXPIRY: 'idleExpiresAtMs' extends keyof ToolVmLeafAuthorityReference
	? false
	: true = true;

function authorityReference(
	options: {
		readonly gateway?: GatewayEpochIdentity;
		readonly leaseId?: string;
		readonly leafGeneration?: string;
		readonly principal?: StableToolVmLeasePrincipal;
	} = {},
): ToolVmLeafAuthorityReference {
	return {
		gateway: options.gateway ?? GATEWAY_ONE,
		leaseId: options.leaseId ?? `lease-${options.leafGeneration ?? 'leaf-generation-1'}`,
		leafGeneration: options.leafGeneration ?? 'leaf-generation-1',
		principal: options.principal ?? PRINCIPAL_MAIN,
	};
}

function registerGateway(
	state: ToolVmLeaseAuthorityState = createEmptyToolVmLeaseAuthorityState(),
	gateway: GatewayEpochIdentity = GATEWAY_ONE,
): ToolVmLeaseAuthorityState {
	return reduceToolVmLeaseAuthorityState(state, {
		kind: 'register-parent',
		gateway,
	});
}

function beginProvisioning(
	state: ToolVmLeaseAuthorityState,
	options: {
		readonly compatibility?: ToolVmLeaseCompatibility;
		readonly gateway?: GatewayEpochIdentity;
		readonly leaseId?: string;
		readonly leafGeneration?: string;
		readonly idleExpiresAtMs?: number;
		readonly principal?: StableToolVmLeasePrincipal;
	} = {},
): ToolVmLeaseAuthorityState {
	return reduceToolVmLeaseAuthorityState(state, {
		authority: authorityReference(options),
		compatibility: options.compatibility ?? COMPATIBILITY,
		kind: 'begin-provisioning',
		idleExpiresAtMs: options.idleExpiresAtMs ?? 10_000,
	});
}

function commitCurrent(
	state: ToolVmLeaseAuthorityState,
	options: {
		readonly gateway?: GatewayEpochIdentity;
		readonly leaseId?: string;
		readonly leafGeneration?: string;
		readonly principal?: StableToolVmLeasePrincipal;
		readonly sshBindingId?: string;
		readonly vmId?: string;
	} = {},
): ToolVmLeaseAuthorityState {
	const leafGeneration = options.leafGeneration ?? 'leaf-generation-1';
	return reduceToolVmLeaseAuthorityState(state, {
		authority: authorityReference(options),
		kind: 'commit-current',
		runtimeBinding: {
			runtimeRecordId: `runtime-${leafGeneration}`,
			tcpSlot: leafGeneration === 'leaf-generation-1' ? 1 : 2,
			vmId: options.vmId ?? `tool-vm-${leafGeneration}`,
		},
		sshBinding: {
			bindingId: options.sshBindingId ?? `ssh-${leafGeneration}`,
			host: '127.0.0.1',
			identityFile: `/tmp/${leafGeneration}`,
			port: 19_000,
			serverIdentity: `host-key-${leafGeneration}`,
			user: 'sandbox',
		},
	});
}

function createCurrentLeaf(
	options: {
		readonly gateway?: GatewayEpochIdentity;
		readonly leaseId?: string;
		readonly leafGeneration?: string;
		readonly idleExpiresAtMs?: number;
		readonly principal?: StableToolVmLeasePrincipal;
	} = {},
): ToolVmLeaseAuthorityState {
	const gateway = options.gateway ?? GATEWAY_ONE;
	return commitCurrent(beginProvisioning(registerGateway(undefined, gateway), options), options);
}

function activeUseInput(
	overrides: Partial<StartToolVmActiveUseInput> = {},
): StartToolVmActiveUseInput {
	return {
		lastHeartbeatAtMs: 100,
		operationPayloadDigest: 'payload-digest-1',
		processEpoch: 'process-1',
		semanticOperationId: 'operation-1',
		sessionAttachmentGeneration: 7,
		startedAtMs: 100,
		useId: 'use-1',
		...overrides,
	};
}

function expectTransitionError(
	operation: () => unknown,
	code: ToolVmLeaseAuthorityTransitionError['code'],
): void {
	let thrownError: unknown;
	try {
		operation();
	} catch (error) {
		thrownError = error;
	}
	expect(thrownError).toBeInstanceOf(ToolVmLeaseAuthorityTransitionError);
	expect(thrownError).toMatchObject({ code });
}

describe('Tool VM lease authority state', () => {
	it('freezes the accepted default retention and observation-gap budgets', () => {
		expect(createEmptyToolVmLeaseAuthorityState().retentionPolicy).toEqual({
			leafTombstoneTtlMs: 60 * 60 * 1_000,
			maxLeafTombstones: 4_096,
			maxTerminalUseTombstones: 4_096,
			observationGapGraceMs: 120_000,
			terminalUseTombstoneTtlMs: 10 * 60 * 1_000,
		});
	});

	it('admits one non-routable B while retaining access-fencing A by exact generation', () => {
		// Arrange
		const principalRevisionA = {
			...PRINCIPAL_MAIN,
			profileAssignmentRevision: 'assignment-a',
		} as const;
		const principalRevisionB = {
			...principalRevisionA,
			profileAssignmentRevision: 'assignment-b',
		} as const;
		const authorityA = authorityReference({ principal: principalRevisionA });
		const authorityB = authorityReference({
			leaseId: 'lease-b',
			leafGeneration: 'leaf-generation-b',
			principal: principalRevisionB,
		});
		const currentA = commitCurrent(
			beginProvisioning(registerGateway(), { principal: principalRevisionA }),
			{ principal: principalRevisionA },
		);
		const accessFencingA = reduceToolVmLeaseAuthorityState(currentA, {
			ambiguousAtMs: 200,
			authority: authorityA,
			kind: 'begin-destruction',
			reason: 'profile-revision-rollover',
		});

		// Act
		const provisioningB = beginProvisioning(accessFencingA, {
			leaseId: authorityB.leaseId,
			leafGeneration: authorityB.leafGeneration,
			principal: principalRevisionB,
		});

		// Assert
		expect(accessFencingA.currentPrincipalKeyByAgentId.has(PRINCIPAL_MAIN.agentId)).toBe(false);
		expect(accessFencingA.leavesByPrincipal.has(stablePrincipalKey(principalRevisionA))).toBe(
			false,
		);
		expect(
			accessFencingA.accessFencingLeavesByGeneration.get(authorityA.leafGeneration),
		).toMatchObject({ kind: 'destroying', leaseId: authorityA.leaseId });
		expect(
			provisioningB.leavesByPrincipal.get(stablePrincipalKey(principalRevisionB)),
		).toMatchObject({ kind: 'provisioning', leaseId: authorityB.leaseId });
		expectTransitionError(
			() =>
				authorizeCurrentToolVmLeafBinding(provisioningB, {
					authority: authorityB,
					compatibility: COMPATIBILITY,
					nowMs: 100,
					sshBindingId: 'ssh-leaf-generation-b',
				}),
			'leaf-not-current',
		);
		expectTransitionError(
			() =>
				commitCurrent(provisioningB, {
					leaseId: authorityB.leaseId,
					leafGeneration: authorityB.leafGeneration,
					principal: principalRevisionB,
				}),
			'predecessor-access-not-fenced',
		);
		expectTransitionError(
			() =>
				beginProvisioning(provisioningB, {
					leaseId: 'lease-c',
					leafGeneration: 'leaf-generation-c',
					principal: principalRevisionB,
				}),
			'leaf-already-exists',
		);

		// Act
		const retiringA = reduceToolVmLeaseAuthorityState(provisioningB, {
			authority: authorityA,
			kind: 'access-fenced',
		});
		const currentB = commitCurrent(retiringA, {
			leaseId: authorityB.leaseId,
			leafGeneration: authorityB.leafGeneration,
			principal: principalRevisionB,
		});

		// Assert
		expect(currentB.retiringLeavesByGeneration.get(authorityA.leafGeneration)).toMatchObject({
			kind: 'retiring',
			leaseId: authorityA.leaseId,
		});
		expect(currentB.leavesByPrincipal.get(stablePrincipalKey(principalRevisionB))).toMatchObject({
			kind: 'current',
			leaseId: authorityB.leaseId,
		});
		expect(currentB.currentPrincipalKeyByAgentId.get(PRINCIPAL_MAIN.agentId)).toBe(
			stablePrincipalKey(principalRevisionB),
		);
		expectTransitionError(
			() =>
				authorizeCurrentToolVmLeafBinding(currentB, {
					authority: authorityA,
					compatibility: COMPATIBILITY,
					nowMs: 100,
					sshBindingId: 'ssh-leaf-generation-1',
				}),
			'leaf-not-current',
		);

		// Act
		const cleanupDebtA = reduceToolVmLeaseAuthorityState(currentB, {
			authority: authorityA,
			kind: 'destruction-incomplete',
			reason: 'provider-cleanup-incomplete-after-containment',
		});
		const cleanedA = reduceToolVmLeaseAuthorityState(cleanupDebtA, {
			authority: authorityA,
			destroyedAtMs: 300,
			kind: 'destruction-completed',
			reason: 'cleanup-retried',
		});

		// Assert
		expect(cleanupDebtA.parent).toEqual({ gateway: GATEWAY_ONE, kind: 'registered' });
		expect(cleanupDebtA.retiringLeavesByGeneration.get(authorityA.leafGeneration)).toMatchObject({
			cleanupIncompleteReason: 'provider-cleanup-incomplete-after-containment',
			kind: 'retiring',
		});
		expect(cleanedA.retiringLeavesByGeneration.has(authorityA.leafGeneration)).toBe(false);
		expect(cleanedA.leavesByPrincipal.get(stablePrincipalKey(principalRevisionB))).toMatchObject({
			kind: 'current',
			leaseId: authorityB.leaseId,
		});
	});

	it.each(['running', 'observation-gap'] as const)(
		'classifies %s work ambiguous during rollover and preserves evidence after cleanup',
		(activeUseKind) => {
			const authority = authorityReference();
			const activeUse = activeUseInput({
				correlation: {
					runId: 'run-rollover',
					traceId: '0123456789abcdef0123456789abcdef',
				},
				latestOperationReport: {
					observedAtMs: 125,
					phase: 'running',
				},
			});
			const latestReport = {
				reportedAtMs: 125,
				sequence: 1,
				status: 'running' as const,
				summary: 'rollover evidence',
			};
			let state = reduceToolVmLeaseAuthorityState(createCurrentLeaf(), {
				authority,
				kind: 'start-active-use',
				use: activeUse,
			});
			state = reduceToolVmLeaseAuthorityState(state, {
				authority,
				heartbeatAtMs: latestReport.reportedAtMs,
				kind: 'heartbeat-active-use',
				processEpoch: activeUse.processEpoch,
				report: latestReport,
				sessionAttachmentGeneration: activeUse.sessionAttachmentGeneration,
				useId: activeUse.useId,
			});
			if (activeUseKind === 'observation-gap') {
				state = reduceToolVmLeaseAuthorityState(state, {
					gateway: GATEWAY_ONE,
					kind: 'session-disconnected',
					observedAtMs: 150,
					processEpoch: 'process-1',
					sessionAttachmentGeneration: 7,
				});
			}

			const destroying = reduceToolVmLeaseAuthorityState(state, {
				ambiguousAtMs: 200,
				authority,
				kind: 'begin-destruction',
				reason: 'health-rollover',
			});
			const retiring = reduceToolVmLeaseAuthorityState(destroying, {
				authority,
				kind: 'access-fenced',
			});
			const destroyed = reduceToolVmLeaseAuthorityState(retiring, {
				authority,
				destroyedAtMs: 300,
				kind: 'destruction-completed',
				reason: 'health-rollover',
				vmId: 'tool-vm-leaf-generation-1',
			});

			expect(
				destroying.accessFencingLeavesByGeneration.get(authority.leafGeneration),
			).toMatchObject({
				activeUses: new Map([
					[
						'use-1',
						expect.objectContaining({
							ambiguousAtMs: 200,
							kind: 'ambiguous',
							reason: 'leaf-rollover',
						}),
					],
				]),
				kind: 'destroying',
			});
			expect([...destroyed.terminalUseTombstones.values()]).toEqual([
				expect.objectContaining({
					endedAtMs: 300,
					leafGeneration: authority.leafGeneration,
					outcome: 'ambiguous-rollover',
					ambiguousAtMs: 200,
					ambiguityReason: 'leaf-rollover',
					correlation: activeUse.correlation,
					latestOperationReport: activeUse.latestOperationReport,
					latestReport,
					operationPayloadDigest: activeUse.operationPayloadDigest,
					principal: PRINCIPAL_MAIN,
					processEpoch: activeUse.processEpoch,
					semanticOperationId: activeUse.semanticOperationId,
					startedAtMs: activeUse.startedAtMs,
					useId: 'use-1',
				}),
			]);
		},
	);

	it('evicts the oldest terminal-use evidence instead of blocking physical destruction', () => {
		const authority = authorityReference();
		const boundedState = createEmptyToolVmLeaseAuthorityState({
			retentionPolicy: { maxTerminalUseTombstones: 1 },
		});
		const current = commitCurrent(beginProvisioning(registerGateway(boundedState)));
		const firstUseId = '0190a5f1-1234-7abc-8def-1234567890ab';
		const rolloverUseId = '0190a5f1-1235-7abc-8def-1234567890ab';
		const firstRunning = reduceToolVmLeaseAuthorityState(current, {
			authority,
			kind: 'start-active-use',
			use: activeUseInput({ useId: firstUseId }),
		});
		const firstTerminal = reduceToolVmLeaseAuthorityState(firstRunning, {
			authority,
			endedAtMs: 150,
			kind: 'end-active-use',
			outcome: 'completed',
			processEpoch: 'process-1',
			sessionAttachmentGeneration: 7,
			useId: firstUseId,
		});
		const rolloverRunning = reduceToolVmLeaseAuthorityState(firstTerminal, {
			authority,
			kind: 'start-active-use',
			use: activeUseInput({
				operationPayloadDigest: 'rollover-payload',
				semanticOperationId: 'rollover-operation',
				useId: rolloverUseId,
			}),
		});
		const destroying = reduceToolVmLeaseAuthorityState(rolloverRunning, {
			ambiguousAtMs: 200,
			authority,
			kind: 'begin-destruction',
			reason: 'health-rollover',
		});
		const retiring = reduceToolVmLeaseAuthorityState(destroying, {
			authority,
			kind: 'access-fenced',
		});

		const destroyed = reduceToolVmLeaseAuthorityState(retiring, {
			authority,
			destroyedAtMs: 300,
			kind: 'destruction-completed',
			reason: 'health-rollover',
			vmId: 'tool-vm-leaf-generation-1',
		});

		expect(destroyed.tombstonesByGeneration.has(authority.leafGeneration)).toBe(true);
		expect([...destroyed.terminalUseTombstones.values()]).toEqual([
			expect.objectContaining({
				outcome: 'ambiguous-rollover',
				useId: rolloverUseId,
			}),
		]);
	});

	it('refuses an ambiguous A useId on B and admits genuinely new B work', () => {
		const principalRevisionA = {
			...PRINCIPAL_MAIN,
			profileAssignmentRevision: 'assignment-a',
		} as const;
		const principalRevisionB = {
			...principalRevisionA,
			profileAssignmentRevision: 'assignment-b',
		} as const;
		const authorityA = authorityReference({ principal: principalRevisionA });
		const authorityB = authorityReference({
			leaseId: 'lease-b',
			leafGeneration: 'leaf-generation-b',
			principal: principalRevisionB,
		});
		const retiredUseId = '0190a5f1-1234-7abc-8def-1234567890ab';
		const freshUseId = '0190a5f1-1235-7abc-8def-1234567890ab';
		const retiredUse = activeUseInput({ useId: retiredUseId });
		const currentA = commitCurrent(
			beginProvisioning(registerGateway(), { principal: principalRevisionA }),
			{ principal: principalRevisionA },
		);
		const runningA = reduceToolVmLeaseAuthorityState(currentA, {
			authority: authorityA,
			kind: 'start-active-use',
			use: retiredUse,
		});
		const destroyingA = reduceToolVmLeaseAuthorityState(runningA, {
			ambiguousAtMs: 200,
			authority: authorityA,
			kind: 'begin-destruction',
			reason: 'profile-revision-rollover',
		});
		const retiringA = reduceToolVmLeaseAuthorityState(destroyingA, {
			authority: authorityA,
			kind: 'access-fenced',
		});
		const destroyedA = reduceToolVmLeaseAuthorityState(retiringA, {
			authority: authorityA,
			destroyedAtMs: 300,
			kind: 'destruction-completed',
			reason: 'profile-revision-rollover',
			vmId: 'tool-vm-leaf-generation-1',
		});
		const currentB = commitCurrent(
			beginProvisioning(destroyedA, {
				leaseId: authorityB.leaseId,
				leafGeneration: authorityB.leafGeneration,
				principal: principalRevisionB,
			}),
			{
				leaseId: authorityB.leaseId,
				leafGeneration: authorityB.leafGeneration,
				principal: principalRevisionB,
			},
		);

		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(currentB, {
					authority: authorityB,
					kind: 'start-active-use',
					use: retiredUse,
				}),
			'active-use-not-resumable',
		);
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(currentB, {
					authority: authorityB,
					kind: 'start-active-use',
					use: {
						...retiredUse,
						processEpoch: 'process-b',
						semanticOperationId: 'operation-b',
					},
				}),
			'active-use-semantic-collision',
		);
		const freshB = reduceToolVmLeaseAuthorityState(currentB, {
			authority: authorityB,
			kind: 'start-active-use',
			use: activeUseInput({
				operationPayloadDigest: 'payload-b',
				processEpoch: 'process-b',
				semanticOperationId: 'operation-b',
				useId: freshUseId,
			}),
		});
		expect(freshB.leavesByPrincipal.get(stablePrincipalKey(principalRevisionB))).toMatchObject({
			activeUses: new Map([[freshUseId, expect.objectContaining({ kind: 'running' })]]),
			kind: 'current',
		});
	});

	it('refuses ambiguous A work on current B while A cleanup remains pending', () => {
		// Arrange
		const principalRevisionA = {
			...PRINCIPAL_MAIN,
			profileAssignmentRevision: 'assignment-a',
		} as const;
		const principalRevisionB = {
			...principalRevisionA,
			profileAssignmentRevision: 'assignment-b',
		} as const;
		const authorityA = authorityReference({ principal: principalRevisionA });
		const authorityB = authorityReference({
			leaseId: 'lease-b',
			leafGeneration: 'leaf-generation-b',
			principal: principalRevisionB,
		});
		const ambiguousUseId = '0190a5f1-1234-7abc-8def-1234567890ab';
		const freshUseId = '0190a5f1-1235-7abc-8def-1234567890ab';
		const ambiguousUse = activeUseInput({ useId: ambiguousUseId });
		const currentA = commitCurrent(
			beginProvisioning(registerGateway(), { principal: principalRevisionA }),
			{ principal: principalRevisionA },
		);
		const runningA = reduceToolVmLeaseAuthorityState(currentA, {
			authority: authorityA,
			kind: 'start-active-use',
			use: ambiguousUse,
		});
		const destroyingA = reduceToolVmLeaseAuthorityState(runningA, {
			ambiguousAtMs: 200,
			authority: authorityA,
			kind: 'begin-destruction',
			reason: 'profile-revision-rollover',
		});
		const retiringA = reduceToolVmLeaseAuthorityState(destroyingA, {
			authority: authorityA,
			kind: 'access-fenced',
		});
		const currentB = commitCurrent(
			beginProvisioning(retiringA, {
				leaseId: authorityB.leaseId,
				leafGeneration: authorityB.leafGeneration,
				principal: principalRevisionB,
			}),
			{
				leaseId: authorityB.leaseId,
				leafGeneration: authorityB.leafGeneration,
				principal: principalRevisionB,
			},
		);

		// Act / Assert
		expect(currentB.retiringLeavesByGeneration.get(authorityA.leafGeneration)).toMatchObject({
			kind: 'retiring',
		});
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(currentB, {
					authority: authorityB,
					kind: 'start-active-use',
					use: ambiguousUse,
				}),
			'active-use-not-resumable',
		);
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(currentB, {
					authority: authorityB,
					kind: 'start-active-use',
					use: {
						...ambiguousUse,
						operationPayloadDigest: 'payload-b',
						processEpoch: 'process-b',
						semanticOperationId: 'operation-b',
					},
				}),
			'active-use-semantic-collision',
		);
		const freshB = reduceToolVmLeaseAuthorityState(currentB, {
			authority: authorityB,
			kind: 'start-active-use',
			use: activeUseInput({
				operationPayloadDigest: 'payload-b',
				processEpoch: 'process-b',
				semanticOperationId: 'operation-b',
				useId: freshUseId,
			}),
		});
		expect(freshB.leavesByPrincipal.get(stablePrincipalKey(principalRevisionB))).toMatchObject({
			activeUses: new Map([[freshUseId, expect.objectContaining({ kind: 'running' })]]),
			kind: 'current',
		});
	});

	it('retains containment-unproven A by generation while one successor B remains provisional', () => {
		// Arrange
		const authorityA = authorityReference();
		const accessFencingA = reduceToolVmLeaseAuthorityState(createCurrentLeaf(), {
			ambiguousAtMs: 200,
			authority: authorityA,
			kind: 'begin-destruction',
			reason: 'health-rollover',
		});

		// Assert
		expect(accessFencingA.currentPrincipalKeyByAgentId.has(PRINCIPAL_MAIN.agentId)).toBe(false);
		expect(accessFencingA.leavesByPrincipal.has(stablePrincipalKey(PRINCIPAL_MAIN))).toBe(false);
		expect(
			accessFencingA.accessFencingLeavesByGeneration.get(authorityA.leafGeneration),
		).toMatchObject({ kind: 'destroying' });
		expectTransitionError(
			() =>
				authorizeCurrentToolVmLeafBinding(accessFencingA, {
					authority: authorityA,
					compatibility: COMPATIBILITY,
					nowMs: 100,
					sshBindingId: 'ssh-leaf-generation-1',
				}),
			'leaf-not-current',
		);
		const provisionalB = beginProvisioning(accessFencingA, {
			leaseId: 'lease-b',
			leafGeneration: 'leaf-generation-b',
		});

		// Act
		const containmentUnprovenA = reduceToolVmLeaseAuthorityState(provisionalB, {
			authority: authorityA,
			kind: 'destruction-incomplete',
			reason: 'managed-vm-close-unproven',
		});

		// Assert
		expect(
			containmentUnprovenA.accessFencingLeavesByGeneration.get(authorityA.leafGeneration),
		).toMatchObject({ kind: 'owner-unsafe' });
		expect(
			containmentUnprovenA.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN)),
		).toMatchObject({ kind: 'provisioning', leaseId: 'lease-b' });
		expectTransitionError(
			() => beginProvisioning(containmentUnprovenA, { leafGeneration: 'leaf-generation-b' }),
			'leaf-already-exists',
		);
	});

	it('refuses parent retirement while an access-fenced predecessor still has cleanup debt', () => {
		// Arrange
		const authority = authorityReference();
		const retiring = reduceToolVmLeaseAuthorityState(
			reduceToolVmLeaseAuthorityState(
				reduceToolVmLeaseAuthorityState(createCurrentLeaf(), {
					ambiguousAtMs: 200,
					authority,
					kind: 'begin-destruction',
					reason: 'gateway-shutdown',
				}),
				{ authority, kind: 'access-fenced' },
			),
			{ gateway: GATEWAY_ONE, kind: 'seal-parent' },
		);

		// Act / Assert
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(retiring, {
					gateway: GATEWAY_ONE,
					kind: 'retire-parent',
				}),
			'parent-has-live-leaves',
		);
	});

	it('serializes provisional/current authority and rejects stale asynchronous commits', () => {
		const registered = registerGateway();
		const provisional = beginProvisioning(registered);

		expectTransitionError(
			() => beginProvisioning(provisional, { leafGeneration: 'leaf-generation-2' }),
			'leaf-already-exists',
		);
		expectTransitionError(
			() => commitCurrent(provisional, { leafGeneration: 'leaf-generation-stale' }),
			'leaf-generation-mismatch',
		);

		const current = commitCurrent(provisional);
		expect(current.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))).toMatchObject({
			kind: 'current',
			leafGeneration: 'leaf-generation-1',
		});
	});

	it.each([
		{
			code: 'parent-unregistered' as const,
			name: 'unregistered',
			state: createEmptyToolVmLeaseAuthorityState(),
		},
		{
			code: 'parent-not-admitting' as const,
			name: 'sealed',
			state: reduceToolVmLeaseAuthorityState(registerGateway(), {
				gateway: GATEWAY_ONE,
				kind: 'seal-parent',
			}),
		},
		{
			code: 'parent-not-admitting' as const,
			name: 'retired',
			state: reduceToolVmLeaseAuthorityState(
				reduceToolVmLeaseAuthorityState(registerGateway(), {
					gateway: GATEWAY_ONE,
					kind: 'seal-parent',
				}),
				{ gateway: GATEWAY_ONE, kind: 'retire-parent' },
			),
		},
	])('denies provisioning under a $name Gateway parent', ({ code, state }) => {
		expectTransitionError(() => beginProvisioning(state), code);
	});

	it('completes an admitted late commit after seal while denying every cross-Gateway authority mutation', () => {
		const provisional = beginProvisioning(registerGateway());
		const sealed = reduceToolVmLeaseAuthorityState(provisional, {
			gateway: GATEWAY_ONE,
			kind: 'seal-parent',
		});
		const committedAfterSeal = commitCurrent(sealed);

		expect(committedAfterSeal.parent).toEqual({ gateway: GATEWAY_ONE, kind: 'sealed' });
		expect(
			committedAfterSeal.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN)),
		).toMatchObject({
			kind: 'current',
			leafGeneration: 'leaf-generation-1',
		});
		expectTransitionError(
			() => commitCurrent(sealed, { gateway: GATEWAY_TWO }),
			'parent-identity-mismatch',
		);
		expectTransitionError(
			() => beginProvisioning(registerGateway(), { gateway: GATEWAY_TWO }),
			'parent-identity-mismatch',
		);
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(committedAfterSeal, {
					gateway: GATEWAY_TWO,
					kind: 'retire-parent',
				}),
			'parent-identity-mismatch',
		);
	});

	it('quarantines a provisional allocation and blocks a successor until exact destruction', () => {
		const authority = authorityReference();
		const provisional = beginProvisioning(registerGateway());
		const quarantined = reduceToolVmLeaseAuthorityState(provisional, {
			authority,
			kind: 'quarantine',
			reason: 'containment-uncertain',
		});

		expect(quarantined.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))).toMatchObject({
			kind: 'quarantined',
			quarantineReason: 'containment-uncertain',
		});
		expectTransitionError(
			() => beginProvisioning(quarantined, { leafGeneration: 'leaf-generation-2' }),
			'leaf-already-exists',
		);
	});

	it('restores one suspect leaf without rotating its stable runtime or SSH binding', () => {
		const authority = authorityReference();
		const current = createCurrentLeaf();
		const currentLeaf = current.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN));
		if (currentLeaf?.kind !== 'current') {
			throw new Error('Expected current Tool VM lease leaf fixture.');
		}
		const suspect = reduceToolVmLeaseAuthorityState(current, {
			authority,
			kind: 'mark-suspect',
			reason: 'ssh',
		});
		const restored = reduceToolVmLeaseAuthorityState(suspect, {
			authority,
			kind: 'restore-current',
		});

		expect(restored.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))).toMatchObject({
			kind: 'current',
			runtimeBinding: currentLeaf.runtimeBinding,
			sshBinding: currentLeaf.sshBinding,
		});
	});

	it.each([
		{
			code: 'leaf-generation-mismatch' as const,
			name: 'stale generation',
			reference: authorityReference({ leafGeneration: 'leaf-generation-stale' }),
		},
		{
			code: 'principal-mismatch' as const,
			name: 'cross-agent',
			reference: authorityReference({ principal: PRINCIPAL_SIBLING }),
		},
		{
			code: 'parent-identity-mismatch' as const,
			name: 'cross-Gateway',
			reference: authorityReference({ gateway: GATEWAY_TWO }),
		},
	])('denies $name leaf binding authority', ({ code, reference }) => {
		const state = createCurrentLeaf();
		expectTransitionError(
			() =>
				authorizeCurrentToolVmLeafBinding(state, {
					authority: reference,
					compatibility: COMPATIBILITY,
					nowMs: 100,
					sshBindingId: 'ssh-leaf-generation-1',
				}),
			code,
		);
	});

	it('denies incompatible reattachment even for the same principal and generation', () => {
		const state = createCurrentLeaf();
		expectTransitionError(
			() =>
				authorizeCurrentToolVmLeafBinding(state, {
					authority: authorityReference(),
					compatibility: { ...COMPATIBILITY, policyFingerprint: 'policy-b' },
					nowMs: 100,
					sshBindingId: 'ssh-leaf-generation-1',
				}),
			'compatibility-conflict',
		);
	});

	it('authorizes only the exact current lease before the half-open idle-expiry boundary', () => {
		const authority = authorityReference({ leaseId: 'lease-current' });
		const state = createCurrentLeaf({
			leaseId: authority.leaseId,
			idleExpiresAtMs: 500,
		});
		const authorized = authorizeCurrentToolVmLeafBinding(state, {
			authority,
			compatibility: COMPATIBILITY,
			nowMs: 499,
			sshBindingId: 'ssh-leaf-generation-1',
		});
		expect(authorized).toMatchObject({
			leaseId: 'lease-current',
			idleExpiresAtMs: 500,
			runtimeBinding: { vmId: 'tool-vm-leaf-generation-1' },
		});
		expect(
			authorizeCurrentToolVmLeafBinding(state, {
				authority,
				compatibility: COMPATIBILITY,
				nowMs: 499,
				sshBindingId: 'ssh-leaf-generation-1',
			}),
		).toMatchObject({ runtimeBinding: { vmId: 'tool-vm-leaf-generation-1' } });
		expectTransitionError(
			() =>
				authorizeCurrentToolVmLeafBinding(state, {
					authority: { ...authority, leaseId: 'lease-stale' },
					compatibility: COMPATIBILITY,
					nowMs: 499,
					sshBindingId: 'ssh-leaf-generation-1',
				}),
			'lease-identity-mismatch',
		);
		for (const nowMs of [500, 501]) {
			expectTransitionError(
				() =>
					authorizeCurrentToolVmLeafBinding(state, {
						authority,
						compatibility: COMPATIBILITY,
						nowMs,
						sshBindingId: 'ssh-leaf-generation-1',
					}),
				'lease-expired',
			);
		}
	});

	it('does not carry controller-owned idle expiry in a caller authority reference', () => {
		expect(AUTHORITY_REFERENCE_EXCLUDES_IDLE_EXPIRY).toBe(true);
		expect(authorityReference()).not.toHaveProperty('idleExpiresAtMs');
	});

	it('advances the idle-expiry deadline monotonically on renewal', () => {
		const authority = authorityReference();
		const state = createCurrentLeaf({ idleExpiresAtMs: 500 });

		const renewed = reduceToolVmLeaseAuthorityState(state, {
			authority,
			kind: 'renew-idle-expiry',
			nextIdleExpiresAtMs: 1_000,
			nowMs: 400,
		});

		expect(renewed.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))).toMatchObject({
			idleExpiresAtMs: 1_000,
			kind: 'current',
		});
	});

	it.each([
		{ name: 'equal to the current deadline', nextIdleExpiresAtMs: 500, nowMs: 400 },
		{ name: 'behind the current deadline', nextIdleExpiresAtMs: 499, nowMs: 400 },
	])('rejects an idle-expiry renewal $name', ({ nextIdleExpiresAtMs, nowMs }) => {
		const authority = authorityReference();
		const state = createCurrentLeaf({ idleExpiresAtMs: 500 });

		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(state, {
					authority,
					kind: 'renew-idle-expiry',
					nextIdleExpiresAtMs,
					nowMs,
				}),
			'idle-expiry-regressed',
		);
	});

	it('rejects an idle-expiry deadline not later than the observation even during active use', () => {
		const authority = authorityReference();
		const running = reduceToolVmLeaseAuthorityState(createCurrentLeaf({ idleExpiresAtMs: 500 }), {
			authority,
			kind: 'start-active-use',
			use: activeUseInput(),
		});

		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(running, {
					authority,
					kind: 'renew-idle-expiry',
					nextIdleExpiresAtMs: 750,
					nowMs: 1_000,
				}),
			'idle-expiry-regressed',
		);
	});

	it('rejects renewal after idle expiry when no non-terminal use holds the leaf', () => {
		const authority = authorityReference();
		const idle = createCurrentLeaf({ idleExpiresAtMs: 500 });

		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(idle, {
					authority,
					kind: 'renew-idle-expiry',
					nextIdleExpiresAtMs: 1_100,
					nowMs: 600,
				}),
			'lease-expired',
		);
	});

	it.each(['running', 'observation-gap'] as const)(
		'permits renewal after idle expiry while an exact %s use remains non-terminal',
		(activeUseKind) => {
			const authority = authorityReference();
			let state = reduceToolVmLeaseAuthorityState(createCurrentLeaf({ idleExpiresAtMs: 500 }), {
				authority,
				kind: 'start-active-use',
				use: activeUseInput(),
			});
			if (activeUseKind === 'observation-gap') {
				state = reduceToolVmLeaseAuthorityState(state, {
					gateway: GATEWAY_ONE,
					kind: 'session-disconnected',
					observedAtMs: 550,
					processEpoch: 'process-1',
					sessionAttachmentGeneration: 7,
				});
			}

			const renewed = reduceToolVmLeaseAuthorityState(state, {
				authority,
				kind: 'renew-idle-expiry',
				nextIdleExpiresAtMs: 1_100,
				nowMs: 600,
			});

			expect(renewed.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))).toMatchObject({
				activeUses: new Map([['use-1', expect.objectContaining({ kind: activeUseKind })]]),
				idleExpiresAtMs: 1_100,
				kind: 'current',
			});
		},
	);

	it('keeps a current binding authorized after its idle deadline while use remains non-terminal', () => {
		const authority = authorityReference();
		const running = reduceToolVmLeaseAuthorityState(createCurrentLeaf({ idleExpiresAtMs: 500 }), {
			authority,
			kind: 'start-active-use',
			use: activeUseInput(),
		});

		expect(
			authorizeCurrentToolVmLeafBinding(running, {
				authority,
				compatibility: COMPATIBILITY,
				nowMs: 600,
				sshBindingId: 'ssh-leaf-generation-1',
			}),
		).toMatchObject({ idleExpiresAtMs: 500, leaseId: authority.leaseId });
	});

	it('advances idle expiry after an exact active-use heartbeat and renewal', () => {
		const authority = authorityReference();
		const running = reduceToolVmLeaseAuthorityState(createCurrentLeaf({ idleExpiresAtMs: 500 }), {
			authority,
			kind: 'start-active-use',
			use: activeUseInput(),
		});
		const heartbeated = reduceToolVmLeaseAuthorityState(running, {
			authority,
			heartbeatAtMs: 600,
			kind: 'heartbeat-active-use',
			processEpoch: 'process-1',
			sessionAttachmentGeneration: 7,
			useId: 'use-1',
		});

		const renewed = reduceToolVmLeaseAuthorityState(heartbeated, {
			authority,
			kind: 'renew-idle-expiry',
			nextIdleExpiresAtMs: 1_100,
			nowMs: 600,
		});

		expect(renewed.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))).toMatchObject({
			activeUses: new Map([
				['use-1', expect.objectContaining({ kind: 'running', lastHeartbeatAtMs: 600 })],
			]),
			idleExpiresAtMs: 1_100,
			kind: 'current',
		});
	});

	it('denies same-zone successor Gateway mutation and binding authority over the current leaf', () => {
		const state = createCurrentLeaf({ idleExpiresAtMs: 500 });
		const successorAuthority = authorityReference({ gateway: GATEWAY_TWO });

		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(state, {
					authority: successorAuthority,
					kind: 'renew-idle-expiry',
					nextIdleExpiresAtMs: 1_000,
					nowMs: 400,
				}),
			'parent-identity-mismatch',
		);
		expectTransitionError(
			() =>
				authorizeCurrentToolVmLeafBinding(state, {
					authority: successorAuthority,
					compatibility: COMPATIBILITY,
					nowMs: 400,
					sshBindingId: 'ssh-leaf-generation-1',
				}),
			'parent-identity-mismatch',
		);
	});

	it('tracks concurrent uses through a disconnect observation gap and allows exact-process resume', () => {
		const authority = authorityReference();
		const running = reduceToolVmLeaseAuthorityState(createCurrentLeaf(), {
			authority,
			kind: 'start-active-use',
			use: {
				lastHeartbeatAtMs: 100,
				operationPayloadDigest: 'payload-digest-1',
				processEpoch: 'process-1',
				semanticOperationId: 'operation-1',
				sessionAttachmentGeneration: 7,
				startedAtMs: 100,
				useId: 'use-1',
			},
		});
		const concurrent = reduceToolVmLeaseAuthorityState(running, {
			authority,
			kind: 'start-active-use',
			use: {
				lastHeartbeatAtMs: 101,
				operationPayloadDigest: 'payload-digest-2',
				processEpoch: 'process-1',
				semanticOperationId: 'operation-2',
				sessionAttachmentGeneration: 7,
				startedAtMs: 101,
				useId: 'use-2',
			},
		});
		expect(
			concurrent.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))?.activeUses.size,
		).toBe(2);

		const disconnected = reduceToolVmLeaseAuthorityState(concurrent, {
			gateway: GATEWAY_ONE,
			kind: 'session-disconnected',
			observedAtMs: 120,
			processEpoch: 'process-1',
			sessionAttachmentGeneration: 7,
		});
		expect(
			disconnected.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))?.activeUses,
		).toEqual(
			new Map([
				['use-1', expect.objectContaining({ kind: 'observation-gap' })],
				['use-2', expect.objectContaining({ kind: 'observation-gap' })],
			]),
		);
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(disconnected, {
					authority,
					kind: 'start-active-use',
					use: activeUseInput({
						operationPayloadDigest: 'payload-digest-3',
						semanticOperationId: 'operation-3',
						useId: 'use-3',
					}),
				}),
			'active-use-conflict',
		);
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(disconnected, {
					authority,
					kind: 'resume-active-use',
					lastHeartbeatAtMs: 121,
					nowMs: 121,
					processEpoch: 'process-stale',
					sessionAttachmentGeneration: 8,
					useId: 'use-1',
				}),
			'process-epoch-mismatch',
		);
		const resumed = reduceToolVmLeaseAuthorityState(disconnected, {
			authority,
			kind: 'resume-active-use',
			lastHeartbeatAtMs: 121,
			nowMs: 121,
			processEpoch: 'process-1',
			sessionAttachmentGeneration: 8,
			useId: 'use-1',
		});
		expect(resumed.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))).toMatchObject({
			activeUses: new Map([
				['use-1', expect.objectContaining({ kind: 'running' })],
				['use-2', expect.objectContaining({ kind: 'observation-gap' })],
			]),
			kind: 'current',
		});
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(resumed, {
					authority,
					endedAtMs: 130,
					kind: 'end-active-use',
					outcome: 'completed',
					processEpoch: 'process-stale',
					sessionAttachmentGeneration: 8,
					useId: 'use-1',
				}),
			'process-epoch-mismatch',
		);
		const terminal = reduceToolVmLeaseAuthorityState(resumed, {
			authority,
			endedAtMs: 130,
			kind: 'end-active-use',
			outcome: 'completed',
			processEpoch: 'process-1',
			sessionAttachmentGeneration: 8,
			useId: 'use-1',
		});
		expect(terminal.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))).toMatchObject({
			activeUses: new Map([['use-2', expect.objectContaining({ kind: 'observation-gap' })]]),
		});
		expect([...terminal.terminalUseTombstones.values()]).toEqual([
			expect.objectContaining({ processEpoch: 'process-1' }),
		]);
	});

	it('makes exact-P running retries idempotent while distinct uses run concurrently', () => {
		const authority = authorityReference();
		const use = activeUseInput();
		const running = reduceToolVmLeaseAuthorityState(createCurrentLeaf(), {
			authority,
			kind: 'start-active-use',
			use,
		});
		expect(
			reduceToolVmLeaseAuthorityState(running, {
				authority,
				kind: 'start-active-use',
				use,
			}),
		).toBe(running);
		for (const changedUse of [
			{ ...use, processEpoch: 'process-2' },
			{ ...use, semanticOperationId: 'operation-2' },
			{ ...use, operationPayloadDigest: 'payload-digest-2' },
		]) {
			expectTransitionError(
				() =>
					reduceToolVmLeaseAuthorityState(running, {
						authority,
						kind: 'start-active-use',
						use: changedUse,
					}),
				'active-use-semantic-collision',
			);
		}
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(running, {
					authority,
					kind: 'start-active-use',
					use: { ...use, sessionAttachmentGeneration: 8 },
				}),
			'active-use-conflict',
		);
		for (const staleConcurrentUse of [
			activeUseInput({
				operationPayloadDigest: 'payload-digest-2',
				processEpoch: 'process-2',
				semanticOperationId: 'operation-2',
				useId: 'use-2',
			}),
			activeUseInput({
				operationPayloadDigest: 'payload-digest-2',
				semanticOperationId: 'operation-2',
				sessionAttachmentGeneration: 8,
				useId: 'use-2',
			}),
		]) {
			expectTransitionError(
				() =>
					reduceToolVmLeaseAuthorityState(running, {
						authority,
						kind: 'start-active-use',
						use: staleConcurrentUse,
					}),
				'active-use-conflict',
			);
		}
		const concurrent = reduceToolVmLeaseAuthorityState(running, {
			authority,
			kind: 'start-active-use',
			use: activeUseInput({
				operationPayloadDigest: 'payload-digest-2',
				semanticOperationId: 'operation-2',
				useId: 'use-2',
			}),
		});
		expect(
			concurrent.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))?.activeUses.size,
		).toBe(2);
	});

	it.each([
		{ commandKind: 'expire-observation-gap' as const, reason: 'observation-gap-expired' },
		{ commandKind: 'process-epoch-lost' as const, reason: 'process-epoch-lost' },
	])(
		'$commandKind makes non-terminal work ambiguous and quarantines only its leaf',
		({ commandKind, reason }) => {
			const mainAuthority = authorityReference();
			const siblingAuthority = authorityReference({
				leafGeneration: 'leaf-generation-sibling',
				principal: PRINCIPAL_SIBLING,
			});
			let state = createCurrentLeaf();
			state = commitCurrent(
				beginProvisioning(state, {
					leafGeneration: siblingAuthority.leafGeneration,
					principal: PRINCIPAL_SIBLING,
				}),
				{
					leafGeneration: siblingAuthority.leafGeneration,
					principal: PRINCIPAL_SIBLING,
				},
			);
			state = reduceToolVmLeaseAuthorityState(state, {
				authority: mainAuthority,
				kind: 'start-active-use',
				use: {
					lastHeartbeatAtMs: 100,
					operationPayloadDigest: 'payload-digest-1',
					processEpoch: 'process-1',
					semanticOperationId: 'operation-1',
					sessionAttachmentGeneration: 7,
					startedAtMs: 100,
					useId: 'use-1',
				},
			});
			if (commandKind === 'expire-observation-gap') {
				state = reduceToolVmLeaseAuthorityState(state, {
					gateway: GATEWAY_ONE,
					kind: 'session-disconnected',
					observedAtMs: 110,
					processEpoch: 'process-1',
					sessionAttachmentGeneration: 7,
				});
			}
			const siblingBefore = state.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_SIBLING));
			const parentBefore = state.parent;

			const transitioned =
				commandKind === 'expire-observation-gap'
					? reduceToolVmLeaseAuthorityState(state, {
							ambiguousAtMs: 120_200,
							authority: mainAuthority,
							expectedSessionAttachmentGeneration: 7,
							kind: 'expire-observation-gap',
							nowMs: 120_200,
							useId: 'use-1',
						})
					: reduceToolVmLeaseAuthorityState(state, {
							ambiguousAtMs: 200,
							gateway: GATEWAY_ONE,
							kind: 'process-epoch-lost',
							processEpoch: 'process-1',
						});

			expect(transitioned.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))).toMatchObject({
				activeUses: new Map([['use-1', expect.objectContaining({ kind: 'ambiguous', reason })]]),
				kind: 'quarantined',
			});
			expect(transitioned.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_SIBLING))).toBe(
				siblingBefore,
			);
			expect(transitioned.parent).toBe(parentBefore);
			expect(
				authorizeCurrentToolVmLeafBinding(transitioned, {
					authority: siblingAuthority,
					compatibility: COMPATIBILITY,
					nowMs: 100,
					sshBindingId: 'ssh-leaf-generation-sibling',
				}),
			).toMatchObject({ runtimeBinding: { vmId: 'tool-vm-leaf-generation-sibling' } });
		},
	);

	it('marks only exact-P active uses ambiguous when another process epoch remains active', () => {
		const mainAuthority = authorityReference();
		const siblingAuthority = authorityReference({
			leafGeneration: 'leaf-generation-sibling',
			principal: PRINCIPAL_SIBLING,
		});
		let state = createCurrentLeaf();
		state = commitCurrent(
			beginProvisioning(state, {
				leafGeneration: siblingAuthority.leafGeneration,
				principal: siblingAuthority.principal,
			}),
			{
				leafGeneration: siblingAuthority.leafGeneration,
				principal: siblingAuthority.principal,
			},
		);
		state = reduceToolVmLeaseAuthorityState(state, {
			authority: mainAuthority,
			kind: 'start-active-use',
			use: activeUseInput({ processEpoch: 'process-1', useId: 'use-process-1' }),
		});
		state = reduceToolVmLeaseAuthorityState(state, {
			authority: siblingAuthority,
			kind: 'start-active-use',
			use: activeUseInput({
				operationPayloadDigest: 'payload-digest-2',
				processEpoch: 'process-2',
				semanticOperationId: 'operation-2',
				useId: 'use-process-2',
			}),
		});
		const siblingBefore = state.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_SIBLING));

		const transitioned = reduceToolVmLeaseAuthorityState(state, {
			ambiguousAtMs: 200,
			gateway: GATEWAY_ONE,
			kind: 'process-epoch-lost',
			processEpoch: 'process-1',
		});

		expect(transitioned.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))).toMatchObject({
			activeUses: new Map([
				[
					'use-process-1',
					expect.objectContaining({
						kind: 'ambiguous',
						processEpoch: 'process-1',
						reason: 'process-epoch-lost',
					}),
				],
			]),
			kind: 'quarantined',
		});
		expect(transitioned.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_SIBLING))).toBe(
			siblingBefore,
		);
		expect(
			authorizeCurrentToolVmLeafBinding(transitioned, {
				authority: siblingAuthority,
				compatibility: COMPATIBILITY,
				nowMs: 200,
				sshBindingId: 'ssh-leaf-generation-sibling',
			}),
		).toMatchObject({ leaseId: siblingAuthority.leaseId });
	});
});
