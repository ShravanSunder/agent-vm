import {
	SANDBOX_MAXIMUM_BINARY_BYTES,
	type GatewayRuntimeTrustedInvocationContext,
	type ManagedAgentProjection,
	type SandboxEnvironmentHandle,
	type SandboxStreamHandle,
} from '@agent-vm/agent-portal-sdk/contracts';
import type {
	GatewayRuntimeClient,
	GatewayRuntimeTraceContext,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import {
	GatewayRuntimeLocalExecTransport,
	type GatewayRuntimeLocalExecFinalizeToken,
	type GatewayRuntimeLocalExecOperation,
	type GatewayRuntimeLocalExecSpec,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-local-exec';

import {
	createOpenClawGatewayRuntimeSandboxFilesystemBridge,
	type OpenClawGatewayRuntimeSandboxFilesystemBridge,
} from './gateway-runtime-sandbox-filesystem-bridge.js';
import {
	createOpenClawGatewayRuntimeLocalExecOperation,
	gatewayRuntimeBinaryChunk,
	gatewayRuntimeContentDigest,
	requireGatewayRuntimeCompletedExitCode,
	type OpenClawGatewayRuntimeDirectExecution,
} from './gateway-runtime-sandbox-local-exec-operation.js';
import {
	findOpenClawAgentVmSandboxMismatch,
	resolveOpenClawAgentIdFromSessionKey,
} from './openclaw-agent-vm-contract.js';

const OPENCLAW_GATEWAY_RUNTIME_BACKEND_ID = 'gondolin';
const TOOL_VM_DEFAULT_WORKDIR = '/work';
const MAXIMUM_EXECUTION_MILLISECONDS = 60 * 60 * 1_000;
const EXECUTION_STREAM_READ_CHUNK_BYTES = 1024 * 1024;

type GatewayRuntimeSandbox = GatewayRuntimeClient['sandbox'];

export interface OpenClawGatewayRuntimeSandboxClient {
	readonly sandbox: {
		readonly environment: Pick<GatewayRuntimeSandbox['environment'], 'close' | 'open'>;
		readonly execution: Pick<GatewayRuntimeSandbox['execution'], 'cancel' | 'start' | 'wait'>;
		readonly filesystem: Pick<
			GatewayRuntimeSandbox['filesystem'],
			'mkdir' | 'read' | 'remove' | 'rename' | 'stat' | 'write'
		>;
		readonly stream: Pick<GatewayRuntimeSandbox['stream'], 'close' | 'read' | 'write'>;
	};
}

export interface OpenClawGatewayRuntimeSandboxLocalExecTransport {
	readonly close: () => Promise<void>;
	readonly finalize: (token: GatewayRuntimeLocalExecFinalizeToken) => Promise<void>;
	readonly reserve: (
		operation: GatewayRuntimeLocalExecOperation,
	) => Promise<GatewayRuntimeLocalExecSpec>;
}

export interface OpenClawCreateSandboxBackendParams {
	readonly agentWorkspaceDir: string;
	readonly cfg: unknown;
	readonly scopeKey: string;
	readonly sessionKey: string;
	readonly skillsWorkspaceDir?: string;
	readonly workspaceDir: string;
}

export interface OpenClawGatewayRuntimeSandboxBackendHandle {
	readonly createFsBridge: (params: {
		readonly sandbox: unknown;
	}) => OpenClawGatewayRuntimeSandboxFilesystemBridge;
	readonly id: string;
	readonly runtimeId: string;
	readonly runtimeLabel: string;
	readonly workdir: string;
	readonly buildExecSpec: (params: {
		readonly command: string;
		readonly env: Record<string, string>;
		readonly usePty: boolean;
		readonly workdir?: string;
	}) => Promise<{
		readonly argv: string[];
		readonly env: Record<string, string>;
		readonly finalizeToken?: unknown;
		readonly stdinMode: 'pipe-open' | 'pipe-closed';
	}>;
	readonly finalizeExec: (params: {
		readonly exitCode: number | null;
		readonly status: 'completed' | 'failed';
		readonly timedOut: boolean;
		readonly token?: unknown;
	}) => Promise<void>;
	readonly runShellCommand: (
		params: OpenClawSandboxBackendCommandParams,
	) => Promise<{ readonly code: number; readonly stderr: Buffer; readonly stdout: Buffer }>;
}

export interface OpenClawGatewayRuntimeSandboxRegistration {
	readonly close: () => Promise<void>;
	readonly factory: (
		params: OpenClawCreateSandboxBackendParams,
	) => Promise<OpenClawGatewayRuntimeSandboxBackendHandle>;
	readonly resolveWorkdir: () => string;
}

export interface CreateOpenClawGatewayRuntimeSandboxRegistrationOptions {
	readonly agentProjections: Readonly<Record<string, ManagedAgentProjection>>;
	readonly client: OpenClawGatewayRuntimeSandboxClient;
	readonly localExecTransport?: OpenClawGatewayRuntimeSandboxLocalExecTransport;
	readonly traceContextProvider?: () => GatewayRuntimeTraceContext | undefined;
}

interface OpenClawSandboxBackendCommandParams {
	readonly allowFailure?: boolean;
	readonly args?: readonly string[];
	readonly script: string;
	readonly signal?: AbortSignal;
	readonly stdin?: Buffer | string;
}

function createTrustedContext(options: {
	readonly agentId: string;
	readonly projection: ManagedAgentProjection;
	readonly sessionKey: string;
}): GatewayRuntimeTrustedInvocationContext {
	return {
		correlation: { sessionKey: options.sessionKey },
		principal: {
			agentId: options.agentId,
			frameworkIdentity: options.projection.frameworkIdentity,
			profileAssignmentRevision: options.projection.profileAssignmentRevision,
			toolPortalProfileId: options.projection.toolPortalProfileId,
		},
	};
}

function requireProjection(options: {
	readonly agentProjections: Readonly<Record<string, ManagedAgentProjection>>;
	readonly sessionKey: string;
}): { readonly agentId: string; readonly projection: ManagedAgentProjection } {
	const agentId = resolveOpenClawAgentIdFromSessionKey(options.sessionKey);
	const projection = options.agentProjections[agentId];
	if (projection === undefined) {
		throw new Error(`OpenClaw agent '${agentId}' is not configured for managed Tool Portal.`);
	}
	if (
		projection.agentId !== agentId ||
		projection.frameworkIdentity.kind !== 'openclaw' ||
		projection.frameworkIdentity.agentId !== agentId
	) {
		throw new Error(
			`OpenClaw projection identity does not match authenticated agent '${agentId}'.`,
		);
	}
	return { agentId, projection };
}

function requireManagedSandboxConfig(config: unknown): void {
	if (typeof config !== 'object' || config === null || Array.isArray(config)) {
		throw new Error('OpenClaw managed SandboxBackend requires a Sandbox config object.');
	}
	const mismatch = findOpenClawAgentVmSandboxMismatch(config);
	if (mismatch !== undefined) {
		throw new Error(
			`OpenClaw managed SandboxBackend requires ${mismatch.key}='${mismatch.expectedValue}'.`,
		);
	}
}

function environmentRequestOptions(
	trustedContext: GatewayRuntimeTrustedInvocationContext,
	signal?: AbortSignal,
	traceContext?: GatewayRuntimeTraceContext,
): {
	readonly signal?: AbortSignal;
	readonly traceContext?: GatewayRuntimeTraceContext;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
} {
	return {
		...(signal === undefined ? {} : { signal }),
		...(traceContext === undefined ? {} : { traceContext }),
		trustedContext,
	};
}

function environmentVariables(
	environment: Readonly<Record<string, string>>,
): readonly { readonly name: string; readonly value: string }[] | undefined {
	const variables = Object.entries(environment).map(([name, value]) => ({ name, value }));
	return variables.length === 0 ? undefined : variables;
}

function requireDirectStream(
	streams: readonly SandboxStreamHandle[],
	channel: 'stderr' | 'stdin' | 'stdout',
): SandboxStreamHandle {
	const stream = streams.find((candidate) => candidate.channel === channel);
	if (stream === undefined) {
		throw new Error(`Gateway Runtime direct execution omitted required ${channel} stream.`);
	}
	return stream;
}

async function openDirectExecution(options: {
	readonly client: OpenClawGatewayRuntimeSandboxClient;
	readonly command: string;
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly environmentHandle: SandboxEnvironmentHandle;
	readonly requestOptions: ReturnType<typeof environmentRequestOptions>;
}): Promise<OpenClawGatewayRuntimeDirectExecution> {
	const started = await options.client.sandbox.execution.start(
		{
			command: options.command,
			cwd: options.cwd,
			environment: options.environmentHandle,
			...(environmentVariables(options.environment) === undefined
				? {}
				: { environmentVariables: environmentVariables(options.environment) }),
			mode: { kind: 'direct' },
			timeoutMs: MAXIMUM_EXECUTION_MILLISECONDS,
		},
		options.requestOptions,
	);
	if (started.mode !== 'direct') {
		throw new Error('Gateway Runtime returned an attachment reservation for direct execution.');
	}
	return {
		environment: options.environmentHandle,
		operation: started.operation,
		stderr: requireDirectStream(started.streams, 'stderr'),
		stdin: requireDirectStream(started.streams, 'stdin'),
		stdout: requireDirectStream(started.streams, 'stdout'),
	};
}

function shellQuote(argument: string): string {
	return `'${argument.replaceAll("'", `'\\''`)}'`;
}

function shellCommand(params: OpenClawSandboxBackendCommandParams): string {
	if (params.args === undefined || params.args.length === 0) return params.script;
	return `/bin/sh -c ${shellQuote(params.script)} openclaw-sandbox-fs ${params.args
		.map(shellQuote)
		.join(' ')}`;
}

async function readWholeStream(options: {
	readonly client: OpenClawGatewayRuntimeSandboxClient;
	readonly requestOptions: ReturnType<typeof environmentRequestOptions>;
	readonly stream: SandboxStreamHandle;
}): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let cursor: string | undefined;
	let totalBytes = 0;
	for (;;) {
		if (totalBytes >= SANDBOX_MAXIMUM_BINARY_BYTES) {
			throw new Error('Gateway Runtime execution output exceeded the canonical byte ceiling.');
		}
		// oxlint-disable-next-line no-await-in-loop -- Stream cursors are ordered and cannot be read concurrently.
		const result = await options.client.sandbox.stream.read(
			{
				...(cursor === undefined ? {} : { cursor }),
				maxBytes: Math.min(
					EXECUTION_STREAM_READ_CHUNK_BYTES,
					SANDBOX_MAXIMUM_BINARY_BYTES - totalBytes,
				),
				stream: options.stream,
			},
			options.requestOptions,
		);
		const chunk = Buffer.from(result.chunk.contentBase64, 'base64');
		chunks.push(chunk);
		totalBytes += chunk.byteLength;
		if (totalBytes > SANDBOX_MAXIMUM_BINARY_BYTES) {
			throw new Error('Gateway Runtime execution output exceeded the canonical byte ceiling.');
		}
		if (result.eof) return Buffer.concat(chunks);
		if (result.nextCursor === undefined || result.nextCursor === cursor) {
			throw new Error('Gateway Runtime execution stream returned a non-advancing cursor.');
		}
		cursor = result.nextCursor;
	}
}

async function writeAndCloseStdin(options: {
	readonly client: OpenClawGatewayRuntimeSandboxClient;
	readonly content: Buffer | string | undefined;
	readonly requestOptions: ReturnType<typeof environmentRequestOptions>;
	readonly stdin: SandboxStreamHandle;
}): Promise<void> {
	if (options.content !== undefined) {
		const content = Buffer.isBuffer(options.content)
			? options.content
			: Buffer.from(options.content);
		await options.client.sandbox.stream.write(
			{
				content: gatewayRuntimeBinaryChunk(content),
				contentDigest: gatewayRuntimeContentDigest(content),
				sequence: 0,
				stream: options.stdin,
			},
			options.requestOptions,
		);
	}
	await options.client.sandbox.stream.close({ stream: options.stdin }, options.requestOptions);
}

async function runBufferedCommand(options: {
	readonly client: OpenClawGatewayRuntimeSandboxClient;
	readonly command: OpenClawSandboxBackendCommandParams;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}): Promise<{ readonly code: number; readonly stderr: Buffer; readonly stdout: Buffer }> {
	const requestOptions = environmentRequestOptions(options.trustedContext, options.command.signal);
	const cleanupRequestOptions = environmentRequestOptions(options.trustedContext);
	const opened = await options.client.sandbox.environment.open({}, requestOptions);
	try {
		const execution = await openDirectExecution({
			client: options.client,
			command: shellCommand(options.command),
			cwd: TOOL_VM_DEFAULT_WORKDIR,
			environment: {},
			environmentHandle: opened.environment,
			requestOptions,
		});
		const operationPromises = [
			options.client.sandbox.execution.wait(
				{ operation: execution.operation, timeoutMs: MAXIMUM_EXECUTION_MILLISECONDS },
				requestOptions,
			),
			readWholeStream({ client: options.client, requestOptions, stream: execution.stdout }),
			readWholeStream({ client: options.client, requestOptions, stream: execution.stderr }),
			writeAndCloseStdin({
				client: options.client,
				content: options.command.stdin,
				requestOptions,
				stdin: execution.stdin,
			}),
		] as const;
		const operationResults = await Promise.all(operationPromises).catch(async (error: unknown) => {
			await options.client.sandbox.execution
				.cancel({ operation: execution.operation }, cleanupRequestOptions)
				.catch(() => undefined);
			await Promise.allSettled(operationPromises);
			throw error;
		});
		const [waited, stdout, stderr] = operationResults;
		const code = requireGatewayRuntimeCompletedExitCode(waited.outcome, waited.exitCode);
		if (code !== 0 && options.command.allowFailure !== true) {
			throw new Error(
				`OpenClaw Tool VM shell command failed with exit ${String(code)}: ${stderr.toString('utf8').trim()}`,
			);
		}
		return { code, stderr, stdout };
	} finally {
		await options.client.sandbox.environment.close(
			{ environment: opened.environment },
			cleanupRequestOptions,
		);
	}
}

function isGatewayRuntimeLocalExecFinalizeToken(
	token: unknown,
): token is GatewayRuntimeLocalExecFinalizeToken {
	return (
		isUnknownRecord(token) &&
		token.kind === 'gateway-runtime-local-exec' &&
		typeof token.reservationId === 'string'
	);
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createOpenClawGatewayRuntimeSandboxRegistration(
	options: CreateOpenClawGatewayRuntimeSandboxRegistrationOptions,
): OpenClawGatewayRuntimeSandboxRegistration {
	const localExecTransport = options.localExecTransport ?? new GatewayRuntimeLocalExecTransport();
	return {
		close: async () => await localExecTransport.close(),
		factory: async (params) => {
			requireManagedSandboxConfig(params.cfg);
			const { agentId, projection } = requireProjection({
				agentProjections: options.agentProjections,
				sessionKey: params.sessionKey,
			});
			const trustedContext = createTrustedContext({
				agentId,
				projection,
				sessionKey: params.sessionKey,
			});
			return {
				id: OPENCLAW_GATEWAY_RUNTIME_BACKEND_ID,
				runtimeId: `agent-vm:${agentId}`,
				runtimeLabel: `Agent VM Tool VM (${agentId})`,
				workdir: TOOL_VM_DEFAULT_WORKDIR,
				buildExecSpec: async ({ command, env, usePty, workdir }) => {
					if (usePty) {
						throw new Error(
							'Pinned OpenClaw managed SandboxBackend requires pipe-backed execution.',
						);
					}
					const traceContext = options.traceContextProvider?.();
					const requestOptions = environmentRequestOptions(trustedContext, undefined, traceContext);
					const opened = await options.client.sandbox.environment.open({}, requestOptions);
					let execution: OpenClawGatewayRuntimeDirectExecution | undefined;
					try {
						execution = await openDirectExecution({
							client: options.client,
							command,
							cwd: workdir ?? TOOL_VM_DEFAULT_WORKDIR,
							environment: env,
							environmentHandle: opened.environment,
							requestOptions,
						});
						const localExecOperation = createOpenClawGatewayRuntimeLocalExecOperation({
							client: options.client,
							execution,
							requestOptions,
						});
						await localExecOperation.closeStdin();
						const spec = await localExecTransport.reserve(localExecOperation);
						return {
							argv: [...spec.argv],
							env: { ...spec.env },
							finalizeToken: spec.finalizeToken,
							stdinMode: 'pipe-closed',
						};
					} catch (error: unknown) {
						if (execution !== undefined) {
							await options.client.sandbox.execution
								.cancel({ operation: execution.operation }, requestOptions)
								.catch(() => undefined);
						}
						await options.client.sandbox.environment.close(
							{ environment: opened.environment },
							requestOptions,
						);
						throw error;
					}
				},
				finalizeExec: async ({ token }) => {
					if (isGatewayRuntimeLocalExecFinalizeToken(token)) {
						await localExecTransport.finalize(token);
					}
				},
				runShellCommand: async (command: OpenClawSandboxBackendCommandParams) =>
					await runBufferedCommand({ client: options.client, command, trustedContext }),
				createFsBridge: () =>
					createOpenClawGatewayRuntimeSandboxFilesystemBridge({
						client: options.client,
						openClawWorkspaceRoot: params.workspaceDir,
						trustedContext,
					}),
			};
		},
		resolveWorkdir: () => TOOL_VM_DEFAULT_WORKDIR,
	};
}
