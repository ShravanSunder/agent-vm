import { runToolPortalOperation } from './tool-portal-cli-operation.js';
import type { ToolPortalCommand } from './tool-portal-cli-parser.js';

export type ToolPortalOperation = (
	command: ToolPortalCommand,
	environment: NodeJS.ProcessEnv,
) => Promise<number>;

function assertNever(value: never): never {
	throw new Error(`Unsupported Tool Portal CLI operation: ${String(value)}.`);
}

export async function dispatchToolPortalCommand(
	command: ToolPortalCommand,
	environment: NodeJS.ProcessEnv,
	operation: ToolPortalOperation = runToolPortalOperation,
): Promise<number> {
	switch (command.operation) {
		case 'artifact-read':
		case 'call':
		case 'describe':
		case 'list':
		case 'search':
			return operation(command, environment);
		default:
			return assertNever(command);
	}
}
