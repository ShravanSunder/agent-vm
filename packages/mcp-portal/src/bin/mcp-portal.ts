#!/usr/bin/env node

import { basename } from 'node:path';

import type { SecretResolver } from '@agent-vm/secret-management';
import { run } from '@optique/run';

import {
	configureProcessLogging,
	type ConfigureProcessLoggingProps,
	type ProcessLoggingHandle,
} from '../cli/process-logging.js';
import { mcpPortalRootParser, type McpPortalCommand } from '../cli/mcp-portal-cli-parser.js';
import { runMcpPortalCommand } from './mcp-portal-command-dispatcher.js';

export interface AgentVmMcpPortalRuntimeProps {
	readonly configureProcessLogging?: (
		props: ConfigureProcessLoggingProps,
	) => Promise<ProcessLoggingHandle>;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly secretResolver?: SecretResolver;
}

function writeMcpPortalDiagnostic(text: string): void {
	try {
		process.stderr.write(text);
	} catch {
		// Keep the product result when the fallback diagnostic writer is unavailable.
	}
}

export async function runMcpPortalCommandWithProcessLogging(
	command: McpPortalCommand,
	props: AgentVmMcpPortalRuntimeProps = {},
): Promise<number> {
	if (command.command !== 'mcp-proxy.serve') {
		return await runMcpPortalCommand(command, props);
	}

	let logging: ProcessLoggingHandle;
	try {
		const configureLogging = props.configureProcessLogging ?? configureProcessLogging;
		logging = await configureLogging({ stderr: process.stderr });
	} catch (error: unknown) {
		const loggingSetupFailure = new Error('mcp-portal: process logging setup failed.', {
			cause: error,
		});
		writeMcpPortalDiagnostic(`${loggingSetupFailure.message}\n`);
		return 1;
	}

	let loggingShutdownAttempted = false;
	const shutdownLogging = async (): Promise<void> => {
		if (loggingShutdownAttempted) return;
		loggingShutdownAttempted = true;
		try {
			await logging.shutdown();
		} catch {
			try {
				process.stderr.write('mcp-portal: logging shutdown failed\n');
			} catch {
				// Preserve the product result when the fallback diagnostic writer fails.
			}
		}
	};
	try {
		return await runMcpPortalCommand(command, props);
	} finally {
		await shutdownLogging();
	}
}

export function shouldRunMcpPortalEntrypoint(argvPath: string | undefined): boolean {
	const entrypointName = argvPath === undefined ? undefined : basename(argvPath);
	return (
		entrypointName === 'mcp-portal' ||
		entrypointName === 'mcp-portal.js' ||
		entrypointName === 'mcp-portal.ts'
	);
}

async function runMcpPortalExecutable(): Promise<void> {
	const command = run(mcpPortalRootParser, {
		commandList: 'top-level',
		help: 'both',
		programName: 'mcp-portal',
		showDefault: true,
	});
	process.exitCode = await runMcpPortalCommandWithProcessLogging(command);
}

if (shouldRunMcpPortalEntrypoint(process.argv[1])) {
	void runMcpPortalExecutable().catch((error: unknown) => {
		writeMcpPortalDiagnostic(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
