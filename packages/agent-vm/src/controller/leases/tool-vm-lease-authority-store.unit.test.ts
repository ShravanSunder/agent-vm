import { describe, expect, it } from 'vitest';

import {
	createToolVmLeaseAuthorityStore,
	type ToolVmLeaseSessionAttachment,
	type ToolVmLeaseStableOwner,
} from './tool-vm-lease-authority-store.js';

const stableOwner = {
	agentId: 'main',
	agentWorkspaceDir: '/home/openclaw/workspace',
	purpose: 'tool_vm_lease',
	sessionKeyDigest: '0123456789abcdef0123456789abcdef',
	workMountDir: '/host/sandbox-work',
	zoneId: 'zone-a',
} satisfies ToolVmLeaseStableOwner;

const sessionAttachment = {
	bootId: 'gateway-boot-a',
	connectionId: 'socket-a',
	controllerEpoch: 'epoch-a',
	peerId: 'gateway-zone-a',
	sessionId: 'session-a',
} satisfies ToolVmLeaseSessionAttachment;

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
			sessionAttachment,
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
