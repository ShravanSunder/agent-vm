import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
	createControllerRunnerOperationLedger,
	type ControllerRunnerAllowedTransitionBySource,
	type ControllerRunnerOperationLedger,
	type CreateControllerRunnerOperationLedgerProps,
} from './controller-runner-operation-record.js';

const crashCuts = [
	'reservation',
	'runner-create',
	'pre-identity-start',
	'identity-publication',
	'admission',
	'dispatch',
	'side-effect',
	'stream',
	'result',
	'containment',
	'gateway-retirement',
] as const;

const operationAuthority = {
	controllerEpoch: 'controller-epoch-a',
	executionFingerprint: 'fingerprint-a',
	gatewayEpoch: 'gateway-epoch-a',
	operationId: 'operation-a',
	parentGatewayVmId: 'gateway-vm-a',
	runnerId: 'runner-a',
	runtimeEpoch: 'runtime-epoch-a',
	stablePrincipal: 'a'.repeat(64),
} as const;

const runnerIdentity = {
	command: 'qemu-system-aarch64 -name runner-a',
	hostProcessId: 12_345,
	processStartIdentity: 'Mon Jul 13 18:00:00 2026',
	vmId: 'runner-vm-a',
} as const;

const testLedgerRuntime = {
	clock: { now: (): Date => new Date('2026-07-13T18:00:00.000Z') },
} satisfies CreateControllerRunnerOperationLedgerProps['runtime'];

describe('controller runner durable crash cuts', () => {
	it.each(crashCuts)(
		'contains or fences predecessor work after %s without adoption or redispatch',
		async (crashCut) => {
			await using temporaryRuntime = await createTemporaryRuntimeDirectory();
			const containPredecessor = vi.fn(async () =>
				crashCut === 'reservation' ||
				crashCut === 'runner-create' ||
				crashCut === 'pre-identity-start'
					? ({ kind: 'owner-unsafe', reason: 'identity-not-published' } as const)
					: ({ kind: 'contained' } as const),
			);
			const predecessor = createControllerRunnerOperationLedger({
				containPredecessor,
				controllerEpoch: operationAuthority.controllerEpoch,
				recordsDirectoryPath: temporaryRuntime.path,
				runtime: testLedgerRuntime,
			});
			await advanceOperationToCrashCut(predecessor, crashCut);

			const successor = createControllerRunnerOperationLedger({
				containPredecessor,
				controllerEpoch: 'controller-epoch-b',
				recordsDirectoryPath: temporaryRuntime.path,
				runtime: testLedgerRuntime,
			});
			const recovery = await successor.recover();

			expect(recovery).toMatchObject({ adoptedRunnerCount: 0, redispatchedOperationCount: 0 });
			expect(recovery.predecessorOperations).toContainEqual(
				expect.objectContaining({
					operationId: operationAuthority.operationId,
					outcome:
						crashCut === 'reservation' ||
						crashCut === 'runner-create' ||
						crashCut === 'pre-identity-start'
							? 'owner-unsafe'
							: 'contained',
				}),
			);
			expect(containPredecessor).toHaveBeenCalledOnce();
		},
	);

	it('persists full parentage, fingerprint, and host process identity before dispatch', async () => {
		await using temporaryRuntime = await createTemporaryRuntimeDirectory();
		const ledger = createControllerRunnerOperationLedger({
			containPredecessor: async () => ({ kind: 'contained' }),
			controllerEpoch: operationAuthority.controllerEpoch,
			recordsDirectoryPath: temporaryRuntime.path,
			runtime: testLedgerRuntime,
		});
		await advanceOperationToCrashCut(ledger, 'dispatch');

		await expect(ledger.load(operationAuthority.operationId)).resolves.toMatchObject({
			...operationAuthority,
			identity: runnerIdentity,
			kind: 'dispatch-armed',
		});
	});

	it('blocks a successor in the same parent scope after uncontained pre-identity work', async () => {
		await using temporaryRuntime = await createTemporaryRuntimeDirectory();
		const predecessor = createControllerRunnerOperationLedger({
			containPredecessor: async () => ({
				kind: 'owner-unsafe',
				reason: 'identity-not-published',
			}),
			controllerEpoch: operationAuthority.controllerEpoch,
			recordsDirectoryPath: temporaryRuntime.path,
			runtime: testLedgerRuntime,
		});
		await advanceOperationToCrashCut(predecessor, 'pre-identity-start');
		const successor = createControllerRunnerOperationLedger({
			containPredecessor: async () => ({
				kind: 'owner-unsafe',
				reason: 'identity-not-published',
			}),
			controllerEpoch: 'controller-epoch-b',
			recordsDirectoryPath: temporaryRuntime.path,
			runtime: testLedgerRuntime,
		});
		await successor.recover();

		await expect(
			successor.admitSuccessor({
				parentGatewayVmId: operationAuthority.parentGatewayVmId,
				stablePrincipal: operationAuthority.stablePrincipal,
			}),
		).resolves.toEqual({ kind: 'rejected', reason: 'predecessor-owner-unsafe' });
	});

	it('records positive normal-flow containment as the durable terminal state', async () => {
		await using temporaryRuntime = await createTemporaryRuntimeDirectory();
		const ledger = createControllerRunnerOperationLedger({
			containPredecessor: async () => ({ kind: 'contained' }),
			controllerEpoch: operationAuthority.controllerEpoch,
			recordsDirectoryPath: temporaryRuntime.path,
			runtime: testLedgerRuntime,
		});
		await advanceOperationToCrashCut(ledger, 'result');
		await ledger.recordContainmentStarted({ operationId: operationAuthority.operationId });
		await ledger.recordContained({ operationId: operationAuthority.operationId });

		await expect(ledger.load(operationAuthority.operationId)).resolves.toMatchObject({
			containment: 'proven',
			kind: 'contained-terminal',
		});
		await expect(
			ledger.admitSuccessor({
				parentGatewayVmId: operationAuthority.parentGatewayVmId,
				stablePrincipal: operationAuthority.stablePrincipal,
			}),
		).resolves.toEqual({ kind: 'admitted' });
	});

	it('rejects skipped and backward runtime transitions without changing the durable record', async () => {
		await using temporaryRuntime = await createTemporaryRuntimeDirectory();
		const ledger = createControllerRunnerOperationLedger({
			containPredecessor: async () => ({ kind: 'contained' }),
			controllerEpoch: operationAuthority.controllerEpoch,
			recordsDirectoryPath: temporaryRuntime.path,
			runtime: testLedgerRuntime,
		});
		await ledger.reserve(operationAuthority);

		await expect(
			ledger.recordVmCreated({
				operationId: operationAuthority.operationId,
				vmId: runnerIdentity.vmId,
			}),
		).rejects.toThrow("expected 'creation-started'");
		await expect(ledger.load(operationAuthority.operationId)).resolves.toMatchObject({
			generation: 1,
			kind: 'reserved',
			updatedAt: '2026-07-13T18:00:00.000Z',
		});

		await ledger.recordCreationStarted({ operationId: operationAuthority.operationId });
		await expect(
			ledger.recordCreationStarted({ operationId: operationAuthority.operationId }),
		).rejects.toThrow("expected 'reserved'");
		await expect(ledger.load(operationAuthority.operationId)).resolves.toMatchObject({
			generation: 2,
			kind: 'creation-started',
		});
	});

	it('exposes only the compiler-approved next kinds and required grouped runtime clock', () => {
		expectTypeOf<
			ControllerRunnerAllowedTransitionBySource['reserved']
		>().toEqualTypeOf<'creation-started'>();
		expectTypeOf<ControllerRunnerAllowedTransitionBySource['identity-published']>().toEqualTypeOf<
			'admission-validated' | 'containment-started'
		>();
		expectTypeOf<
			ControllerRunnerAllowedTransitionBySource['result-recorded']
		>().toEqualTypeOf<'containment-started'>();
		expectTypeOf<CreateControllerRunnerOperationLedgerProps>().toHaveProperty('runtime');
		expectTypeOf<CreateControllerRunnerOperationLedgerProps>().not.toHaveProperty('now');
		expectTypeOf<
			CreateControllerRunnerOperationLedgerProps['runtime']['clock']['now']
		>().toEqualTypeOf<() => Date>();
	});

	it('does not expose dispatch or adoption authority to recovery', () => {
		expectTypeOf<CreateControllerRunnerOperationLedgerProps>().not.toHaveProperty('dispatch');
		expectTypeOf<ControllerRunnerOperationLedger>().not.toHaveProperty('adopt');
		expect(true).toBe(true);
	});
});

async function advanceOperationToCrashCut(
	ledger: ControllerRunnerOperationLedger,
	crashCut: (typeof crashCuts)[number],
): Promise<void> {
	await ledger.reserve(operationAuthority);
	if (crashCut === 'reservation') return;
	await ledger.recordCreationStarted({ operationId: operationAuthority.operationId });
	if (crashCut === 'runner-create') return;
	await ledger.recordVmCreated({
		operationId: operationAuthority.operationId,
		vmId: runnerIdentity.vmId,
	});
	if (crashCut === 'pre-identity-start') return;
	await ledger.publishIdentity({
		identity: runnerIdentity,
		operationId: operationAuthority.operationId,
	});
	if (crashCut === 'identity-publication') return;
	await ledger.recordAdmissionValidated({ operationId: operationAuthority.operationId });
	if (crashCut === 'admission') return;
	await ledger.recordDispatchArmed({ operationId: operationAuthority.operationId });
	if (crashCut === 'dispatch') return;
	await ledger.recordRunning({ operationId: operationAuthority.operationId });
	if (crashCut === 'side-effect') return;
	await ledger.recordResultStreaming({ operationId: operationAuthority.operationId });
	if (crashCut === 'stream') return;
	await ledger.recordResult({ operationId: operationAuthority.operationId });
	if (crashCut === 'result') return;
	await ledger.recordContainmentStarted({ operationId: operationAuthority.operationId });
	if (crashCut === 'containment') return;
	await ledger.recordGatewayRetired({ operationId: operationAuthority.operationId });
}

async function createTemporaryRuntimeDirectory(): Promise<
	AsyncDisposable & { readonly path: string }
> {
	const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-runner-ledger-'));
	return {
		path: temporaryDirectoryPath,
		[Symbol.asyncDispose]: async (): Promise<void> => {
			await rm(temporaryDirectoryPath, { force: true, recursive: true });
		},
	};
}
