import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';

import type { ExecutorCapabilities } from './executor-interface.js';
import { getOrCreateLocalToolMcpServer } from './local-tool-mcp-server.js';

export interface CodexRuntimeHandle {
	readonly env: Record<string, string>;
	readonly homeDirectory: string;
}

function buildProviderEnvironment(
	inheritedEnv: NodeJS.ProcessEnv,
	homeDirectory: string,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(inheritedEnv)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	env.HOME = homeDirectory;
	return env;
}

export async function prepareCodexRuntimeCapabilities(options: {
	readonly capabilities: ExecutorCapabilities;
	readonly inheritedEnv: NodeJS.ProcessEnv;
	readonly stateDirectory?: string | undefined;
	readonly workingDirectory: string;
}): Promise<CodexRuntimeHandle> {
	await fs.mkdir(options.workingDirectory, { recursive: true });
	const codexHomeBase = options.stateDirectory ?? os.tmpdir();
	await fs.mkdir(codexHomeBase, { recursive: true });
	const homeDirectory = await fs.mkdtemp(path.join(codexHomeBase, 'agent-vm-codex-home-'));
	await fs.mkdir(path.join(homeDirectory, '.codex'), { recursive: true });
	const env = buildProviderEnvironment(options.inheritedEnv, homeDirectory);

	for (const mcpServer of options.capabilities.mcpServers) {
		const mcpAddArgs = [
			'mcp',
			'add',
			mcpServer.name,
			'--url',
			mcpServer.url,
			...(mcpServer.bearerTokenEnvVar
				? ['--bearer-token-env-var', mcpServer.bearerTokenEnvVar]
				: []),
		];
		// MCP registration must be serialized because each command mutates the same config home.
		// oxlint-disable-next-line eslint/no-await-in-loop
		await execa('codex', mcpAddArgs, {
			cwd: options.workingDirectory,
			env,
			reject: true,
		});
	}

	const localToolServer = await getOrCreateLocalToolMcpServer(options.capabilities.tools);
	if (localToolServer) {
		await execa('codex', ['mcp', 'add', 'agent-vm-local-tools', '--url', localToolServer.url], {
			cwd: options.workingDirectory,
			env,
			reject: true,
		});
	}

	return { env, homeDirectory };
}
