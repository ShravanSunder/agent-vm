#!/usr/bin/env node

import path from 'node:path';

import {
	startGatewayRuntimeProductionService,
	writeGatewayRuntimeFatalEvidence,
} from '../production/gateway-runtime-production-service.js';
import { loadGatewayRuntimeServiceConfig } from '../production/gateway-runtime-service-config.js';

function configPathFromArguments(arguments_: readonly string[]): string {
	if (arguments_.length !== 2 || arguments_[0] !== '--config') {
		throw new Error('Gateway runtime requires exactly --config <absolute-path>.');
	}
	const configPath = arguments_[1];
	if (configPath === undefined || !path.isAbsolute(configPath) || configPath.includes('\0')) {
		throw new Error('Gateway runtime config path must be absolute and contain no NUL bytes.');
	}
	return configPath;
}

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

async function runGatewayRuntimeExecutable(): Promise<void> {
	const config = await loadGatewayRuntimeServiceConfig(
		configPathFromArguments(process.argv.slice(2)),
	);
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
}

void runGatewayRuntimeExecutable().catch(() => {
	process.stderr.write('Gateway runtime service failed.\n');
	process.exitCode = 1;
});
