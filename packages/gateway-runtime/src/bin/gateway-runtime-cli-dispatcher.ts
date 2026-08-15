import { runGatewayRuntimeStartLifecycle } from './gateway-runtime-cli-operation.js';
import type { GatewayRuntimeCommand } from './gateway-runtime-cli-parser.js';

export interface GatewayRuntimeCommandOperations {
	readonly runStartLifecycle: (
		command: Extract<GatewayRuntimeCommand, { readonly command: 'start' }>,
	) => Promise<void>;
}

const defaultGatewayRuntimeCommandOperations = {
	runStartLifecycle: runGatewayRuntimeStartLifecycle,
} satisfies GatewayRuntimeCommandOperations;

function assertNever(value: never): never {
	throw new Error(`Unexpected Gateway Runtime command: ${JSON.stringify(value)}`);
}

export async function dispatchGatewayRuntimeCommand(
	command: GatewayRuntimeCommand,
	operations: GatewayRuntimeCommandOperations = defaultGatewayRuntimeCommandOperations,
): Promise<void> {
	const commandKind = command.command;
	switch (commandKind) {
		case 'start':
			await operations.runStartLifecycle(command);
			return;
		default:
			return assertNever(commandKind);
	}
}
