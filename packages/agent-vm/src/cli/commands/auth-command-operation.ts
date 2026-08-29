import { type CliDependencies, type CliIo } from '../agent-vm-cli-support.js';
import type { AgentVmCommand } from '../agent-vm-command-parser.js';
import { runOnePasswordAuthCommand } from '../onepassword-auth-command.js';
import { loadSystemConfigFromCliOption } from './command-operation-support.js';

type AuthCommand = Extract<AgentVmCommand, { readonly command: 'auth.1password' }>;

export async function runAuthCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	command: AuthCommand,
): Promise<void> {
	const systemConfig = await loadSystemConfigFromCliOption(command.options.config, dependencies);
	await runOnePasswordAuthCommand({
		dependencies,
		io,
		systemConfig,
		...(command.options.tokenReference === undefined
			? {}
			: { tokenReference: command.options.tokenReference }),
	});
}
