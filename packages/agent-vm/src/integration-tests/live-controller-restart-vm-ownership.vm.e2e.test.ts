import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	createManagedVm,
	destroyManagedVmExact,
	type ManagedVm,
	type ManagedVmDestroyTargetV1,
	type ManagedVmOwnershipReservationReferenceV1,
} from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it } from 'vitest';

import { createGatewayOwnershipCoordinator } from '../controller/vm-ownership/gateway-ownership-coordinator.js';
import type { VmOwnershipDeploymentIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';
import { createVmOwnershipJournal } from '../controller/vm-ownership/vm-ownership-journal.js';
import { assertVmDestructionComplete } from '../shared/vm-destruction-receipt.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';

const describeLiveVmE2e = shouldRunLiveVmE2e() ? describe : describe.skip;
const zoneId = 'ownership-restart';

interface TestDeployment {
	readonly deploymentIdentity: VmOwnershipDeploymentIdentity;
	readonly rootDirectory: string;
	readonly stateDirectory: string;
}

async function createTestDeployment(): Promise<TestDeployment> {
	const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-own-'));
	return {
		deploymentIdentity: {
			configPath: path.join(
				rootDirectory,
				'nested-deployment-segment'.repeat(8),
				'config',
				'system.json',
			),
			controllerPort: 18_841,
			projectNamespace: 'ownership-restart-e2e',
		},
		rootDirectory,
		stateDirectory: path.join(rootDirectory, 'state'),
	};
}

async function createRealVm(
	ownershipReservation: ManagedVmOwnershipReservationReferenceV1,
	sessionLabel: string,
): Promise<ManagedVm> {
	return await createManagedVm({
		allowedHosts: [],
		cpus: 1,
		imagePath: '',
		memory: '512M',
		ownershipReservation,
		rootfsMode: 'memory',
		secrets: {},
		sessionLabel,
		vfsMounts: {},
	});
}

async function assertExactTargetAlreadyAbsent(target: ManagedVmDestroyTargetV1): Promise<void> {
	const receipt = await destroyManagedVmExact(target);
	assertVmDestructionComplete(receipt, `repeat exact destruction for ${target.vmId}`);
	expect(receipt.resources.exactRunner.status).toBe('already-absent');
	expect(
		Object.values(receipt.resources).every((resource) => resource.status === 'already-absent'),
	).toBe(true);
}

const temporaryDeploymentRoots: string[] = [];
const managedVmsForHarnessCleanup: ManagedVm[] = [];

afterEach(async () => {
	const cleanupResults = await Promise.allSettled(
		managedVmsForHarnessCleanup.splice(0).map(async (managedVm) => {
			const receipt = await managedVm.close();
			assertVmDestructionComplete(receipt, `real VM harness cleanup for ${managedVm.id}`);
		}),
	);
	await Promise.all(
		temporaryDeploymentRoots
			.splice(0)
			.map(async (rootDirectory) => await rm(rootDirectory, { force: true, recursive: true })),
	);
	const cleanupErrors = cleanupResults.flatMap((result) =>
		result.status === 'rejected' ? [result.reason as unknown] : [],
	);
	if (cleanupErrors.length > 0) {
		throw new AggregateError(cleanupErrors, 'real VM controller-restart harness cleanup failed');
	}
});

describeLiveVmE2e('live e2e: controller restart exact VM ownership', () => {
	it('refuses a successor until current and provisional children and their Gateway are destroyed', async () => {
		// Arrange: C1 owns one real Gateway, one current Tool VM, and one provisional Tool VM.
		const deployment = await createTestDeployment();
		temporaryDeploymentRoots.push(deployment.rootDirectory);
		const firstController = createGatewayOwnershipCoordinator({
			controllerEpoch: 'controller-epoch-before-restart',
			createId: randomUUID,
			deploymentIdentity: deployment.deploymentIdentity,
			nowMs: Date.now,
			stateDirectoryForZone: () => deployment.stateDirectory,
		});
		const gatewayOwnership = await firstController.beginGatewayEpoch({
			bootId: 'gateway-boot-before-restart',
			generationId: 'gateway-generation-before-restart',
			sessionLabel: 'gateway-before-controller-restart',
			zoneId,
		});
		const gatewayVm = await createRealVm(
			gatewayOwnership.ownershipReservation,
			'gateway-before-controller-restart',
		);
		managedVmsForHarnessCleanup.push(gatewayVm);

		const currentToolOwnership = firstController.admitProvisionalToolVm({
			agentId: 'current-agent',
			expectedGateway: gatewayOwnership.gatewayIdentity,
			sessionLabel: 'current-tool-before-controller-restart',
		});
		const currentToolVm = await createRealVm(
			await currentToolOwnership.ready,
			'current-tool-before-controller-restart',
		);
		managedVmsForHarnessCleanup.push(currentToolVm);
		await currentToolOwnership.commitCurrent();

		const provisionalToolOwnership = firstController.admitProvisionalToolVm({
			agentId: 'provisional-agent',
			expectedGateway: gatewayOwnership.gatewayIdentity,
			sessionLabel: 'provisional-tool-before-controller-restart',
		});
		const provisionalToolVm = await createRealVm(
			await provisionalToolOwnership.ready,
			'provisional-tool-before-controller-restart',
		);
		managedVmsForHarnessCleanup.push(provisionalToolVm);
		const liveVmMarkers = await Promise.all([
			gatewayVm.exec("printf 'gateway-live'"),
			currentToolVm.exec("printf 'current-tool-live'"),
			provisionalToolVm.exec("printf 'provisional-tool-live'"),
		]);
		expect(liveVmMarkers).toMatchObject([
			{ exitCode: 0, stdout: 'gateway-live' },
			{ exitCode: 0, stdout: 'current-tool-live' },
			{ exitCode: 0, stdout: 'provisional-tool-live' },
		]);

		const oldTargets = [
			currentToolVm.getDestroyTarget(),
			provisionalToolVm.getDestroyTarget(),
			gatewayVm.getDestroyTarget(),
		] as const;
		const journal = createVmOwnershipJournal({
			nowMs: Date.now,
			stateDirectory: deployment.stateDirectory,
		});
		await expect(
			journal.loadGatewayMembership(gatewayOwnership.gatewayIdentity.gatewayEpochId),
		).resolves.toMatchObject({
			children: [
				expect.objectContaining({ state: 'current', vmId: currentToolVm.id }),
				expect.objectContaining({ state: 'provisional', vmId: provisionalToolVm.id }),
			],
			gateway: expect.objectContaining({ gatewayVmId: gatewayVm.id }),
			state: 'admitting',
		});

		const exactDestroyOrder: string[] = [];
		let signalFirstDestroyStarted: (() => void) | undefined;
		const firstDestroyStarted = new Promise<void>((resolve) => {
			signalFirstDestroyStarted = resolve;
		});
		let permitFirstDestroy: (() => void) | undefined;
		const firstDestroyPermitted = new Promise<void>((resolve) => {
			permitFirstDestroy = resolve;
		});
		const replacementController = createGatewayOwnershipCoordinator({
			controllerEpoch: 'controller-epoch-after-restart',
			createId: randomUUID,
			deploymentIdentity: deployment.deploymentIdentity,
			destroyManagedVmExact: async (target) => {
				exactDestroyOrder.push(`${target.role}:${target.vmId}`);
				if (exactDestroyOrder.length === 1) {
					signalFirstDestroyStarted?.();
					await firstDestroyPermitted;
				}
				return await destroyManagedVmExact(target);
			},
			nowMs: Date.now,
			stateDirectoryForZone: () => deployment.stateDirectory,
		});

		// Act: C2 receives only durable ownership evidence, not C1's ManagedVm handles.
		const startupReconciliation = replacementController.reconcileControllerStartup([zoneId]);
		await firstDestroyStarted;
		const prematureSuccessorOutcome = await replacementController
			.beginGatewayEpoch({
				bootId: 'premature-gateway-boot',
				generationId: 'premature-gateway-generation',
				sessionLabel: 'premature-gateway-before-destruction',
				zoneId,
			})
			.then(
				(successor) => ({ kind: 'admitted' as const, successor }),
				(error: unknown) => ({ error, kind: 'rejected' as const }),
			);
		permitFirstDestroy?.();
		await startupReconciliation;

		// Assert: both children are exactly destroyed before G, and C2 adopts no old epoch.
		const expectedChildDestructions = [`tool:${currentToolVm.id}`, `tool:${provisionalToolVm.id}`];
		const expectedGatewayDestruction = `gateway:${gatewayVm.id}`;
		const observedOldSubtreeDestruction = exactDestroyOrder.filter(
			(destroyedIdentity) =>
				expectedChildDestructions.includes(destroyedIdentity) ||
				destroyedIdentity === expectedGatewayDestruction,
		);
		expect(observedOldSubtreeDestruction).toHaveLength(3);
		expect(new Set(observedOldSubtreeDestruction.slice(0, 2))).toEqual(
			new Set(expectedChildDestructions),
		);
		expect(observedOldSubtreeDestruction[2]).toBe(expectedGatewayDestruction);
		await expect(
			journal.loadGatewayMembership(gatewayOwnership.gatewayIdentity.gatewayEpochId),
		).resolves.toMatchObject({
			children: [
				expect.objectContaining({ state: 'destroyed', vmId: currentToolVm.id }),
				expect.objectContaining({ state: 'destroyed', vmId: provisionalToolVm.id }),
			],
			state: 'destroyed',
		});
		expect(() =>
			replacementController.resolveGatewayEpoch({
				bootId: gatewayOwnership.gatewayIdentity.bootId,
				controllerEpoch: gatewayOwnership.gatewayIdentity.controllerEpoch,
				zoneId,
			}),
		).toThrow();
		if (prematureSuccessorOutcome.kind === 'admitted') {
			await replacementController.destroyGatewayDetached(
				prematureSuccessorOutcome.successor.gatewayIdentity,
			);
		}
		expect(prematureSuccessorOutcome).toMatchObject({ kind: 'rejected' });

		const successor = await replacementController.beginGatewayEpoch({
			bootId: 'gateway-boot-after-restart',
			generationId: 'gateway-generation-after-restart',
			sessionLabel: 'gateway-after-controller-restart',
			zoneId,
		});
		expect(successor.gatewayIdentity).toMatchObject({
			controllerEpoch: 'controller-epoch-after-restart',
			zoneId,
		});
		expect(successor.gatewayIdentity.gatewayVmId).not.toBe(gatewayVm.id);

		await Promise.all(oldTargets.map(assertExactTargetAlreadyAbsent));
		await expect(
			replacementController.destroyGatewayDetached(successor.gatewayIdentity),
		).resolves.toMatchObject({ complete: true, vmId: successor.gatewayIdentity.gatewayVmId });
	}, 180_000);
});
