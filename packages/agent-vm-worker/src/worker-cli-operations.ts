import { Server as HttpServer } from 'node:http';

import { serve } from '@hono/node-server';

import { loadWorkerConfig, resolvePhaseExecutor } from './config/worker-config.js';
import { createWorkerControlApplicationMessageHandler } from './control-session/worker-control-application-handler.js';
import { attachWorkerControlUpgradeHandler } from './control-session/worker-control-http-server.js';
import {
	createWorkerControlService,
	createWorkerControlServiceOptionsFromEnvironment,
} from './control-session/worker-control-service.js';
import { createCoordinator, type Coordinator } from './coordinator/coordinator.js';
import { createApp } from './server.js';
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

export async function runWorkerServeLifecycle(command: WorkerServeCommand): Promise<void> {
	const configPath = command.config ?? process.env.WORKER_CONFIG_PATH ?? undefined;
	const baseConfig = await loadWorkerConfig(configPath);
	const config = command.stateDir ? { ...baseConfig, stateDir: command.stateDir } : baseConfig;
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
			port: command.port,
		},
		(info) => {
			writeStdout(
				{ stdout: process.stdout },
				`[agent-vm-worker] Server listening on http://localhost:${info.port}`,
			);
		},
	);
	if (server instanceof HttpServer) {
		attachWorkerControlUpgradeHandler({ server, workerControlService });
	}
}
