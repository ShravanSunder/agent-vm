// oxlint-disable typescript-eslint/explicit-function-return-type
import { subcommands } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { createOpenClawSubcommands } from './auth-definition.js';
import { createBackupSubcommands } from './backup-definition.js';
import { createBuildCommand } from './build-definition.js';
import { createCacheSubcommands } from './cache-definition.js';
import { createControllerSubcommands } from './controller-definition.js';
import { createDoctorCommand } from './doctor-definition.js';
import { createInitCommand } from './init-definition.js';

export function createAgentVmApp(io: CliIo, dependencies: CliDependencies) {
	return subcommands({
		name: 'agent-vm',
		version: '0.1.0',
		description: 'Gondolin-based VM controller for OpenClaw and coding agents',
		cmds: {
			init: createInitCommand(io, dependencies),
			build: createBuildCommand(io, dependencies),
			doctor: createDoctorCommand(io, dependencies),
			cache: createCacheSubcommands(io, dependencies),
			backup: createBackupSubcommands(io, dependencies),
			openclaw: createOpenClawSubcommands(io, dependencies),
			controller: createControllerSubcommands(io, dependencies),
		},
	});
}
