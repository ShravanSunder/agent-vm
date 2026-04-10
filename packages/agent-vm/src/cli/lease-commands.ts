import type { SystemConfig } from '../controller/system-config.js';

import {
	type CliDependencies,
	type CliIo,
	resolveControllerBaseUrl,
	writeJson,
} from './agent-vm-cli-support.js';

interface RunLeaseCommandOptions {
	readonly dependencies: CliDependencies;
	readonly io: CliIo;
	readonly restArguments: readonly string[];
	readonly systemConfig: SystemConfig;
}

export async function runLeaseCommand(options: RunLeaseCommandOptions): Promise<void> {
	const controllerClient = options.dependencies.createControllerClient({
		baseUrl: resolveControllerBaseUrl(options.systemConfig),
	});
	const leaseSubcommand = options.restArguments[0];

	if (leaseSubcommand === 'list') {
		writeJson(options.io, await controllerClient.listLeases());
		return;
	}

	if (leaseSubcommand === 'release') {
		const leaseId = options.restArguments[1];
		if (!leaseId) {
			throw new Error('Usage: agent-vm controller lease release <leaseId>');
		}
		await controllerClient.releaseLease(leaseId);
		writeJson(options.io, { ok: true, released: leaseId });
		return;
	}

	throw new Error(`Unknown lease subcommand '${leaseSubcommand ?? 'undefined'}'.`);
}
