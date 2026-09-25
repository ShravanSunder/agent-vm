export interface ManagedVmBootSignalSnapshot {
	readonly bootRequestObserved: boolean;
	readonly dhcpActivityObserved: boolean;
	readonly execResponseCount: number;
	readonly ext4MountActivityObserved: boolean;
	readonly guestControlFrameCount: number;
	readonly hostExecRequestObserved: boolean;
	readonly initProcessLaunchObserved: boolean;
	readonly initramfsObserved: boolean;
	readonly initramfsUnpackFailureObserved: boolean;
	readonly initramfsRootDeviceNotFoundObserved: boolean;
	readonly initramfsRootMountFailedObserved: boolean;
	readonly initramfsVirtioPortsNotReadyObserved: boolean;
	readonly kernelOomObserved: boolean;
	readonly kernelPanicObserved: boolean;
	readonly linuxKernelBannerObserved: boolean;
	readonly qemuStderrObserved: boolean;
	readonly qemuStdoutObserved: boolean;
	readonly rootfsInitObserved: boolean;
	readonly preSandboxdMarkerObserved: boolean;
	readonly sandboxfsFailureObserved: boolean;
	readonly sandboxfsLaunchObserved: boolean;
	readonly sandboxsshLaunchObserved: boolean;
	readonly vfsReadyObserved: boolean;
	readonly virtioFsFrameCount: number;
}

export interface ManagedVmBootSignalTracker {
	observe(component: string, message: string): void;
	snapshot(): ManagedVmBootSignalSnapshot;
	stop(): void;
}

/** Retain only finite startup signals from Gondolin's debug callback, never its guest text. */
export function createManagedVmBootSignalTracker(): ManagedVmBootSignalTracker {
	let active = true;
	let bootRequestObserved = false;
	let dhcpActivityObserved = false;
	let execResponseCount = 0;
	let ext4MountActivityObserved = false;
	let guestControlFrameCount = 0;
	let hostExecRequestObserved = false;
	let initProcessLaunchObserved = false;
	let initramfsObserved = false;
	let initramfsUnpackFailureObserved = false;
	let initramfsRootDeviceNotFoundObserved = false;
	let initramfsRootMountFailedObserved = false;
	let initramfsVirtioPortsNotReadyObserved = false;
	let kernelOomObserved = false;
	let kernelPanicObserved = false;
	let linuxKernelBannerObserved = false;
	let qemuStderrObserved = false;
	let qemuStdoutObserved = false;
	let rootfsInitObserved = false;
	let preSandboxdMarkerObserved = false;
	let sandboxfsFailureObserved = false;
	let sandboxfsLaunchObserved = false;
	let sandboxsshLaunchObserved = false;
	let vfsReadyObserved = false;
	let virtioFsFrameCount = 0;

	function observeGuestInitSignal(message: string): void {
		const signalText = message.replace(/^\[\s*\d+(?:\.\d+)?\]\s+/u, '');
		if (signalText.startsWith('Linux version ')) linuxKernelBannerObserved = true;
		if (signalText.startsWith('Run /init as init process')) initProcessLaunchObserved = true;
		if (signalText.startsWith('Initramfs unpacking failed:')) {
			initramfsUnpackFailureObserved = true;
		}
		if (signalText.startsWith('Kernel panic - not syncing:')) kernelPanicObserved = true;
		if (signalText.startsWith('Out of memory:') || signalText.startsWith('oom-kill:')) {
			kernelOomObserved = true;
		}
		if (
			signalText.startsWith('udhcpc:') ||
			signalText === '[init] udhcpc failed' ||
			signalText === '[initramfs] udhcpc failed'
		) {
			dhcpActivityObserved = true;
		}
		if (signalText.startsWith('EXT4-fs (')) ext4MountActivityObserved = true;
		if (signalText.startsWith('[initramfs]')) {
			initramfsObserved = true;
			if (signalText.startsWith('[initramfs] root device ') && signalText.endsWith(' not found')) {
				initramfsRootDeviceNotFoundObserved = true;
			}
			if (signalText.startsWith('[initramfs] failed to mount ')) {
				initramfsRootMountFailedObserved = true;
			}
			if (signalText === '[initramfs] virtio ports not ready') {
				initramfsVirtioPortsNotReadyObserved = true;
			}
			return;
		}
		if (!signalText.startsWith('[init]')) return;
		rootfsInitObserved = true;
		if (signalText.startsWith('[init] starting sandboxfs')) sandboxfsLaunchObserved = true;
		if (
			signalText === '[init] sandboxfs mount not ready' ||
			signalText === '[init] /usr/bin/sandboxfs missing'
		) {
			sandboxfsFailureObserved = true;
		}
		if (signalText === '[init] starting sandboxssh') sandboxsshLaunchObserved = true;
		// This serial marker precedes `exec /usr/bin/sandboxd`; it does not prove sandboxd started.
		if (signalText === '[init] starting sandboxd') preSandboxdMarkerObserved = true;
	}

	return {
		observe(component: string, message: string): void {
			if (!active) return;
			if (component === 'qemu') {
				if (message.startsWith('stdout: ')) {
					qemuStdoutObserved = true;
					observeGuestInitSignal(message.slice('stdout: '.length));
				} else {
					qemuStderrObserved = true;
				}
				return;
			}
			if (component === 'vfs') {
				if (message === 'vfs_ready') vfsReadyObserved = true;
				return;
			}
			if (component !== 'protocol') return;
			if (message.startsWith('client rx type=boot')) bootRequestObserved = true;
			if (message === 'client rx type=exec' || message.startsWith('client rx type=exec ')) {
				hostExecRequestObserved = true;
			}
			if (message.startsWith('virtiofs rx t=')) {
				virtioFsFrameCount = Math.min(virtioFsFrameCount + 1, 1_000);
				return;
			}
			if (message.startsWith('virtio rx t=')) {
				guestControlFrameCount = Math.min(guestControlFrameCount + 1, 1_000);
			}
			if (message.startsWith('virtio rx t=exec_response')) {
				execResponseCount = Math.min(execResponseCount + 1, 1_000);
			}
		},
		snapshot(): ManagedVmBootSignalSnapshot {
			return {
				bootRequestObserved,
				dhcpActivityObserved,
				execResponseCount,
				ext4MountActivityObserved,
				guestControlFrameCount,
				hostExecRequestObserved,
				initProcessLaunchObserved,
				initramfsObserved,
				initramfsUnpackFailureObserved,
				initramfsRootDeviceNotFoundObserved,
				initramfsRootMountFailedObserved,
				initramfsVirtioPortsNotReadyObserved,
				kernelOomObserved,
				kernelPanicObserved,
				linuxKernelBannerObserved,
				qemuStderrObserved,
				qemuStdoutObserved,
				rootfsInitObserved,
				preSandboxdMarkerObserved,
				sandboxfsFailureObserved,
				sandboxfsLaunchObserved,
				sandboxsshLaunchObserved,
				vfsReadyObserved,
				virtioFsFrameCount,
			};
		},
		stop(): void {
			active = false;
		},
	};
}
