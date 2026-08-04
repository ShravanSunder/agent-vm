import { describe, expect, it } from 'vitest';

import {
	assertPartialOrder,
	createCausalFixture,
	requireBound,
	secretIdentityPem,
	stablePrincipal,
	trustedContext,
	unrelatedTrustedContext,
} from './tool-vm-retirement-authority.integration-test-fixture.js';

describe('Tool VM retirement authority causal integration', () => {
	it('rotates the real control connection before stale held binding work can publish', async () => {
		const fixture = await createCausalFixture({
			commandResultTimeoutMs: 50,
			commandTtlMs: 1_000,
		});

		try {
			const acquisition = fixture.activeUseRuntime.acquisitionPort.acquire({ trustedContext });
			await expect(acquisition).resolves.toMatchObject({ kind: 'not-bound' });
			await fixture.connectionRotationCompleted;
			fixture.firstLeaseCreationMayFinish.resolve();
			await fixture.stalePublicationRejected.promise;

			assertPartialOrder(fixture.evidence, [
				'waiting-acquire-observed',
				'binding-result-timeout-observed',
				'control-connection-rotated',
				'stale-binding-publication-rejected',
			]);
			expect(fixture.leaseManager.listLeases()).toHaveLength(1);
			expect(fixture.publishedBindingRuntime.readState({ trustedContext })).toEqual({
				kind: 'unbound',
				stablePrincipal,
			});
			const serializedEvidence = JSON.stringify(fixture.evidence);
			expect(serializedEvidence).not.toContain(secretIdentityPem);
			expect(serializedEvidence).not.toContain('secret-tool-vm-key');
			expect(Object.keys(fixture.evidence[0] ?? {}).toSorted()).toEqual([
				'agentKey',
				'connectionGeneration',
				'event',
				'leafGeneration',
				'leaseId',
				'sequence',
			]);
		} finally {
			await fixture.close();
		}
	});

	it('contains command expiry and reacquires after SSH failure with exact predecessor fencing', async () => {
		const fixture = await createCausalFixture({
			commandResultTimeoutMs: 1_000,
			commandTtlMs: 50,
		});

		try {
			const acceptedSession = fixture.gatewayService.getCurrentAcceptedSession();
			const firstAcquisition = fixture.activeUseRuntime.acquisitionPort.acquire({ trustedContext });
			await expect(firstAcquisition).resolves.toMatchObject({ kind: 'not-bound' });
			expect(fixture.gatewayService.getCurrentAcceptedSession()).toBe(acceptedSession);
			fixture.firstLeaseCreationMayFinish.resolve();
			await fixture.stalePublicationRejected.promise;
			expect(fixture.leaseManager.listLeases()).toHaveLength(1);
			expect(fixture.publishedBindingRuntime.readState({ trustedContext }).kind).toBe('unbound');

			const retainedLeaseResult = await fixture.activeUseRuntime.acquisitionPort.acquire({
				trustedContext,
			});
			if (retainedLeaseResult.kind !== 'bound') {
				throw new Error(
					`Retained lease was not rebound: state=${JSON.stringify(fixture.publishedBindingRuntime.readState({ trustedContext }))}; evidence=${JSON.stringify(fixture.evidence)}`,
				);
			}
			const retainedLeaseAcquisition = retainedLeaseResult;
			expect(retainedLeaseAcquisition.operationContext.leaseId).toBe('lease-causal-1');
			await retainedLeaseAcquisition.endActiveUse('completed');
			fixture.armPredecessorExactAbsenceBarrier();
			fixture.emitCurrentBindingTransportFailure();
			expect(fixture.publishedBindingRuntime.readState({ trustedContext }).kind).toBe('degraded');

			const replacementAcquisition = fixture.activeUseRuntime.acquisitionPort.acquire({
				trustedContext,
			});
			await Promise.all([
				fixture.predecessorDestructionObserved,
				fixture.successorProvisionalBootObserved,
			]);
			expect(fixture.evidence.map((entry) => entry.event)).not.toContain(
				'predecessor-exact-absence-proved',
			);
			expect(fixture.evidence.map((entry) => entry.event)).not.toContain('successor-ssh-observed');
			expect(fixture.evidence.map((entry) => entry.event)).not.toContain(
				'successor-commit-observed',
			);
			expect(fixture.evidence.map((entry) => entry.event)).not.toContain(
				'successor-fresh-binding-published',
			);
			expect(fixture.evidence.map((entry) => entry.event)).not.toContain('successor-use-succeeded');
			expect(fixture.leaseManager.getCurrentLeaseBinding('lease-causal-2')).toBeUndefined();

			fixture.predecessorExactAbsenceMayFinish.resolve();
			const replacementLeaseAcquisition = requireBound(await replacementAcquisition);
			expect(replacementLeaseAcquisition.operationContext.leaseId).toBe('lease-causal-2');
			expect(fixture.gatewayService.getCurrentAcceptedSession()).toBe(acceptedSession);
			assertPartialOrder(fixture.evidence, [
				'predecessor-destruction-observed',
				'successor-provisional-boot-observed',
				'predecessor-exact-absence-proved',
				'successor-ssh-observed',
				'successor-commit-observed',
				'lease-reacquire-succeeded',
				'successor-fresh-binding-published',
				'successor-use-succeeded',
			]);
			await replacementLeaseAcquisition.endActiveUse('completed');
			await fixture.leaseManager.releaseLease('lease-causal-2');
			expect(fixture.publishedBindingRuntime.readState({ trustedContext })).toMatchObject({
				generation: {
					leafGeneration: 'leaf-causal-2',
					leaseId: 'lease-causal-2',
				},
				kind: 'retired',
				reason: 'released',
			});

			const recoveredAcquisition = requireBound(
				await fixture.activeUseRuntime.acquisitionPort.acquire({ trustedContext }),
			);
			expect(recoveredAcquisition.operationContext.leaseId).toBe('lease-causal-3');
			await recoveredAcquisition.endActiveUse('completed');
			fixture.rejectNextReadyUseWithStaleGatewayBinding();
			const laterResult = await fixture.activeUseRuntime.acquisitionPort.acquire({
				trustedContext,
			});
			if (laterResult.kind !== 'bound') {
				throw new Error(
					`Rejected-use recovery failed: result=${JSON.stringify(laterResult)} evidence=${JSON.stringify(fixture.evidence)}`,
				);
			}
			const laterAcquisition = laterResult;
			expect(laterAcquisition.operationContext.leaseId).toBe('lease-causal-4');
			expect(fixture.gatewayService.getCurrentAcceptedSession()).toBe(acceptedSession);
			expect(fixture.evidence.map((entry) => entry.event)).toContain('rejected-use-observed');
			assertPartialOrder(fixture.evidence, [
				'rejected-use-observed',
				'rejected-use-recovery-binding-published',
				'rejected-use-recovery-succeeded',
			]);
			expect(fixture.evidence.map((entry) => entry.event)).not.toContain(
				'control-connection-rotated',
			);
			assertPartialOrder(fixture.evidence, [
				'stale-binding-publication-rejected',
				'fresh-binding-published',
			]);
			expect(JSON.stringify(fixture.evidence)).not.toMatch(
				/BEGIN OPENSSH PRIVATE KEY|secret-host-key|secret-tool-vm-key/u,
			);
			await laterAcquisition.endActiveUse('completed');
		} finally {
			await fixture.close();
		}
	});

	it('retires an idle predecessor through Gateway unroute and admits one shared successor without blocking another agent', async () => {
		let nowMs = Date.now();
		const fixture = await createCausalFixture({
			commandResultTimeoutMs: 1_000,
			commandTtlMs: 1_000,
			effectiveIdleTtlMs: 10,
			now: () => nowMs,
		});

		try {
			fixture.firstLeaseCreationMayFinish.resolve();
			const predecessorAcquisition = requireBound(
				await fixture.activeUseRuntime.acquisitionPort.acquire({ trustedContext }),
			);
			expect(predecessorAcquisition.operationContext.leaseId).toBe('lease-causal-1');
			await predecessorAcquisition.endActiveUse('completed');
			fixture.armPredecessorExactAbsenceBarrier();
			nowMs += 11;

			const idleRetirement = fixture.idleReaper.reapExpiredLeases();
			await fixture.predecessorDestructionObserved;
			expect(fixture.evidence.map((entry) => entry.event)).toContain(
				'gateway-binding-retirement-requested',
			);
			await fixture.gatewaySshCloseStarted;

			let firstMainCompleted = false;
			let secondMainCompleted = false;
			const firstMainAcquisition = fixture.activeUseRuntime.acquisitionPort
				.acquire({ trustedContext })
				.then((result) => {
					firstMainCompleted = true;
					return requireBound(result);
				});
			const secondMainAcquisition = fixture.activeUseRuntime.acquisitionPort
				.acquire({ trustedContext })
				.then((result) => {
					secondMainCompleted = true;
					return requireBound(result);
				});
			const unrelatedAcquisition = requireBound(
				await fixture.activeUseRuntime.acquisitionPort.acquire({
					trustedContext: unrelatedTrustedContext,
				}),
			);

			expect(unrelatedAcquisition.operationContext.leaseId).toBe('lease-causal-2');
			expect(firstMainCompleted).toBe(false);
			expect(secondMainCompleted).toBe(false);
			expect(fixture.evidence.map((entry) => entry.event)).not.toContain('successor-ssh-enabled');
			expect(fixture.evidence.map((entry) => entry.event)).not.toContain(
				'successor-current-committed',
			);
			expect(fixture.evidence.map((entry) => entry.event)).not.toContain(
				'successor-binding-published',
			);

			fixture.predecessorExactAbsenceMayFinish.resolve();
			const [firstSuccessorAcquisition, secondSuccessorAcquisition] = await Promise.all([
				firstMainAcquisition,
				secondMainAcquisition,
			]);
			expect(firstSuccessorAcquisition.operationContext).toMatchObject({
				leafGeneration: 'leaf-causal-3',
				leaseId: 'lease-causal-3',
			});
			expect(secondSuccessorAcquisition.operationContext).toMatchObject({
				leafGeneration: 'leaf-causal-3',
				leaseId: 'lease-causal-3',
			});
			fixture.recordWaitingCallCompleted(firstSuccessorAcquisition);
			await idleRetirement;

			assertPartialOrder(fixture.evidence, [
				'retirement-fenced',
				'gateway-binding-unrouted',
				'gateway-ssh-close-started',
				'gateway-retirement-acknowledged',
			]);
			assertPartialOrder(fixture.evidence, [
				'retirement-fenced',
				'tool-vm-termination-started',
				'tool-vm-absence-proven',
				'successor-admission-released',
				'successor-ssh-enabled',
				'successor-current-committed',
				'successor-binding-published',
				'successor-ssh-ready',
				'waiting-call-completed',
			]);
			expect(
				fixture.evidence.filter(
					(entry) =>
						entry.agentKey === trustedContext.principal.agentId &&
						entry.event === 'successor-ssh-enabled',
				).length,
			).toBe(1);
			expect(fixture.gatewayService.getCurrentAcceptedSession()).toBeDefined();
			expect(JSON.stringify(fixture.evidence)).not.toMatch(
				/BEGIN OPENSSH PRIVATE KEY|secret-host-key|secret-tool-vm-key/u,
			);

			await Promise.all([
				firstSuccessorAcquisition.endActiveUse('completed'),
				secondSuccessorAcquisition.endActiveUse('completed'),
				unrelatedAcquisition.endActiveUse('completed'),
			]);
		} finally {
			await fixture.close();
		}
	});
});
