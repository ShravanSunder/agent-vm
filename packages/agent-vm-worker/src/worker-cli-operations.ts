import { Server as HttpServer } from 'node:http';

import { serve } from '@hono/node-server';

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
import type { ProcessLoggingHandle } from './shared/process-logging.js';
import type { HealthCommandOptions, ServeCommandOptions } from './worker-command-parser.js';

export interface CliIo {
	readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
	readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export interface WorkerCliOperations {
	readonly runHealth: (options: HealthCommandOptions, io: CliIo) => Promise<void>;
	readonly runServe: (
		options: ServeCommandOptions,
		io: CliIo,
		logging?: ProcessLoggingHandle,
	) => Promise<void>;
}

export interface WorkerServePathOptions {
	readonly configPathFromCli: string | undefined;
	readonly configPathFromEnvironment: string | undefined;
	readonly stateDirectoryFromCli: string | undefined;
}

export interface ResolvedWorkerServePaths {
	readonly configPath: string | undefined;
	readonly stateDirectoryOverride: string | undefined;
}

export function resolveWorkerServePaths(options: WorkerServePathOptions): ResolvedWorkerServePaths {
	let stateDirectoryOverride: string | undefined;
	if (options.stateDirectoryFromCli) {
		stateDirectoryOverride = options.stateDirectoryFromCli;
	}
	return {
		configPath: options.configPathFromCli ?? options.configPathFromEnvironment,
		stateDirectoryOverride,
	};
}

function writeStdout(io: CliIo, message: string): void {
	io.stdout.write(`${message}\n`);
}

type WorkerShutdownSignal = 'SIGINT' | 'SIGTERM';

interface WorkerSignalTarget {
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

export interface WorkerServeLifecycleOptions {
	readonly server: { readonly close: () => Promise<void> };
	readonly workerControlService?: Pick<WorkerControlService, 'close'> | undefined;
	readonly logging?: ProcessLoggingHandle | undefined;
	readonly signalTarget?: WorkerSignalTarget | undefined;
}

export async function runWorkerServeLifecycle(options: WorkerServeLifecycleOptions): Promise<void> {
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

		try {
			await options.logging?.shutdown();
		} catch {
			// The process root reports logging shutdown failure without replacing the product result.
		}
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

export async function runServeCommand(
	options: ServeCommandOptions,
	io: CliIo,
	logging?: ProcessLoggingHandle,
): Promise<void> {
	const resolvedPaths = resolveWorkerServePaths({
		configPathFromCli: options.config,
		configPathFromEnvironment: process.env.WORKER_CONFIG_PATH,
		stateDirectoryFromCli: options.stateDir,
	});
	const baseConfig = await loadWorkerConfig(resolvedPaths.configPath);
	const config =
		resolvedPaths.stateDirectoryOverride === undefined
			? baseConfig
			: { ...baseConfig, stateDir: resolvedPaths.stateDirectoryOverride };
	const workDir = process.env.WORK_DIR ?? '/work';
	const startTime = Date.now();
	const workerControlOptions = createWorkerControlServiceOptionsFromEnvironment();
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
	coordinatorRef.current = await createCoordinator({
		config,
		workDir,
		...(workerControlService === undefined ? {} : { workerControlService }),
	});
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

	const server = serve(
		{
			fetch: app.fetch,
			port: options.port,
		},
		(info) => {
			writeStdout(io, `[agent-vm-worker] Server listening on http://localhost:${info.port}`);
		},
	);
	if (server instanceof HttpServer) {
		attachWorkerControlUpgradeHandler({ server, workerControlService });
		await runWorkerServeLifecycle({
			server: { close: () => closeHttpServer(server) },
			workerControlService,
			logging,
		});
	}
}

export async function runHealthCommand(options: HealthCommandOptions, io: CliIo): Promise<void> {
	try {
		const response = await fetch(`http://localhost:${options.port}/health`);
		if (!response.ok) {
			throw new Error(`Health check failed: ${response.status}`);
		}
		const data: unknown = await response.json();
		writeStdout(io, JSON.stringify(data, null, 2));
	} catch (error: unknown) {
		throw new Error(
			`Health check failed: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

export const defaultWorkerCliOperations: WorkerCliOperations = {
	runHealth: runHealthCommand,
	runServe: runServeCommand,
};
