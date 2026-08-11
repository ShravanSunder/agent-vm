import { loadGatewayLifecycle } from '../../gateway/gateway-lifecycle-loader.js';
import { type CliDependencies, type CliIo, requireZone } from '../agent-vm-cli-support.js';
import type { AgentVmCommand } from '../agent-vm-command-parser.js';
import { runCodexHarnessAuthCommand } from '../codex-harness-auth-command.js';
import { runOnePasswordAuthCommand } from '../onepassword-auth-command.js';
import { runOpenClawAuthCommand } from '../openclaw-auth-command.js';
import { loadSystemConfigFromCliOption } from './command-operation-support.js';

type AuthCommand = Extract<
	AgentVmCommand,
	{ readonly command: 'auth.1password' | 'auth.codex-harness' | 'auth.openclaw.login' }
>;

export async function runAuthCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	command: AuthCommand,
): Promise<void> {
	const systemConfig = await loadSystemConfigFromCliOption(command.options.config, dependencies);
	if (command.command === 'auth.1password') {
		await runOnePasswordAuthCommand({
			dependencies,
			io,
			systemConfig,
			...(command.options.tokenReference === undefined
				? {}
				: { tokenReference: command.options.tokenReference }),
		});
		return;
	}
	const zone = requireZone(systemConfig, command.options.zone);
	if (command.command === 'auth.codex-harness') {
		await runCodexHarnessAuthCommand({
			...(command.options.agent === undefined ? {} : { agentId: command.options.agent }),
			allAgents: command.options.allAgents,
			dependencies,
			io,
			systemConfig,
			zone,
		});
		return;
	}
	if (zone.gateway.type !== 'openclaw')
		throw new Error(`Zone '${zone.id}' does not support OpenClaw auth login.`);
	const lifecycle = loadGatewayLifecycle(zone.gateway.type);
	await runOpenClawAuthCommand({
		...(command.options.agent === undefined ? {} : { agentId: command.options.agent }),
		allConfiguredProfiles: command.options.allConfiguredProfiles,
		authConfig: lifecycle.authConfig,
		dependencies,
		deviceCode: command.options.deviceCode,
		dryRun: command.options.dryRun,
		io,
		profileIds: command.options.profileIds,
		provider: command.options.provider,
		systemConfig,
		zoneId: zone.id,
	});
}
