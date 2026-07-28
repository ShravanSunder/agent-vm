import { describe, expect, it } from 'vitest';

import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';
import { startManagedGatewayImageBootFixture } from './managed-gateway-image-boot-test-fixture.js';

const describeLiveVmIntegration = shouldRunLiveVmE2e() ? describe : describe.skip;
const gatewayRuntimePressureEvidencePrefix = 'GATEWAY_RUNTIME_UDS_PRESSURE_EVIDENCE=';

interface GatewayRuntimeUdsPressureEvidence {
	readonly kernelPressurePoint: {
		readonly configuredSendBufferCapacityBytes: number;
		readonly measurementMethod: 'python3-getsockopt-so-sndbuf-and-ioctl-tiocoutq';
		readonly queuedPayloadBytes: number;
	};
	readonly packageEntrypoint: string;
	readonly processGroupId: number;
	readonly processUserId: number;
	readonly readControl: {
		readonly completedOnlyAfterTargetAuthoritativeTerminal: boolean;
		readonly completionOutcome: 'cancelled';
		readonly controlForwardCount: number;
		readonly discardDrainResumedImmediately: boolean;
		readonly eventOrder: readonly string[];
		readonly framesParsedWhilePaused: number;
		readonly globalSocketPauseObserved: boolean;
		readonly pauseDeadlineExpired: boolean;
		readonly pauseDeadlineMilliseconds: number;
		readonly remoteAcknowledgementRequiredForEscape: boolean;
		readonly siblingForwardCount: number;
		readonly targetDataDiscardCount: number;
	};
	readonly sender: {
		readonly disconnectStoppedSourceReads: boolean;
		readonly drainObserved: boolean;
		readonly encodedFrameHighWaterBytes: number;
		readonly highWaterRetainedBytes: {
			readonly kernelSendBufferedBytes: number;
			readonly nodeWritableBufferedBytes: number;
			readonly parserBufferedBytes: number;
			readonly sourceOwnedApplicationChunkBytes: number;
		};
		readonly ownedApplicationChunkHighWaterCount: number;
		readonly retainedByteLimits: {
			readonly maxKernelSendBufferedBytes: number;
			readonly maxNodeWritableBufferedBytes: number;
			readonly maxParserBufferedBytes: number;
			readonly maxSourceOwnedApplicationChunkBytes: number;
		};
		readonly sourceChunkBytes: number;
		readonly sourceReadCount: number;
		readonly writeFalseObserved: boolean;
	};
	readonly socketAddress: string;
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGatewayRuntimeUdsPressureEvidence(stdout: string): GatewayRuntimeUdsPressureEvidence {
	const evidenceLine = stdout
		.split('\n')
		.find((line) => line.startsWith(gatewayRuntimePressureEvidencePrefix));
	if (evidenceLine === undefined) {
		throw new Error(`Gateway runtime pressure probe omitted evidence. stdout:\n${stdout}`);
	}
	const parsed: unknown = JSON.parse(
		evidenceLine.slice(gatewayRuntimePressureEvidencePrefix.length),
	);
	if (
		!isObjectRecord(parsed) ||
		!isObjectRecord(parsed.kernelPressurePoint) ||
		!isObjectRecord(parsed.readControl) ||
		!isObjectRecord(parsed.sender) ||
		!isObjectRecord(parsed.sender.highWaterRetainedBytes) ||
		typeof parsed.packageEntrypoint !== 'string' ||
		typeof parsed.processGroupId !== 'number' ||
		typeof parsed.processUserId !== 'number' ||
		typeof parsed.socketAddress !== 'string'
	) {
		throw new Error(`Gateway runtime pressure probe returned malformed evidence: ${evidenceLine}`);
	}
	return parsed as unknown as GatewayRuntimeUdsPressureEvidence;
}

function renderGatewayRuntimeUdsPressureGuestProbe(): string {
	return String.raw`
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readlink } from 'node:fs/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const evidencePrefix = ${JSON.stringify(gatewayRuntimePressureEvidencePrefix)};
const packageEntrypointUrl = import.meta.resolve('@agent-vm/gateway-runtime');
const packageEntrypoint = fileURLToPath(packageEntrypointUrl);
const gatewayRuntime = await import(packageEntrypointUrl);
const gatewayRuntimeClient = await import('@agent-vm/agent-portal-sdk/gateway-runtime-client');
const expectedExports = [
	'createGatewayRuntimePaths',
	'sendGatewayRuntimeApplicationChunks',
];
for (const exportName of expectedExports) {
	assert.equal(
		typeof gatewayRuntime[exportName],
		'function',
		'packaged @agent-vm/gateway-runtime is missing export ' + exportName,
	);
}
assert.equal(
	typeof gatewayRuntimeClient.GatewayRuntimeSocketReadFlow,
	'function',
	'packaged @agent-vm/agent-portal-sdk is missing GatewayRuntimeSocketReadFlow',
);
assert.equal(
	typeof gatewayRuntimeClient.GatewayRuntimeFrameDecoder,
	'function',
	'packaged @agent-vm/agent-portal-sdk is missing GatewayRuntimeFrameDecoder',
);
assert.equal(
	typeof gatewayRuntimeClient.encodeGatewayRuntimeFrame,
	'function',
	'packaged @agent-vm/agent-portal-sdk is missing encodeGatewayRuntimeFrame',
);

const processUserId = process.getuid?.();
const processGroupId = process.getgid?.();
assert.equal(typeof processUserId, 'number');
assert.equal(typeof processGroupId, 'number');
assert.equal(processUserId, 0, 'Gateway runtime pressure proof must run as root.');
assert.equal(processGroupId, 0, 'Gateway runtime pressure proof must run with the root group.');
assert.ok(
	packageEntrypoint.startsWith('/opt/agent-vm/local-packages/'),
	'Gateway runtime pressure proof must load the packaged image overlay.',
);
assert.ok(
	packageEntrypoint.endsWith('/gateway-runtime/dist/index.js'),
	'Gateway runtime pressure proof must resolve the packaged ESM entrypoint.',
);

const paths = gatewayRuntime.createGatewayRuntimePaths({});
assert.equal(paths.managedPluginSocketPath, '/run/agent-vm/gateway-runtime/managed-plugin.sock');

const SOURCE_CHUNK_BYTES = 16 * 1024;
const MAX_SOURCE_READS_BEFORE_PRESSURE = 4_096;
const MAX_PARSER_BUFFERED_BYTES = 1_056_768;
const MAX_NODE_WRITABLE_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_KERNEL_SEND_BUFFERED_BYTES = 4 * 1024 * 1024;
const PAUSE_DEADLINE_MILLISECONDS = 50;
const TARGET_STREAM_ID = 'target-stream';
const SIBLING_STREAM_ID = 'sibling-stream';
const socketErrors = [];

function writeWithCallback(socket, bytes, context) {
	return new Promise((resolve, reject) => {
		const onError = (error) => {
			cleanup();
			reject(new Error(context + ': ' + error.message, { cause: error }));
		};
		const onAbort = () => {
			cleanup();
			reject(new Error('Timed out while ' + context));
		};
		const deadlineSignal = AbortSignal.timeout(10_000);
		const cleanup = () => {
			deadlineSignal.removeEventListener('abort', onAbort);
			socket.off('error', onError);
		};
		deadlineSignal.addEventListener('abort', onAbort, { once: true });
		socket.once('error', onError);
		socket.write(bytes, (error) => {
			if (error !== undefined && error !== null) {
				onError(error);
				return;
			}
			cleanup();
			resolve();
		});
	});
}

async function measureKernelPressurePoint() {
	const pythonProbe = [
		'import array',
		'import fcntl',
		'import json',
		'import socket',
		'import sys',
		'import termios',
		'',
		'live_socket = socket.socket(fileno=3)',
		'try:',
		'    try:',
		'        peer_name = live_socket.getpeername()',
		'    except OSError:',
		'        peer_name = None',
		'    if peer_name != sys.argv[1]:',
		'        print(json.dumps({"matched": False}))',
		'    else:',
		'        configured_send_buffer_capacity_bytes = live_socket.getsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF)',
		'        queued_payload = array.array("i", [0])',
		'        fcntl.ioctl(live_socket.fileno(), termios.TIOCOUTQ, queued_payload, True)',
		'        print(json.dumps({',
		'            "configuredSendBufferCapacityBytes": configured_send_buffer_capacity_bytes,',
		'            "matched": True,',
		'            "measurementMethod": "python3-getsockopt-so-sndbuf-and-ioctl-tiocoutq",',
		'            "queuedPayloadBytes": queued_payload[0],',
		'        }))',
		'finally:',
		'    live_socket.detach()',
	].join('\n');
	const fileDescriptorEntries = await readdir('/proc/self/fd');
	for (const fileDescriptorEntry of fileDescriptorEntries) {
		if (!/^\d+$/u.test(fileDescriptorEntry)) continue;
		let fileDescriptorTarget;
		try {
			fileDescriptorTarget = await readlink('/proc/self/fd/' + fileDescriptorEntry);
		} catch {
			continue;
		}
		if (!fileDescriptorTarget.startsWith('socket:[')) continue;
		const candidateFileDescriptor = Number(fileDescriptorEntry);
		const result = spawnSync(
			'python3',
			['-c', pythonProbe, paths.managedPluginSocketPath],
			{
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe', candidateFileDescriptor],
			},
		);
		if (result.status !== 0 || result.stdout.length === 0) continue;
		const parsed = JSON.parse(result.stdout);
		if (parsed.matched !== true) continue;
		assert.equal(typeof parsed.configuredSendBufferCapacityBytes, 'number');
		assert.equal(typeof parsed.queuedPayloadBytes, 'number');
		assert.equal(
			parsed.measurementMethod,
			'python3-getsockopt-so-sndbuf-and-ioctl-tiocoutq',
		);
		return {
			configuredSendBufferCapacityBytes: parsed.configuredSendBufferCapacityBytes,
			measurementMethod: parsed.measurementMethod,
			queuedPayloadBytes: parsed.queuedPayloadBytes,
		};
	}
	throw new Error(
		'Python kernel pressure probe did not find the connected fixed-path UDS client through /proc/self/fd.',
	);
}

const udsServer = net.createServer();
let pressureClient;
let pressureServerSocket;
let readControlClient;
let readControlServerSocket;
try {
	const listening = once(udsServer, 'listening', { signal: AbortSignal.timeout(10_000) });
	udsServer.listen(paths.managedPluginSocketPath);
	await listening;
	const socketAddress = udsServer.address();
	assert.equal(socketAddress, paths.managedPluginSocketPath);

	const pressureConnection = once(udsServer, 'connection', {
		signal: AbortSignal.timeout(10_000),
	});
	pressureClient = net.createConnection(paths.managedPluginSocketPath);
	pressureClient.on('error', (error) => socketErrors.push('pressure client: ' + error.message));
	await once(pressureClient, 'connect', { signal: AbortSignal.timeout(10_000) });
	[pressureServerSocket] = await pressureConnection;
	pressureServerSocket.on('error', (error) =>
		socketErrors.push('pressure server: ' + error.message),
	);
	pressureServerSocket.pause();
	assert.equal(pressureServerSocket.isPaused(), true);

	const pressureDecoder = new gatewayRuntimeClient.GatewayRuntimeFrameDecoder({
		maxBufferedBytes: MAX_PARSER_BUFFERED_BYTES,
		maxContentBytes: MAX_PARSER_BUFFERED_BYTES - 8_192,
		maxFramesPerChunk: 4_096,
	});
	let parserBufferedHighWaterBytes = 0;
	let firstPressureDataObservedResolve;
	const firstPressureDataObserved = new Promise((resolve) => {
		firstPressureDataObservedResolve = resolve;
	});
	let splitFirstPressureData = false;
	pressureServerSocket.on('data', (receivedBytes) => {
		const decoderInputs =
			!splitFirstPressureData && receivedBytes.byteLength > 1
				? [receivedBytes.subarray(0, 1), receivedBytes.subarray(1)]
				: [receivedBytes];
		splitFirstPressureData = true;
		for (const decoderInput of decoderInputs) {
			pressureDecoder.push(decoderInput);
			parserBufferedHighWaterBytes = Math.max(
				parserBufferedHighWaterBytes,
				pressureDecoder.bufferedByteLength,
			);
		}
		firstPressureDataObservedResolve();
	});

	const retainedByteLimits = {
		maxKernelSendBufferedBytes: MAX_KERNEL_SEND_BUFFERED_BYTES,
		maxNodeWritableBufferedBytes: MAX_NODE_WRITABLE_BUFFERED_BYTES,
		maxParserBufferedBytes: MAX_PARSER_BUFFERED_BYTES,
		maxSourceOwnedApplicationChunkBytes: SOURCE_CHUNK_BYTES,
	};
	let sourceReadCount = 0;
	let sourceReturnObserved = false;
	let pressureSourceReadCount;
	let disconnectScheduled = false;
	let encodedFrameHighWaterBytes = 0;
	let kernelPressurePoint;
	const pendingSourceRead = new Promise(() => {});
	const boundedSource = {
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				if (
					pressureSourceReadCount !== undefined &&
					sourceReadCount > pressureSourceReadCount
				) {
					return await pendingSourceRead;
				}
				if (sourceReadCount >= MAX_SOURCE_READS_BEFORE_PRESSURE) {
					return { done: true, value: undefined };
				}
				const sourceChunk = new Uint8Array(SOURCE_CHUNK_BYTES);
				sourceChunk.fill(sourceReadCount % 251);
				sourceReadCount += 1;
				return { done: false, value: sourceChunk };
			},
			return: async () => {
				sourceReturnObserved = true;
				return { done: true, value: undefined };
			},
		}),
	};
	const pressureServerClosed = once(pressureServerSocket, 'close', {
		signal: AbortSignal.timeout(10_000),
	});
	const sendResult = await gatewayRuntime.sendGatewayRuntimeApplicationChunks({
		encodeChunk: (sourceChunk) => {
			const encodedFrame = gatewayRuntimeClient.encodeGatewayRuntimeFrame({
				jsonrpc: '2.0',
				method: 'stream.data',
				params: {
					chunkBase64: Buffer.from(sourceChunk).toString('base64'),
					sequence: sourceReadCount,
					streamId: TARGET_STREAM_ID,
				},
			});
			encodedFrameHighWaterBytes = Math.max(
				encodedFrameHighWaterBytes,
				encodedFrame.byteLength,
			);
			return encodedFrame;
		},
		maxTotalApplicationBytes: SOURCE_CHUNK_BYTES * MAX_SOURCE_READS_BEFORE_PRESSURE,
		observeExternalRetainedBytes: async () => {
			if (pressureClient.writableNeedDrain && kernelPressurePoint === undefined) {
				kernelPressurePoint = await measureKernelPressurePoint();
			}
			if (
				pressureSourceReadCount !== undefined &&
				sourceReadCount > pressureSourceReadCount &&
				!disconnectScheduled
			) {
				disconnectScheduled = true;
				queueMicrotask(() => pressureClient.destroy());
			}
			return {
				kernelSendBufferedBytes: pressureClient.writableNeedDrain
					? kernelPressurePoint?.queuedPayloadBytes ?? 0
					: 0,
				parserBufferedBytes: parserBufferedHighWaterBytes,
			};
		},
		onWritablePressure: async (pressureEvidence) => {
			assert.equal(pressureSourceReadCount, undefined);
			pressureSourceReadCount = sourceReadCount;
			assert.ok(kernelPressurePoint !== undefined);
			assert.equal(
				pressureEvidence.retainedBytes.kernelSendBufferedBytes,
				kernelPressurePoint.queuedPayloadBytes,
			);
			pressureServerSocket.resume();
			await firstPressureDataObserved;
		},
		retainedByteLimits,
		source: boundedSource,
		writable: pressureClient,
	});
	await pressureServerClosed;
	pressureDecoder.finish();
	assert.equal(sendResult.kind, 'disconnected');
	assert.equal(sourceReturnObserved, true);
	assert.equal(sendResult.chunkReadCount, sourceReadCount);
	assert.equal(sendResult.chunkWriteCount, sourceReadCount);
	assert.equal(sendResult.writablePressureCount, 1);
	assert.equal(sendResult.drainCount, 1);
	assert.ok(sourceReadCount < MAX_SOURCE_READS_BEFORE_PRESSURE);
	assert.ok(parserBufferedHighWaterBytes > 0);
	assert.ok(kernelPressurePoint !== undefined);
	assert.ok(kernelPressurePoint.configuredSendBufferCapacityBytes > 0);
	assert.ok(kernelPressurePoint.queuedPayloadBytes >= 0);
	assert.ok(
		kernelPressurePoint.queuedPayloadBytes <=
			kernelPressurePoint.configuredSendBufferCapacityBytes,
	);
	assert.ok(kernelPressurePoint.queuedPayloadBytes <= MAX_KERNEL_SEND_BUFFERED_BYTES);

	const readControlConnection = once(udsServer, 'connection', {
		signal: AbortSignal.timeout(10_000),
	});
	readControlClient = net.createConnection(paths.managedPluginSocketPath);
	readControlClient.on('error', (error) =>
		socketErrors.push('read-control client: ' + error.message),
	);
	await once(readControlClient, 'connect', { signal: AbortSignal.timeout(10_000) });
	[readControlServerSocket] = await readControlConnection;
	readControlServerSocket.on('error', (error) =>
		socketErrors.push('read-control server: ' + error.message),
	);

	const readDecoder = new gatewayRuntimeClient.GatewayRuntimeFrameDecoder();
	let framesParsed = 0;
	let framesParsedWhilePaused = 0;
	let targetDataDiscardCount = 0;
	let siblingForwardCount = 0;
	let controlForwardCount = 0;
	let pauseDeadlineExpired = false;
	let discardDrainResumedImmediately = false;
	let completedOnlyAfterTargetAuthoritativeTerminal = false;
	const eventOrder = [];
	let completionOutcome;
	let completeReadControlResolve;
	let completeReadControlReject;
	const readControlCompleted = new Promise((resolve, reject) => {
		completeReadControlResolve = resolve;
		completeReadControlReject = reject;
	});
	const completionDeadlineSignal = AbortSignal.timeout(10_000);
	completionDeadlineSignal.addEventListener(
		'abort',
		() => completeReadControlReject(new Error('Timed out waiting for authoritative terminal.')),
		{ once: true },
	);

	function toClientFrame(message) {
		if (message.method === 'gateway.heartbeat') {
			return { kind: 'control', method: message.method };
		}
		if (message.method === 'stream.data') {
			return {
				chunk: Buffer.from(message.params.chunkBase64, 'base64'),
				kind: 'stream-data',
				streamId: message.params.streamId,
			};
		}
		assert.equal(message.method, 'stream.terminal');
		return {
			kind: 'authoritative-stream-terminal',
			outcome: message.params.outcome,
			streamId: message.params.streamId,
		};
	}

	const readFlow = new gatewayRuntimeClient.GatewayRuntimeSocketReadFlow({
		deadlineScheduler: {
			schedule: ({ afterMilliseconds, onDeadline }) => {
				const deadlineHandle = setTimeout(() => {
					pauseDeadlineExpired = true;
					onDeadline();
				}, afterMilliseconds);
				return { cancel: () => clearTimeout(deadlineHandle) };
			},
		},
		forwardFrame: (frame) => {
			if (frame.kind === 'control') {
				controlForwardCount += 1;
				eventOrder.push('forward-control');
				return;
			}
			if (frame.streamId === SIBLING_STREAM_ID) {
				siblingForwardCount += 1;
				eventOrder.push(
					frame.kind === 'stream-data'
						? 'forward-sibling-data'
						: 'forward-sibling-terminal',
				);
				return;
			}
			assert.equal(frame.kind, 'authoritative-stream-terminal');
			eventOrder.push('forward-target-terminal');
		},
		onStreamCompleted: (completion) => {
			assert.equal(completion.streamId, TARGET_STREAM_ID);
			assert.equal(eventOrder.at(-1), 'forward-target-terminal');
			completionOutcome = completion.outcome;
			completedOnlyAfterTargetAuthoritativeTerminal = true;
			eventOrder.push('complete-target');
			completeReadControlResolve();
		},
		pauseDeadlineMilliseconds: PAUSE_DEADLINE_MILLISECONDS,
		socket: {
			pause: () => readControlClient.pause(),
			resume: () => {
				readControlClient.resume();
				discardDrainResumedImmediately = !readControlClient.isPaused();
			},
		},
	});

	readControlClient.on('data', (receivedBytes) => {
		try {
			const messages = readDecoder.push(receivedBytes);
			for (const message of messages) {
				framesParsed += 1;
				if (readControlClient.isPaused()) framesParsedWhilePaused += 1;
				const frame = toClientFrame(message);
				const eventCountBeforeFrame = eventOrder.length;
				readFlow.receiveFrame(frame);
				if (frame.kind === 'stream-data' && frame.streamId === TARGET_STREAM_ID) {
					assert.equal(eventOrder.length, eventCountBeforeFrame);
					targetDataDiscardCount += 1;
					eventOrder.push('discard-target-data');
				}
			}
		} catch (error) {
			completeReadControlReject(error);
		}
	});

	readFlow.applyDownstreamPressure(TARGET_STREAM_ID);
	const globalSocketPauseObserved = readControlClient.isPaused();
	assert.equal(globalSocketPauseObserved, true);

	const readControlFrames = [
		gatewayRuntimeClient.encodeGatewayRuntimeFrame({
			jsonrpc: '2.0',
			method: 'stream.data',
			params: { chunkBase64: 'AQ==', streamId: TARGET_STREAM_ID },
		}),
		gatewayRuntimeClient.encodeGatewayRuntimeFrame({
			jsonrpc: '2.0',
			method: 'stream.data',
			params: { chunkBase64: 'Ag==', streamId: SIBLING_STREAM_ID },
		}),
		gatewayRuntimeClient.encodeGatewayRuntimeFrame({
			jsonrpc: '2.0',
			method: 'gateway.heartbeat',
			params: {},
		}),
		gatewayRuntimeClient.encodeGatewayRuntimeFrame({
			jsonrpc: '2.0',
			method: 'stream.terminal',
			params: { outcome: 'completed', streamId: SIBLING_STREAM_ID },
		}),
		gatewayRuntimeClient.encodeGatewayRuntimeFrame({
			jsonrpc: '2.0',
			method: 'stream.terminal',
			params: { outcome: 'cancelled', streamId: TARGET_STREAM_ID },
		}),
	];
	await writeWithCallback(
		readControlServerSocket,
		Buffer.concat(readControlFrames),
		'writing queued read-control frames',
	);
	assert.equal(framesParsed, 0, 'Paused socket parsed queued frames before local escape.');
	await readControlCompleted;
	readDecoder.finish();
	assert.equal(completionOutcome, 'cancelled');
	assert.deepEqual(eventOrder, [
		'discard-target-data',
		'forward-sibling-data',
		'forward-control',
		'forward-sibling-terminal',
		'forward-target-terminal',
		'complete-target',
	]);
	assert.deepEqual(socketErrors, []);
	assert.ok(kernelPressurePoint !== undefined);

	process.stdout.write(
		evidencePrefix +
			JSON.stringify({
				kernelPressurePoint,
				packageEntrypoint,
				processGroupId,
				processUserId,
				readControl: {
					completedOnlyAfterTargetAuthoritativeTerminal,
					completionOutcome,
					controlForwardCount,
					discardDrainResumedImmediately,
					eventOrder,
					framesParsedWhilePaused,
					globalSocketPauseObserved,
					pauseDeadlineExpired,
					pauseDeadlineMilliseconds: PAUSE_DEADLINE_MILLISECONDS,
					remoteAcknowledgementRequiredForEscape: false,
					siblingForwardCount,
					targetDataDiscardCount,
				},
				sender: {
					disconnectStoppedSourceReads:
						sendResult.kind === 'disconnected' &&
						sourceReturnObserved &&
						sendResult.chunkReadCount === sourceReadCount,
					drainObserved: sendResult.drainCount > 0,
					encodedFrameHighWaterBytes,
					highWaterRetainedBytes: sendResult.highWaterRetainedBytes,
					ownedApplicationChunkHighWaterCount:
						sendResult.highWaterRetainedBytes.sourceOwnedApplicationChunkBytes > 0 ? 1 : 0,
					retainedByteLimits,
					sourceChunkBytes: SOURCE_CHUNK_BYTES,
					sourceReadCount,
					writeFalseObserved: sendResult.writablePressureCount > 0,
				},
				socketAddress,
			}) +
			'\n',
	);
} finally {
	pressureClient?.destroy();
	pressureServerSocket?.destroy();
	readControlClient?.destroy();
	readControlServerSocket?.destroy();
	if (udsServer.listening) {
		const closed = once(udsServer, 'close', { signal: AbortSignal.timeout(10_000) });
		udsServer.close();
		await closed;
	}
}
`;
}

describeLiveVmIntegration('live e2e: Gateway runtime UDS pressure', () => {
	it('proves bounded packaged UDS flow control under stock-VM pressure', async () => {
		// Arrange
		const fixture = await startManagedGatewayImageBootFixture({
			omittedInputFileName: 'tool-portal-service.json',
			sessionLabel: 'gateway-runtime-uds-pressure',
		});
		try {
			// Act
			const runtimeRootSetup = await fixture.vm.exec([
				'install',
				'-d',
				'-m',
				'0700',
				'/run/agent-vm/gateway-runtime',
			]);
			if (runtimeRootSetup.exitCode !== 0) {
				throw new Error(
					`Gateway runtime directory setup failed with exit ${String(runtimeRootSetup.exitCode)}.\nstdout:\n${runtimeRootSetup.stdout}\nstderr:\n${runtimeRootSetup.stderr}`,
				);
			}
			const guestProbeResult = await fixture.vm.exec(
				[
					'/bin/sh',
					'-c',
					'exec env PATH=/pnpm:/usr/local/bin:/usr/bin:/bin node --input-type=module',
				],
				{
					cwd: '/opt/agent-vm/local-packages',
					stdin: renderGatewayRuntimeUdsPressureGuestProbe(),
				},
			);

			// Assert
			if (guestProbeResult.exitCode !== 0) {
				throw new Error(
					`Gateway runtime stock-VM pressure probe failed with exit ${String(guestProbeResult.exitCode)}.\nstdout:\n${guestProbeResult.stdout}\nstderr:\n${guestProbeResult.stderr}`,
				);
			}
			const evidence = parseGatewayRuntimeUdsPressureEvidence(guestProbeResult.stdout);
			expect(evidence.socketAddress).toBe('/run/agent-vm/gateway-runtime/managed-plugin.sock');
			expect(evidence.processUserId).toBe(0);
			expect(evidence.processGroupId).toBe(0);
			expect(evidence.packageEntrypoint).toMatch(/^\/opt\/agent-vm\/local-packages\//u);
			expect(evidence.packageEntrypoint).toMatch(/\/gateway-runtime\/dist\/index\.js$/u);
			expect(evidence.kernelPressurePoint).toMatchObject({
				measurementMethod: 'python3-getsockopt-so-sndbuf-and-ioctl-tiocoutq',
			});
			expect(evidence.kernelPressurePoint.configuredSendBufferCapacityBytes).toBeGreaterThan(0);
			expect(evidence.kernelPressurePoint.queuedPayloadBytes).toBeGreaterThanOrEqual(0);
			expect(evidence.kernelPressurePoint.queuedPayloadBytes).toBeLessThanOrEqual(
				evidence.kernelPressurePoint.configuredSendBufferCapacityBytes,
			);
			expect(evidence.sender).toMatchObject({
				disconnectStoppedSourceReads: true,
				drainObserved: true,
				ownedApplicationChunkHighWaterCount: 1,
				sourceChunkBytes: 16 * 1024,
				writeFalseObserved: true,
			});
			expect(evidence.sender.sourceReadCount).toBeGreaterThan(0);
			expect(evidence.sender.encodedFrameHighWaterBytes).toBeGreaterThan(
				evidence.sender.sourceChunkBytes,
			);
			expect(evidence.sender.highWaterRetainedBytes).toMatchObject({
				kernelSendBufferedBytes: evidence.kernelPressurePoint.queuedPayloadBytes,
				nodeWritableBufferedBytes: expect.any(Number),
				parserBufferedBytes: expect.any(Number),
				sourceOwnedApplicationChunkBytes: evidence.sender.sourceChunkBytes,
			});
			expect(evidence.sender.highWaterRetainedBytes.nodeWritableBufferedBytes).toBeGreaterThan(0);
			expect(evidence.sender.highWaterRetainedBytes.parserBufferedBytes).toBeGreaterThan(0);
			expect(evidence.sender.highWaterRetainedBytes.kernelSendBufferedBytes).toBeLessThanOrEqual(
				evidence.sender.retainedByteLimits.maxKernelSendBufferedBytes,
			);
			expect(evidence.sender.highWaterRetainedBytes.nodeWritableBufferedBytes).toBeLessThanOrEqual(
				evidence.sender.retainedByteLimits.maxNodeWritableBufferedBytes,
			);
			expect(evidence.sender.highWaterRetainedBytes.parserBufferedBytes).toBeLessThanOrEqual(
				evidence.sender.retainedByteLimits.maxParserBufferedBytes,
			);
			expect(
				evidence.sender.highWaterRetainedBytes.sourceOwnedApplicationChunkBytes,
			).toBeLessThanOrEqual(evidence.sender.retainedByteLimits.maxSourceOwnedApplicationChunkBytes);
			expect(evidence.readControl).toEqual({
				completedOnlyAfterTargetAuthoritativeTerminal: true,
				completionOutcome: 'cancelled',
				controlForwardCount: 1,
				discardDrainResumedImmediately: true,
				eventOrder: [
					'discard-target-data',
					'forward-sibling-data',
					'forward-control',
					'forward-sibling-terminal',
					'forward-target-terminal',
					'complete-target',
				],
				framesParsedWhilePaused: 0,
				globalSocketPauseObserved: true,
				pauseDeadlineExpired: true,
				pauseDeadlineMilliseconds: 50,
				remoteAcknowledgementRequiredForEscape: false,
				siblingForwardCount: 2,
				targetDataDiscardCount: 1,
			});
		} finally {
			await fixture.close();
		}
	}, 900_000);
});
