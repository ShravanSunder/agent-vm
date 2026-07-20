import type {
	SandboxOperationIdentity,
	SandboxStreamHandle,
} from '@agent-vm/agent-portal-sdk/contracts';
import type { GatewayRuntimeClient } from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import type { GatewayRuntimeClientTrustedInvocationContext } from '@agent-vm/agent-portal-sdk/gateway-runtime-client';

import {
	gatewayRuntimeBinaryChunk,
	gatewayRuntimeContentDigest,
} from './gateway-runtime-sandbox-local-exec-operation.js';

const maximumOperationMilliseconds = 60_000;
const resetConnectionScript = [
	'set -eu',
	'marker_file=/workspace/agent-vm-lease-leaf-reset-connection.log',
	"printf '%s\\n' 'S2_RESET_CONNECTION_DISPATCHED' >> \"$marker_file\"",
	'sync "$marker_file"',
	'current_pid=$$',
	'sshd_pid=',
	'while [ "$current_pid" -gt 1 ]; do',
	'  parent_pid=$(awk \'/^PPid:/ { print $2 }\' "/proc/$current_pid/status")',
	'  [ -n "$parent_pid" ] || exit 96',
	'  parent_name=$(awk \'/^Name:/ { print $2 }\' "/proc/$parent_pid/status")',
	'  case "$parent_name" in',
	'    sshd|sshd-session) sshd_pid=$parent_pid; break ;;',
	'  esac',
	'  current_pid=$parent_pid',
	'done',
	'[ -n "$sshd_pid" ] || exit 97',
	'IFS= read -r _ || true',
	'kill -TERM "$sshd_pid"',
	'exit 98',
].join('\n');

type GatewayRuntimeSandbox = GatewayRuntimeClient['sandbox'];

export interface GatewayRuntimeSandboxE2eActuatorClient {
	readonly sandbox: {
		readonly environment: Pick<GatewayRuntimeSandbox['environment'], 'close' | 'open'>;
		readonly execution: Pick<GatewayRuntimeSandbox['execution'], 'cancel' | 'start' | 'wait'>;
		readonly filesystem: Pick<GatewayRuntimeSandbox['filesystem'], 'read' | 'write'>;
		readonly stream: Pick<GatewayRuntimeSandbox['stream'], 'close'>;
	};
}

interface GatewayRuntimeSandboxE2eIdentityParams {
	readonly agentId: string;
	readonly sessionKey: string;
}

export interface GatewayRuntimeSandboxE2eResetConnectionParams extends GatewayRuntimeSandboxE2eIdentityParams {
	readonly action: 'reset-connection';
}

export interface GatewayRuntimeSandboxE2eWriteReadParams extends GatewayRuntimeSandboxE2eIdentityParams {
	readonly action: 'write-read';
	readonly filePath: string;
	readonly marker: string;
}

export interface GatewayRuntimeSandboxE2eActiveOperationParams extends GatewayRuntimeSandboxE2eIdentityParams {
	readonly action: 'active-operation-containment';
	readonly filePath: string;
	readonly marker: string;
	readonly sentinelFilePath: string;
}

export type GatewayRuntimeSandboxE2eActuatorParams =
	| GatewayRuntimeSandboxE2eActiveOperationParams
	| GatewayRuntimeSandboxE2eResetConnectionParams
	| GatewayRuntimeSandboxE2eWriteReadParams;

export interface GatewayRuntimeSandboxE2eResetConnectionObservationDetails {
	readonly agentId: string;
	readonly kind: 'reset-connection';
	readonly status: 'ambiguous';
}

export interface GatewayRuntimeSandboxE2eWriteReadSuccessDetails {
	readonly agentId: string;
	readonly filePath: string;
	readonly kind: 'write-read';
	readonly marker: string;
	readonly readBack: string;
	readonly status: 'ok';
}

export type GatewayRuntimeSandboxE2eActuatorDetails =
	| GatewayRuntimeSandboxE2eResetConnectionObservationDetails
	| GatewayRuntimeSandboxE2eWriteReadSuccessDetails;

class GatewayRuntimeSandboxE2eActuatorError extends Error {
	readonly code: string;

	constructor(code: string, options: ErrorOptions = {}) {
		super('Gateway Runtime sandbox E2E actuator rejected a non-canonical result.', options);
		this.code = code;
		this.name = 'GatewayRuntimeSandboxE2eActuatorError';
	}
}

async function performSandboxProbeStage<TResult>(options: {
	readonly code: string;
	readonly operation: () => Promise<TResult>;
}): Promise<TResult> {
	try {
		return await options.operation();
	} catch (error: unknown) {
		throw new GatewayRuntimeSandboxE2eActuatorError(options.code, { cause: error });
	}
}

function requestOptions(trustedContext: GatewayRuntimeClientTrustedInvocationContext): {
	readonly trustedContext: GatewayRuntimeClientTrustedInvocationContext;
} {
	return { trustedContext };
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function requireStdinStream(streams: readonly SandboxStreamHandle[]): SandboxStreamHandle {
	const stdin = streams.find((stream) => stream.channel === 'stdin');
	if (stdin === undefined) {
		throw new GatewayRuntimeSandboxE2eActuatorError('execution-stdin-missing');
	}
	return stdin;
}

async function performActiveOperation(options: {
	readonly client: GatewayRuntimeSandboxE2eActuatorClient;
	readonly params: GatewayRuntimeSandboxE2eActiveOperationParams;
	readonly trustedContext: GatewayRuntimeClientTrustedInvocationContext;
}): Promise<never> {
	const operationOptions = requestOptions(options.trustedContext);
	const opened = await performSandboxProbeStage({
		code: 'environment-open-failed',
		operation: async () => await options.client.sandbox.environment.open({}, operationOptions),
	});
	const filePath = `/workspace/${options.params.filePath}`;
	const sentinelFilePath = `/workspace/${options.params.sentinelFilePath}`;
	const command = [
		'set -eu',
		`printf '%s\\n' ${shellQuote(options.params.marker)} > ${shellQuote(filePath)}`,
		`printf '%s\\n' ${shellQuote(options.params.marker)} > ${shellQuote(sentinelFilePath)}`,
		`sync ${shellQuote(filePath)} ${shellQuote(sentinelFilePath)}`,
		'while :; do sleep 1; done',
	].join('\n');
	let operation: SandboxOperationIdentity | undefined;
	try {
		const started = await options.client.sandbox.execution.start(
			{
				command,
				cwd: '/work',
				environment: opened.environment,
				mode: { kind: 'direct' },
				timeoutMs: maximumOperationMilliseconds,
			},
			operationOptions,
		);
		if (started.mode !== 'direct') {
			throw new GatewayRuntimeSandboxE2eActuatorError('active-execution-mode');
		}
		operation = started.operation;
		await options.client.sandbox.stream.close(
			{ stream: requireStdinStream(started.streams) },
			operationOptions,
		);
		await options.client.sandbox.execution.wait(
			{ operation, timeoutMs: maximumOperationMilliseconds },
			operationOptions,
		);
		throw new GatewayRuntimeSandboxE2eActuatorError('active-operation-ended');
	} catch (error: unknown) {
		if (operation !== undefined) {
			await options.client.sandbox.execution
				.cancel({ operation }, operationOptions)
				.catch(() => undefined);
		}
		throw error;
	} finally {
		await options.client.sandbox.environment
			.close({ environment: opened.environment }, operationOptions)
			.catch(() => undefined);
	}
}

async function performWriteRead(options: {
	readonly client: GatewayRuntimeSandboxE2eActuatorClient;
	readonly params: GatewayRuntimeSandboxE2eWriteReadParams;
	readonly trustedContext: GatewayRuntimeClientTrustedInvocationContext;
}): Promise<GatewayRuntimeSandboxE2eWriteReadSuccessDetails> {
	const operationOptions = requestOptions(options.trustedContext);
	const markerBytes = Buffer.from(options.params.marker, 'utf8');
	const sandboxPath = `/workspace/${options.params.filePath}`;
	const opened = await performSandboxProbeStage({
		code: 'environment-open-failed',
		operation: async () => await options.client.sandbox.environment.open({}, operationOptions),
	});
	try {
		const written = await performSandboxProbeStage({
			code: 'filesystem-write-failed',
			operation: async () =>
				await options.client.sandbox.filesystem.write(
					{
						atomic: true,
						content: gatewayRuntimeBinaryChunk(markerBytes),
						environment: opened.environment,
						path: sandboxPath,
					},
					operationOptions,
				),
		});
		if (
			written.bytesWritten !== markerBytes.byteLength ||
			written.contentDigest !== gatewayRuntimeContentDigest(markerBytes) ||
			written.path !== sandboxPath
		) {
			throw new GatewayRuntimeSandboxE2eActuatorError('filesystem-write-mismatch');
		}
		const read = await performSandboxProbeStage({
			code: 'filesystem-read-failed',
			operation: async () =>
				await options.client.sandbox.filesystem.read(
					{
						environment: opened.environment,
						maxBytes: markerBytes.byteLength,
						offsetBytes: 0,
						path: sandboxPath,
					},
					operationOptions,
				),
		});
		const readBackBytes = Buffer.from(read.chunk.contentBase64, 'base64');
		if (
			read.chunk.encoding !== 'base64' ||
			read.chunk.byteLength !== readBackBytes.byteLength ||
			!read.eof ||
			read.nextOffsetBytes !== markerBytes.byteLength ||
			read.path !== sandboxPath ||
			!readBackBytes.equals(markerBytes)
		) {
			throw new GatewayRuntimeSandboxE2eActuatorError('filesystem-readback-mismatch');
		}
		return {
			agentId: options.params.agentId,
			filePath: options.params.filePath,
			kind: 'write-read',
			marker: options.params.marker,
			readBack: readBackBytes.toString('utf8'),
			status: 'ok',
		};
	} finally {
		await performSandboxProbeStage({
			code: 'environment-close-failed',
			operation: async () =>
				await options.client.sandbox.environment.close(
					{ environment: opened.environment },
					operationOptions,
				),
		});
	}
}

async function performResetConnection(options: {
	readonly client: GatewayRuntimeSandboxE2eActuatorClient;
	readonly params: GatewayRuntimeSandboxE2eResetConnectionParams;
	readonly trustedContext: GatewayRuntimeClientTrustedInvocationContext;
}): Promise<GatewayRuntimeSandboxE2eResetConnectionObservationDetails> {
	const operationOptions = requestOptions(options.trustedContext);
	const opened = await performSandboxProbeStage({
		code: 'environment-open-failed',
		operation: async () => await options.client.sandbox.environment.open({}, operationOptions),
	});
	const started = await options.client.sandbox.execution.start(
		{
			command: resetConnectionScript,
			cwd: '/work',
			environment: opened.environment,
			mode: { kind: 'direct' },
			timeoutMs: maximumOperationMilliseconds,
		},
		operationOptions,
	);
	if (started.mode !== 'direct') {
		throw new GatewayRuntimeSandboxE2eActuatorError('reset-execution-mode');
	}
	try {
		const waitPromise = options.client.sandbox.execution.wait(
			{ operation: started.operation, timeoutMs: maximumOperationMilliseconds },
			operationOptions,
		);
		const streamCloseSettled = options.client.sandbox.stream
			.close({ stream: requireStdinStream(started.streams) }, operationOptions)
			.then(
				() => undefined,
				() => undefined,
			);
		const waited = await waitPromise;
		await streamCloseSettled;
		if (waited.outcome.kind !== 'ambiguous') {
			throw new GatewayRuntimeSandboxE2eActuatorError('reset-outcome-shape');
		}
		return { agentId: options.params.agentId, kind: 'reset-connection', status: 'ambiguous' };
	} catch (error: unknown) {
		await options.client.sandbox.execution
			.cancel({ operation: started.operation }, operationOptions)
			.catch(() => undefined);
		throw error;
	} finally {
		await options.client.sandbox.environment
			.close({ environment: opened.environment }, operationOptions)
			.catch(() => undefined);
	}
}

export async function actuateGatewayRuntimeSandboxE2eProbe(options: {
	readonly client: GatewayRuntimeSandboxE2eActuatorClient;
	readonly params: GatewayRuntimeSandboxE2eActuatorParams;
	readonly trustedContext: GatewayRuntimeClientTrustedInvocationContext;
}): Promise<GatewayRuntimeSandboxE2eActuatorDetails> {
	switch (options.params.action) {
		case 'active-operation-containment':
			return await performActiveOperation({ ...options, params: options.params });
		case 'reset-connection':
			return await performResetConnection({ ...options, params: options.params });
		case 'write-read':
			return await performWriteRead({ ...options, params: options.params });
	}
}
