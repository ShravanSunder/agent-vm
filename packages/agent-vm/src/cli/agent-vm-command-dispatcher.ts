import type { CliDependencies, CliIo } from './agent-vm-cli-support.js';
import type { AgentVmCommand } from './agent-vm-command-parser.js';
import { runAuthCommandOperation } from './commands/auth-command-operation.js';
import {
	runControllerCommandOperation,
	type ControllerCommandExecutionOptions,
} from './commands/controller-command-operation.js';
import { runInitCommandOperation } from './commands/init-command-operation.js';
import {
	runBackupCommandOperation,
	runBuildCommandOperation,
	runCacheCommandOperation,
	runConfigCommandOperation,
	runDoctorCommandOperation,
	runManualCommandOperation,
	runMigrateCommandOperation,
	runPathsCommandOperation,
	runResourcesCommandOperation,
	runValidateCommandOperation,
} from './commands/runtime-command-operations.js';

type CommandWithName<TName extends AgentVmCommand['command']> = Extract<
	AgentVmCommand,
	{ readonly command: TName }
>;
type Operation<TName extends AgentVmCommand['command']> = (
	io: CliIo,
	dependencies: CliDependencies,
	command: CommandWithName<TName>,
) => Promise<void>;

export interface AgentVmCommandOperationSet {
	readonly auth: Operation<'auth.1password'>;
	readonly backup: Operation<'backup.create' | 'backup.list' | 'backup.restore'>;
	readonly build: Operation<'build'>;
	readonly cache: Operation<'cache.list' | 'cache.clean'>;
	readonly config: Operation<'config.reset-instructions'>;
	readonly controller: (
		io: CliIo,
		dependencies: CliDependencies,
		command: CommandWithName<Extract<AgentVmCommand['command'], `controller.${string}`>>,
		executionOptions?: ControllerCommandExecutionOptions,
	) => Promise<void>;
	readonly doctor: Operation<'doctor'>;
	readonly init: Operation<'init'>;
	readonly manual: Operation<'manual.update'>;
	readonly migrate: Operation<'migrate.images'>;
	readonly paths: Operation<'paths.show'>;
	readonly resources: Operation<'resources.init' | 'resources.validate' | 'resources.update'>;
	readonly validate: Operation<'validate'>;
}

export const defaultAgentVmCommandOperations = {
	auth: runAuthCommandOperation,
	backup: runBackupCommandOperation,
	build: runBuildCommandOperation,
	cache: runCacheCommandOperation,
	config: runConfigCommandOperation,
	controller: runControllerCommandOperation,
	doctor: runDoctorCommandOperation,
	init: runInitCommandOperation,
	manual: runManualCommandOperation,
	migrate: runMigrateCommandOperation,
	paths: runPathsCommandOperation,
	resources: runResourcesCommandOperation,
	validate: runValidateCommandOperation,
} satisfies AgentVmCommandOperationSet;

export async function dispatchAgentVmCommand(
	command: AgentVmCommand,
	io: CliIo,
	dependencies: CliDependencies,
	operations: AgentVmCommandOperationSet = defaultAgentVmCommandOperations,
	controllerExecutionOptions: ControllerCommandExecutionOptions = {},
): Promise<void> {
	switch (command.command) {
		case 'init':
			return await operations.init(io, dependencies, command);
		case 'build':
			return await operations.build(io, dependencies, command);
		case 'validate':
			return await operations.validate(io, dependencies, command);
		case 'doctor':
			return await operations.doctor(io, dependencies, command);
		case 'cache.list':
		case 'cache.clean':
			return await operations.cache(io, dependencies, command);
		case 'config.reset-instructions':
			return await operations.config(io, dependencies, command);
		case 'manual.update':
			return await operations.manual(io, dependencies, command);
		case 'migrate.images':
			return await operations.migrate(io, dependencies, command);
		case 'paths.show':
			return await operations.paths(io, dependencies, command);
		case 'resources.init':
		case 'resources.validate':
		case 'resources.update':
			return await operations.resources(io, dependencies, command);
		case 'backup.create':
		case 'backup.list':
		case 'backup.restore':
			return await operations.backup(io, dependencies, command);
		case 'auth.1password':
			return await operations.auth(io, dependencies, command);
		case 'controller.start':
		case 'controller.stop':
		case 'controller.cleanup':
		case 'controller.status':
		case 'controller.health':
		case 'controller.health-snapshot':
		case 'controller.service-health':
		case 'controller.ssh':
		case 'controller.destroy':
		case 'controller.upgrade':
		case 'controller.logs':
		case 'controller.credentials.check':
		case 'controller.credentials.refresh':
			return await operations.controller(io, dependencies, command, controllerExecutionOptions);
		default: {
			const unreachableCommand: never = command;
			throw new Error(`Unhandled agent-vm command: ${String(unreachableCommand)}`);
		}
	}
}
