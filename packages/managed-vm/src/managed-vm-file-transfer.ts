export interface ManagedVmCreateDirectoryRequest {
	readonly guestPath: string;
	readonly signal?: AbortSignal;
}

export interface ManagedVmWriteFileStreamRequest {
	readonly contents: AsyncIterable<Uint8Array>;
	readonly guestPath: string;
	readonly signal?: AbortSignal;
}

/** Trusted controller plumbing, not an agent-visible filesystem or mount. */
export interface ManagedVmFileTransferCapability {
	/** Create a private directory; an existing target is a conflict, not reuse. */
	createDirectory(request: ManagedVmCreateDirectoryRequest): Promise<void>;
	/**
	 * Stream into a caller-owned temporary file. This truncates the target;
	 * path authorization, reservations and no-replace publication belong to the caller.
	 * Resolves only after destination completion, without collecting the input.
	 */
	writeFileStream(request: ManagedVmWriteFileStreamRequest): Promise<void>;
}
