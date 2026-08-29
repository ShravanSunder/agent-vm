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
	expectedMessage?: RegExp,
): void {
	let thrownError: unknown;
	try {
		operation();
	} catch (error) {
		thrownError = error;
	}
	expect(thrownError).toBeInstanceOf(ToolVmLeaseAuthorityTransitionError);
	expect(thrownError).toMatchObject({ code });
	if (expectedMessage !== undefined) {
		expect(thrownError).toMatchObject({ message: expect.stringMatching(expectedMessage) });
	}
}

describe('Tool VM lease authority reliability boundaries', () => {
	it('accepts only exact P/session/leaf-fenced heartbeats and replaces one bounded latest report', () => {
		const authority = authorityReference();
		const running = reduceToolVmLeaseAuthorityState(createCurrentLeaf(), {
			authority,
			kind: 'start-active-use',
			use: activeUseInput(),
		});
		const heartbeating = reduceToolVmLeaseAuthorityState(running, {
			authority,
			heartbeatAtMs: 110,
			kind: 'heartbeat-active-use',
			processEpoch: 'process-1',
			report: {
				reportedAtMs: 110,
				sequence: 1,
				status: 'progress',
				summary: 'cloning repository',
			},
			sessionAttachmentGeneration: 7,
			useId: 'use-1',
		});
		expect(heartbeating.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))).toMatchObject({
			activeUses: new Map([
				[
					'use-1',
					expect.objectContaining({
						lastHeartbeatAtMs: 110,
						latestReport: expect.objectContaining({
							sequence: 1,
							summary: 'cloning repository',
						}),
					}),
				],
			]),
		});
		expect(
			reduceToolVmLeaseAuthorityState(heartbeating, {
				authority,
				heartbeatAtMs: 110,
				kind: 'heartbeat-active-use',
				processEpoch: 'process-1',
				sessionAttachmentGeneration: 7,
				useId: 'use-1',
			}).leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN)),
		).toMatchObject({
			activeUses: new Map([['use-1', expect.objectContaining({ lastHeartbeatAtMs: 110 })]]),
		});
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(heartbeating, {
					authority,
					heartbeatAtMs: 109,
					kind: 'heartbeat-active-use',
					processEpoch: 'process-1',
					sessionAttachmentGeneration: 7,
					useId: 'use-1',
				}),
			'active-use-heartbeat-regressed',
		);

		for (const [command, expectedCode] of [
			[
				{
					authority,
					heartbeatAtMs: 111,
					kind: 'heartbeat-active-use' as const,
					processEpoch: 'process-stale',
					sessionAttachmentGeneration: 7,
					useId: 'use-1',
				},
				'process-epoch-mismatch' as const,
			],
			[
				{
					authority,
					heartbeatAtMs: 111,
					kind: 'heartbeat-active-use' as const,
					processEpoch: 'process-1',
					sessionAttachmentGeneration: 8,
					useId: 'use-1',
				},
				'attachment-generation-regressed' as const,
			],
			[
				{
					authority: authorityReference({ leafGeneration: 'leaf-generation-stale' }),
					heartbeatAtMs: 111,
					kind: 'heartbeat-active-use' as const,
					processEpoch: 'process-1',
					sessionAttachmentGeneration: 7,
					useId: 'use-1',
				},
				'leaf-generation-mismatch' as const,
			],
			[
				{
					authority,
					heartbeatAtMs: 111,
					kind: 'heartbeat-active-use' as const,
					processEpoch: 'process-1',
					sessionAttachmentGeneration: 7,
					useId: 'use-missing',
				},
				'active-use-not-found' as const,
			],
		] as const) {
			expectTransitionError(
				() => reduceToolVmLeaseAuthorityState(heartbeating, command),
				expectedCode,
			);
		}
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(heartbeating, {
					authority,
					heartbeatAtMs: 112,
					kind: 'heartbeat-active-use',
					processEpoch: 'process-1',
					report: {
						reportedAtMs: 112,
						sequence: 1,
						status: 'running',
						summary: 'stale report',
					},
					sessionAttachmentGeneration: 7,
					useId: 'use-1',
				}),
			'active-use-report-regressed',
		);
	});

	it('uses an immutable gap deadline to order before, at, and after-deadline resume and expiry', () => {
		const authority = authorityReference();
		const configured = createEmptyToolVmLeaseAuthorityState({
			retentionPolicy: { observationGapGraceMs: 20 },
		});
		const running = reduceToolVmLeaseAuthorityState(
			commitCurrent(beginProvisioning(registerGateway(configured))),
			{ authority, kind: 'start-active-use', use: activeUseInput() },
		);
		const disconnected = reduceToolVmLeaseAuthorityState(running, {
			gateway: GATEWAY_ONE,
			kind: 'session-disconnected',
			observedAtMs: 100,
			processEpoch: 'process-1',
			sessionAttachmentGeneration: 7,
		});
		expect(disconnected.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))).toMatchObject({
			activeUses: new Map([['use-1', expect.objectContaining({ resumeDeadlineMs: 120 })]]),
		});

		for (const nowMs of [119]) {
			expect(
				reduceToolVmLeaseAuthorityState(disconnected, {
					authority,
					kind: 'resume-active-use',
					lastHeartbeatAtMs: nowMs,
					nowMs,
					processEpoch: 'process-1',
					sessionAttachmentGeneration: 8,
					useId: 'use-1',
				}).leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN)),
			).toMatchObject({
				activeUses: new Map([['use-1', expect.objectContaining({ kind: 'running' })]]),
			});
		}
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(disconnected, {
					authority,
					kind: 'resume-active-use',
					lastHeartbeatAtMs: 120,
					nowMs: 120,
					processEpoch: 'process-1',
					sessionAttachmentGeneration: 8,
					useId: 'use-1',
				}),
			'observation-gap-expired',
		);
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(disconnected, {
					authority,
					kind: 'resume-active-use',
					lastHeartbeatAtMs: 121,
					nowMs: 121,
					processEpoch: 'process-1',
					sessionAttachmentGeneration: 8,
					useId: 'use-1',
				}),
			'observation-gap-expired',
		);
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(disconnected, {
					ambiguousAtMs: 119,
					authority,
					expectedSessionAttachmentGeneration: 7,
					kind: 'expire-observation-gap',
					nowMs: 119,
					useId: 'use-1',
				}),
			'observation-gap-not-expired',
		);
		const expiredAtDeadline = reduceToolVmLeaseAuthorityState(disconnected, {
			ambiguousAtMs: 120,
			authority,
			expectedSessionAttachmentGeneration: 7,
			kind: 'expire-observation-gap',
			nowMs: 120,
			useId: 'use-1',
		});
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(expiredAtDeadline, {
					authority,
					kind: 'resume-active-use',
					lastHeartbeatAtMs: 120,
					nowMs: 120,
					processEpoch: 'process-1',
					sessionAttachmentGeneration: 8,
					useId: 'use-1',
				}),
			'leaf-not-current',
		);
	});

	it('tombstones terminal use meaning and scopes same-ID replay collision to one principal', () => {
		const authority = authorityReference();
		const use = activeUseInput();
		const running = reduceToolVmLeaseAuthorityState(createCurrentLeaf(), {
			authority,
			kind: 'start-active-use',
			use,
		});
		const terminal = reduceToolVmLeaseAuthorityState(running, {
			authority,
			endedAtMs: 130,
			kind: 'end-active-use',
			outcome: 'completed',
			processEpoch: 'process-1',
			sessionAttachmentGeneration: 7,
			useId: 'use-1',
		});

		expect(terminal.terminalUseTombstones.size).toBe(1);
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(terminal, {
					authority,
					kind: 'start-active-use',
					use,
				}),
			'active-use-not-resumable',
			/already ended/iu,
		);
		for (const changedUse of [
			{ ...use, processEpoch: 'process-2' },
			{ ...use, semanticOperationId: 'operation-2' },
			{ ...use, operationPayloadDigest: 'changed-payload' },
		]) {
			expectTransitionError(
				() =>
					reduceToolVmLeaseAuthorityState(terminal, {
						authority,
						kind: 'start-active-use',
						use: changedUse,
					}),
				'active-use-semantic-collision',
			);
		}

		const siblingAuthority = authorityReference({
			leafGeneration: 'leaf-generation-sibling',
			principal: PRINCIPAL_SIBLING,
		});
		const withSibling = commitCurrent(
			beginProvisioning(terminal, {
				leafGeneration: siblingAuthority.leafGeneration,
				principal: siblingAuthority.principal,
			}),
			{
				leafGeneration: siblingAuthority.leafGeneration,
				principal: siblingAuthority.principal,
			},
		);
		expect(
			reduceToolVmLeaseAuthorityState(withSibling, {
				authority: siblingAuthority,
				kind: 'start-active-use',
				use,
			}).leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_SIBLING)),
		).toMatchObject({ activeUses: new Map([['use-1', expect.any(Object)]]) });
	});

	it('refuses a destroyed VM identity that conflicts with the committed runtime binding', () => {
		const authority = authorityReference();
		const destroying = reduceToolVmLeaseAuthorityState(createCurrentLeaf(), {
			ambiguousAtMs: 200,
			authority,
			kind: 'begin-destruction',
			reason: 'test',
		});
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(destroying, {
					authority,
					destroyedAtMs: 300,
					kind: 'destruction-completed',
					reason: 'test',
					vmId: 'tool-vm-wrong',
				}),
			'lease-identity-mismatch',
		);
		expect(destroying.accessFencingLeavesByGeneration.get(authority.leafGeneration)).toMatchObject({
			kind: 'destroying',
			runtimeBinding: { vmId: 'tool-vm-leaf-generation-1' },
		});
	});

	it('refuses tombstone overflow until explicit expiry pruning preserves unknown-result safety', () => {
		const configured = createEmptyToolVmLeaseAuthorityState({
			retentionPolicy: {
				leafTombstoneTtlMs: 10,
				maxLeafTombstones: 1,
				maxTerminalUseTombstones: 1,
				terminalUseTombstoneTtlMs: 10,
			},
		});
		const authority = authorityReference();
		const current = commitCurrent(beginProvisioning(registerGateway(configured)));
		const runningFirst = reduceToolVmLeaseAuthorityState(current, {
			authority,
			kind: 'start-active-use',
			use: activeUseInput(),
		});
		const endedFirst = reduceToolVmLeaseAuthorityState(runningFirst, {
			authority,
			endedAtMs: 100,
			kind: 'end-active-use',
			outcome: 'completed',
			processEpoch: 'process-1',
			sessionAttachmentGeneration: 7,
			useId: 'use-1',
		});
		const secondUse = activeUseInput({
			operationPayloadDigest: 'payload-digest-2',
			semanticOperationId: 'operation-2',
			useId: 'use-2',
		});
		const runningSecond = reduceToolVmLeaseAuthorityState(endedFirst, {
			authority,
			kind: 'start-active-use',
			use: secondUse,
		});
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(runningSecond, {
					authority,
					endedAtMs: 101,
					kind: 'end-active-use',
					outcome: 'completed',
					processEpoch: 'process-1',
					sessionAttachmentGeneration: 7,
					useId: 'use-2',
				}),
			'tombstone-capacity-exhausted',
		);
		const beforeUseExpiry = reduceToolVmLeaseAuthorityState(runningSecond, {
			kind: 'prune-tombstones',
			nowMs: 109,
		});
		expect(beforeUseExpiry.terminalUseTombstones.size).toBe(1);
		const prunedUses = reduceToolVmLeaseAuthorityState(runningSecond, {
			kind: 'prune-tombstones',
			nowMs: 110,
		});
		const endedSecond = reduceToolVmLeaseAuthorityState(prunedUses, {
			authority,
			endedAtMs: 110,
			kind: 'end-active-use',
			outcome: 'completed',
			processEpoch: 'process-1',
			sessionAttachmentGeneration: 7,
			useId: 'use-2',
		});
		expect(endedSecond.terminalUseTombstones.size).toBe(1);

		const destroyingFirst = reduceToolVmLeaseAuthorityState(endedSecond, {
			ambiguousAtMs: 115,
			authority,
			kind: 'begin-destruction',
			reason: 'replace-first',
		});
		const destroyedFirst = reduceToolVmLeaseAuthorityState(destroyingFirst, {
			authority,
			destroyedAtMs: 120,
			kind: 'destruction-completed',
			reason: 'replace-first',
		});
		const replacementAuthority = authorityReference({ leafGeneration: 'leaf-generation-2' });
		const replacement = commitCurrent(
			beginProvisioning(destroyedFirst, { leafGeneration: 'leaf-generation-2' }),
			{ leafGeneration: 'leaf-generation-2' },
		);
		const destroyingReplacement = reduceToolVmLeaseAuthorityState(replacement, {
			ambiguousAtMs: 121,
			authority: replacementAuthority,
			kind: 'begin-destruction',
			reason: 'replace-second',
		});
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(destroyingReplacement, {
					authority: replacementAuthority,
					destroyedAtMs: 121,
					kind: 'destruction-completed',
					reason: 'replace-second',
				}),
			'tombstone-capacity-exhausted',
		);
		const beforeLeafExpiry = reduceToolVmLeaseAuthorityState(destroyingReplacement, {
			kind: 'prune-tombstones',
			nowMs: 129,
		});
		expect(beforeLeafExpiry.tombstonesByGeneration.size).toBe(1);
		const prunedLeaves = reduceToolVmLeaseAuthorityState(destroyingReplacement, {
			kind: 'prune-tombstones',
			nowMs: 130,
		});
		const destroyedReplacement = reduceToolVmLeaseAuthorityState(prunedLeaves, {
			authority: replacementAuthority,
			destroyedAtMs: 130,
			kind: 'destruction-completed',
			reason: 'replace-second',
		});
		expect(destroyedReplacement.tombstonesByGeneration.size).toBe(1);
	});

	it('tombstones positively destroyed authority, denies its old SSH binding, and admits one exact replacement', () => {
		const oldAuthority = authorityReference();
		const current = createCurrentLeaf();
		const destroying = reduceToolVmLeaseAuthorityState(current, {
			ambiguousAtMs: 200,
			authority: oldAuthority,
			kind: 'begin-destruction',
			reason: 'persistent-ssh-failure',
		});
		const ownerUnsafe = reduceToolVmLeaseAuthorityState(destroying, {
			authority: oldAuthority,
			kind: 'destruction-incomplete',
			reason: 'runner-still-live',
		});
		const replacementAuthority = authorityReference({ leafGeneration: 'leaf-generation-2' });
		const replacementProvisioning = beginProvisioning(ownerUnsafe, {
			leafGeneration: replacementAuthority.leafGeneration,
		});
		expectTransitionError(
			() => beginProvisioning(replacementProvisioning, { leafGeneration: 'leaf-generation-3' }),
			'leaf-already-exists',
		);
		expectTransitionError(
			() =>
				commitCurrent(replacementProvisioning, {
					leafGeneration: replacementAuthority.leafGeneration,
				}),
			'predecessor-access-not-fenced',
		);

		const retryingDestruction = reduceToolVmLeaseAuthorityState(replacementProvisioning, {
			authority: oldAuthority,
			kind: 'retry-destruction',
			reason: 'retry-exact-destruction',
		});
		const destroyed = reduceToolVmLeaseAuthorityState(retryingDestruction, {
			authority: oldAuthority,
			destroyedAtMs: 300,
			kind: 'destruction-completed',
			reason: 'persistent-ssh-failure',
		});
		expect(destroyed.leavesByPrincipal.get(stablePrincipalKey(PRINCIPAL_MAIN))).toMatchObject({
			kind: 'provisioning',
			leafGeneration: replacementAuthority.leafGeneration,
		});
		expect(destroyed.tombstonesByGeneration.get('leaf-generation-1')).toMatchObject({
			kind: 'destroyed',
			leaseId: 'lease-leaf-generation-1',
			sshBindingId: 'ssh-leaf-generation-1',
		});
		expectTransitionError(
			() =>
				authorizeCurrentToolVmLeafBinding(destroyed, {
					authority: oldAuthority,
					compatibility: COMPATIBILITY,
					nowMs: 100,
					sshBindingId: 'ssh-leaf-generation-1',
				}),
			'leaf-destroyed',
		);

		expectTransitionError(() => commitCurrent(destroyed), 'leaf-destroyed');
		const replacementCurrent = commitCurrent(destroyed, {
			leafGeneration: replacementAuthority.leafGeneration,
		});
		expect(
			authorizeCurrentToolVmLeafBinding(replacementCurrent, {
				authority: replacementAuthority,
				compatibility: COMPATIBILITY,
				nowMs: 100,
				sshBindingId: 'ssh-leaf-generation-2',
			}),
		).toMatchObject({ runtimeBinding: { vmId: 'tool-vm-leaf-generation-2' } });
		expectTransitionError(
			() =>
				authorizeCurrentToolVmLeafBinding(replacementCurrent, {
					authority: oldAuthority,
					compatibility: COMPATIBILITY,
					nowMs: 100,
					sshBindingId: 'ssh-leaf-generation-1',
				}),
			'leaf-destroyed',
		);
	});
});
