import type { ManagedVmImageBuildRequest } from './gondolin-image-builder.js';

interface GondolinBuildRequestMessage {
	readonly request: ManagedVmImageBuildRequest;
	readonly type: 'build-request';
}

function isGondolinBuildRequestMessage(value: unknown): value is GondolinBuildRequestMessage {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as {
		readonly request?: unknown;
		readonly type?: unknown;
	};
	return candidate.type === 'build-request' && typeof candidate.request === 'object';
}

function disconnectFromParent(): void {
	process.disconnect?.();
}

function sendStructuredError(error: unknown): void {
	process.send?.({
		message: error instanceof Error ? error.message : String(error),
		...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
		type: 'error',
	});
}

process.on('uncaughtException', (error) => {
	sendStructuredError(error);
	disconnectFromParent();
	process.exitCode = 1;
});

process.on('unhandledRejection', (reason) => {
	sendStructuredError(reason);
	disconnectFromParent();
	process.exitCode = 1;
});

process.once('message', (message: unknown) => {
	void (async (): Promise<void> => {
		if (!isGondolinBuildRequestMessage(message)) {
			process.send?.({
				message: 'Invalid Gondolin build child request.',
				type: 'error',
			});
			disconnectFromParent();
			return;
		}

		try {
			const { runManagedVmImageBuildRequest } = await import('./gondolin-image-builder.js');
			const result = await runManagedVmImageBuildRequest(message.request);
			process.send?.({ result, type: 'result' });
		} catch (error) {
			sendStructuredError(error);
		} finally {
			disconnectFromParent();
		}
	})();
});
