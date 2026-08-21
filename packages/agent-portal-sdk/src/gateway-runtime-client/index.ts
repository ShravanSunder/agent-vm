import {
	GatewayApprovalDecisionRequestSchema,
	GatewayApprovalDecisionResultSchema,
	type GatewayApprovalDecisionRequest,
	type GatewayApprovalDecisionResult,
} from '../approval-surface/index.js';
import {
	PortalArtifactReadRequestSchema,
	PortalArtifactReadResultSchema,
	type PortalArtifactReadRequest,
	type PortalArtifactReadResult,
} from '../artifact-surface/index.js';
import {
	GatewayRuntimeAttachmentMetadataSchema,
	GatewayRuntimeTrustedInvocationCorrelationSchema,
	GatewayRuntimeTrustedInvocationContextSchema,
	GatewayRuntimeTrustedInvocationPrincipalSchema,
	GatewayRuntimeTrustedInvocationRequesterSchema,
	type GatewayRuntimeAttachmentMetadata as CanonicalGatewayRuntimeAttachmentMetadata,
	type GatewayRuntimeTrustedInvocationContext,
} from '../contracts/index.js';
import {
	PortalCallRequestSchema,
	PortalCallResultSchema,
	PortalDescribeRequestSchema,
	PortalDescribeResultSchema,
	PortalListRequestSchema,
	PortalListResultSchema,
	PortalSearchRequestSchema,
	PortalSearchResultSchema,
	type PortalCallRequest,
	type PortalCallResult,
	type PortalDescribeRequest,
	type PortalDescribeResult,
	type PortalListRequest,
	type PortalListResult,
	type PortalSearchRequest,
	type PortalSearchResult,
} from '../portal-call-surface/index.js';
import {
	GatewayRuntimeSandboxOperations,
	type GatewayRuntimeTrustedRequestOptions,
} from './gateway-runtime-sandbox-operations.js';
import {
	DEFAULT_GATEWAY_RUNTIME_STARTUP_RETRY_POLICY,
	GatewayRuntimeStartupUnavailableError,
	defaultGatewayRuntimeStartupRetryScheduler,
	type GatewayRuntimeStartupRetryPolicy,
	type GatewayRuntimeStartupRetryScheduler,
} from './gateway-runtime-startup-retry.js';
import {
	GatewayRuntimeTraceContextSchema,
	type GatewayRuntimeTraceContext,
	type GatewayRuntimeTraceContextProvider,
} from './gateway-runtime-trace-context.js';
import { createNodeGatewayRuntimeTransportFactory } from './node-gateway-runtime-transport.js';

export const DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH =
	'/run/agent-vm/gateway-runtime/managed-plugin.sock';

export type GatewayRuntimeAttachmentMetadata = Readonly<
	Omit<CanonicalGatewayRuntimeAttachmentMetadata, 'configuredAgentIds'> & {
		readonly configuredAgentIds: readonly string[];
	}
>;

export type GatewayRuntimeClientTrustedInvocationContext = GatewayRuntimeTrustedInvocationContext;

export interface GatewayRuntimeRequestOptions {
	readonly signal?: AbortSignal;
	readonly traceContext?: GatewayRuntimeTraceContext;
}

export interface GatewayRuntimeConnectOptions {
	readonly signal?: AbortSignal;
}

export type GatewayRuntimePortalRequestOptions = GatewayRuntimeTrustedRequestOptions;

export interface GatewayRuntimeConnection {
	readonly close: () => Promise<void>;
	readonly handshake: (
		handshake: GatewayRuntimeAttachmentMetadata,
		options?: GatewayRuntimeRequestOptions,
	) => Promise<void>;
	readonly request: (
		method: string,
		params: unknown,
		options?: { readonly signal?: AbortSignal },
	) => Promise<unknown>;
}

export interface GatewayRuntimeTransportFactory {
	readonly connect: (options: {
		readonly signal: AbortSignal;
		readonly socketPath: string;
	}) => Promise<GatewayRuntimeConnection>;
}

export interface GatewayRuntimeClientOptions {
	readonly attachment: GatewayRuntimeAttachmentMetadata;
	readonly socketPath?: string;
	readonly startupRetryPolicy?: Partial<GatewayRuntimeStartupRetryPolicy>;
	readonly startupRetryScheduler?: GatewayRuntimeStartupRetryScheduler;
	readonly traceContextProvider?: GatewayRuntimeTraceContextProvider;
	readonly transportFactory?: GatewayRuntimeTransportFactory;
}

export type GatewayRuntimeClientErrorCode =
	| 'already-connected'
	| 'handshake-required'
	| 'invalid-attachment'
	| 'invalid-request-metadata'
	| 'invalid-startup-retry-policy'
	| 'public-authority-injection'
	| 'startup-aborted'
	| 'startup-retry-exhausted';

export class GatewayRuntimeClientError extends Error {
	readonly code: GatewayRuntimeClientErrorCode;

	constructor(code: GatewayRuntimeClientErrorCode, message: string, options: ErrorOptions = {}) {
		super(message, options);
		this.name = 'GatewayRuntimeClientError';
		this.code = code;
	}
}

function resolveStartupRetryPolicy(
	override: Partial<GatewayRuntimeStartupRetryPolicy> | undefined,
): GatewayRuntimeStartupRetryPolicy {
	const policy = { ...DEFAULT_GATEWAY_RUNTIME_STARTUP_RETRY_POLICY, ...override };
	if (
		!Number.isSafeInteger(policy.deadlineMs) ||
		policy.deadlineMs <= 0 ||
		!Number.isSafeInteger(policy.intervalMs) ||
		policy.intervalMs <= 0 ||
		!Number.isSafeInteger(policy.maxAttempts) ||
		policy.maxAttempts <= 0 ||
		policy.deadlineMs > 60_000 ||
		policy.maxAttempts > 1_000 ||
		policy.intervalMs > policy.deadlineMs
	) {
		throw new GatewayRuntimeClientError(
			'invalid-startup-retry-policy',
			'Gateway runtime startup retry policy must contain positive bounded integers.',
		);
	}
	return Object.freeze(policy);
}

function startupAbortedError(reason: unknown): GatewayRuntimeClientError {
	return new GatewayRuntimeClientError(
		'startup-aborted',
		'Gateway runtime startup was aborted.',
		reason instanceof Error ? { cause: reason } : {},
	);
}

function startupRetryExhaustedError(props: {
	readonly attempts: number;
	readonly cause?: Error;
}): GatewayRuntimeClientError {
	return new GatewayRuntimeClientError(
		'startup-retry-exhausted',
		`Gateway runtime startup retry was exhausted after ${props.attempts} attempts.`,
		props.cause === undefined ? {} : { cause: props.cause },
	);
}

const publicAuthorityFieldNames = [
	'allowedOperationGroups',
	'authority',
	'operationGroups',
	'principal',
	'surface',
] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateAttachmentMetadata(
	attachment: GatewayRuntimeAttachmentMetadata,
): GatewayRuntimeAttachmentMetadata {
	if (!isRecord(attachment)) {
		throw new GatewayRuntimeClientError(
			'invalid-attachment',
			'Gateway runtime attachment metadata must be an object.',
		);
	}
	if (publicAuthorityFieldNames.some((fieldName) => Object.hasOwn(attachment, fieldName))) {
		throw new GatewayRuntimeClientError(
			'public-authority-injection',
			'Gateway runtime attachment metadata cannot carry server-derived authority.',
		);
	}
	const parsedAttachment = GatewayRuntimeAttachmentMetadataSchema.safeParse(attachment);
	if (!parsedAttachment.success) {
		throw new GatewayRuntimeClientError(
			'invalid-attachment',
			'Gateway runtime attachment metadata is invalid.',
			{ cause: parsedAttachment.error },
		);
	}
	Object.freeze(parsedAttachment.data.configuredAgentIds);
	return Object.freeze(parsedAttachment.data);
}

function createGatewayRuntimeRequestParams<TPublicRequest>(props: {
	readonly publicRequest: TPublicRequest;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}): {
	readonly publicRequest: TPublicRequest;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
} {
	return {
		publicRequest: props.publicRequest,
		trustedContext: GatewayRuntimeTrustedInvocationContextSchema.parse(props.trustedContext),
	};
}

function gatewayRuntimeRequestOptions(
	options: GatewayRuntimePortalRequestOptions,
): GatewayRuntimeRequestOptions {
	return {
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.traceContext === undefined ? {} : { traceContext: options.traceContext }),
	};
}

class GatewayRuntimePortalOperations {
	readonly #client: GatewayRuntimeClient;

	constructor(client: GatewayRuntimeClient) {
		this.#client = client;
	}

	async list(
		request: PortalListRequest,
		options: GatewayRuntimePortalRequestOptions,
	): Promise<PortalListResult> {
		const validatedRequest = PortalListRequestSchema.parse(request);
		const result = await this.#client.request(
			'portal.list',
			createGatewayRuntimeRequestParams({
				publicRequest: validatedRequest,
				trustedContext: options.trustedContext,
			}),
			gatewayRuntimeRequestOptions(options),
		);
		return PortalListResultSchema.parse(result);
	}

	async search(
		request: PortalSearchRequest,
		options: GatewayRuntimePortalRequestOptions,
	): Promise<PortalSearchResult> {
		const validatedRequest = PortalSearchRequestSchema.parse(request);
		const result = await this.#client.request(
			'portal.search',
			createGatewayRuntimeRequestParams({
				publicRequest: validatedRequest,
				trustedContext: options.trustedContext,
			}),
			gatewayRuntimeRequestOptions(options),
		);
		return PortalSearchResultSchema.parse(result);
	}

	async describe(
		request: PortalDescribeRequest,
		options: GatewayRuntimePortalRequestOptions,
	): Promise<PortalDescribeResult> {
		const validatedRequest = PortalDescribeRequestSchema.parse(request);
		const result = await this.#client.request(
			'portal.describe',
			createGatewayRuntimeRequestParams({
				publicRequest: validatedRequest,
				trustedContext: options.trustedContext,
			}),
			gatewayRuntimeRequestOptions(options),
		);
		return PortalDescribeResultSchema.parse(result);
	}

	async call(
		request: PortalCallRequest,
		options: GatewayRuntimePortalRequestOptions,
	): Promise<PortalCallResult> {
		const validatedRequest = PortalCallRequestSchema.parse(request);
		const result = await this.#client.request(
			'portal.call',
			createGatewayRuntimeRequestParams({
				publicRequest: validatedRequest,
				trustedContext: options.trustedContext,
			}),
			gatewayRuntimeRequestOptions(options),
		);
		return PortalCallResultSchema.parse(result);
	}
}

class GatewayRuntimeArtifactOperations {
	readonly #client: GatewayRuntimeClient;

	constructor(client: GatewayRuntimeClient) {
		this.#client = client;
	}

	async read(
		request: PortalArtifactReadRequest,
		options: GatewayRuntimePortalRequestOptions,
	): Promise<PortalArtifactReadResult> {
		const validatedRequest = PortalArtifactReadRequestSchema.parse(request);
		const result = await this.#client.request(
			'artifact.read',
			createGatewayRuntimeRequestParams({
				publicRequest: validatedRequest,
				trustedContext: options.trustedContext,
			}),
			gatewayRuntimeRequestOptions(options),
		);
		return PortalArtifactReadResultSchema.parse(result);
	}
}

class GatewayRuntimeApprovalOperations {
	readonly #client: GatewayRuntimeClient;

	constructor(client: GatewayRuntimeClient) {
		this.#client = client;
	}

	async decide(
		request: GatewayApprovalDecisionRequest,
		options: GatewayRuntimePortalRequestOptions,
	): Promise<GatewayApprovalDecisionResult> {
		const validatedRequest = GatewayApprovalDecisionRequestSchema.parse(request);
		const result = await this.#client.request(
			'approval.decide',
			createGatewayRuntimeRequestParams({
				publicRequest: validatedRequest,
				trustedContext: options.trustedContext,
			}),
			gatewayRuntimeRequestOptions(options),
		);
		return GatewayApprovalDecisionResultSchema.parse(result);
	}
}

/** Rich private-UDS client for one current managed-framework attachment. */
export class GatewayRuntimeClient {
	readonly #attachment: GatewayRuntimeAttachmentMetadata;
	readonly #socketPath: string;
	readonly #startupRetryPolicy: GatewayRuntimeStartupRetryPolicy;
	readonly #startupRetryScheduler: GatewayRuntimeStartupRetryScheduler;
	readonly #traceContextProvider: GatewayRuntimeTraceContextProvider | undefined;
	readonly #transportFactory: GatewayRuntimeTransportFactory;
	#connection: GatewayRuntimeConnection | undefined;
	#connecting = false;
	#handshakeComplete = false;
	readonly artifacts: GatewayRuntimeArtifactOperations;
	readonly approvals: GatewayRuntimeApprovalOperations;
	readonly portal: GatewayRuntimePortalOperations;
	readonly sandbox: GatewayRuntimeSandboxOperations;

	constructor(options: GatewayRuntimeClientOptions) {
		this.#attachment = validateAttachmentMetadata(options.attachment);
		this.#socketPath = options.socketPath ?? DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH;
		this.#startupRetryPolicy = resolveStartupRetryPolicy(options.startupRetryPolicy);
		this.#startupRetryScheduler =
			options.startupRetryScheduler ?? defaultGatewayRuntimeStartupRetryScheduler;
		this.#traceContextProvider = options.traceContextProvider;
		this.#transportFactory = options.transportFactory ?? createNodeGatewayRuntimeTransportFactory();
		this.artifacts = new GatewayRuntimeArtifactOperations(this);
		this.approvals = new GatewayRuntimeApprovalOperations(this);
		this.portal = new GatewayRuntimePortalOperations(this);
		this.sandbox = Object.freeze(new GatewayRuntimeSandboxOperations(this));
	}

	async #connectOnce(props: {
		readonly attemptNumber: number;
		readonly deadlineAtMs: number;
		readonly signal: AbortSignal;
	}): Promise<GatewayRuntimeConnection> {
		const remainingMs = Math.max(1, props.deadlineAtMs - this.#startupRetryScheduler.now());
		const attemptCancellation = new AbortController();
		let deadlineExpired = false;
		const deadline = setTimeout(() => {
			deadlineExpired = true;
			attemptCancellation.abort(new Error('Gateway runtime startup deadline expired.'));
		}, remainingMs);
		const abortAttempt = (): void => attemptCancellation.abort(props.signal.reason);
		props.signal.addEventListener('abort', abortAttempt, { once: true });
		if (props.signal.aborted) abortAttempt();
		let connection: GatewayRuntimeConnection | undefined;
		try {
			connection = await this.#transportFactory.connect({
				signal: attemptCancellation.signal,
				socketPath: this.#socketPath,
			});
			await connection.handshake(this.#attachment, { signal: attemptCancellation.signal });
			return connection;
		} catch (error: unknown) {
			if (connection !== undefined) await connection.close();
			if (props.signal.aborted) throw startupAbortedError(props.signal.reason);
			if (deadlineExpired) {
				throw startupRetryExhaustedError({
					attempts: props.attemptNumber,
					...(error instanceof Error ? { cause: error } : {}),
				});
			}
			throw error;
		} finally {
			clearTimeout(deadline);
			props.signal.removeEventListener('abort', abortAttempt);
		}
	}

	async #connectWithStartupRetry(props: {
		readonly attemptsCompleted: number;
		readonly deadlineAtMs: number;
		readonly signal: AbortSignal;
	}): Promise<GatewayRuntimeConnection> {
		const attemptNumber = props.attemptsCompleted + 1;
		let unavailableError: GatewayRuntimeStartupUnavailableError;
		try {
			return await this.#connectOnce({
				attemptNumber,
				deadlineAtMs: props.deadlineAtMs,
				signal: props.signal,
			});
		} catch (error: unknown) {
			if (error instanceof GatewayRuntimeClientError) throw error;
			if (!(error instanceof GatewayRuntimeStartupUnavailableError)) throw error;
			unavailableError = error;
		}

		const remainingMs = props.deadlineAtMs - this.#startupRetryScheduler.now();
		if (attemptNumber >= this.#startupRetryPolicy.maxAttempts || remainingMs <= 0) {
			throw startupRetryExhaustedError({
				attempts: attemptNumber,
				cause: unavailableError,
			});
		}
		try {
			await this.#startupRetryScheduler.wait(
				Math.min(this.#startupRetryPolicy.intervalMs, remainingMs),
				props.signal,
			);
		} catch (error: unknown) {
			if (props.signal.aborted) throw startupAbortedError(props.signal.reason);
			throw error;
		}
		if (this.#startupRetryScheduler.now() >= props.deadlineAtMs) {
			throw startupRetryExhaustedError({
				attempts: attemptNumber,
				cause: unavailableError,
			});
		}
		return await this.#connectWithStartupRetry({
			attemptsCompleted: attemptNumber,
			deadlineAtMs: props.deadlineAtMs,
			signal: props.signal,
		});
	}

	async connect(options: GatewayRuntimeConnectOptions = {}): Promise<void> {
		if (this.#connection !== undefined || this.#connecting) {
			throw new GatewayRuntimeClientError(
				'already-connected',
				'Gateway runtime client already has a connection.',
			);
		}
		const signal = options.signal ?? new AbortController().signal;
		if (signal.aborted) throw startupAbortedError(signal.reason);
		this.#connecting = true;
		const deadlineAtMs = this.#startupRetryScheduler.now() + this.#startupRetryPolicy.deadlineMs;
		try {
			const connection = await this.#connectWithStartupRetry({
				attemptsCompleted: 0,
				deadlineAtMs,
				signal,
			});
			this.#connection = connection;
			this.#handshakeComplete = true;
		} finally {
			this.#connecting = false;
		}
	}

	async disconnect(): Promise<void> {
		const connection = this.#connection;
		this.#connection = undefined;
		this.#handshakeComplete = false;
		if (connection !== undefined) await connection.close();
	}

	async reconnect(options: GatewayRuntimeConnectOptions = {}): Promise<void> {
		if (this.#connecting) {
			throw new GatewayRuntimeClientError(
				'already-connected',
				'Gateway runtime client already has a connection attempt in progress.',
			);
		}
		this.#connecting = true;
		try {
			await this.disconnect();
			const signal = options.signal ?? new AbortController().signal;
			if (signal.aborted) throw startupAbortedError(signal.reason);
			const connection = await this.#connectOnce({
				attemptNumber: 1,
				deadlineAtMs: this.#startupRetryScheduler.now() + this.#startupRetryPolicy.deadlineMs,
				signal,
			});
			this.#connection = connection;
			this.#handshakeComplete = true;
		} finally {
			this.#connecting = false;
		}
	}

	async request(
		method: string,
		params: unknown,
		options: GatewayRuntimeRequestOptions = {},
	): Promise<unknown> {
		if (!this.#handshakeComplete || this.#connection === undefined) {
			throw new GatewayRuntimeClientError(
				'handshake-required',
				'Gateway runtime attachment handshake must complete before method calls.',
			);
		}
		const transportOptions = options.signal === undefined ? {} : { signal: options.signal };
		const providedTraceContext = options.traceContext ?? this.#traceContextProvider?.();
		if (providedTraceContext === undefined) {
			return await this.#connection.request(method, params, transportOptions);
		}
		if (!isRecord(params)) {
			throw new GatewayRuntimeClientError(
				'invalid-request-metadata',
				'Gateway runtime trace context requires object request parameters.',
			);
		}
		const traceContext = GatewayRuntimeTraceContextSchema.parse(providedTraceContext);
		return await this.#connection.request(method, { ...params, traceContext }, transportOptions);
	}
}

export {
	DEFAULT_GATEWAY_RUNTIME_STARTUP_RETRY_POLICY,
	GatewayRuntimeStartupUnavailableError,
	type GatewayRuntimeStartupRetryPolicy,
	type GatewayRuntimeStartupRetryScheduler,
} from './gateway-runtime-startup-retry.js';
export {
	GATEWAY_RUNTIME_TRACEPARENT_MAX_LENGTH,
	GATEWAY_RUNTIME_TRACESTATE_MAX_LENGTH,
	GATEWAY_RUNTIME_TRACESTATE_MAX_MEMBERS,
	GatewayRuntimeTraceContextSchema,
	type GatewayRuntimeTraceContext,
	type GatewayRuntimeTraceContextProvider,
} from './gateway-runtime-trace-context.js';
export {
	GatewayRuntimeSandboxEnvironmentOperations,
	GatewayRuntimeSandboxExecutionOperations,
	GatewayRuntimeSandboxFilesystemOperations,
	GatewayRuntimeSandboxOperations,
	GatewayRuntimeSandboxProcessOperations,
	GatewayRuntimeSandboxRetainedResultOperations,
	GatewayRuntimeSandboxStreamOperations,
	GatewayRuntimeSandboxTerminalOperations,
	type GatewayRuntimeTrustedRequestOptions,
} from './gateway-runtime-sandbox-operations.js';

export type {
	GatewayRuntimeManagedPluginClientKind,
	GatewayRuntimeTrustedInvocationCorrelation,
	GatewayRuntimeTrustedInvocationContext,
	GatewayRuntimeTrustedInvocationPrincipal,
	GatewayRuntimeTrustedInvocationRequester,
} from '../contracts/index.js';

export {
	GatewayRuntimeTrustedInvocationCorrelationSchema,
	GatewayRuntimeTrustedInvocationContextSchema,
	GatewayRuntimeTrustedInvocationPrincipalSchema,
	GatewayRuntimeTrustedInvocationRequesterSchema,
};

export {
	GATEWAY_RUNTIME_REQUEST_CANCEL_NOTIFICATION_METHOD,
	GatewayRuntimeRemoteError,
	NodeGatewayRuntimeTransportError,
	createNodeGatewayRuntimeTransportFactory,
} from './node-gateway-runtime-transport.js';
export {
	GatewayRuntimeSocketReadFlow,
	type GatewayRuntimeCompletedStreamEvidence,
	type GatewayRuntimePauseDeadlineScheduler,
	type GatewayRuntimeReadableSocketControl,
	type GatewayRuntimeSocketReadFlowOptions,
} from './gateway-runtime-socket-read-flow.js';
export * from './gateway-runtime-flow-control.js';
export * from './gateway-runtime-protocol.js';
