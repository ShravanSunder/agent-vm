import { object, or } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { map, optional, withDefault } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { command, option } from '@optique/core/primitives';

import {
	createWorkerConfigPathValueParser,
	createWorkerPortValueParser,
	createWorkerStateDirectoryValueParser,
} from './optique-cli-support.js';

export const DEFAULT_WORKER_PORT = 18_789;

export interface ServeCommandOptions {
	readonly config: string | undefined;
	readonly port: number;
	readonly stateDir: string | undefined;
}

export interface HealthCommandOptions {
	readonly port: number;
}

export interface ServeCommand {
	readonly command: 'serve';
	readonly options: ServeCommandOptions;
}

export interface HealthCommand {
	readonly command: 'health';
	readonly options: HealthCommandOptions;
}

export type WorkerCommand = ServeCommand | HealthCommand;

function createServeCommand(): Parser<'sync', ServeCommand> {
	return command(
		'serve',
		map(
			object({
				config: optional(
					option('-c', '--config', createWorkerConfigPathValueParser(), {
						description: message`Path to worker config JSON`,
					}),
				),
				port: withDefault(
					option('-p', '--port', createWorkerPortValueParser(), {
						description: message`Port to listen on`,
					}),
					DEFAULT_WORKER_PORT,
				),
				stateDir: optional(
					option('--state-dir', createWorkerStateDirectoryValueParser(), {
						description: message`State directory path`,
					}),
				),
			}),
			(options): ServeCommand => ({ command: 'serve', options }),
		),
		{ description: message`Start the agent-vm-worker HTTP server` },
	);
}

function createHealthCommand(): Parser<'sync', HealthCommand> {
	return command(
		'health',
		map(
			object({
				port: withDefault(
					option('-p', '--port', createWorkerPortValueParser(), {
						description: message`Port to check`,
					}),
					DEFAULT_WORKER_PORT,
				),
			}),
			(options): HealthCommand => ({ command: 'health', options }),
		),
		{ description: message`Check worker health` },
	);
}

export function createWorkerCommandParser(): Parser<'sync', WorkerCommand> {
	return or(createServeCommand(), createHealthCommand());
}
