import { describe, expect, it } from 'vitest';

import {
	classifyToolVmLeaseCloseOutcome,
	classifyToolVmLeaseReleaseRequest,
	classifyToolVmLeaseRenewal,
	isToolVmLeaseExpired,
	isToolVmLeaseIdleExpired,
} from './tool-vm-lease-lifecycle.js';

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
		expect(classifyToolVmLeaseCloseOutcome({ closeSucceeded: true })).toEqual({
			kind: 'release-tcp-and-delete-record',
		});
	});

	it('classifies close failure as TCP quarantine and runtime-record preservation', () => {
		expect(classifyToolVmLeaseCloseOutcome({ closeSucceeded: false })).toEqual({
			kind: 'quarantine-tcp-and-preserve-record',
		});
	});
});
