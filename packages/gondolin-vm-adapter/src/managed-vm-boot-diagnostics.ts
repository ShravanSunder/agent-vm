export interface ManagedVmBootSignalSnapshot {
	readonly bootRequestObserved: boolean;
	readonly execResponseCount: number;
	readonly guestControlFrameCount: number;
	readonly hostExecRequestObserved: boolean;
	readonly initramfsObserved: boolean;
	readonly initramfsRootDeviceNotFoundObserved: boolean;
	readonly initramfsRootMountFailedObserved: boolean;
	readonly initramfsVirtioPortsNotReadyObserved: boolean;
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
	let execResponseCount = 0;
	let guestControlFrameCount = 0;
	let hostExecRequestObserved = false;
	let initramfsObserved = false;
	let initramfsRootDeviceNotFoundObserved = false;
	let initramfsRootMountFailedObserved = false;
	let initramfsVirtioPortsNotReadyObserved = false;
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
		if (message.startsWith('[initramfs]')) {
			initramfsObserved = true;
			if (message.startsWith('[initramfs] root device ')) {
				initramfsRootDeviceNotFoundObserved = true;
			}
			if (message.startsWith('[initramfs] failed to mount ')) {
				initramfsRootMountFailedObserved = true;
			}
			if (message === '[initramfs] virtio ports not ready') {
				initramfsVirtioPortsNotReadyObserved = true;
			}
			return;
		}
		if (!message.startsWith('[init]')) return;
		rootfsInitObserved = true;
		if (message.startsWith('[init] starting sandboxfs')) sandboxfsLaunchObserved = true;
		if (
			message === '[init] sandboxfs mount not ready' ||
			message === '[init] /usr/bin/sandboxfs missing'
		) {
			sandboxfsFailureObserved = true;
		}
		if (message === '[init] starting sandboxssh') sandboxsshLaunchObserved = true;
		// This serial marker precedes `exec /usr/bin/sandboxd`; it does not prove sandboxd started.
		if (message === '[init] starting sandboxd') preSandboxdMarkerObserved = true;
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
				execResponseCount,
				guestControlFrameCount,
				hostExecRequestObserved,
				initramfsObserved,
				initramfsRootDeviceNotFoundObserved,
				initramfsRootMountFailedObserved,
				initramfsVirtioPortsNotReadyObserved,
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
