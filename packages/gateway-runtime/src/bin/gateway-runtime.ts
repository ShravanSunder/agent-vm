#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { getLogger } from '@logtape/logtape';

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
	runGatewayRuntimeCliParser,
	type GatewayRuntimeCliCommand,
} from './gateway-runtime-cli-parser.js';

const gatewayRuntimeLoggingShutdownFailure = 'Gateway runtime logging shutdown failed.\n';
const gatewayRuntimeFatalEvidenceFailure = 'Gateway runtime fatal evidence write failed.\n';
const gatewayRuntimeStartupFailure = 'Gateway runtime service startup failed.\n';
const gatewayRuntimeProcessLogger = getLogger(['agent-vm', 'gateway-runtime', 'process']);

type GatewayRuntimeRetirementSignalName = 'SIGINT' | 'SIGTERM';

export interface GatewayRuntimeRetirementSignal {
	readonly cleanup: () => void;
	readonly signal: NodeJS.Signals;
}

export interface GatewayRuntimeSignalTarget {
	readonly escalate?: (signal: GatewayRuntimeRetirementSignalName) => void;
	readonly off: (signal: GatewayRuntimeRetirementSignalName, listener: () => void) => void;
	readonly on: (signal: GatewayRuntimeRetirementSignalName, listener: () => void) => void;
}

function escalateGatewayRuntimeSignal(signal: GatewayRuntimeRetirementSignalName): void {
	process.kill(process.pid, signal);
}

export function waitForRetirementSignal(
	signalTarget: GatewayRuntimeSignalTarget = process,
): Promise<GatewayRuntimeRetirementSignal> {
	return new Promise<GatewayRuntimeRetirementSignal>((resolve) => {
		let signalObserved = false;
		let listenersCleaned = false;
		const escalateSignal = signalTarget.escalate ?? escalateGatewayRuntimeSignal;
		const onSigint = (): void => {
			observeSignal('SIGINT');
		};
		const onSigterm = (): void => {
			observeSignal('SIGTERM');
		};
		const cleanup = (): void => {
			if (listenersCleaned) return;
			listenersCleaned = true;
			signalTarget.off('SIGINT', onSigint);
			signalTarget.off('SIGTERM', onSigterm);
		};
		const observeSignal = (signal: GatewayRuntimeRetirementSignalName): void => {
			if (signalObserved) {
				cleanup();
				escalateSignal(signal);
				return;
			}
			signalObserved = true;
			resolve({
				cleanup,
				signal,
			});
		};
		signalTarget.on('SIGINT', onSigint);
		signalTarget.on('SIGTERM', onSigterm);
	});
}

function assertNever(value: never): never {
	throw new Error(`Unhandled Gateway Runtime command: ${String(value)}`);
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
	let logging: ProcessLoggingHandle;
	try {
		logging = await props.configureLogging(props.config);
	} catch (error: unknown) {
		throw new Error('Gateway runtime process logging setup failed.', { cause: error });
	}
	let service: TService;
	try {
		service = await props.startService(props.config);
	} catch (error: unknown) {
		try {
			await props.writeFatalEvidence();
		} catch {
			try {
				gatewayRuntimeProcessLogger.error('Gateway runtime fatal evidence write failed.', {
					event: 'fatal-evidence-write-failed',
					failureClass: 'startup',
				});
			} catch {
				try {
					props.writeStderr(gatewayRuntimeFatalEvidenceFailure);
				} catch {
					// Keep the primary startup failure when diagnostics are unavailable.
				}
			}
		}
		try {
			gatewayRuntimeProcessLogger.error('Gateway runtime service startup failed.', {
				event: 'startup-failed',
				failureClass: 'startup',
			});
		} catch {
			try {
				props.writeStderr(gatewayRuntimeStartupFailure);
			} catch {
				// Keep the primary startup failure when diagnostics are unavailable.
			}
		}
		await logging.shutdown().catch(() => {
			try {
				props.writeStderr(gatewayRuntimeLoggingShutdownFailure);
			} catch {
				// Keep the primary startup failure when diagnostics are unavailable.
			}
		});
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

async function dispatchGatewayRuntimeCommand(
	commandValue: GatewayRuntimeCliCommand,
): Promise<void> {
	switch (commandValue.command) {
		case 'start': {
			const config = await loadGatewayRuntimeServiceConfig(commandValue.options.config);
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
