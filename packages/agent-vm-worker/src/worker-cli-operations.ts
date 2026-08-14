import { Server as HttpServer } from 'node:http';

import { serve, type ServerType } from '@hono/node-server';

import { loadWorkerConfig, resolvePhaseExecutor } from './config/worker-config.js';
import { createWorkerControlApplicationMessageHandler } from './control-session/worker-control-application-handler.js';
import { attachWorkerControlUpgradeHandler } from './control-session/worker-control-http-server.js';
import {
	createWorkerControlService,
	createWorkerControlServiceOptionsFromEnvironment,
	type WorkerControlService,
} from './control-session/worker-control-service.js';
import { createCoordinator, type Coordinator } from './coordinator/coordinator.js';
import { createApp } from './server.js';
import {
	configureProcessLogging,
	workerProcessLoggingShutdownFailureMessage,
	type ProcessLoggingHandle,
} from './shared/process-logging.js';
import type { WorkerCommand } from './worker-cli-parser.js';

type WorkerHealthCommand = Extract<WorkerCommand, { readonly command: 'health' }>;
type WorkerServeCommand = Extract<WorkerCommand, { readonly command: 'serve' }>;

export interface WorkerCliIo {
	readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
}

function writeStdout(io: WorkerCliIo, message: string): void {
	io.stdout.write(`${message}\n`);
}

export async function runWorkerHealthOperation(
	command: WorkerHealthCommand,
	io: WorkerCliIo = { stdout: process.stdout },
): Promise<void> {
	try {
		const response = await fetch(`http://localhost:${command.port}/health`);
		if (!response.ok) {
			throw new Error(`HTTP ${String(response.status)}`);
		}
		const responseBody: unknown = await response.json();
		writeStdout(io, JSON.stringify(responseBody, null, 2));
	} catch (error: unknown) {
		throw new Error(
			`Health check failed: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

type WorkerShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface WorkerSignalTarget {
	readonly off: (signal: WorkerShutdownSignal, listener: () => void) => void;
	readonly on: (signal: WorkerShutdownSignal, listener: () => void) => void;
}

interface WorkerShutdownWaiter {
	readonly signal: Promise<WorkerShutdownSignal>;
	readonly cleanup: () => void;
}

function waitForWorkerShutdownSignal(
	signalTarget: WorkerSignalTarget = process,
): WorkerShutdownWaiter {
	const signals = ['SIGINT', 'SIGTERM'] satisfies readonly WorkerShutdownSignal[];
	let resolveSignal: ((signal: WorkerShutdownSignal) => void) | undefined;
	const signal = new Promise<WorkerShutdownSignal>((resolve) => {
		resolveSignal = resolve;
	});
	const listeners = new Map<WorkerShutdownSignal, () => void>();
	for (const registeredSignal of signals) {
		const listener = (): void => {
			resolveSignal?.(registeredSignal);
		};
		listeners.set(registeredSignal, listener);
		signalTarget.on(registeredSignal, listener);
	}
	return {
		signal,
		cleanup: (): void => {
			for (const [registeredSignal, listener] of listeners) {
				signalTarget.off(registeredSignal, listener);
			}
			listeners.clear();
		},
	};
}

export interface WorkerServeShutdownLifecycleOptions {
	readonly server: { readonly close: () => Promise<void> };
	readonly workerControlService?: Pick<WorkerControlService, 'close'> | undefined;
	readonly logging?: ProcessLoggingHandle | undefined;
	readonly signalTarget?: WorkerSignalTarget | undefined;
}

async function shutdownWorkerProcessLogging(
	logging: ProcessLoggingHandle | undefined,
): Promise<void> {
	try {
		await logging?.shutdown();
	} catch {
		try {
			process.stderr.write(workerProcessLoggingShutdownFailureMessage);
		} catch {
			// Preserve the product result when the diagnostic writer is unavailable.
		}
	}
}

/**
 * Wait for retirement, close product resources in order, then dispose logging.
 * Product shutdown failures remain the primary result; logging is diagnostic.
 */
export async function runWorkerServeShutdownLifecycle(
	options: WorkerServeShutdownLifecycleOptions,
): Promise<void> {
	const shutdownWaiter = waitForWorkerShutdownSignal(options.signalTarget);
	let productCloseFailed = false;
	let productCloseError: unknown;
	try {
		try {
			await shutdownWaiter.signal;
			await options.server.close();
		} catch (error: unknown) {
			productCloseFailed = true;
			productCloseError = error;
		}
		if (options.workerControlService !== undefined) {
			try {
				await options.workerControlService.close();
			} catch (error: unknown) {
				if (!productCloseFailed) productCloseError = error;
				productCloseFailed = true;
			}
		}

		await shutdownWorkerProcessLogging(options.logging);
		if (productCloseFailed) throw productCloseError;
	} finally {
		shutdownWaiter.cleanup();
	}
}

function closeHttpServer(server: HttpServer): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error?: Error) => {
			if (error === undefined) resolve();
			else reject(error);
		});
	});
}

interface WorkerStartupResources {
	readonly logging: ProcessLoggingHandle | undefined;
	readonly server?: HttpServer | undefined;
	readonly workerControlService?: Pick<WorkerControlService, 'close'> | undefined;
}

async function closeWorkerStartupResources(resources: WorkerStartupResources): Promise<void> {
	await (
		resources.server === undefined ? Promise.resolve() : closeHttpServer(resources.server)
	).catch(() => undefined);
	await resources.workerControlService?.close().catch(() => undefined);
	await shutdownWorkerProcessLogging(resources.logging);
}

export async function runWorkerServeLifecycle(
	command: WorkerServeCommand,
	logging?: ProcessLoggingHandle,
): Promise<void> {
	let processLogging = logging;
	if (processLogging === undefined) {
		try {
			processLogging = await configureProcessLogging({ stderr: process.stderr });
		} catch (error: unknown) {
			throw new Error('Worker process logging setup failed.', { cause: error });
		}
	}
	const configPath = command.config ?? process.env.WORKER_CONFIG_PATH ?? undefined;
	let baseConfig: Awaited<ReturnType<typeof loadWorkerConfig>>;
	try {
		baseConfig = await loadWorkerConfig(configPath);
	} catch (error: unknown) {
		await closeWorkerStartupResources({ logging: processLogging });
		throw error;
	}
	const config = command.stateDir ? { ...baseConfig, stateDir: command.stateDir } : baseConfig;
	const workDir = process.env.WORK_DIR ?? '/work';
	const startTime = Date.now();
	let workerControlOptions: ReturnType<typeof createWorkerControlServiceOptionsFromEnvironment>;
	try {
		workerControlOptions = createWorkerControlServiceOptionsFromEnvironment();
	} catch (error: unknown) {
		await closeWorkerStartupResources({ logging: processLogging });
		throw error;
	}
	const coordinatorRef: { current?: Coordinator | undefined } = {};
	function requireCoordinator(): Coordinator {
		if (coordinatorRef.current === undefined) {
			throw new Error('Worker coordinator is not initialized.');
		}
		return coordinatorRef.current;
	}
	const workerControlService =
		workerControlOptions === undefined
			? undefined
			: createWorkerControlService({
					...workerControlOptions,
					applicationMessageHandler: createWorkerControlApplicationMessageHandler(),
				});
	try {
		coordinatorRef.current = await createCoordinator({
			config,
			workDir,
			...(workerControlService === undefined ? {} : { workerControlService }),
		});
	} catch (error: unknown) {
		await closeWorkerStartupResources({ logging: processLogging, workerControlService });
		throw error;
	}
	const coordinator = requireCoordinator();
	const defaultExecutor = resolvePhaseExecutor(config, {});

	const app = createApp({
		getActiveTaskId: () => coordinator.getActiveTaskId(),
		getActiveTaskStatus: () => {
			const activeTaskId = coordinator.getActiveTaskId();
			if (!activeTaskId) return null;
			return coordinator.getTaskState(activeTaskId)?.status ?? null;
		},
		getTaskState: (taskId) => coordinator.getTaskState(taskId),
		submitTask: async (input) => coordinator.submitTask(input),
		closeTask: async (taskId) => coordinator.closeTask(taskId),
		getUptime: () => Math.floor((Date.now() - startTime) / 1000),
		getExecutorInfo: () => ({
			provider: defaultExecutor.provider,
			model: defaultExecutor.model,
		}),
		workerControlService,
	});

	let server: ReturnType<typeof serve> | undefined;
	try {
		server = await new Promise<ServerType>((resolve, reject) => {
			const pendingServer = serve(
				{
					fetch: app.fetch,
					port: command.port,
				},
				(info) => {
					pendingServer.off('error', reject);
					writeStdout(
						{ stdout: process.stdout },
						`[agent-vm-worker] Server listening on http://localhost:${info.port}`,
					);
					resolve(pendingServer);
				},
			);
			pendingServer.once('error', reject);
		});
		if (server instanceof HttpServer) {
			attachWorkerControlUpgradeHandler({ server, workerControlService });
		}
	} catch (error: unknown) {
		await closeWorkerStartupResources({
			logging: processLogging,
			server: server instanceof HttpServer ? server : undefined,
			workerControlService,
		});
		throw error;
	}
	if (server instanceof HttpServer) {
		await runWorkerServeShutdownLifecycle({
			server: { close: () => closeHttpServer(server) },
			workerControlService,
			logging: processLogging,
		});
		return;
	}
	await closeWorkerStartupResources({ logging: processLogging, workerControlService });
}
