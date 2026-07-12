import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign as signPayload, type KeyObject } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

import {
	CONTROL_PROTOCOL_VERSION,
	CONTROL_READY_HEADER_NAMES,
	ControlEnvelopeSchema,
	type ControlHandshakeCredential,
	type ControlHandshakeProof,
	type ControlReadyRequestProof,
	buildControlMessageReceipt,
	buildControlReadyRequestSignaturePayload,
} from '@agent-vm/control-protocol-contracts';
import {
	WorkerControlRpcMessageSchema,
	type WorkerControlHello as ControlHello,
} from '@agent-vm/worker-control-contracts';
import { execa } from 'execa';
import { io as createSocketIoClient, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';

import {
	CONTROL_HANDSHAKE_HEADER_NAMES,
	CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
	WORKER_CONTROL_ENV_NAMES,
	WORKER_CONTROL_READY_PATH,
	WORKER_CONTROL_SOCKET_PATH,
	buildWorkerControlSignaturePayload,
	type WorkerControlIdentity,
} from './control-session/worker-control-service.js';
import {
	SCRIPTED_E2E_EXECUTOR_ENV_NAME,
	SCRIPTED_E2E_EXECUTOR_PROVIDER,
} from './work-executor/scripted-e2e-executor.js';
import { resolveWorkerRuntimeEntrypoint } from './worker-e2e-gates.js';
import { waitForWorkerProtocolRetryInterval } from './worker-e2e-protocol-wait.js';

interface WorkerProcessOutput {
	stderr: string;
	stdout: string;
}

const runWorkerControlE2e = process.env.AGENT_VM_WORKER_E2E === '1';
const describeWorkerControlE2e = runWorkerControlE2e ? describe : describe.skip;
const activeSocketIoClients: Socket[] = [];

const workerControlE2eIdentity = {
	bootId: 'worker-boot-e2e',
	controllerEpoch: 'controller-epoch-e2e',
	generationId: 'worker-generation-e2e',
	peerId: 'worker-zone-e2e',
	zoneId: 'worker-e2e',
} satisfies WorkerControlIdentity;

function waitForNodeEvent(emitter: NodeJS.EventEmitter, eventName: string): Promise<void> {
	return new Promise((resolve) => {
		emitter.once(eventName, () => resolve());
	});
}

async function waitForChildExit(
	child: ChildProcess,
	timeoutMs: number,
	describeExit: string,
): Promise<void> {
	if (child.exitCode !== null) {
		return;
	}
	let timeout: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		once(child, 'exit').then(() => undefined),
		new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(
				() => reject(new Error(`${describeExit} did not exit within ${String(timeoutMs)}ms.`)),
				timeoutMs,
			);
		}),
	]).finally(() => {
		if (timeout !== undefined) clearTimeout(timeout);
	});
}

function waitForOutputCondition(options: {
	readonly child: ChildProcess;
	readonly describeCondition: string;
	readonly isReady: () => boolean;
	readonly output: WorkerProcessOutput;
	readonly stream: Readable | null;
	readonly timeoutMs: number;
}): Promise<void> {
	if (options.isReady()) {
		return Promise.resolve();
	}
	if (options.child.exitCode !== null) {
		return Promise.reject(
			new Error(
				`${options.describeCondition} failed because the process exited:\n${options.output.stderr}`,
			),
		);
	}
	if (options.stream === null) {
		return Promise.reject(new Error(`${options.describeCondition} failed: stdout is not piped.`));
	}
	const outputStream = options.stream;
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(
				new Error(
					`${options.describeCondition} did not complete within ${String(
						options.timeoutMs,
					)}ms.\nstdout:\n${options.output.stdout}\nstderr:\n${options.output.stderr}`,
				),
			);
		}, options.timeoutMs);
		const cleanup = (): void => {
			clearTimeout(timeout);
			outputStream.off('data', onData);
			options.child.off('exit', onExit);
		};
		const onData = (): void => {
			if (options.isReady()) {
				cleanup();
				resolve();
			}
		};
		const onExit = (): void => {
			cleanup();
			reject(
				new Error(
					`${options.describeCondition} failed because the process exited:\n${options.output.stderr}`,
				),
			);
		};
		outputStream.on('data', onData);
		options.child.once('exit', onExit);
		onData();
	});
}

async function findAvailablePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('Failed to determine an available port.')));
				return;
			}
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(address.port);
			});
		});
	});
}

async function waitForWorkerReady(options: {
	readonly output: WorkerProcessOutput;
	readonly port: number;
	readonly workerProcess: ChildProcess;
	readonly timeoutMs: number;
}): Promise<void> {
	await waitForOutputCondition({
		child: options.workerProcess,
		describeCondition: 'Worker readiness',
		isReady: () =>
			options.output.stdout.includes(
				`Server listening on http://localhost:${String(options.port)}`,
			),
		output: options.output,
		stream: options.workerProcess.stdout,
		timeoutMs: options.timeoutMs,
	});

	const response = await fetch(`http://127.0.0.1:${String(options.port)}/health`);
	if (!response.ok) {
		throw new Error(
			`Worker reported listening but /health returned HTTP ${String(response.status)}.`,
		);
	}
}

async function readRawWorkerControlUpgradeResponse(
	port: number,
	headers: Readonly<Record<string, string>>,
	query = 'EIO=4&transport=websocket',
): Promise<string> {
	const socket = net.connect({ host: '127.0.0.1', port });
	socket.setEncoding('utf8');
	await waitForNodeEvent(socket, 'connect');
	socket.write(
		[
			`GET ${WORKER_CONTROL_SOCKET_PATH}?${query} HTTP/1.1`,
			`Host: 127.0.0.1:${String(port)}`,
			'Connection: Upgrade',
			'Upgrade: websocket',
			'Sec-WebSocket-Version: 13',
			'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
			...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
			'\r\n',
		].join('\r\n'),
	);
	let response = '';
	socket.on('data', (chunk) => {
		response += chunk;
	});
	await waitForNodeEvent(socket, 'close');
	return response;
}

async function fetchWorkerControlCredential(
	port: number,
	headers: Readonly<Record<string, string>>,
): Promise<ControlHandshakeCredential> {
	const response = await fetch(`http://127.0.0.1:${String(port)}${WORKER_CONTROL_READY_PATH}`, {
		headers,
	});
	expect(response.status).toBe(200);
	return (await response.json()) as ControlHandshakeCredential;
}

function buildWorkerControlReadyHeaders(options: {
	readonly identity: WorkerControlIdentity;
	readonly issuedAtMs?: number | undefined;
	readonly privateKey: KeyObject;
	readonly requestId: string;
}): Readonly<Record<string, string>> {
	const proofWithoutSignature = {
		audience: 'worker_control',
		bootId: options.identity.bootId,
		controllerEpoch: options.identity.controllerEpoch,
		generationId: options.identity.generationId,
		issuedAtMs: options.issuedAtMs ?? Date.now(),
		peerId: options.identity.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		requestId: options.requestId,
		zoneId: options.identity.zoneId,
	} satisfies Omit<ControlReadyRequestProof, 'signature'>;
	const signature = signPayload(
		null,
		Buffer.from(buildControlReadyRequestSignaturePayload(proofWithoutSignature)),
		options.privateKey,
	).toString('base64url');
	return {
		[CONTROL_READY_HEADER_NAMES.bootId]: proofWithoutSignature.bootId,
		[CONTROL_READY_HEADER_NAMES.controllerEpoch]: proofWithoutSignature.controllerEpoch,
		[CONTROL_READY_HEADER_NAMES.domain]: proofWithoutSignature.audience,
		[CONTROL_READY_HEADER_NAMES.generationId]: proofWithoutSignature.generationId,
		[CONTROL_READY_HEADER_NAMES.issuedAtMs]: String(proofWithoutSignature.issuedAtMs),
		[CONTROL_READY_HEADER_NAMES.peerId]: proofWithoutSignature.peerId,
		[CONTROL_READY_HEADER_NAMES.protocol]: CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
		[CONTROL_READY_HEADER_NAMES.requestId]: proofWithoutSignature.requestId,
		[CONTROL_READY_HEADER_NAMES.signature]: signature,
		[CONTROL_READY_HEADER_NAMES.zoneId]: proofWithoutSignature.zoneId,
	};
}

function buildWorkerControlHeaders(options: {
	readonly credential: ControlHandshakeCredential;
	readonly privateKey: KeyObject;
}): Readonly<Record<string, string>> {
	const proofWithoutSignature = {
		audience: options.credential.audience,
		bootId: options.credential.bootId,
		controllerEpoch: options.credential.controllerEpoch,
		credentialId: options.credential.credentialId,
		expiresAtMs: options.credential.expiresAtMs,
		generationId: options.credential.generationId,
		issuedAtMs: options.credential.issuedAtMs,
		nonce: options.credential.nonce,
		peerId: options.credential.peerId,
		protocolVersion: options.credential.protocolVersion,
		zoneId: options.credential.zoneId,
	} satisfies Omit<ControlHandshakeProof, 'signature'>;
	const signature = signPayload(
		null,
		Buffer.from(buildWorkerControlSignaturePayload(proofWithoutSignature)),
		options.privateKey,
	).toString('base64url');
	return {
		[CONTROL_HANDSHAKE_HEADER_NAMES.bootId]: options.credential.bootId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.controllerEpoch]: options.credential.controllerEpoch,
		[CONTROL_HANDSHAKE_HEADER_NAMES.credentialId]: options.credential.credentialId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.domain]: options.credential.audience,
		[CONTROL_HANDSHAKE_HEADER_NAMES.expiresAtMs]: String(options.credential.expiresAtMs),
		[CONTROL_HANDSHAKE_HEADER_NAMES.generationId]: options.credential.generationId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.issuedAtMs]: String(options.credential.issuedAtMs),
		[CONTROL_HANDSHAKE_HEADER_NAMES.nonce]: options.credential.nonce,
		[CONTROL_HANDSHAKE_HEADER_NAMES.peerId]: options.credential.peerId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.protocol]: CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
		[CONTROL_HANDSHAKE_HEADER_NAMES.signature]: signature,
		[CONTROL_HANDSHAKE_HEADER_NAMES.zoneId]: options.credential.zoneId,
	};
}

function waitForSocketConnect(socket: Socket): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once('connect', () => resolve());
		socket.once('connect_error', (error: Error) => reject(error));
	});
}

interface WorkerTaskStatusResponse {
	readonly reason?: string;
	readonly status?: string;
}

async function waitForWorkerTaskStatus(options: {
	readonly port: number;
	readonly taskId: string;
	readonly timeoutMs: number;
}): Promise<WorkerTaskStatusResponse> {
	const startedAtMs = Date.now();
	let lastState: WorkerTaskStatusResponse = {};
	while (Date.now() - startedAtMs < options.timeoutMs) {
		// oxlint-disable-next-line no-await-in-loop -- task status polling must wait for each protocol response before the next retry.
		const response = await fetch(
			`http://127.0.0.1:${String(options.port)}/tasks/${options.taskId}`,
		);
		if (response.ok) {
			// oxlint-disable-next-line no-await-in-loop -- the response body belongs to the sequential poll above.
			const state = (await response.json()) as WorkerTaskStatusResponse;
			lastState = state;
			if (state.status === 'completed' || state.status === 'failed' || state.status === 'closed') {
				return state;
			}
		}
		// oxlint-disable-next-line no-await-in-loop -- bounded protocol retry backoff after an observed non-terminal state.
		await waitForWorkerProtocolRetryInterval(100);
	}
	throw new Error(
		`Task ${options.taskId} did not reach a terminal status within ${String(
			options.timeoutMs,
		)}ms. Last state: ${JSON.stringify(lastState)}`,
	);
}

async function runGitCommand(options: {
	readonly args: readonly string[];
	readonly cwd: string;
}): Promise<string> {
	const result = await execa('git', options.args, {
		cwd: options.cwd,
		reject: false,
		timeout: 30_000,
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${options.args.join(' ')} failed in ${options.cwd}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}
	return result.stdout.trim();
}

async function createWorkerTaskRepo(tempRoot: string): Promise<{
	readonly gitDirPath: string;
	readonly repoUrl: string;
	readonly seedPath: string;
	readonly workPath: string;
}> {
	const seedPath = path.join(tempRoot, 'seed-repo');
	const gitDirPath = path.join(tempRoot, 'gitdirs', 'tool-repo.git');
	const workPath = path.join(tempRoot, 'worker-work', 'tool-repo');
	await fs.mkdir(seedPath, { recursive: true });
	await fs.mkdir(path.dirname(gitDirPath), { recursive: true });
	await runGitCommand({ args: ['init', '-b', 'main'], cwd: seedPath });
	await runGitCommand({
		args: ['config', 'user.email', 'worker-git-rpc@example.com'],
		cwd: seedPath,
	});
	await runGitCommand({ args: ['config', 'user.name', 'worker-git-rpc'], cwd: seedPath });
	await runGitCommand({ args: ['config', 'commit.gpgsign', 'false'], cwd: seedPath });
	await fs.writeFile(path.join(seedPath, 'README.md'), 'worker git rpc e2e\n');
	await runGitCommand({ args: ['add', 'README.md'], cwd: seedPath });
	await runGitCommand({
		args: ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'],
		cwd: seedPath,
	});
	await fs.rename(path.join(seedPath, '.git'), gitDirPath);
	return {
		gitDirPath,
		repoUrl: 'https://example.invalid/acme/worker-git-rpc.git',
		seedPath,
		workPath,
	};
}

describeWorkerControlE2e('e2e: worker control session process', () => {
	let workerProcess: ChildProcess | undefined;

	afterEach(async () => {
		for (const socket of activeSocketIoClients.splice(0)) {
			socket.close();
		}
		if (workerProcess && workerProcess.exitCode === null) {
			workerProcess.kill('SIGTERM');
			try {
				await waitForChildExit(workerProcess, 5_000, 'Worker SIGTERM shutdown');
			} catch (error) {
				if (workerProcess.exitCode === null) {
					workerProcess.kill('SIGKILL');
					await waitForChildExit(workerProcess, 5_000, 'Worker SIGKILL shutdown');
				}
				throw error;
			}
			workerProcess = undefined;
		}
	});

	it('serves worker-ready and accepts only signed websocket Socket.IO control upgrades', async () => {
		const repoRoot = path.resolve(process.cwd());
		const workerEntrypoint = resolveWorkerRuntimeEntrypoint(repoRoot);
		await fs.access(workerEntrypoint);

		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-control-smoke-'));
		const stateDir = path.join(tempRoot, 'state');
		const workDir = path.join(tempRoot, 'work');
		const configPath = path.join(tempRoot, 'worker-config.json');
		const port = await findAvailablePort();
		const workerLogPath = path.join(tempRoot, 'worker-control.log');
		const workerOutput: WorkerProcessOutput = { stderr: '', stdout: '' };
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		const verifierPublicKeyPem = publicKey.export({ format: 'pem', type: 'spki' });

		await fs.mkdir(stateDir, { recursive: true });
		await fs.mkdir(workDir, { recursive: true });
		await fs.writeFile(
			configPath,
			JSON.stringify({
				runtimeInstructions: 'Worker control smoke runtime instructions.',
				defaults: { provider: 'codex', model: 'gpt-5.4-mini' },
				phases: {
					plan: {
						skills: [],
						cycle: { kind: 'noReview' },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					work: {
						skills: [],
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					wrapup: { skills: [], instructions: null },
				},
				mcpServers: [],
				verification: [],
				branchPrefix: 'agent/',
				stateDir,
			}),
		);

		workerProcess = spawn(
			'node',
			[workerEntrypoint, 'serve', '--port', String(port), '--config', configPath],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					[WORKER_CONTROL_ENV_NAMES.bootId]: workerControlE2eIdentity.bootId,
					[WORKER_CONTROL_ENV_NAMES.controllerEpoch]: workerControlE2eIdentity.controllerEpoch,
					[WORKER_CONTROL_ENV_NAMES.generationId]: workerControlE2eIdentity.generationId,
					[WORKER_CONTROL_ENV_NAMES.peerId]: workerControlE2eIdentity.peerId,
					[WORKER_CONTROL_ENV_NAMES.verifierPublicKeyPem]: verifierPublicKeyPem,
					[WORKER_CONTROL_ENV_NAMES.zoneId]: workerControlE2eIdentity.zoneId,
					WORK_DIR: workDir,
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
		workerProcess.stdout?.setEncoding('utf8');
		workerProcess.stderr?.setEncoding('utf8');
		workerProcess.stdout?.on('data', (chunk: string) => {
			workerOutput.stdout += chunk;
		});
		workerProcess.stderr?.on('data', (chunk: string) => {
			workerOutput.stderr += chunk;
		});

		try {
			await waitForWorkerReady({
				output: workerOutput,
				port,
				timeoutMs: 30_000,
				workerProcess,
			});

			const credential = await fetchWorkerControlCredential(
				port,
				buildWorkerControlReadyHeaders({
					identity: workerControlE2eIdentity,
					privateKey,
					requestId: '11111111-1111-4111-8111-111111111111',
				}),
			);
			expect(credential.audience).toBe('worker_control');
			const badResponse = await readRawWorkerControlUpgradeResponse(port, {});
			expect(badResponse).toMatch(/^HTTP\/1\.1 400 Bad Request/u);
			expect(badResponse).not.toContain('101 Switching Protocols');

			const client = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
				addTrailingSlash: false,
				extraHeaders: buildWorkerControlHeaders({ credential, privateKey }),
				forceNew: true,
				path: WORKER_CONTROL_SOCKET_PATH,
				reconnection: false,
				timeout: 2_000,
				transports: ['websocket'],
			});
			activeSocketIoClients.push(client);
			await waitForSocketConnect(client);

			const helloPayload = {
				bootId: workerControlE2eIdentity.bootId,
				controllerEpoch: workerControlE2eIdentity.controllerEpoch,
				domain: 'worker_control',
				peerId: workerControlE2eIdentity.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
			} satisfies ControlHello;
			await expect(
				client.timeout(1_000).emitWithAck('control:hello', helloPayload),
			).resolves.toMatchObject({
				controllerEpoch: workerControlE2eIdentity.controllerEpoch,
				outcome: 'accepted',
			});
			expect(client.io.engine.transport.name).toBe('websocket');
		} catch (error) {
			await fs.writeFile(workerLogPath, workerOutput.stdout + workerOutput.stderr).catch(() => {});
			const workerLog = await fs.readFile(workerLogPath, 'utf8').catch(() => '');
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}\n\nWorker log:\n${workerLog}`,
				{ cause: error },
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 120_000);

	it('drives git push and pull-default through the delivered worker runtime coordinator', async () => {
		const repoRoot = path.resolve(process.cwd());
		const workerEntrypoint = resolveWorkerRuntimeEntrypoint(repoRoot);
		await fs.access(workerEntrypoint);

		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-git-rpc-e2e-'));
		const stateDir = path.join(tempRoot, 'state');
		const workDir = path.join(tempRoot, 'work');
		const configPath = path.join(tempRoot, 'worker-config.json');
		const port = await findAvailablePort();
		const workerLogPath = path.join(tempRoot, 'worker-git-rpc.log');
		const workerOutput: WorkerProcessOutput = { stderr: '', stdout: '' };
		let controllerSocket: Socket | undefined;
		try {
			await fs.mkdir(stateDir, { recursive: true });
			await fs.mkdir(workDir, { recursive: true });
			await fs.writeFile(
				configPath,
				JSON.stringify({
					runtimeInstructions: 'Worker control git RPC e2e runtime instructions.',
					defaults: { provider: SCRIPTED_E2E_EXECUTOR_PROVIDER, model: 'scripted' },
					phases: {
						plan: {
							provider: SCRIPTED_E2E_EXECUTOR_PROVIDER,
							model: 'scripted',
							skills: [],
							cycle: { kind: 'noReview' },
							agentInstructions: null,
							reviewerInstructions: null,
							agentTurnTimeoutMs: 5_000,
							reviewerTurnTimeoutMs: 5_000,
						},
						work: {
							provider: SCRIPTED_E2E_EXECUTOR_PROVIDER,
							model: 'scripted',
							skills: [],
							cycle: { kind: 'review', cycleCount: 1 },
							agentInstructions: null,
							reviewerInstructions: null,
							agentTurnTimeoutMs: 10_000,
							reviewerTurnTimeoutMs: 5_000,
						},
						wrapup: {
							provider: SCRIPTED_E2E_EXECUTOR_PROVIDER,
							model: 'scripted',
							skills: [],
							instructions: null,
							turnTimeoutMs: 5_000,
						},
					},
					mcpServers: [],
					verification: [],
					branchPrefix: 'agent/',
					stateDir,
				}),
			);

			const { privateKey, publicKey } = generateKeyPairSync('ed25519');
			const verifierPublicKeyPem = publicKey.export({ format: 'pem', type: 'spki' });

			workerProcess = spawn(
				'node',
				[workerEntrypoint, 'serve', '--port', String(port), '--config', configPath],
				{
					cwd: repoRoot,
					env: {
						...process.env,
						[SCRIPTED_E2E_EXECUTOR_ENV_NAME]: '1',
						[WORKER_CONTROL_ENV_NAMES.bootId]: workerControlE2eIdentity.bootId,
						[WORKER_CONTROL_ENV_NAMES.controllerEpoch]: workerControlE2eIdentity.controllerEpoch,
						[WORKER_CONTROL_ENV_NAMES.generationId]: workerControlE2eIdentity.generationId,
						[WORKER_CONTROL_ENV_NAMES.peerId]: workerControlE2eIdentity.peerId,
						[WORKER_CONTROL_ENV_NAMES.verifierPublicKeyPem]: verifierPublicKeyPem,
						[WORKER_CONTROL_ENV_NAMES.zoneId]: workerControlE2eIdentity.zoneId,
						WORK_DIR: workDir,
					},
					stdio: ['ignore', 'pipe', 'pipe'],
				},
			);
			workerProcess.stdout?.setEncoding('utf8');
			workerProcess.stderr?.setEncoding('utf8');
			workerProcess.stdout?.on('data', (chunk: string) => {
				workerOutput.stdout += chunk;
			});
			workerProcess.stderr?.on('data', (chunk: string) => {
				workerOutput.stderr += chunk;
			});
			await waitForWorkerReady({
				output: workerOutput,
				port,
				timeoutMs: 30_000,
				workerProcess,
			});

			const credential = await fetchWorkerControlCredential(
				port,
				buildWorkerControlReadyHeaders({
					identity: workerControlE2eIdentity,
					privateKey,
					requestId: '22222222-2222-4222-8222-222222222222',
				}),
			);
			controllerSocket = createSocketIoClient(`ws://127.0.0.1:${String(port)}`, {
				addTrailingSlash: false,
				extraHeaders: buildWorkerControlHeaders({ credential, privateKey }),
				forceNew: true,
				path: WORKER_CONTROL_SOCKET_PATH,
				reconnection: false,
				timeout: 2_000,
				transports: ['websocket'],
			});
			activeSocketIoClients.push(controllerSocket);
			await waitForSocketConnect(controllerSocket);
			const helloPayload = {
				bootId: workerControlE2eIdentity.bootId,
				controllerEpoch: workerControlE2eIdentity.controllerEpoch,
				domain: 'worker_control',
				peerId: workerControlE2eIdentity.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
			} satisfies ControlHello;
			await expect(
				controllerSocket.timeout(1_000).emitWithAck('control:hello', helloPayload),
			).resolves.toMatchObject({
				controllerEpoch: workerControlE2eIdentity.controllerEpoch,
				outcome: 'accepted',
			});

			const observedOperations: string[] = [];
			let controllerSequence = 0;
			controllerSocket.on('control:message', (...args: unknown[]) => {
				const [rawEnvelope, rawPayload, rawAcknowledge] = args;
				const envelope = ControlEnvelopeSchema.parse(rawEnvelope);
				const message = WorkerControlRpcMessageSchema.parse(rawPayload);
				expect(envelope.domain).toBe('worker_control');
				expect(envelope.operation).toBe(message.operation);
				expect(JSON.stringify(message.payload)).not.toContain('PACK');
				if (typeof rawAcknowledge !== 'function') {
					throw new Error('Worker control message did not include a Socket.IO ack callback.');
				}
				const acknowledge = rawAcknowledge as (response: unknown) => void;
				const emitCommandResult = (responsePayload: unknown): void => {
					acknowledge(buildControlMessageReceipt());
					controllerSequence += 1;
					void controllerSocket
						?.timeout(1_000)
						.emitWithAck(
							'control:message',
							ControlEnvelopeSchema.parse({
								...envelope,
								createdAtMs: Date.now(),
								kind: 'command_result',
								messageId: randomUUID(),
								sequence: controllerSequence,
							}),
							{
								kind: 'command_result',
								operation: message.operation,
								payload: responsePayload,
							},
						)
						.catch(() => undefined);
				};
				if (message.kind !== 'command') {
					acknowledge(buildControlMessageReceipt());
					return;
				}
				observedOperations.push(message.operation);
				if (message.operation === 'git_push') {
					expect(Object.keys(message.payload).toSorted()).toEqual([
						'branchName',
						'command',
						'expectedHead',
						'repoUrl',
						'task',
					]);
					emitCommandResult({
						gitPush: {
							results: [
								{
									branch: message.payload.branchName,
									localHead: message.payload.expectedHead,
									repoUrl: message.payload.repoUrl,
									success: true,
								},
							],
						},
						responseToMessageId: envelope.messageId,
						result: 'ok',
					});
					return;
				}
				if (message.operation === 'git_pull_default') {
					expect(Object.keys(message.payload).toSorted()).toEqual([
						'command',
						'currentBranch',
						'currentHead',
						'repoUrl',
						'task',
						'worktreeDirty',
					]);
					emitCommandResult({
						gitPullDefault: {
							commitsSinceForkPoint: [],
							currentBranch: message.payload.currentBranch,
							currentBranchSync: {
								branch: message.payload.currentBranch ?? 'agent/worker-git-rpc',
								localHead: message.payload.currentHead ?? 'local-head',
								remoteHead: message.payload.currentHead ?? 'local-head',
								status: 'up-to-date',
								upstreamTrackingRef: 'origin/agent/worker-git-rpc',
							},
							defaultBranch: 'main',
							divergence: { aheadOfDefault: 0, behindDefault: 0, forkPoint: 'fork-sha' },
							fetchedCommits: [],
							kind: 'advanced',
							localDefaultHead: 'local-main-sha',
							message: 'Default branch refreshed.',
							remoteDefaultHead: 'remote-main-sha',
							repoUrl: message.payload.repoUrl,
							success: true,
						},
						responseToMessageId: envelope.messageId,
						result: 'ok',
					});
					return;
				}
				emitCommandResult({
					error: {
						errorClass: 'unexpected_operation',
						retryable: false,
						safeMessage: `Unexpected operation ${message.operation}`,
					},
					responseToMessageId: envelope.messageId,
					result: 'rejected',
				});
			});

			const repo = await createWorkerTaskRepo(tempRoot);
			const taskId = 'task-worker-git-rpc-e2e';
			const submitResponse = await fetch(`http://127.0.0.1:${String(port)}/tasks`, {
				body: JSON.stringify({
					taskId,
					prompt: 'Run the scripted worker-control git RPC e2e proof.',
					repos: [
						{
							baseBranch: 'main',
							gitDirPath: repo.gitDirPath,
							repoUrl: repo.repoUrl,
							workPath: repo.workPath,
						},
					],
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});
			expect(submitResponse.status).toBe(201);
			const finalTaskState = await waitForWorkerTaskStatus({
				port,
				taskId,
				timeoutMs: 30_000,
			});
			if (finalTaskState.status !== 'completed') {
				throw new Error(`Expected task to complete, got ${JSON.stringify(finalTaskState)}`);
			}
			expect(observedOperations).toEqual(['git_push', 'git_pull_default']);
			expect(await runGitCommand({ args: ['branch', '--show-current'], cwd: repo.workPath })).toBe(
				'agent/task-worker-git-rpc-e2e',
			);
		} catch (error) {
			await fs.writeFile(workerLogPath, workerOutput.stdout + workerOutput.stderr).catch(() => {});
			const workerLog = await fs.readFile(workerLogPath, 'utf8').catch(() => '');
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}\n\nWorker log:\n${workerLog}`,
				{ cause: error },
			);
		} finally {
			controllerSocket?.close();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 120_000);
});
