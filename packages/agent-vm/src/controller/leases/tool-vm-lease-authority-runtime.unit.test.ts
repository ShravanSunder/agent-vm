import { describe, expect, it, vi } from 'vitest';

import { createToolVmLeaseAuthorityRuntime } from './tool-vm-lease-authority-runtime.js';
import {
	COMPATIBILITY,
	GATEWAY_ONE,
	RUNTIME_BINDING,
	SSH_BINDING,
	createAuthority,
	createLease,
	expectTransitionError,
	type TestLease,
} from './tool-vm-lease-authority-runtime.test-helpers.js';

describe('createToolVmLeaseAuthorityRuntime', () => {
	it('publishes provisioning authority without inventing a VM or reservation identity', () => {
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease, { readonly slot: number }>();
		const authority = createAuthority();
		const cleanupContext = { slot: 1 };
		runtime.registerGateway(GATEWAY_ONE);

		runtime.beginProvisioning({
			authority,
			cleanupContext,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: 10_000,
		});

		expect(runtime.authorityForLease(authority.leaseId)).toEqual(authority);
		expect(runtime.cleanupContextForAuthority(authority)).toBe(cleanupContext);
		expect(runtime.leafSnapshotForLease(authority.leaseId)).toEqual(
			expect.objectContaining({ kind: 'provisioning' }),
		);
		expect(JSON.stringify(runtime.leafSnapshotForLease(authority.leaseId))).not.toMatch(
			/reservation|destructionIdentity|receipt/u,
		);
	});

	it('does not retain a second resource when reducer admission rejects a principal collision', () => {
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const firstAuthority = createAuthority();
		const secondAuthority = createAuthority({
			leaseId: 'lease-2',
			leafGeneration: 'leaf-generation-2',
		});
		runtime.registerGateway(GATEWAY_ONE);
		runtime.beginProvisioning({
			authority: firstAuthority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: 10_000,
		});

		expect(() =>
			runtime.beginProvisioning({
				authority: secondAuthority,
				compatibility: COMPATIBILITY,
				idleExpiresAtMs: 10_000,
			}),
		).toThrow(/already has/iu);
		expect(runtime.authorityForLease(firstAuthority.leaseId)).toEqual(firstAuthority);
		expect(runtime.authorityForLease(secondAuthority.leaseId)).toBeUndefined();
	});

	it('atomically binds the VM at current commit and publishes the lease', async () => {
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const lease = createLease();
		runtime.registerGateway(GATEWAY_ONE);
		runtime.beginProvisioning({ authority, compatibility: COMPATIBILITY, idleExpiresAtMs: 10_000 });

		await runtime.commitCurrent({
			authority,
			lease,
			runtimeBinding: RUNTIME_BINDING,
			sshBinding: SSH_BINDING,
		});

		expect(runtime.getLease(lease.id)).toBe(lease);
		expect(runtime.leafSnapshotForLease(lease.id)).toMatchObject({
			kind: 'current',
			runtimeBinding: RUNTIME_BINDING,
			sshBinding: SSH_BINDING,
		});
	});

	it('rejects commit when the lease VM does not match the controller runtime binding', async () => {
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		runtime.registerGateway(GATEWAY_ONE);
		runtime.beginProvisioning({ authority, compatibility: COMPATIBILITY, idleExpiresAtMs: 10_000 });

		await expect(
			runtime.commitCurrent({
				authority,
				lease: createLease({ vm: { id: 'different-vm' } }),
				runtimeBinding: RUNTIME_BINDING,
				sshBinding: SSH_BINDING,
			}),
		).rejects.toThrow(/does not match/iu);
		expect(runtime.getLease(authority.leaseId)).toBeUndefined();
	});

	it('accepts identical commit retries and rejects binding drift', async () => {
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const lease = createLease();
		runtime.registerGateway(GATEWAY_ONE);
		runtime.beginProvisioning({ authority, compatibility: COMPATIBILITY, idleExpiresAtMs: 10_000 });
		await runtime.commitCurrent({
			authority,
			lease,
			runtimeBinding: RUNTIME_BINDING,
			sshBinding: SSH_BINDING,
		});

		await expect(
			runtime.commitCurrent({
				authority,
				lease,
				runtimeBinding: RUNTIME_BINDING,
				sshBinding: SSH_BINDING,
			}),
		).resolves.toBeUndefined();
		await expect(
			runtime.commitCurrent({
				authority,
				lease,
				runtimeBinding: { ...RUNTIME_BINDING, tcpSlot: 2 },
				sshBinding: SSH_BINDING,
			}),
		).rejects.toThrow(/retry changed/iu);
	});

	it('allows an admitted provisioning leaf to commit after parent seal but rejects new admission', async () => {
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		runtime.registerGateway(GATEWAY_ONE);
		runtime.beginProvisioning({ authority, compatibility: COMPATIBILITY, idleExpiresAtMs: 10_000 });
		runtime.sealGateway(GATEWAY_ONE);

		await runtime.commitCurrent({
			authority,
			lease: createLease(),
			runtimeBinding: RUNTIME_BINDING,
			sshBinding: SSH_BINDING,
		});
		await expectTransitionError(
			() =>
				runtime.beginProvisioning({
					authority: createAuthority({ leaseId: 'lease-2', leafGeneration: 'leaf-generation-2' }),
					compatibility: COMPATIBILITY,
					idleExpiresAtMs: 10_000,
				}),
			'parent-not-admitting',
		);
	});

	it('runs the controller destroy callback once and retires only after completion', async () => {
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const destroy = vi.fn(async () => {});
		runtime.registerGateway(GATEWAY_ONE);
		runtime.beginProvisioning({ authority, compatibility: COMPATIBILITY, idleExpiresAtMs: 10_000 });
		runtime.sealGateway(GATEWAY_ONE);

		await expectTransitionError(() => runtime.retireGateway(GATEWAY_ONE), 'parent-has-live-leaves');
		await runtime.destroyExact({ authority, destroy, destroyedAtMs: 20_000, reason: 'shutdown' });
		runtime.retireGateway(GATEWAY_ONE);

		expect(destroy).toHaveBeenCalledOnce();
		expect(runtime.authorityForLease(authority.leaseId)).toBeUndefined();
	});
});
