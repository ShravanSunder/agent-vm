#!/usr/bin/env node

import { serve } from '@hono/node-server';
import { command, number, option, optional, run, string, subcommands } from 'cmd-ts';

import { loadWorkerConfig, resolvePhaseExecutor } from './config/worker-config.js';
import { createCoordinator } from './coordinator/coordinator.js';
import { createApp } from './server.js';

function writeStdout(message: string): void {
	process.stdout.write(`${message}\n`);
}

function writeStderr(message: string): void {
	process.stderr.write(`${message}\n`);
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
		const baseConfig = loadWorkerConfig(configPath);
		const config = args.stateDir ? { ...baseConfig, stateDir: args.stateDir } : baseConfig;
		const workspaceDir = process.env.WORKSPACE_DIR ?? '/workspace';
		const startTime = Date.now();
		const coordinator = createCoordinator({ config, workspaceDir });
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
		});

		serve(
			{
				fetch: app.fetch,
				port: args.port,
			},
			(info) => {
				writeStdout(`[agent-vm-worker] Server listening on http://localhost:${info.port}`);
			},
		);
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
				writeStderr(`Health check failed: ${response.status}`);
				process.exit(1);
			}
			const data = await response.json();
			writeStdout(JSON.stringify(data, null, 2));
		} catch (error) {
			writeStderr(`Health check failed: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
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

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
	if (argv.length === 0 || (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h'))) {
		process.exitCode = 0;
		writeStdout('agent-vm-worker <subcommand>');
		writeStdout('> Configurable task worker for Gondolin VMs');
		writeStdout('');
		writeStdout('where <subcommand> can be one of:');
		writeStdout('');
		writeStdout('- serve - Start the agent-vm-worker HTTP server');
		writeStdout('- health - Check worker health');
		writeStdout('');
		writeStdout('For more help, try running `agent-vm-worker <subcommand> --help`');
		return;
	}

	await run(app, [...argv]);
	process.exitCode = 0;
}

void main().catch((error) => {
	writeStderr(`[main] Fatal error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
