import { describe, expect, it } from 'vitest';

import { createToolVmLeaseId, isToolVmLeaseId } from './tool-vm-lease-id.js';

describe('Tool VM lease ids', () => {
	it('creates opaque UUIDv7 lease ids and rejects legacy readable ids', () => {
		const leaseId = createToolVmLeaseId();

		expect(isToolVmLeaseId(leaseId)).toBe(true);
		expect(isToolVmLeaseId('1b5c5d78-91b4-4c8e-a15e-f475dced59ef')).toBe(false);
		expect(isToolVmLeaseId('shravan-main-1700000000000')).toBe(false);
		expect(isToolVmLeaseId('agent:main:discord:channel:123')).toBe(false);
		expect(isToolVmLeaseId('not-a-uuid')).toBe(false);
	});
});
