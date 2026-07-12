import type {
	ManagedVmCanonicalDirectoryIdentity,
	OwnedHostDirectory,
	OwnedHostDirectoryState,
	OwnedHostDirectoryTransfer,
} from './managed-vm-contracts.js';

export interface OwnedHostDirectoryControllerOptions {
	readonly identity: ManagedVmCanonicalDirectoryIdentity;
	readonly onClose: () => void;
	readonly onConsume?: () => void;
}

/**
 * Creates the backend-neutral half of an owned-directory capability. Native
 * resources remain captured by provider callbacks and never enter this object.
 */
export function createOwnedHostDirectoryController(
	options: OwnedHostDirectoryControllerOptions,
): OwnedHostDirectory {
	type InternalOwnedHostDirectoryState = OwnedHostDirectoryState | 'transferring';
	let currentState: InternalOwnedHostDirectoryState = 'acquired';
	let resourceClosed = false;
	let resourceClosing = false;
	const getInternalState = (): InternalOwnedHostDirectoryState => currentState;

	const closeResource = (): boolean => {
		if (resourceClosed) {
			return true;
		}
		if (resourceClosing) {
			return false;
		}
		resourceClosing = true;
		try {
			options.onClose();
			resourceClosed = true;
			return true;
		} finally {
			resourceClosing = false;
		}
	};

	const transfer: OwnedHostDirectoryTransfer = {
		close(): void {
			if (currentState !== 'adapter-owned') {
				return;
			}
			if (closeResource()) {
				currentState = 'closed';
			}
		},
		get identity(): ManagedVmCanonicalDirectoryIdentity {
			return options.identity;
		},
		get state(): 'adapter-owned' | 'closed' {
			return currentState === 'adapter-owned' ? 'adapter-owned' : 'closed';
		},
	};

	return {
		close(): void {
			if (currentState === 'adapter-owned') {
				throw new Error(
					'Owned host directory cannot be closed by its former owner after transfer.',
				);
			}
			if (getInternalState() === 'closed') {
				return;
			}
			if (closeResource()) {
				currentState = 'closed';
			}
		},
		consume(): OwnedHostDirectoryTransfer {
			if (currentState !== 'acquired') {
				throw new Error(`Owned host directory cannot be consumed while ${currentState}.`);
			}
			currentState = 'transferring';
			try {
				options.onConsume?.();
			} catch (consumeError) {
				try {
					if (closeResource()) {
						currentState = 'closed';
					}
				} catch (closeError) {
					// oxlint-disable-next-line preserve-caught-error -- AggregateError.errors retains cleanup failure while cause retains the transfer failure.
					throw new AggregateError(
						[consumeError, closeError],
						'Owned host directory transfer and cleanup both failed.',
						{ cause: consumeError },
					);
				}
				throw consumeError;
			}
			if (getInternalState() === 'closed') {
				throw new Error('Owned host directory closed during ownership transfer.');
			}
			currentState = 'adapter-owned';
			return transfer;
		},
		get identity(): ManagedVmCanonicalDirectoryIdentity {
			return options.identity;
		},
		get state(): OwnedHostDirectoryState {
			return currentState === 'transferring' ? 'acquired' : currentState;
		},
	};
}

export function assertPositiveHostProcessId(hostProcessId: number | null): number {
	if (!Number.isSafeInteger(hostProcessId) || hostProcessId === null || hostProcessId <= 0) {
		throw new Error('A started managed VM must expose a positive stable host process ID.');
	}
	return hostProcessId;
}
