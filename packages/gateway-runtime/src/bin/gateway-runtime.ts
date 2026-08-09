#!/usr/bin/env node

import {
	startGatewayRuntimeProductionService,
	writeGatewayRuntimeFatalEvidence,
} from '../production/gateway-runtime-production-service.js';
import { loadGatewayRuntimeServiceConfig } from '../production/gateway-runtime-service-config.js';
import {
	runGatewayRuntimeCliParser,
	type GatewayRuntimeCliCommand,
} from './gateway-runtime-cli-parser.js';

async function waitForRetirementSignal(): Promise<NodeJS.Signals> {
	return await new Promise<NodeJS.Signals>((resolve) => {
		const onSignal = (signal: NodeJS.Signals): void => {
			process.off('SIGINT', onSignal);
			process.off('SIGTERM', onSignal);
			resolve(signal);
		};
		process.once('SIGINT', onSignal);
		process.once('SIGTERM', onSignal);
	});
}

function assertNever(value: never): never {
	throw new Error(`Unhandled Gateway Runtime command: ${String(value)}`);
}

async function dispatchGatewayRuntimeCommand(
	commandValue: GatewayRuntimeCliCommand,
): Promise<void> {
	switch (commandValue.command) {
		case 'start': {
			const config = await loadGatewayRuntimeServiceConfig(commandValue.options.config);
			let service: Awaited<ReturnType<typeof startGatewayRuntimeProductionService>>;
			try {
				service = await startGatewayRuntimeProductionService({
					config,
					dependencies: {},
				});
			} catch (error: unknown) {
				await writeGatewayRuntimeFatalEvidence({ config, failureCode: 'startup-failed' }).catch(
					() => undefined,
				);
				throw error;
			}
			process.stdout.write(`${JSON.stringify(service.readiness)}\n`);
			await waitForRetirementSignal();
			const retirement = await service.retire();
			process.stdout.write(`${JSON.stringify(retirement)}\n`);
			return;
		}
		default:
			return assertNever(commandValue.command);
	}
}

async function runGatewayRuntimeExecutable(): Promise<void> {
	const parseResult = runGatewayRuntimeCliParser(process.argv.slice(2), {
		stderr: process.stderr,
		stdout: process.stdout,
	});
	if (parseResult.kind === 'help') return;
	if (parseResult.kind === 'parse-error') {
		process.exitCode = parseResult.exitCode;
		return;
	}
	await dispatchGatewayRuntimeCommand(parseResult.value);
}

void runGatewayRuntimeExecutable().catch(() => {
	process.stderr.write('Gateway runtime service failed.\n');
	process.exitCode = 1;
});
