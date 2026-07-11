import type { VmDestroyReceiptV1 } from '@agent-vm/gondolin-adapter';
import { describe, expect, it } from 'vitest';

import {
	classifyToolVmLeaseCloseOutcome,
	classifyToolVmLeaseReleaseRequest,
	classifyToolVmLeaseRenewal,
	isToolVmLeaseExpired,
	isToolVmLeaseIdleExpired,
} from './tool-vm-lease-lifecycle.js';

const incompleteVmDestroyReceipt = {
	contractVersion: 1,
	reservationId: 'reservation-incomplete',
	vmId: 'tool-vm-incomplete',
	controllerEpoch: 'controller-epoch-1',
	parentGateway: { vmId: 'gateway-vm-1', epoch: 'gateway-epoch-1' },
	role: 'tool',
	requestedRunner: {
		backend: 'qemu',
		executableName: 'qemu-system-aarch64',
		discoveryIdentity: 'runner-incomplete',
	},
	complete: false,
	completedAt: '2026-07-10T00:00:00.000Z',
	resources: {
		exactRunner: { status: 'unproven', reason: 'runner-resistant' },
		ingressListener: { status: 'already-absent' },
		ingressSockets: { status: 'already-absent' },
		sshListener: { status: 'destroyed' },
		sshSessions: { status: 'destroyed' },
		sessionIpc: { status: 'already-absent' },
		qmp: { status: 'destroyed' },
		disposableStorage: { status: 'destroyed' },
	},
} satisfies VmDestroyReceiptV1;

const completeVmDestroyReceipt = {
	...incompleteVmDestroyReceipt,
	complete: true,
	resources: {
		...incompleteVmDestroyReceipt.resources,
		exactRunner: { status: 'destroyed' },
	},
} satisfies VmDestroyReceiptV1;

describe('Tool VM lease lifecycle classification', () => {
	it('classifies idle expiration separately from active-use expiration protection', () => {
		const leaseTiming = {
			effectiveIdleTtlMs: 1_000,
			lastUsedAt: 1_000,
			nowMs: 2_001,
		};

		expect(isToolVmLeaseIdleExpired(leaseTiming)).toBe(true);
		expect(isToolVmLeaseExpired({ ...leaseTiming, activeUseCount: 0 })).toBe(true);
		expect(isToolVmLeaseExpired({ ...leaseTiming, activeUseCount: 1 })).toBe(false);
	});

	it('classifies renewals as evict-expired before probing VM liveness', () => {
		expect(
			classifyToolVmLeaseRenewal({
				activeUseCount: 0,
				effectiveIdleTtlMs: 1_000,
				lastUsedAt: 1_000,
				nowMs: 2_001,
				vmLive: false,
			}),
		).toEqual({ kind: 'evict-expired' });
	});

	it('classifies renewals as evict-dead only when the lease is not expired and the VM probe failed', () => {
		expect(
			classifyToolVmLeaseRenewal({
				activeUseCount: 0,
				effectiveIdleTtlMs: 10_000,
				lastUsedAt: 1_000,
				nowMs: 2_001,
				vmLive: false,
			}),
		).toEqual({ kind: 'evict-dead' });
	});

	it('classifies renewals as renewable when the lease is not expired and the VM is live', () => {
		expect(
			classifyToolVmLeaseRenewal({
				activeUseCount: 0,
				effectiveIdleTtlMs: 10_000,
				lastUsedAt: 1_000,
				nowMs: 2_001,
				vmLive: true,
			}),
		).toEqual({ kind: 'renew' });
	});

	it('blocks release with active use unless force is set', () => {
		expect(
			classifyToolVmLeaseReleaseRequest({
				activeUseCount: 1,
				force: false,
				lastUsedAt: 1_000,
			}),
		).toEqual({ kind: 'blocked-active-use' });
		expect(
			classifyToolVmLeaseReleaseRequest({
				activeUseCount: 1,
				force: true,
				lastUsedAt: 1_000,
			}),
		).toEqual({ kind: 'release' });
	});

	it('skips release when the lease was touched after the caller cutoff', () => {
		expect(
			classifyToolVmLeaseReleaseRequest({
				activeUseCount: 0,
				force: false,
				ifLastUsedAtBeforeOrAt: 1_500,
				lastUsedAt: 2_000,
			}),
		).toEqual({ kind: 'skip-recently-used' });
	});

	it('classifies close success as safe TCP release and record deletion', () => {
		expect(classifyToolVmLeaseCloseOutcome({ destroyReceipt: completeVmDestroyReceipt })).toEqual({
			kind: 'release-tcp-and-delete-record',
		});
	});

	it('classifies close failure as TCP quarantine and runtime-record preservation', () => {
		expect(classifyToolVmLeaseCloseOutcome({ destroyReceipt: undefined })).toEqual({
			kind: 'quarantine-tcp-and-preserve-record',
		});
	});

	it('uses destroy receipt completeness instead of promise resolution as the ownership oracle', () => {
		expect(classifyToolVmLeaseCloseOutcome({ destroyReceipt: completeVmDestroyReceipt })).toEqual({
			kind: 'release-tcp-and-delete-record',
		});
		expect(classifyToolVmLeaseCloseOutcome({ destroyReceipt: incompleteVmDestroyReceipt })).toEqual(
			{
				kind: 'quarantine-tcp-and-preserve-record',
			},
		);
	});
});
