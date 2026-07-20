import { describe, expectTypeOf, it } from 'vitest';

import type {
	ManagedVmExactProcessTerminationCapability,
	ManagedVmExactProcessTerminationOutcome,
	ManagedVmHostProcessIdentity,
	ManagedVmProvider,
} from './managed-vm-contracts.js';

describe('ManagedVm exact process termination contract', () => {
	it('exposes one backend-neutral exact-recorded-process capability', () => {
		expectTypeOf<
			ManagedVmProvider['exactProcessTermination']
		>().toEqualTypeOf<ManagedVmExactProcessTerminationCapability>();
	});

	it('binds termination to the durable VM, pid, start, and command identity', () => {
		expectTypeOf<
			Parameters<ManagedVmExactProcessTerminationCapability['terminateRecordedHostProcess']>
		>().toEqualTypeOf<
			[
				{
					readonly contextLabel: string;
					readonly identity: ManagedVmHostProcessIdentity;
				},
			]
		>();
		expectTypeOf<
			Awaited<
				ReturnType<ManagedVmExactProcessTerminationCapability['terminateRecordedHostProcess']>
			>
		>().toEqualTypeOf<ManagedVmExactProcessTerminationOutcome>();
	});
});
