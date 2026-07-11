import { describe, expect, it } from 'vitest';

import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
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
	zoneId: 'shravan',
} satisfies StableToolVmLeasePrincipal;

const PRINCIPAL_SIBLING = {
	agentId: 'sibling',
	zoneId: 'shravan',
} satisfies StableToolVmLeasePrincipal;

const COMPATIBILITY = {
	policyFingerprint: 'policy-a',
	profileId: 'standard',
	purpose: 'coding',
	workMountDir: '/home/openclaw/work',
} satisfies ToolVmLeaseCompatibility;

const AUTHORITY_REFERENCE_EXCLUDES_POLICY_EXPIRY: 'policyExpiresAtMs' extends keyof ToolVmLeafAuthorityReference
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
		readonly policyExpiresAtMs?: number;
		readonly principal?: StableToolVmLeasePrincipal;
	} = {},
): ToolVmLeaseAuthorityState {
	const leafGeneration = options.leafGeneration ?? 'leaf-generation-1';
	return reduceToolVmLeaseAuthorityState(state, {
		authority: authorityReference(options),
		compatibility: options.compatibility ?? COMPATIBILITY,
		destructionIdentity: {
			reservationId: `reservation-${leafGeneration}`,
			reservationPath: `/state/reservations/${leafGeneration}.json`,
			targetIdentity: `target-${leafGeneration}`,
			vmId: `tool-vm-${leafGeneration}`,
		},
		kind: 'begin-provisioning',
		policyExpiresAtMs: options.policyExpiresAtMs ?? 10_000,
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
		readonly policyExpiresAtMs?: number;
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
		expect(current.leavesByPrincipal.get('shravan\0main')).toMatchObject({
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

	it('denies late commit after seal and every cross-Gateway authority mutation', () => {
		const provisional = beginProvisioning(registerGateway());
		const sealed = reduceToolVmLeaseAuthorityState(provisional, {
			gateway: GATEWAY_ONE,
			kind: 'seal-parent',
		});

		expectTransitionError(() => commitCurrent(sealed), 'parent-not-admitting');
		expectTransitionError(
			() => beginProvisioning(registerGateway(), { gateway: GATEWAY_TWO }),
			'parent-identity-mismatch',
		);
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(sealed, {
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

		expect(quarantined.leavesByPrincipal.get('shravan\0main')).toMatchObject({
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
		const currentLeaf = current.leavesByPrincipal.get('shravan\0main');
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

		expect(restored.leavesByPrincipal.get('shravan\0main')).toMatchObject({
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
					compatibility: { ...COMPATIBILITY, workMountDir: '/other/work' },
					nowMs: 100,
					sshBindingId: 'ssh-leaf-generation-1',
				}),
			'compatibility-conflict',
		);
	});

	it('authorizes only the exact current lease before the half-open policy expiry boundary', () => {
		const authority = authorityReference({ leaseId: 'lease-current' });
		const state = createCurrentLeaf({
			leaseId: authority.leaseId,
			policyExpiresAtMs: 500,
		});
		const authorized = authorizeCurrentToolVmLeafBinding(state, {
			authority,
			compatibility: COMPATIBILITY,
			nowMs: 499,
			sshBindingId: 'ssh-leaf-generation-1',
		});
		expect(authorized).toMatchObject({
			leaseId: 'lease-current',
			policyExpiresAtMs: 500,
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

	it('does not carry controller-owned policy expiry in a caller authority reference', () => {
		expect(AUTHORITY_REFERENCE_EXCLUDES_POLICY_EXPIRY).toBe(true);
		expect(authorityReference()).not.toHaveProperty('policyExpiresAtMs');
	});

	it('blocks conflicting use through a disconnect observation gap and allows exact-process resume', () => {
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
		expectTransitionError(
			() =>
				reduceToolVmLeaseAuthorityState(running, {
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
				}),
			'active-use-conflict',
		);

		const disconnected = reduceToolVmLeaseAuthorityState(running, {
			gateway: GATEWAY_ONE,
			kind: 'session-disconnected',
			observedAtMs: 120,
			processEpoch: 'process-1',
			sessionAttachmentGeneration: 7,
		});
		expect(disconnected.leavesByPrincipal.get('shravan\0main')).toMatchObject({
			activeUses: new Map([['use-1', expect.objectContaining({ kind: 'observation-gap' })]]),
			kind: 'current',
		});
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
		expect(resumed.leavesByPrincipal.get('shravan\0main')).toMatchObject({
			activeUses: new Map([['use-1', expect.objectContaining({ kind: 'running' })]]),
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
		expect(terminal.leavesByPrincipal.get('shravan\0main')).toMatchObject({
			activeUses: new Map(),
		});
		expect([...terminal.terminalUseTombstones.values()]).toEqual([
			expect.objectContaining({ processEpoch: 'process-1' }),
		]);
	});

	it('makes exact-P running retries idempotent and changed-P or changed-meaning retries collide', () => {
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
					use: activeUseInput({ useId: 'use-2' }),
				}),
			'active-use-conflict',
		);
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
			const siblingBefore = state.leavesByPrincipal.get('shravan\0sibling');
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

			expect(transitioned.leavesByPrincipal.get('shravan\0main')).toMatchObject({
				activeUses: new Map([['use-1', expect.objectContaining({ kind: 'ambiguous', reason })]]),
				kind: 'quarantined',
			});
			expect(transitioned.leavesByPrincipal.get('shravan\0sibling')).toBe(siblingBefore);
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
});
