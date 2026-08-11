#!/usr/bin/env node

import { Server as HttpServer } from 'node:http';

import { serve } from '@hono/node-server';
import { command, number, option, optional, runSafely, string, subcommands } from 'cmd-ts';

import { loadWorkerConfig, resolvePhaseExecutor } from './config/worker-config.js';
import { createWorkerControlApplicationMessageHandler } from './control-session/worker-control-application-handler.js';
import { attachWorkerControlUpgradeHandler } from './control-session/worker-control-http-server.js';
import {
	createWorkerControlService,
	createWorkerControlServiceOptionsFromEnvironment,
} from './control-session/worker-control-service.js';
import { createCoordinator, type Coordinator } from './coordinator/coordinator.js';
import { createApp } from './server.js';

function writeStdout(message: string): void {
	process.stdout.write(`${message}\n`);
}

export class ReportedCliError extends Error {}

export interface CliIo {
	readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
	readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
}

function isHelpRequest(argv: readonly string[]): boolean {
	return argv.includes('--help') || argv.includes('-h');
}

const serveCommand = command({
	name: 'serve',
	description: 'Start the agent-vm-worker HTTP server',
	args: {
		port: option({
			type: number,
			long: 'port',
			short: 'p',
			defaultValue: () => 18789,
			description: 'Port to listen on',
		}),
		config: option({
			type: optional(string),
			long: 'config',
			short: 'c',
			description: 'Path to worker config JSON',
		}),
		stateDir: option({
			type: optional(string),
			long: 'state-dir',
			description: 'State directory path',
		}),
	},
	handler: async (args) => {
		const configPath = args.config ?? process.env.WORKER_CONFIG_PATH ?? undefined;
		const baseConfig = await loadWorkerConfig(configPath);
		const config = args.stateDir ? { ...baseConfig, stateDir: args.stateDir } : baseConfig;
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
				port: args.port,
			},
			(info) => {
				writeStdout(`[agent-vm-worker] Server listening on http://localhost:${info.port}`);
			},
		);
		if (server instanceof HttpServer) {
			attachWorkerControlUpgradeHandler({ server, workerControlService });
		}
	},
});

const healthCommand = command({
	name: 'health',
	description: 'Check worker health',
	args: {
		port: option({
			type: number,
			long: 'port',
			short: 'p',
			defaultValue: () => 18789,
			description: 'Port to check',
		}),
	},
	handler: async (args) => {
		try {
			const response = await fetch(`http://localhost:${args.port}/health`);
			if (!response.ok) {
				throw new Error(`Health check failed: ${response.status}`);
			}
			const data = await response.json();
			writeStdout(JSON.stringify(data, null, 2));
		} catch (error) {
			throw new Error(
				`Health check failed: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	},
});

const app = subcommands({
	name: 'agent-vm-worker',
	description: 'Configurable task worker for Gondolin VMs',
	cmds: {
		serve: serveCommand,
		health: healthCommand,
	},
});

export async function runAgentVmWorkerCli(
	argv: readonly string[],
	io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<void> {
	const result = await runSafely(app, [...argv]);
	if (!('error' in result)) {
		return;
	}

	const outputStream = result.error.config.into === 'stderr' ? io.stderr : io.stdout;
	outputStream.write(result.error.config.message);
	if (!result.error.config.message.endsWith('\n')) {
		outputStream.write('\n');
	}
	// cmd-ts subcommands still surface top-level help as a stdout Exit with nonzero exitCode.
	// We keep cmd-ts's generated help text verbatim and only normalize that help path to success.
	if (result.error.config.into === 'stdout' && isHelpRequest(argv)) {
		return;
	}
	if (result.error.config.exitCode !== 0) {
		throw new ReportedCliError(result.error.config.message);
	}
}

export function handleCliMainError(
	error: unknown,
	stderr: Pick<NodeJS.WriteStream, 'write'>,
): void {
	if (error instanceof ReportedCliError) {
		return;
	}
	stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
	await runAgentVmWorkerCli(argv, {
		stdout: process.stdout,
		stderr: process.stderr,
	});
}

void main().catch((error) => {
	handleCliMainError(error, process.stderr);
	process.exitCode = 1;
});
