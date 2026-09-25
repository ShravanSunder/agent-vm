import { describe, expect, it } from 'vitest';

import { createManagedVmBootSignalTracker } from './managed-vm-boot-diagnostics.js';

describe('managed VM boot signal tracker', () => {
	it('classifies fixed kernel boot milestones without retaining guest output', () => {
		const tracker = createManagedVmBootSignalTracker();
		tracker.observe('qemu', 'stdout: [    0.000000] Linux version 6.12.1-private');
		tracker.observe('qemu', 'stdout: [    0.010000] Run /init as init process');
		tracker.observe('qemu', 'stdout: [    0.020000] Initramfs unpacking failed: private archive');
		tracker.observe('qemu', 'stdout: [    0.030000] Kernel panic - not syncing: private reason');
		tracker.observe('qemu', 'stdout: [    0.040000] Out of memory: Killed process 42 (private)');
		tracker.observe('qemu', 'stdout: [    0.050000] udhcpc: sending discover on private-interface');
		tracker.observe('qemu', 'stdout: [    0.060000] EXT4-fs (vda): mounted private-volume');

		const snapshot = tracker.snapshot();
		expect(snapshot).toMatchObject({
			dhcpActivityObserved: true,
			ext4MountActivityObserved: true,
			initProcessLaunchObserved: true,
			initramfsUnpackFailureObserved: true,
			kernelOomObserved: true,
			kernelPanicObserved: true,
			linuxKernelBannerObserved: true,
		});
		expect(JSON.stringify(snapshot)).not.toMatch(/private|archive|reason|interface|volume|vda/u);
	});

	it('classifies pinned QEMU, guest init, virtiofs, and host exec milestones without retaining text', () => {
		const tracker = createManagedVmBootSignalTracker();
		tracker.observe('qemu', 'stdout: [initramfs] root device /dev/private-root not found');
		tracker.observe('qemu', 'stdout: [init] starting sandboxfs at /private/mount');
		tracker.observe('qemu', 'stdout: [init] /usr/bin/sandboxfs missing');
		tracker.observe('qemu', 'stdout: [init] starting sandboxssh');
		tracker.observe('qemu', 'stdout: [init] starting sandboxd');
		tracker.observe('qemu', 'stderr: private-qemu-error');
		tracker.observe('protocol', 'client rx type=exec id=secret cmd=private-command');
		tracker.observe('protocol', 'virtiofs rx t=fs_request id=secret op=lookup');
		tracker.observe('protocol', 'virtio rx t=exec_response id=secret exit=0');

		const snapshot = tracker.snapshot();
		expect(snapshot).toEqual({
			bootRequestObserved: false,
			dhcpActivityObserved: false,
			execResponseCount: 1,
			ext4MountActivityObserved: false,
			guestControlFrameCount: 1,
			hostExecRequestObserved: true,
			initProcessLaunchObserved: false,
			initramfsObserved: true,
			initramfsUnpackFailureObserved: false,
			initramfsRootDeviceNotFoundObserved: true,
			initramfsRootMountFailedObserved: false,
			initramfsVirtioPortsNotReadyObserved: false,
			kernelOomObserved: false,
			kernelPanicObserved: false,
			linuxKernelBannerObserved: false,
			qemuStderrObserved: true,
			qemuStdoutObserved: true,
			rootfsInitObserved: true,
			preSandboxdMarkerObserved: true,
			sandboxfsFailureObserved: true,
			sandboxfsLaunchObserved: true,
			sandboxsshLaunchObserved: true,
			vfsReadyObserved: false,
			virtioFsFrameCount: 1,
		});
		expect(JSON.stringify(snapshot)).not.toMatch(/private|secret|\/dev\/|cmd=|id=/u);
	});

	it('caps the virtiofs frame count', () => {
		const tracker = createManagedVmBootSignalTracker();
		for (let frame = 0; frame < 1_005; frame += 1) {
			tracker.observe('protocol', 'virtiofs rx t=fs_request id=1 op=lookup');
		}

		expect(tracker.snapshot().virtioFsFrameCount).toBe(1_000);
	});

	it('does not classify a found initramfs root device as a boot failure', () => {
		const tracker = createManagedVmBootSignalTracker();
		tracker.observe('qemu', 'stdout: [initramfs] root device /dev/vda found');

		expect(tracker.snapshot().initramfsRootDeviceNotFoundObserved).toBe(false);
	});

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
			dhcpActivityObserved: false,
			execResponseCount: 1,
			ext4MountActivityObserved: false,
			guestControlFrameCount: 1,
			hostExecRequestObserved: true,
			initProcessLaunchObserved: false,
			initramfsObserved: false,
			initramfsUnpackFailureObserved: false,
			initramfsRootDeviceNotFoundObserved: false,
			initramfsRootMountFailedObserved: false,
			initramfsVirtioPortsNotReadyObserved: false,
			kernelOomObserved: false,
			kernelPanicObserved: false,
			linuxKernelBannerObserved: false,
			qemuStderrObserved: false,
			qemuStdoutObserved: true,
			rootfsInitObserved: false,
			preSandboxdMarkerObserved: false,
			sandboxfsFailureObserved: false,
			sandboxfsLaunchObserved: false,
			sandboxsshLaunchObserved: false,
			vfsReadyObserved: true,
			virtioFsFrameCount: 0,
		});
		expect(JSON.stringify(snapshot)).not.toMatch(/private|\/data|cmd=|id=/u);
	});
});
