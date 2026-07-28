import { createHash } from 'node:crypto';

import type {
	GatewayRuntimeTrustedInvocationContext,
	SandboxEnvironmentHandle,
	SandboxOperationIdentity,
	SandboxStreamHandle,
	SandboxTerminalOutcome,
} from '@agent-vm/agent-portal-sdk/contracts';
import type {
	GatewayRuntimeLocalExecOperation,
	GatewayRuntimeLocalExecReadResult,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-local-exec';

import type { OpenClawGatewayRuntimeSandboxClient } from './gateway-runtime-sandbox-backend.js';

const EMPTY_STREAM_RETRY_INTERVAL_MS = 10;

export interface OpenClawGatewayRuntimeDirectExecution {
	readonly environment: SandboxEnvironmentHandle;
	readonly operation: SandboxOperationIdentity;
	readonly stderr: SandboxStreamHandle;
	readonly stdin: SandboxStreamHandle;
	readonly stdout: SandboxStreamHandle;
}

type SandboxRequestOptions = {
	readonly signal?: AbortSignal;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
};

export function gatewayRuntimeBinaryChunk(content: Uint8Array): {
	readonly byteLength: number;
	readonly contentBase64: string;
	readonly encoding: 'base64';
} {
	return {
		byteLength: content.byteLength,
		contentBase64: Buffer.from(content).toString('base64'),
		encoding: 'base64',
	};
}

export function gatewayRuntimeContentDigest(content: Uint8Array): `sha256:${string}` {
	return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export function requireGatewayRuntimeCompletedExitCode(
	outcome: SandboxTerminalOutcome,
	exitCode: number | undefined,
): number {
	if (outcome.kind !== 'completed') {
		throw new Error(`Gateway Runtime execution ended with '${outcome.kind}'.`);
	}
	if (exitCode === undefined) {
		throw new Error('Gateway Runtime completed execution without an exact exit code.');
	}
	return exitCode;
}

class OpenClawGatewayRuntimeLocalExecOperation implements GatewayRuntimeLocalExecOperation {
	readonly #client: OpenClawGatewayRuntimeSandboxClient;
	readonly #execution: OpenClawGatewayRuntimeDirectExecution;
	readonly #requestOptions: SandboxRequestOptions;
	#closePromise: Promise<void> | undefined;
	#stdinClosePromise: Promise<void> | undefined;
	#stdinCloseSettled = false;
	#stderrRemoteEof = false;
	#stderrEnded = false;
	#stdoutRemoteEof = false;
	#stdoutEnded = false;
	#waitSettled = false;
	#stdinSequence = 0;
	#stderrCursor: string | undefined;
	#stdoutCursor: string | undefined;

	constructor(options: {
		readonly client: OpenClawGatewayRuntimeSandboxClient;
		readonly execution: OpenClawGatewayRuntimeDirectExecution;
		readonly requestOptions: SandboxRequestOptions;
	}) {
		this.#client = options.client;
		this.#execution = options.execution;
		this.#requestOptions = options.requestOptions;
	}

	async cancel(): Promise<void> {
		try {
			await this.#client.sandbox.execution.cancel(
				{ operation: this.#execution.operation },
				this.#requestOptions,
			);
		} finally {
			await this.#closeEnvironment();
		}
	}

	async closeStdin(): Promise<void> {
		if (this.#waitSettled) return;
		this.#stdinClosePromise ??= this.#client.sandbox.stream
			.close({ stream: this.#execution.stdin }, this.#requestOptions)
			.then(async () => {
				this.#stdinCloseSettled = true;
				await this.#closeEnvironmentWhenSettled();
			});
		await this.#stdinClosePromise;
	}

	async readStderr(maximumBytes: number): Promise<GatewayRuntimeLocalExecReadResult> {
		return await this.#readOutput('stderr', maximumBytes);
	}

	async readStdout(maximumBytes: number): Promise<GatewayRuntimeLocalExecReadResult> {
		return await this.#readOutput('stdout', maximumBytes);
	}

	async wait(): Promise<{ readonly exitCode: number | null }> {
		try {
			const waited = await this.#client.sandbox.execution.wait(
				{ operation: this.#execution.operation, timeoutMs: 60 * 60 * 1_000 },
				this.#requestOptions,
			);
			return {
				exitCode: requireGatewayRuntimeCompletedExitCode(waited.outcome, waited.exitCode),
			};
		} finally {
			this.#waitSettled = true;
			await this.#closeEnvironmentWhenSettled();
		}
	}

	async writeStdin(content: Uint8Array): Promise<void> {
		const sequence = this.#stdinSequence;
		this.#stdinSequence += 1;
		await this.#client.sandbox.stream.write(
			{
				content: gatewayRuntimeBinaryChunk(content),
				contentDigest: gatewayRuntimeContentDigest(content),
				sequence,
				stream: this.#execution.stdin,
			},
			this.#requestOptions,
		);
	}

	async #readOutput(
		channel: 'stderr' | 'stdout',
		maximumBytes: number,
	): Promise<GatewayRuntimeLocalExecReadResult> {
		if (channel === 'stdout' ? this.#stdoutEnded : this.#stderrEnded) return { kind: 'end' };
		if (channel === 'stdout' ? this.#stdoutRemoteEof : this.#stderrRemoteEof) {
			this.#markOutputEnded(channel);
			await this.#closeEnvironmentWhenSettled();
			return { kind: 'end' };
		}
		const stream = channel === 'stdout' ? this.#execution.stdout : this.#execution.stderr;
		/* oxlint-disable no-await-in-loop -- cursor reads are sequential and empty reads are rate-limited */
		while (true) {
			const cursor = channel === 'stdout' ? this.#stdoutCursor : this.#stderrCursor;
			const result = await this.#client.sandbox.stream.read(
				{ ...(cursor === undefined ? {} : { cursor }), maxBytes: maximumBytes, stream },
				this.#requestOptions,
			);
			if (channel === 'stdout') {
				this.#stdoutCursor = result.nextCursor;
				this.#stdoutRemoteEof = result.eof;
			} else {
				this.#stderrCursor = result.nextCursor;
				this.#stderrRemoteEof = result.eof;
			}
			const content = Buffer.from(result.chunk.contentBase64, 'base64');
			if (result.eof && content.byteLength === 0) {
				this.#markOutputEnded(channel);
				await this.#closeEnvironmentWhenSettled();
				return { kind: 'end' };
			}
			if (!result.eof && (result.nextCursor === undefined || result.nextCursor === cursor)) {
				throw new Error('Gateway Runtime local exec stream returned a non-advancing cursor.');
			}
			if (content.byteLength > 0) return { content, kind: 'chunk' };
			await new Promise<void>((resolve) => setTimeout(resolve, EMPTY_STREAM_RETRY_INTERVAL_MS));
		}
		/* oxlint-enable no-await-in-loop */
	}

	#markOutputEnded(channel: 'stderr' | 'stdout'): void {
		if (channel === 'stdout') this.#stdoutEnded = true;
		else this.#stderrEnded = true;
	}

	async #closeEnvironmentWhenSettled(): Promise<void> {
		if (
			this.#waitSettled &&
			this.#stdoutEnded &&
			this.#stderrEnded &&
			(this.#stdinClosePromise === undefined || this.#stdinCloseSettled)
		) {
			await this.#closeEnvironment();
		}
	}

	async #closeEnvironment(): Promise<void> {
		this.#closePromise ??= this.#client.sandbox.environment
			.close({ environment: this.#execution.environment }, this.#requestOptions)
			.then(() => undefined);
		await this.#closePromise;
	}
}

export function createOpenClawGatewayRuntimeLocalExecOperation(options: {
	readonly client: OpenClawGatewayRuntimeSandboxClient;
	readonly execution: OpenClawGatewayRuntimeDirectExecution;
	readonly requestOptions: SandboxRequestOptions;
}): GatewayRuntimeLocalExecOperation {
	return new OpenClawGatewayRuntimeLocalExecOperation(options);
}
