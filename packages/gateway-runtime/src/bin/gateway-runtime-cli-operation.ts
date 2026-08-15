import {
	startGatewayRuntimeProductionService,
	writeGatewayRuntimeFatalEvidence,
} from '../production/gateway-runtime-production-service.js';
import { loadGatewayRuntimeServiceConfig } from '../production/gateway-runtime-service-config.js';
import type { GatewayRuntimeCommand } from './gateway-runtime-cli-parser.js';

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

export async function runGatewayRuntimeStartLifecycle(
	command: Extract<GatewayRuntimeCommand, { readonly command: 'start' }>,
): Promise<void> {
	const config = await loadGatewayRuntimeServiceConfig(command.configPath);
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
