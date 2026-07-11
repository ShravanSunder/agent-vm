import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	GatewayMembershipError,
	registerGatewayMembershipBarrier,
	type GatewayEpochIdentity,
	type ToolVmOwnershipReservationReference,
} from './gateway-membership-barrier.js';
import type { VmOwnershipDeploymentIdentity } from './vm-ownership-contracts.js';
import { createVmOwnershipJournal } from './vm-ownership-journal.js';

const TEST_DEPLOYMENT_IDENTITY = {
	configPath: '/deployments/sunfam/config/system.jsonc',
	controllerPort: 18_800,
	projectNamespace: 'sunfam-test-deployment',
} satisfies VmOwnershipDeploymentIdentity;

const temporaryDirectories: string[] = [];

async function createTemporaryStateDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'agent-vm-membership-barrier-'));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) => {
			await rm(directory, { force: true, recursive: true });
		}),
	);
});

const gatewayIdentity = {
	bootId: 'boot-gateway-a',
	controllerEpoch: 'controller-epoch-a',
	gatewayEpochId: 'gateway-epoch-a',
	gatewayVmId: 'gateway-vm-a',
	generationId: 'gateway-generation-a',
	zoneId: 'sunfam',
} satisfies GatewayEpochIdentity;

function createToolReservation(
	reservationId: string,
	options: {
		readonly agentId?: string;
		readonly gateway?: GatewayEpochIdentity;
		readonly reservationPath?: string;
		readonly revision?: number;
	} = {},
): ToolVmOwnershipReservationReference {
	const gateway = options.gateway ?? gatewayIdentity;
	return {
		controllerEpoch: gateway.controllerEpoch,
		expectedRevision: options.revision ?? 1,
		parentGateway: {
			gatewayEpochId: gateway.gatewayEpochId,
			gatewayVmId: gateway.gatewayVmId,
		},
		principal: {
			...TEST_DEPLOYMENT_IDENTITY,
			agentId: options.agentId ?? 'main',
			kind: 'stable-agent',
			zoneId: gateway.zoneId,
		},
		reservationId,
		reservationPath:
			options.reservationPath ??
			`/var/lib/agent-vm/reservations/${reservationId}/reservation-v1.json`,
		role: 'tool',
		sessionLabel: `tool:${reservationId}`,
		vmId: `vm-${reservationId}`,
	};
}

async function createBarrier(): Promise<{
	readonly barrier: Awaited<ReturnType<typeof registerGatewayMembershipBarrier>>;
	readonly stateDirectory: string;
	readonly toolReservation: (
		reservationId: string,
		options?: Omit<Parameters<typeof createToolReservation>[1], 'reservationPath'>,
	) => ToolVmOwnershipReservationReference;
}> {
	const stateDirectory = await createTemporaryStateDirectory();
	const journal = createVmOwnershipJournal({
		nowMs: () => 1_720_000_000_000,
		stateDirectory,
	});
	const barrier = await registerGatewayMembershipBarrier({
		gateway: gatewayIdentity,
		gatewayReservation: {
			controllerEpoch: gatewayIdentity.controllerEpoch,
			expectedRevision: 1,
			parentGateway: null,
			principal: {
				...TEST_DEPLOYMENT_IDENTITY,
				kind: 'gateway-zone',
				zoneId: gatewayIdentity.zoneId,
			},
			reservationId: 'gateway-reservation-a',
			reservationPath: journal.reservationPathFor('gateway-reservation-a'),
			role: 'gateway',
			sessionLabel: 'gateway:sunfam',
			vmId: gatewayIdentity.gatewayVmId,
		},
		journal,
	});
	return {
		barrier,
		stateDirectory,
		toolReservation: (reservationId, options = {}) =>
			createToolReservation(reservationId, {
				...options,
				reservationPath: journal.reservationPathFor(reservationId),
			}),
	};
}

async function promiseSettled(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	void promise.finally(() => {
		settled = true;
	});
	await Promise.resolve();
	await Promise.resolve();
	return settled;
}

describe('GatewayMembershipBarrier', () => {
	it('linearizes seal against provisional admission before its first await', async () => {
		// Arrange
		const { barrier, toolReservation } = await createBarrier();
		const admission = barrier.admitProvisionalChild(
			gatewayIdentity,
			toolReservation('tool-reservation-a'),
		);

		// Act
		const sealed = barrier.sealGatewayEpoch(gatewayIdentity);

		// Assert
		expect(() =>
			barrier.admitProvisionalChild(
				gatewayIdentity,
				toolReservation('tool-reservation-after-seal'),
			),
		).toThrowError(expect.objectContaining({ code: 'gateway-not-admitting' }));
		await expect(admission.commitCurrent()).rejects.toMatchObject({
			code: 'gateway-not-admitting',
		});
		expect(await promiseSettled(sealed.barrier)).toBe(false);
		await admission.recordDestroyDisposition({
			complete: true,
			observedReservationRevision: 2,
		});
		await expect(sealed.barrier).resolves.toEqual({
			gatewayEpochId: gatewayIdentity.gatewayEpochId,
			kind: 'children-destroyed',
		});
	});

	it('retries an incomplete Gateway disposition without permitting successor admission', async () => {
		// Arrange
		const { barrier, toolReservation } = await createBarrier();
		const sealed = barrier.sealGatewayEpoch(gatewayIdentity);
		await sealed.barrier;
		await barrier.beginGatewayDestroying(gatewayIdentity);

		// Act
		await barrier.recordGatewayDestroyDisposition(gatewayIdentity, { complete: false });

		// Assert
		expect(barrier.snapshot().state).toBe('owner-unsafe');
		expect(() =>
			barrier.admitProvisionalChild(
				gatewayIdentity,
				toolReservation('tool-reservation-after-incomplete-gateway'),
			),
		).toThrowError(expect.objectContaining({ code: 'gateway-not-admitting' }));
		await barrier.beginGatewayDestroying(gatewayIdentity);
		await expect(
			barrier.recordGatewayDestroyDisposition(gatewayIdentity, { complete: true }),
		).resolves.toMatchObject({ state: 'destroyed' });
	});

	it('keeps a late incomplete child in the barrier until a positive retry', async () => {
		// Arrange
		const { barrier, toolReservation } = await createBarrier();
		const admission = barrier.admitProvisionalChild(
			gatewayIdentity,
			toolReservation('tool-reservation-b'),
		);
		await admission.durable;
		const sealed = barrier.sealGatewayEpoch(gatewayIdentity);

		// Act
		await admission.recordDestroyDisposition({
			complete: false,
			observedReservationRevision: 2,
			reason: 'exact-destroy-incomplete',
		});

		// Assert
		expect(barrier.snapshot().state).toBe('owner-unsafe');
		expect(await promiseSettled(sealed.barrier)).toBe(false);
		await admission.recordDestroyDisposition({
			complete: true,
			observedReservationRevision: 3,
		});
		await expect(sealed.barrier).resolves.toMatchObject({ kind: 'children-destroyed' });
		await expect(barrier.beginGatewayDestroying(gatewayIdentity)).resolves.toMatchObject({
			state: 'destroying',
		});
	});

	it('keeps completed child destruction terminal after a late incomplete disposition', async () => {
		// Arrange
		const { barrier, toolReservation } = await createBarrier();
		const admission = barrier.admitProvisionalChild(
			gatewayIdentity,
			toolReservation('tool-reservation-terminal'),
		);
		await admission.durable;
		const sealed = barrier.sealGatewayEpoch(gatewayIdentity);
		await admission.recordDestroyDisposition({
			complete: true,
			observedReservationRevision: 2,
		});
		await sealed.barrier;

		// Act
		await admission
			.recordDestroyDisposition({
				complete: false,
				observedReservationRevision: 3,
				reason: 'exact-destroy-incomplete',
			})
			.catch(() => undefined);

		// Assert
		expect(barrier.snapshot()).toMatchObject({
			children: [expect.objectContaining({ state: 'destroyed' })],
			state: 'sealed',
		});
		await expect(barrier.beginGatewayDestroying(gatewayIdentity)).resolves.toMatchObject({
			state: 'destroying',
		});
	});

	it('rejects duplicate children and a wrong Gateway identity', async () => {
		// Arrange
		const { barrier, toolReservation } = await createBarrier();
		const child = toolReservation('tool-reservation-c');
		const admission = barrier.admitProvisionalChild(gatewayIdentity, child);
		await admission.durable;
		const wrongGateway = {
			...gatewayIdentity,
			gatewayEpochId: 'gateway-epoch-wrong',
		} satisfies GatewayEpochIdentity;

		// Act / Assert
		expect(() => barrier.admitProvisionalChild(gatewayIdentity, child)).toThrowError(
			GatewayMembershipError,
		);
		expect(() => barrier.sealGatewayEpoch(wrongGateway)).toThrowError(
			expect.objectContaining({ code: 'gateway-identity-mismatch' }),
		);
	});

	it('rejects a Tool VM reservation whose parent is not the registered Gateway', async () => {
		// Arrange
		const { barrier, toolReservation } = await createBarrier();
		const wrongParent = toolReservation('tool-reservation-d', {
			gateway: {
				...gatewayIdentity,
				gatewayEpochId: 'gateway-epoch-b',
				gatewayVmId: 'gateway-vm-b',
			},
		});

		// Act / Assert
		expect(() => barrier.admitProvisionalChild(gatewayIdentity, wrongParent)).toThrowError(
			expect.objectContaining({ code: 'wrong-parent' }),
		);
	});

	it('allows at most one provisional or current leaf for a stable principal', async () => {
		// Arrange
		const { barrier, toolReservation } = await createBarrier();
		const firstAdmission = barrier.admitProvisionalChild(
			gatewayIdentity,
			toolReservation('tool-reservation-e', { agentId: 'main' }),
		);
		await firstAdmission.durable;

		// Act / Assert
		expect(() =>
			barrier.admitProvisionalChild(
				gatewayIdentity,
				toolReservation('tool-reservation-f', { agentId: 'main' }),
			),
		).toThrowError(expect.objectContaining({ code: 'principal-conflict' }));
		await firstAdmission.commitCurrent();
		expect(() =>
			barrier.admitProvisionalChild(
				gatewayIdentity,
				toolReservation('tool-reservation-g', { agentId: 'main' }),
			),
		).toThrowError(expect.objectContaining({ code: 'principal-conflict' }));
	});

	it('persists state transitions for durable reload without offering adoption', async () => {
		// Arrange
		const { barrier, stateDirectory, toolReservation } = await createBarrier();
		const admission = barrier.admitProvisionalChild(
			gatewayIdentity,
			toolReservation('tool-reservation-h'),
		);
		await admission.durable;
		await admission.commitCurrent();
		const sealed = barrier.sealGatewayEpoch(gatewayIdentity);
		await admission.recordDestroyDisposition({
			complete: true,
			observedReservationRevision: 2,
		});
		await sealed.barrier;
		await barrier.beginGatewayDestroying(gatewayIdentity);
		await barrier.recordGatewayDestroyDisposition(gatewayIdentity, { complete: true });
		const journal = createVmOwnershipJournal({
			nowMs: () => 1_720_000_000_100,
			stateDirectory,
		});

		// Act
		const reloaded = await journal.loadGatewayMembership(gatewayIdentity.gatewayEpochId);

		// Assert
		expect(reloaded.state).toBe('destroyed');
		expect(reloaded.children).toEqual([
			expect.objectContaining({
				reservationId: 'tool-reservation-h',
				state: 'destroyed',
			}),
		]);
		expect('adopt' in journal).toBe(false);
	});
});
