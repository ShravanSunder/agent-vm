import {
	createPortalAgentIdentity as createPortalAgentIdentityBase,
	type PortalAgentIdentity,
} from '@agent-collaboration/tool-access/authorization';

export function createPortalAgentIdentity(
	input: Omit<Parameters<typeof createPortalAgentIdentityBase>[0], 'source'>,
): PortalAgentIdentity {
	return createPortalAgentIdentityBase({ ...input, source: 'cli-operator' });
}

export function createDeferred<TValue>(): {
	readonly promise: Promise<TValue>;
	readonly reject: (reason?: unknown) => void;
	readonly resolve: (value: TValue) => void;
} {
	let rejectPromise: ((reason?: unknown) => void) | undefined;
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve, reject) => {
		rejectPromise = reject;
		resolvePromise = resolve;
	});
	if (!rejectPromise || !resolvePromise) {
		throw new Error('deferred resolver was not initialized');
	}
	return { promise, reject: rejectPromise, resolve: resolvePromise };
}
