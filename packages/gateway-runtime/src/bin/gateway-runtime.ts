#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getLogger } from '@logtape/logtape';
import { run } from '@optique/run';

import {
	startGatewayRuntimeProductionService,
	writeGatewayRuntimeFatalEvidence,
} from '../production/gateway-runtime-production-service.js';
import { loadGatewayRuntimeServiceConfig } from '../production/gateway-runtime-service-config.js';
import {
	configureProcessLogging,
	type ProcessLoggingHandle,
} from '../production/process-logging.js';
import {
	dispatchGatewayRuntimeCommand,
	type GatewayRuntimeCommandOperations,
} from './gateway-runtime-cli-dispatcher.js';
import { gatewayRuntimeRootParser, type GatewayRuntimeCommand } from './gateway-runtime-cli-parser.js';

const gatewayRuntimeLoggingShutdownFailure = 'Gateway runtime logging shutdown failed.\n';
const gatewayRuntimeProcessLogger = getLogger(['agent-vm', 'gateway-runtime', 'process']);

export interface GatewayRuntimeRetirementSignal {
	readonly cleanup: () => void;
	readonly signal: NodeJS.Signals;
}

export function waitForRetirementSignal(): Promise<GatewayRuntimeRetirementSignal> {
	return new Promise<GatewayRuntimeRetirementSignal>((resolve) => {
		let signalObserved = false;
		let listenersCleaned = false;
		const observeSignal = (signal: NodeJS.Signals): void => {
			if (signalObserved) return;
			signalObserved = true;
			resolve({
				cleanup: (): void => {
					if (listenersCleaned) return;
					listenersCleaned = true;
					process.off('SIGINT', onSigint);
					process.off('SIGTERM', onSigterm);
				},
				signal,
			});
		};
		const onSigint = (): void => {
			observeSignal('SIGINT');
		};
		const onSigterm = (): void => {
			observeSignal('SIGTERM');
		};
		process.on('SIGINT', onSigint);
		process.on('SIGTERM', onSigterm);
	});
}

interface GatewayRuntimeStartLifecycleService {
	readonly readiness: unknown;
	readonly retire: () => Promise<unknown>;
}

export interface GatewayRuntimeStartLifecycleProps<
	TConfig,
	TService extends GatewayRuntimeStartLifecycleService,
> {
	readonly config: TConfig;
	readonly configureLogging: (config: TConfig) => Promise<ProcessLoggingHandle>;
	readonly startService: (config: TConfig) => Promise<TService>;
	readonly waitForRetirementSignal: () => Promise<GatewayRuntimeRetirementSignal>;
	readonly writeFatalEvidence: () => Promise<void>;
	readonly writeStderr: (text: string) => void;
	readonly writeStdout: (text: string) => void;
}

export async function runGatewayRuntimeStartLifecycle<
	TConfig,
	TService extends GatewayRuntimeStartLifecycleService,
>(props: GatewayRuntimeStartLifecycleProps<TConfig, TService>): Promise<void> {
	const logging = await props.configureLogging(props.config);
	let service: TService;
	try {
		service = await props.startService(props.config);
	} catch (error: unknown) {
		gatewayRuntimeProcessLogger.error('Gateway runtime service startup failed.', {
			event: 'startup-failed',
			failureClass: 'startup',
		});
		await logging.shutdown().catch(() => {
			props.writeStderr(gatewayRuntimeLoggingShutdownFailure);
		});
		await props.writeFatalEvidence().catch(() => undefined);
		throw error;
	}
	const retirementSignalPromise = props.waitForRetirementSignal();
	props.writeStdout(`${JSON.stringify(service.readiness)}\n`);
	const retirementSignal = await retirementSignalPromise;
	try {
		const retirement = await service.retire();
		props.writeStdout(`${JSON.stringify(retirement)}\n`);
	} catch (error: unknown) {
		gatewayRuntimeProcessLogger.error('Gateway runtime service retirement failed.', {
			event: 'retirement-failed',
			failureClass: 'retirement',
		});
		throw error;
	} finally {
		await logging.shutdown().catch(() => {
			props.writeStderr(gatewayRuntimeLoggingShutdownFailure);
		});
		retirementSignal.cleanup();
	}
}

async function runGatewayRuntimeStartCommand(
	command: Extract<GatewayRuntimeCommand, { readonly command: 'start' }>,
): Promise<void> {
	const config = await loadGatewayRuntimeServiceConfig(command.configPath);
	await runGatewayRuntimeStartLifecycle({
		config,
		configureLogging: async (loadedConfig) =>
			await configureProcessLogging({
				observability: loadedConfig.observability,
				resourceAttributes: {
					'agent_vm.gateway.epoch': loadedConfig.attachment.gatewayEpoch,
					'agent_vm.zone.id': loadedConfig.controlEndpoint.identity.zoneId,
				},
				stderr: process.stderr,
			}),
		startService: async (loadedConfig) =>
			await startGatewayRuntimeProductionService({
				config: loadedConfig,
				dependencies: {},
			}),
		waitForRetirementSignal,
		writeFatalEvidence: async () =>
			await writeGatewayRuntimeFatalEvidence({ config, failureCode: 'startup-failed' }),
		writeStderr: (text): void => {
			process.stderr.write(text);
		},
		writeStdout: (text): void => {
			process.stdout.write(text);
		},
	});
}

const defaultGatewayRuntimeCommandOperations = {
	runStartLifecycle: runGatewayRuntimeStartCommand,
} satisfies GatewayRuntimeCommandOperations;

async function runGatewayRuntimeExecutable(): Promise<void> {
	const command = run(gatewayRuntimeRootParser, { help: 'both', showDefault: true });
	await dispatchGatewayRuntimeCommand(command, defaultGatewayRuntimeCommandOperations);
}

async function isGatewayRuntimeEntrypoint(): Promise<boolean> {
	const entrypointPath = process.argv[1];
	if (entrypointPath === undefined) return false;
	try {
		const [modulePath, resolvedEntrypointPath] = await Promise.all([
			realpath(fileURLToPath(import.meta.url)),
			realpath(entrypointPath),
		]);
		return modulePath === resolvedEntrypointPath;
	} catch {
		return false;
	}
}

void isGatewayRuntimeEntrypoint().then((isEntrypoint): void => {
	if (!isEntrypoint) return;
	void runGatewayRuntimeExecutable().catch(() => {
		process.stderr.write('Gateway runtime service failed.\n');
		process.exitCode = 1;
	});
});
