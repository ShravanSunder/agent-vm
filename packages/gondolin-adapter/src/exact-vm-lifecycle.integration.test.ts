import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	createManagedVmOwnershipReservation,
	destroyManagedVmExact,
	readManagedVmDestroyTarget,
	readManagedVmOwnershipReservation,
} from './exact-vm-lifecycle.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((temporaryDirectory) => rm(temporaryDirectory, { force: true, recursive: true })),
	);
});

describe('exact VM lifecycle adapter', () => {
	it('creates and reads authoritative ownership before detached exact destruction', async () => {
		const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-exact-lifecycle-'));
		temporaryDirectories.push(temporaryDirectory);
		const identity = randomUUID();
		const principal = JSON.stringify({
			configPath: `/${'nested-deployment-path/'.repeat(10)}config/system.jsonc`,
			controllerPort: 18_800,
			kind: 'worker-task',
			projectNamespace: 'agent-vm-integration',
			taskId: identity,
			zoneId: 'worker-zone',
		});
		expect(principal.length).toBeGreaterThan(256);
		const created = await createManagedVmOwnershipReservation({
			controllerEpoch: 'controller-integration',
			parentGateway: null,
			principal,
			reservationId: `reservation-${identity}`,
			reservationRoot: temporaryDirectory,
			role: 'standalone',
			sessionLabel: 'adapter-integration',
			vmId: `vm-${identity}`,
		});

		const reservation = await readManagedVmOwnershipReservation(created.reservationPath);
		const target = await readManagedVmDestroyTarget(created.reservationPath);
		const receipt = await destroyManagedVmExact(target);

		expect(reservation.reservationId).toBe(created.reservation.reservationId);
		expect(reservation.principal).toBe(principal);
		expect(target).toEqual(created.target);
		expect(target.principal).toBe(principal);
		expect(receipt).toMatchObject({
			complete: true,
			contractVersion: 1,
			reservationId: created.reservation.reservationId,
			vmId: created.reservation.vmId,
		});
	});
});
