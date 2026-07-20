import { createHash } from 'node:crypto';

export type ManagedAgentSelfMutationOrigin = 'gateway' | 'tool-vm';
export const MANAGED_AGENT_SELF_REVISION_MANIFEST_RELATIVE_PATH = '.agent-vm-self-revision.json';

export interface ManagedAgentSelfRevisionManifest {
	readonly contentDigest: string;
	readonly profileAssignmentRevision: string;
	readonly revision: number;
}

export type ManagedAgentSelfCoherenceState =
	| { readonly kind: 'available'; readonly revision: number }
	| { readonly kind: 'fatal' }
	| {
			readonly kind: 'mutating';
			readonly origin: ManagedAgentSelfMutationOrigin;
			readonly revision: number;
	  };

export class ManagedAgentSelfCoherenceFatalError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'ManagedAgentSelfCoherenceFatalError';
	}
}

export interface ManagedAgentSelfMutation {
	complete(options: {
		readonly contentDigest: string;
		readonly flushCompleted: boolean;
		readonly handlesClosed: boolean;
	}): Promise<ManagedAgentSelfRevisionManifest>;
}

export interface ManagedAgentSelfCoherenceCoordinator {
	beginMutation(options: {
		readonly origin: ManagedAgentSelfMutationOrigin;
	}): ManagedAgentSelfMutation;
	readonly activeReadbackAttemptCount: number;
	readonly state: ManagedAgentSelfCoherenceState;
}

export interface ManagedAgentSelfReadbackAttempt {
	/** Synchronously and irreversibly releases the attempt's owned transport/read resources. */
	dispose(): void;
	/** May remain pending after disposal, but must no longer own or perform underlying I/O. */
	readonly result: Promise<ManagedAgentSelfRevisionManifest | null>;
}

type StartManifestReadback = (
	expectedRevision: number,
	signal: AbortSignal,
) => ManagedAgentSelfReadbackAttempt;

interface ManagedAgentSelfCoherenceClock {
	clearTimeout(timeoutHandle: ReturnType<typeof setTimeout>): void;
	setTimeout(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout>;
}

const sha256DigestPattern = /^sha256:[0-9a-f]{64}$/u;

function updateLengthPrefixedBytes(hash: ReturnType<typeof createHash>, content: Uint8Array): void {
	const lengthPrefix = Buffer.alloc(8);
	lengthPrefix.writeBigUInt64BE(BigInt(content.byteLength));
	hash.update(lengthPrefix);
	hash.update(content);
}

export function createManagedAgentSelfContentDigest(options: {
	readonly entries: readonly {
		readonly content: Uint8Array;
		readonly relativePath: string;
	}[];
	readonly maximumBytes: number;
	readonly maximumEntries: number;
}): string {
	if (!Number.isSafeInteger(options.maximumEntries) || options.maximumEntries <= 0) {
		throw new Error('Managed agent self digest entry bound must be a positive safe integer.');
	}
	if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes <= 0) {
		throw new Error('Managed agent self digest byte bound must be a positive safe integer.');
	}
	if (options.entries.length > options.maximumEntries) {
		throw new Error('Managed agent self digest exceeds its bounded entry count.');
	}
	const sortedEntries = [...options.entries].toSorted((leftEntry, rightEntry) =>
		Buffer.compare(
			Buffer.from(leftEntry.relativePath, 'utf8'),
			Buffer.from(rightEntry.relativePath, 'utf8'),
		),
	);
	if (new Set(sortedEntries.map((entry) => entry.relativePath)).size !== sortedEntries.length) {
		throw new Error('Managed agent self digest rejects duplicate relative paths.');
	}
	let totalBytes = 0;
	const hash = createHash('sha256');
	hash.update('managed-agent-self-content:v1\0', 'utf8');
	for (const entry of sortedEntries) {
		if (
			entry.relativePath.length === 0 ||
			entry.relativePath.includes('\0') ||
			entry.relativePath.startsWith('/') ||
			entry.relativePath.endsWith('/') ||
			entry.relativePath.includes('\\') ||
			entry.relativePath === MANAGED_AGENT_SELF_REVISION_MANIFEST_RELATIVE_PATH ||
			entry.relativePath
				.split('/')
				.some((pathSegment) => pathSegment === '' || pathSegment === '.' || pathSegment === '..')
		) {
			throw new Error(
				`Managed agent self digest path '${entry.relativePath}' must be canonical and relative.`,
			);
		}
		const pathBytes = Buffer.from(entry.relativePath, 'utf8');
		totalBytes += pathBytes.byteLength + entry.content.byteLength;
		if (totalBytes > options.maximumBytes) {
			throw new Error('Managed agent self digest exceeds its bounded byte count.');
		}
		updateLengthPrefixedBytes(hash, pathBytes);
		updateLengthPrefixedBytes(hash, entry.content);
	}
	return `sha256:${hash.digest('hex')}`;
}

function manifestsEqual(
	leftManifest: ManagedAgentSelfRevisionManifest,
	rightManifest: ManagedAgentSelfRevisionManifest,
): boolean {
	return (
		leftManifest.contentDigest === rightManifest.contentDigest &&
		leftManifest.profileAssignmentRevision === rightManifest.profileAssignmentRevision &&
		leftManifest.revision === rightManifest.revision
	);
}

export function createManagedAgentSelfCoherenceCoordinator(options: {
	readonly clock?: ManagedAgentSelfCoherenceClock;
	readonly maxReadbackAttempts: number;
	readonly profileAssignmentRevision: string;
	readonly readbackAttemptTimeoutMs: number;
	readonly startGatewayManifestReadback: StartManifestReadback;
	readonly startToolVmManifestReadback: StartManifestReadback;
	readonly writeManifest: (manifest: ManagedAgentSelfRevisionManifest) => Promise<void>;
}): ManagedAgentSelfCoherenceCoordinator {
	if (!Number.isSafeInteger(options.maxReadbackAttempts) || options.maxReadbackAttempts <= 0) {
		throw new Error('Managed agent self readback attempts must be a positive safe integer.');
	}
	if (
		!Number.isSafeInteger(options.readbackAttemptTimeoutMs) ||
		options.readbackAttemptTimeoutMs <= 0
	) {
		throw new Error('Managed agent self readback timeout must be a positive safe integer.');
	}
	if (
		typeof options.profileAssignmentRevision !== 'string' ||
		options.profileAssignmentRevision.length === 0 ||
		options.profileAssignmentRevision.length > 256
	) {
		throw new Error('Managed agent self coordinator requires a bounded assignment revision.');
	}
	const clock = options.clock ?? {
		clearTimeout: (timeoutHandle): void => clearTimeout(timeoutHandle),
		setTimeout: (callback, timeoutMs): ReturnType<typeof setTimeout> =>
			setTimeout(callback, timeoutMs),
	};

	let currentRevision = 0;
	let currentState: ManagedAgentSelfCoherenceState = { kind: 'available', revision: 0 };
	let activeMutationToken: symbol | undefined;
	let activeReadbackAttempt: ManagedAgentSelfReadbackAttempt | undefined;
	const readWithDeadline = async (
		startManifestReadback: StartManifestReadback,
		expectedRevision: number,
	): Promise<ManagedAgentSelfRevisionManifest | null | 'timed-out'> => {
		if (activeReadbackAttempt !== undefined) {
			throw new Error('Managed agent self readback attempts must never overlap.');
		}
		const abortController = new AbortController();
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const readbackAttempt = startManifestReadback(expectedRevision, abortController.signal);
		activeReadbackAttempt = readbackAttempt;
		const timeoutResult = new Promise<'timed-out'>((resolve) => {
			timeoutHandle = clock.setTimeout(() => {
				resolve('timed-out');
				abortController.abort('managed-agent-self-readback-timeout');
			}, options.readbackAttemptTimeoutMs);
		});
		try {
			return await Promise.race([readbackAttempt.result, timeoutResult]);
		} finally {
			if (timeoutHandle !== undefined) {
				clock.clearTimeout(timeoutHandle);
			}
			if (!abortController.signal.aborted) {
				abortController.abort('managed-agent-self-readback-complete');
			}
			try {
				readbackAttempt.dispose();
			} finally {
				activeReadbackAttempt = undefined;
			}
		}
	};

	const failFatal = (message: string, cause?: unknown): never => {
		activeMutationToken = undefined;
		currentState = { kind: 'fatal' };
		throw new ManagedAgentSelfCoherenceFatalError(message, cause === undefined ? {} : { cause });
	};

	return {
		beginMutation(mutationOptions): ManagedAgentSelfMutation {
			if (currentState.kind === 'fatal') {
				throw new ManagedAgentSelfCoherenceFatalError(
					'Managed agent self projection is unavailable after a fatal coherence failure.',
				);
			}
			if (activeMutationToken !== undefined) {
				throw new Error('Managed agent self mutation already active for this projection.');
			}
			const mutationOptionKeys = Object.keys(mutationOptions);
			if (
				mutationOptionKeys.length !== 1 ||
				mutationOptionKeys[0] !== 'origin' ||
				(mutationOptions.origin !== 'gateway' && mutationOptions.origin !== 'tool-vm')
			) {
				throw new Error('Managed agent self mutation contains an unsupported mutation option.');
			}
			const { origin } = mutationOptions;
			const mutationToken = Symbol('managed-agent-self-mutation');
			const nextRevision = currentRevision + 1;
			activeMutationToken = mutationToken;
			currentState = { kind: 'mutating', origin, revision: nextRevision };
			let completed = false;

			return {
				async complete(completionOptions): Promise<ManagedAgentSelfRevisionManifest> {
					if (completed || activeMutationToken !== mutationToken) {
						throw new Error('Managed agent self mutation token is no longer current.');
					}
					completed = true;
					const completionOptionKeys = Object.keys(completionOptions).toSorted();
					if (
						completionOptionKeys.length !== 3 ||
						completionOptionKeys[0] !== 'contentDigest' ||
						completionOptionKeys[1] !== 'flushCompleted' ||
						completionOptionKeys[2] !== 'handlesClosed'
					) {
						return failFatal(
							'Managed agent self mutation completion contains an unsupported proof field.',
						);
					}
					if (!completionOptions.handlesClosed || !completionOptions.flushCompleted) {
						return failFatal(
							'Managed agent self mutation requires closed handles and completed bounded flush.',
						);
					}
					if (!sha256DigestPattern.test(completionOptions.contentDigest)) {
						return failFatal('Managed agent self mutation requires a canonical SHA-256 digest.');
					}

					const expectedManifest: ManagedAgentSelfRevisionManifest = Object.freeze({
						contentDigest: completionOptions.contentDigest,
						profileAssignmentRevision: options.profileAssignmentRevision,
						revision: nextRevision,
					});
					const startOppositeManifestReadback =
						origin === 'tool-vm'
							? options.startGatewayManifestReadback
							: options.startToolVmManifestReadback;
					try {
						await options.writeManifest(expectedManifest);
						for (let attempt = 0; attempt < options.maxReadbackAttempts; attempt += 1) {
							// oxlint-disable-next-line no-await-in-loop -- ordered bounded retries must observe a fresh cross-view result.
							const observedManifest = await readWithDeadline(
								startOppositeManifestReadback,
								nextRevision,
							);
							if (
								observedManifest !== null &&
								observedManifest !== 'timed-out' &&
								manifestsEqual(observedManifest, expectedManifest)
							) {
								currentRevision = nextRevision;
								activeMutationToken = undefined;
								currentState = { kind: 'available', revision: currentRevision };
								return expectedManifest;
							}
						}
					} catch (error) {
						return failFatal('Managed agent self cross-view readback failed.', error);
					}
					return failFatal(
						'Managed agent self cross-view readback was stale, mismatched, or withheld.',
					);
				},
			};
		},
		get activeReadbackAttemptCount(): number {
			return activeReadbackAttempt === undefined ? 0 : 1;
		},
		get state(): ManagedAgentSelfCoherenceState {
			return currentState;
		},
	};
}
