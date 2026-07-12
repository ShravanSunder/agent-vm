// @ts-expect-error Lease is an internal controller type, not a public root export.
import type { Lease as ForbiddenPublicLease } from '@agent-vm/agent-vm';
// @ts-expect-error ToolVmProvisioningHandle is an internal controller type.
import type { ToolVmProvisioningHandle as ForbiddenPublicProvisioningHandle } from '@agent-vm/agent-vm';
// @ts-expect-error createLeaseManager is an internal controller factory.
import type { createLeaseManager as ForbiddenPublicLeaseManagerFactory } from '@agent-vm/agent-vm';
import { describe, expect, it } from 'vitest';

describe('agent-vm public API boundary', () => {
	it('keeps controller lease implementation types internal', () => {
		expect<ForbiddenPublicLease | ForbiddenPublicProvisioningHandle | undefined>(
			undefined,
		).toBeUndefined();
		expect<typeof ForbiddenPublicLeaseManagerFactory | undefined>(undefined).toBeUndefined();
	});
});
