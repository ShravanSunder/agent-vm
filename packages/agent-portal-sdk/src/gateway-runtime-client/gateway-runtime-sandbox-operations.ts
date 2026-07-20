import {
	GatewayRuntimeTrustedInvocationContextSchema,
	SandboxEnvironmentCloseResultSchema,
	SandboxEnvironmentHandleRequestSchema,
	SandboxEnvironmentOpenRequestSchema,
	SandboxEnvironmentOpenResultSchema,
	SandboxEnvironmentStatusResultSchema,
	SandboxExecCancelRequestSchema,
	SandboxExecCancelResultSchema,
	SandboxExecStartRequestSchema,
	SandboxExecStartResultSchema,
	SandboxExecWaitRequestSchema,
	SandboxExecWaitResultSchema,
	SandboxFsListRequestSchema,
	SandboxFsListResultSchema,
	SandboxFsMkdirRequestSchema,
	SandboxFsMkdirResultSchema,
	SandboxFsReadRequestSchema,
	SandboxFsReadResultSchema,
	SandboxFsRemoveRequestSchema,
	SandboxFsRemoveResultSchema,
	SandboxFsRenameRequestSchema,
	SandboxFsRenameResultSchema,
	SandboxFsStatRequestSchema,
	SandboxFsStatResultSchema,
	SandboxFsWriteRequestSchema,
	SandboxFsWriteResultSchema,
	SandboxProcessCancelRequestSchema,
	SandboxProcessCancelResultSchema,
	SandboxProcessHandleRequestSchema,
	SandboxProcessLogsRequestSchema,
	SandboxProcessLogsResultSchema,
	SandboxProcessStartRequestSchema,
	SandboxProcessStartResultSchema,
	SandboxProcessStatusResultSchema,
	SandboxProcessWaitRequestSchema,
	SandboxProcessWaitResultSchema,
	SandboxRetainedResultLookupRequestSchema,
	SandboxRetainedResultLookupResultSchema,
	SandboxStreamCloseRequestSchema,
	SandboxStreamCloseResultSchema,
	SandboxStreamReadRequestSchema,
	SandboxStreamReadResultSchema,
	SandboxStreamWriteRequestSchema,
	SandboxStreamWriteResultSchema,
	SandboxTerminalAttachRequestSchema,
	SandboxTerminalAttachResultSchema,
	SandboxTerminalResizeRequestSchema,
	SandboxTerminalResizeResultSchema,
	type GatewayRuntimeTrustedInvocationContext,
	type SandboxEnvironmentCloseRequest,
	type SandboxEnvironmentCloseResult,
	type SandboxEnvironmentOpenRequest,
	type SandboxEnvironmentOpenResult,
	type SandboxEnvironmentStatusRequest,
	type SandboxEnvironmentStatusResult,
	type SandboxExecCancelRequest,
	type SandboxExecCancelResult,
	type SandboxExecStartRequest,
	type SandboxExecStartResult,
	type SandboxExecWaitRequest,
	type SandboxExecWaitResult,
	type SandboxFsListRequest,
	type SandboxFsListResult,
	type SandboxFsMkdirRequest,
	type SandboxFsMkdirResult,
	type SandboxFsReadRequest,
	type SandboxFsReadResult,
	type SandboxFsRemoveRequest,
	type SandboxFsRemoveResult,
	type SandboxFsRenameRequest,
	type SandboxFsRenameResult,
	type SandboxFsStatRequest,
	type SandboxFsStatResult,
	type SandboxFsWriteRequest,
	type SandboxFsWriteResult,
	type SandboxProcessCancelRequest,
	type SandboxProcessCancelResult,
	type SandboxProcessLogsRequest,
	type SandboxProcessLogsResult,
	type SandboxProcessStartRequest,
	type SandboxProcessStartResult,
	type SandboxProcessStatusRequest,
	type SandboxProcessStatusResult,
	type SandboxProcessWaitRequest,
	type SandboxProcessWaitResult,
	type SandboxRetainedResultLookupRequest,
	type SandboxRetainedResultLookupResult,
	type SandboxStreamCloseRequest,
	type SandboxStreamCloseResult,
	type SandboxStreamReadRequest,
	type SandboxStreamReadResult,
	type SandboxStreamWriteRequest,
	type SandboxStreamWriteResult,
	type SandboxTerminalAttachRequest,
	type SandboxTerminalAttachResult,
	type SandboxTerminalResizeRequest,
	type SandboxTerminalResizeResult,
} from '../contracts/index.js';
import type { GatewayRuntimeTraceContext } from './gateway-runtime-trace-context.js';

export interface GatewayRuntimeTrustedRequestOptions {
	readonly signal?: AbortSignal;
	readonly traceContext?: GatewayRuntimeTraceContext;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

interface GatewayRuntimeSandboxRequestClient {
	readonly request: (
		method: string,
		params: unknown,
		options: {
			readonly signal?: AbortSignal;
			readonly traceContext?: GatewayRuntimeTraceContext;
		},
	) => Promise<unknown>;
}

interface GatewayRuntimeCanonicalSchema<TValue> {
	readonly parse: (value: unknown) => TValue;
}

interface SandboxOperationRequestProps<TRequest, TResult> {
	readonly client: GatewayRuntimeSandboxRequestClient;
	readonly method: string;
	readonly options: GatewayRuntimeTrustedRequestOptions;
	readonly request: TRequest;
	readonly requestSchema: GatewayRuntimeCanonicalSchema<TRequest>;
	readonly resultSchema: GatewayRuntimeCanonicalSchema<TResult>;
}

async function requestSandboxOperation<TRequest, TResult>(
	props: SandboxOperationRequestProps<TRequest, TResult>,
): Promise<TResult> {
	const publicRequest = props.requestSchema.parse(props.request);
	const trustedContext = GatewayRuntimeTrustedInvocationContextSchema.parse(
		props.options.trustedContext,
	);
	const result = await props.client.request(
		props.method,
		{ publicRequest, trustedContext },
		{
			...(props.options.signal === undefined ? {} : { signal: props.options.signal }),
			...(props.options.traceContext === undefined
				? {}
				: { traceContext: props.options.traceContext }),
		},
	);
	return props.resultSchema.parse(result);
}

export class GatewayRuntimeSandboxEnvironmentOperations {
	readonly #client: GatewayRuntimeSandboxRequestClient;

	constructor(client: GatewayRuntimeSandboxRequestClient) {
		this.#client = client;
	}

	async open(
		request: SandboxEnvironmentOpenRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxEnvironmentOpenResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.environment.open',
			options,
			request,
			requestSchema: SandboxEnvironmentOpenRequestSchema,
			resultSchema: SandboxEnvironmentOpenResultSchema,
		});
	}

	async close(
		request: SandboxEnvironmentCloseRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxEnvironmentCloseResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.environment.close',
			options,
			request,
			requestSchema: SandboxEnvironmentHandleRequestSchema,
			resultSchema: SandboxEnvironmentCloseResultSchema,
		});
	}

	async status(
		request: SandboxEnvironmentStatusRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxEnvironmentStatusResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.environment.status',
			options,
			request,
			requestSchema: SandboxEnvironmentHandleRequestSchema,
			resultSchema: SandboxEnvironmentStatusResultSchema,
		});
	}
}

export class GatewayRuntimeSandboxExecutionOperations {
	readonly #client: GatewayRuntimeSandboxRequestClient;

	constructor(client: GatewayRuntimeSandboxRequestClient) {
		this.#client = client;
	}

	async start(
		request: SandboxExecStartRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxExecStartResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.exec.start',
			options,
			request,
			requestSchema: SandboxExecStartRequestSchema,
			resultSchema: SandboxExecStartResultSchema,
		});
	}

	async wait(
		request: SandboxExecWaitRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxExecWaitResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.exec.wait',
			options,
			request,
			requestSchema: SandboxExecWaitRequestSchema,
			resultSchema: SandboxExecWaitResultSchema,
		});
	}

	async cancel(
		request: SandboxExecCancelRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxExecCancelResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.exec.cancel',
			options,
			request,
			requestSchema: SandboxExecCancelRequestSchema,
			resultSchema: SandboxExecCancelResultSchema,
		});
	}
}

export class GatewayRuntimeSandboxRetainedResultOperations {
	readonly #client: GatewayRuntimeSandboxRequestClient;

	constructor(client: GatewayRuntimeSandboxRequestClient) {
		this.#client = client;
	}

	async lookup(
		request: SandboxRetainedResultLookupRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxRetainedResultLookupResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.retained-result.lookup',
			options,
			request,
			requestSchema: SandboxRetainedResultLookupRequestSchema,
			resultSchema: SandboxRetainedResultLookupResultSchema,
		});
	}
}

export class GatewayRuntimeSandboxFilesystemOperations {
	readonly #client: GatewayRuntimeSandboxRequestClient;

	constructor(client: GatewayRuntimeSandboxRequestClient) {
		this.#client = client;
	}

	async stat(
		request: SandboxFsStatRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxFsStatResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.fs.stat',
			options,
			request,
			requestSchema: SandboxFsStatRequestSchema,
			resultSchema: SandboxFsStatResultSchema,
		});
	}

	async list(
		request: SandboxFsListRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxFsListResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.fs.list',
			options,
			request,
			requestSchema: SandboxFsListRequestSchema,
			resultSchema: SandboxFsListResultSchema,
		});
	}

	async read(
		request: SandboxFsReadRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxFsReadResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.fs.read',
			options,
			request,
			requestSchema: SandboxFsReadRequestSchema,
			resultSchema: SandboxFsReadResultSchema,
		});
	}

	async write(
		request: SandboxFsWriteRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxFsWriteResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.fs.write',
			options,
			request,
			requestSchema: SandboxFsWriteRequestSchema,
			resultSchema: SandboxFsWriteResultSchema,
		});
	}

	async mkdir(
		request: SandboxFsMkdirRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxFsMkdirResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.fs.mkdir',
			options,
			request,
			requestSchema: SandboxFsMkdirRequestSchema,
			resultSchema: SandboxFsMkdirResultSchema,
		});
	}

	async rename(
		request: SandboxFsRenameRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxFsRenameResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.fs.rename',
			options,
			request,
			requestSchema: SandboxFsRenameRequestSchema,
			resultSchema: SandboxFsRenameResultSchema,
		});
	}

	async remove(
		request: SandboxFsRemoveRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxFsRemoveResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.fs.remove',
			options,
			request,
			requestSchema: SandboxFsRemoveRequestSchema,
			resultSchema: SandboxFsRemoveResultSchema,
		});
	}
}

export class GatewayRuntimeSandboxProcessOperations {
	readonly #client: GatewayRuntimeSandboxRequestClient;

	constructor(client: GatewayRuntimeSandboxRequestClient) {
		this.#client = client;
	}

	async start(
		request: SandboxProcessStartRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxProcessStartResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.process.start',
			options,
			request,
			requestSchema: SandboxProcessStartRequestSchema,
			resultSchema: SandboxProcessStartResultSchema,
		});
	}

	async status(
		request: SandboxProcessStatusRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxProcessStatusResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.process.status',
			options,
			request,
			requestSchema: SandboxProcessHandleRequestSchema,
			resultSchema: SandboxProcessStatusResultSchema,
		});
	}

	async wait(
		request: SandboxProcessWaitRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxProcessWaitResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.process.wait',
			options,
			request,
			requestSchema: SandboxProcessWaitRequestSchema,
			resultSchema: SandboxProcessWaitResultSchema,
		});
	}

	async logs(
		request: SandboxProcessLogsRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxProcessLogsResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.process.logs',
			options,
			request,
			requestSchema: SandboxProcessLogsRequestSchema,
			resultSchema: SandboxProcessLogsResultSchema,
		});
	}

	async cancel(
		request: SandboxProcessCancelRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxProcessCancelResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.process.cancel',
			options,
			request,
			requestSchema: SandboxProcessCancelRequestSchema,
			resultSchema: SandboxProcessCancelResultSchema,
		});
	}
}

export class GatewayRuntimeSandboxStreamOperations {
	readonly #client: GatewayRuntimeSandboxRequestClient;

	constructor(client: GatewayRuntimeSandboxRequestClient) {
		this.#client = client;
	}

	async read(
		request: SandboxStreamReadRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxStreamReadResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.stream.read',
			options,
			request,
			requestSchema: SandboxStreamReadRequestSchema,
			resultSchema: SandboxStreamReadResultSchema,
		});
	}

	async write(
		request: SandboxStreamWriteRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxStreamWriteResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.stream.write',
			options,
			request,
			requestSchema: SandboxStreamWriteRequestSchema,
			resultSchema: SandboxStreamWriteResultSchema,
		});
	}

	async close(
		request: SandboxStreamCloseRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxStreamCloseResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.stream.close',
			options,
			request,
			requestSchema: SandboxStreamCloseRequestSchema,
			resultSchema: SandboxStreamCloseResultSchema,
		});
	}
}

export class GatewayRuntimeSandboxTerminalOperations {
	readonly #client: GatewayRuntimeSandboxRequestClient;

	constructor(client: GatewayRuntimeSandboxRequestClient) {
		this.#client = client;
	}

	async attach(
		request: SandboxTerminalAttachRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxTerminalAttachResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.terminal.attach',
			options,
			request,
			requestSchema: SandboxTerminalAttachRequestSchema,
			resultSchema: SandboxTerminalAttachResultSchema,
		});
	}

	async resize(
		request: SandboxTerminalResizeRequest,
		options: GatewayRuntimeTrustedRequestOptions,
	): Promise<SandboxTerminalResizeResult> {
		return await requestSandboxOperation({
			client: this.#client,
			method: 'sandbox.terminal.resize',
			options,
			request,
			requestSchema: SandboxTerminalResizeRequestSchema,
			resultSchema: SandboxTerminalResizeResultSchema,
		});
	}
}

export class GatewayRuntimeSandboxOperations {
	readonly environment: GatewayRuntimeSandboxEnvironmentOperations;
	readonly execution: GatewayRuntimeSandboxExecutionOperations;
	readonly filesystem: GatewayRuntimeSandboxFilesystemOperations;
	readonly process: GatewayRuntimeSandboxProcessOperations;
	readonly retainedResults: GatewayRuntimeSandboxRetainedResultOperations;
	readonly stream: GatewayRuntimeSandboxStreamOperations;
	readonly terminal: GatewayRuntimeSandboxTerminalOperations;

	constructor(client: GatewayRuntimeSandboxRequestClient) {
		this.environment = new GatewayRuntimeSandboxEnvironmentOperations(client);
		this.execution = new GatewayRuntimeSandboxExecutionOperations(client);
		this.filesystem = new GatewayRuntimeSandboxFilesystemOperations(client);
		this.process = new GatewayRuntimeSandboxProcessOperations(client);
		this.retainedResults = new GatewayRuntimeSandboxRetainedResultOperations(client);
		this.stream = new GatewayRuntimeSandboxStreamOperations(client);
		this.terminal = new GatewayRuntimeSandboxTerminalOperations(client);
		Object.freeze(this.environment);
		Object.freeze(this.execution);
		Object.freeze(this.filesystem);
		Object.freeze(this.process);
		Object.freeze(this.retainedResults);
		Object.freeze(this.stream);
		Object.freeze(this.terminal);
	}
}
