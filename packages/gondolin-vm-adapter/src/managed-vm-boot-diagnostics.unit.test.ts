import { describe, expect, it } from 'vitest';

import { createManagedVmBootSignalTracker } from './managed-vm-boot-diagnostics.js';

describe('managed VM boot signal tracker', () => {
	it('keeps only closed startup signals and discards guest and command text', () => {
		const tracker = createManagedVmBootSignalTracker();
		tracker.observe('protocol', 'client rx type=boot fuseMount=/data binds=2');
		tracker.observe('qemu', 'stdout: private-guest-output');
		tracker.observe('protocol', 'client rx type=exec id=7 cmd=private-command');
		tracker.observe('protocol', 'virtio rx t=exec_response id=7 exit=0');
		tracker.observe('vfs', 'vfs_ready');
		tracker.stop();
		tracker.observe('protocol', 'virtio rx t=exec_response id=8 exit=0');

		const snapshot = tracker.snapshot();
		expect(snapshot).toEqual({
			bootRequestObserved: true,
			execResponseCount: 1,
			guestControlFrameCount: 1,
			qemuOutputObserved: true,
			vfsReadyObserved: true,
		});
		expect(JSON.stringify(snapshot)).not.toMatch(/private|\/data|cmd=|id=/u);
	});
});
