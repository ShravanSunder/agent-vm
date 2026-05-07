import {
	runGondolinImageBuildRequest,
	type GondolinImageBuildRequest,
} from './gondolin-image-builder.js';

interface GondolinBuildRequestMessage {
	readonly request: GondolinImageBuildRequest;
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

process.on('message', (message: unknown) => {
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
			const result = await runGondolinImageBuildRequest(message.request);
			process.send?.({ result, type: 'result' });
		} catch (error) {
			process.send?.({
				message: error instanceof Error ? error.message : String(error),
				...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
				type: 'error',
			});
		} finally {
			disconnectFromParent();
		}
	})();
});
