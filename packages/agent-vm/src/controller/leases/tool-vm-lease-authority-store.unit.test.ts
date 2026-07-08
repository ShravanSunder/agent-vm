import { describe, expect, it } from 'vitest';

import { createToolVmLeaseAuthorityStore } from './tool-vm-lease-authority-store.js';

const stableOwner = {
	agentId: 'main',
	agentWorkspaceDir: '/home/openclaw/workspace',
	bootId: 'gateway-boot-a',
	controllerEpoch: 'epoch-a',
	peerId: 'gateway-zone-a',
	purpose: 'tool_vm_lease',
	sessionKeyDigest: '0123456789abcdef0123456789abcdef',
	workMountDir: '/host/sandbox-work',
	zoneId: 'zone-a',
};

describe('tool VM lease authority store', () => {
	it('keeps retired old-lease authority only for the tombstone window', () => {
		let nowMs = 1_000;
		const store = createToolVmLeaseAuthorityStore({
			now: () => nowMs,
			tombstoneTtlMs: 500,
		});
		store.recordCurrent({
			compatibility: { profileId: 'standard' },
			leaseId: 'lease-old',
			owner: stableOwner,
		});

		store.markRetired('lease-old');

		expect(store.resolve('lease-old')).toEqual(
			expect.objectContaining({
				leaseId: 'lease-old',
				state: 'retired',
			}),
		);

		nowMs = 1_501;

		expect(store.resolve('lease-old')).toBeUndefined();
	});
});
