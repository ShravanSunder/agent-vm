// oxlint-disable typescript-eslint/explicit-function-return-type
import { command, option, optional, positional, string } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { promptAndStoreServiceAccountToken, scaffoldAgentVmProject } from '../init-command.js';
import { parseGatewayType } from './command-definition-support.js';

export function createInitCommand(io: CliIo, dependencies: CliDependencies) {
	return command({
		name: 'init',
		description: 'Scaffold a new agent-vm project',
		args: {
			zoneId: positional({
				displayName: 'zone-id',
				type: optional(string),
				description: 'Zone identifier (default: "default")',
			}),
			type: option({
				type: string,
				long: 'type',
				description: 'Gateway type: openclaw or coding',
			}),
		},
		handler: async ({ type, zoneId }) => {
			const result = (dependencies.scaffoldAgentVmProject ?? scaffoldAgentVmProject)({
				gatewayType: parseGatewayType(type),
				targetDir: dependencies.getCurrentWorkingDirectory?.() ?? process.cwd(),
				zoneId: zoneId ?? 'default',
			});
			const keychainStored = await (
				dependencies.promptAndStoreServiceAccountToken ?? promptAndStoreServiceAccountToken
			)();
			io.stdout.write(`${JSON.stringify({ ...result, keychainStored }, null, 2)}\n`);
		},
	});
}
