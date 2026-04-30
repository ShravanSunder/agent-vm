import type { LoadedSystemConfig } from '../../config/system-config.js';
import {
	ControllerZoneNotFoundError,
	ControllerZoneOperationUnsupportedError,
} from './zone-runtime-errors.js';
import type {
	ControllerZoneRuntime,
	ControllerZoneRuntimeSnapshot,
	OpenClawZoneRuntime,
	WorkerZoneRuntime,
} from './zone-runtime-types.js';

export interface ZoneRuntimeRegistry {
	readonly selectedZoneIds: readonly string[];
	destroyZone(
		zoneId: string,
		purge: boolean,
	): Promise<{
		readonly ok: true;
		readonly purged: boolean;
		readonly zoneId: string;
	}>;
	getOpenClawRuntime(zoneId: string): OpenClawZoneRuntime;
	getSnapshotByZone(): Readonly<Record<string, ControllerZoneRuntimeSnapshot>>;
	getWorkerRuntime(zoneId: string): WorkerZoneRuntime;
	startSelectedZones(): Promise<void>;
	stopAllZones(): Promise<void>;
}

export function createZoneRuntimeRegistry(options: {
	readonly createRuntimeForZone: (
		zone: LoadedSystemConfig['zones'][number],
	) => ControllerZoneRuntime;
	readonly startupFailures?: readonly {
		readonly lastError: string;
		readonly zoneId: string;
	}[];
	readonly systemConfig: LoadedSystemConfig;
	readonly zoneIds?: readonly string[];
	readonly writeLog?: (message: string) => void;
}): ZoneRuntimeRegistry {
	const runtimeZoneIds = options.zoneIds ?? options.systemConfig.zones.map((zone) => zone.id);
	const startupFailuresByZoneId = new Map(
		(options.startupFailures ?? []).map((failure) => [failure.zoneId, failure]),
	);
	const selectedZoneIds = [...new Set([...runtimeZoneIds, ...startupFailuresByZoneId.keys()])];
	const runtimesByZoneId = new Map<string, ControllerZoneRuntime>();
	const writeLog =
		options.writeLog ??
		((message: string): void => {
			process.stderr.write(`[zone-runtime-registry] ${message}\n`);
		});

	for (const zoneId of runtimeZoneIds) {
		const zone = options.systemConfig.zones.find((candidateZone) => candidateZone.id === zoneId);
		if (!zone) {
			throw new ControllerZoneNotFoundError(zoneId);
		}
		runtimesByZoneId.set(zoneId, options.createRuntimeForZone(zone));
	}

	const getRuntime = (zoneId: string): ControllerZoneRuntime => {
		const runtime = runtimesByZoneId.get(zoneId);
		if (!runtime) {
			throw new ControllerZoneNotFoundError(zoneId);
		}
		return runtime;
	};

	return {
		selectedZoneIds,
		async destroyZone(zoneId, purge) {
			return await getRuntime(zoneId).destroy(purge);
		},
		getOpenClawRuntime(zoneId) {
			const runtime = getRuntime(zoneId);
			if (runtime.gatewayType !== 'openclaw') {
				throw new ControllerZoneOperationUnsupportedError(
					zoneId,
					'OpenClaw operations',
					runtime.gatewayType,
				);
			}
			return runtime;
		},
		getSnapshotByZone() {
			return {
				...Object.fromEntries(
					[...startupFailuresByZoneId.entries()].map(([zoneId, failure]) => [
						zoneId,
						{
							lastError: failure.lastError,
							lifecycleState: 'failed',
						},
					]),
				),
				...Object.fromEntries(
					[...runtimesByZoneId.entries()].map(([zoneId, runtime]) => [
						zoneId,
						runtime.getSnapshot(),
					]),
				),
			};
		},
		getWorkerRuntime(zoneId) {
			const runtime = getRuntime(zoneId);
			if (runtime.gatewayType !== 'worker') {
				throw new ControllerZoneOperationUnsupportedError(
					zoneId,
					'worker operations',
					runtime.gatewayType,
				);
			}
			return runtime;
		},
		async startSelectedZones() {
			await Promise.all(
				[...runtimesByZoneId.values()]
					.filter((runtime): runtime is OpenClawZoneRuntime => runtime.gatewayType === 'openclaw')
					.map(async (runtime) => {
						try {
							await runtime.start();
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							writeLog(`Failed to start zone '${runtime.zoneId}': ${message}`);
							// Partial start: failed runtimes retain their own failed snapshot.
						}
					}),
			);
		},
		async stopAllZones() {
			const stopResults = await Promise.allSettled(
				[...runtimesByZoneId.values()].map(async (runtime) => await runtime.shutdown()),
			);
			const stopErrors = stopResults
				.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
				.map((result) =>
					result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
				);
			if (stopErrors.length > 0) {
				throw new AggregateError(
					stopErrors,
					`Failed to stop one or more gateway zones: ${stopErrors.map((error) => error.message).join('; ')}`,
				);
			}
		},
	};
}
