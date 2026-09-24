export interface ManagedVmBootSignalSnapshot {
	readonly bootRequestObserved: boolean;
	readonly execResponseCount: number;
	readonly guestConsoleObserved: boolean;
	readonly guestControlFrameCount: number;
	readonly vfsReadyObserved: boolean;
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
	let guestConsoleObserved = false;
	let guestControlFrameCount = 0;
	let vfsReadyObserved = false;

	return {
		observe(component: string, message: string): void {
			if (!active) return;
			if (component === 'qemu') {
				guestConsoleObserved = true;
				return;
			}
			if (component === 'vfs') {
				if (message === 'vfs_ready') vfsReadyObserved = true;
				return;
			}
			if (component !== 'protocol') return;
			if (message.startsWith('client rx type=boot')) bootRequestObserved = true;
			if (!message.startsWith('virtio rx t=')) return;
			guestControlFrameCount = Math.min(guestControlFrameCount + 1, 1_000);
			if (message.startsWith('virtio rx t=exec_response')) {
				execResponseCount = Math.min(execResponseCount + 1, 1_000);
			}
		},
		snapshot(): ManagedVmBootSignalSnapshot {
			return {
				bootRequestObserved,
				execResponseCount,
				guestConsoleObserved,
				guestControlFrameCount,
				vfsReadyObserved,
			};
		},
		stop(): void {
			active = false;
		},
	};
}
