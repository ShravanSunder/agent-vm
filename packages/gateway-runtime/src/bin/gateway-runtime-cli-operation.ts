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
import type { GatewayRuntimeCommand } from './gateway-runtime-cli-parser.js';

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

export function waitForRetirementSignal(
	signalTarget: GatewayRuntimeSignalTarget = process,
): Promise<GatewayRuntimeRetirementSignal> {
	return new Promise((resolve) => {
		let observed = false;
		let cleaned = false;
		const escalate = signalTarget.escalate ?? ((signal) => process.kill(process.pid, signal));
		const cleanup = (): void => {
			if (cleaned) return;
			cleaned = true;
			signalTarget.off('SIGINT', onSigint);
			signalTarget.off('SIGTERM', onSigterm);
		};
		const observe = (signal: GatewayRuntimeRetirementSignalName): void => {
			if (observed) {
				cleanup();
				escalate(signal);
				return;
			}
			observed = true;
			resolve({ cleanup, signal });
		};
		const onSigint = (): void => observe('SIGINT');
		const onSigterm = (): void => observe('SIGTERM');
		signalTarget.on('SIGINT', onSigint);
		signalTarget.on('SIGTERM', onSigterm);
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
				} catch {}
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
			} catch {}
		}
		await logging.shutdown().catch(() => {
			try {
				props.writeStderr(gatewayRuntimeLoggingShutdownFailure);
			} catch {}
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
			try {
				props.writeStderr(gatewayRuntimeLoggingShutdownFailure);
			} catch {}
		});
		retirementSignal.cleanup();
	}
}

export async function runGatewayRuntimeStartCommand(
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
			await startGatewayRuntimeProductionService({ config: loadedConfig, dependencies: {} }),
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
