import {
	isProcessAlive,
	killOrphanedManagedVmProcess,
	killProcess,
	readProcessCommand,
	readProcessIdentity,
	sleep,
} from '../shared/managed-vm-process.js';
import type {
	GatewayRuntimeRecord,
	GatewayRuntimeRecordLegacyDefaults,
} from './gateway-runtime-record.js';
import {
	deleteGatewayRuntimeRecord,
	loadGatewayRuntimeRecord,
	quarantineGatewayRuntimeRecord,
} from './gateway-runtime-record.js';

function writeRecoveryLog(message: string): void {
	process.stderr.write(`[agent-vm] ${message}\n`);
}

function expectedGatewaySessionLabel(projectNamespace: string, zoneId: string): string {
	return `${projectNamespace}:${zoneId}:gateway`;
}

function validateRuntimeRecordCleanupScope(options: {
	readonly legacyRecordDefaults?: GatewayRuntimeRecordLegacyDefaults;
	readonly projectNamespace: string;
	readonly runtimeRecord: GatewayRuntimeRecord;
	readonly stateDir: string;
	readonly zoneId: string;
}): string | null {
	if (
		options.legacyRecordDefaults !== undefined &&
		options.runtimeRecord.configPath !== options.legacyRecordDefaults.configPath
	) {
		return `Gateway runtime record at '${options.stateDir}' belongs to configPath '${options.runtimeRecord.configPath}', not '${options.legacyRecordDefaults.configPath}'. Refusing scoped cleanup.`;
	}
	if (
		options.legacyRecordDefaults !== undefined &&
		options.runtimeRecord.controllerPort !== options.legacyRecordDefaults.controllerPort
	) {
		return `Gateway runtime record at '${options.stateDir}' belongs to controllerPort '${options.runtimeRecord.controllerPort}', not '${options.legacyRecordDefaults.controllerPort}'. Refusing scoped cleanup.`;
	}
	if (options.runtimeRecord.projectNamespace !== options.projectNamespace) {
		return `Gateway runtime record at '${options.stateDir}' for zone '${options.runtimeRecord.zoneId}' belongs to projectNamespace '${options.runtimeRecord.projectNamespace}', not '${options.projectNamespace}'. Refusing scoped cleanup.`;
	}
	if (options.runtimeRecord.zoneId !== options.zoneId) {
		return `Gateway runtime record at '${options.stateDir}' belongs to zone '${options.runtimeRecord.zoneId}', not requested zone '${options.zoneId}'. Refusing scoped cleanup.`;
	}
	const expectedSessionLabel = expectedGatewaySessionLabel(
		options.projectNamespace,
		options.zoneId,
	);
	if (options.runtimeRecord.sessionLabel !== expectedSessionLabel) {
		return `Gateway runtime record at '${options.stateDir}' session label '${options.runtimeRecord.sessionLabel}' does not match expected '${expectedSessionLabel}'. Refusing scoped cleanup.`;
	}
	return null;
}

async function killOrphanedGatewayProcess(
	runtimeRecord: GatewayRuntimeRecord,
	dependencies: Required<
		Pick<
			GatewayRecoveryDependencies,
			'isProcessAlive' | 'killProcess' | 'readProcessCommand' | 'readProcessIdentity' | 'sleep'
		>
	>,
): Promise<number | null> {
	return await killOrphanedManagedVmProcess({
		contextLabel: `Gateway runtime record for zone '${runtimeRecord.zoneId}'`,
		dependencies,
		pid: runtimeRecord.qemuPid,
		// recordedIdentity is optional on the schema for back-compat with
		// pre-v1 records; cleanup falls back to the command-only check when
		// it's absent. New writes always set it.
		...(runtimeRecord.processIdentity !== undefined
			? { recordedIdentity: runtimeRecord.processIdentity }
			: {}),
	});
}

export interface GatewayRecoveryDependencies {
	readonly deleteGatewayRuntimeRecord?: typeof deleteGatewayRuntimeRecord;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
	readonly loadGatewayRuntimeRecord?: typeof loadGatewayRuntimeRecord;
	readonly log?: (message: string) => void;
	readonly readProcessCommand?: (pid: number) => Promise<string | null>;
	readonly readProcessIdentity?: typeof readProcessIdentity;
	readonly quarantineGatewayRuntimeRecord?: typeof quarantineGatewayRuntimeRecord;
	readonly sleep?: (delayMs: number) => Promise<void>;
}

export async function cleanupOrphanedGatewayIfPresent(
	options: {
		readonly legacyRecordDefaults?: GatewayRuntimeRecordLegacyDefaults;
		readonly mode?: 'in-process-recovery' | 'offline-cleanup';
		readonly projectNamespace: string;
		readonly stateDir: string;
		readonly zoneId: string;
	},
	dependencies: GatewayRecoveryDependencies = {},
): Promise<{
	readonly cleanedUp: boolean;
	readonly cleanupWarning?: string;
	readonly killedPid: number | null;
}> {
	const log = dependencies.log ?? writeRecoveryLog;
	const runtimeRecord = await (dependencies.loadGatewayRuntimeRecord ?? loadGatewayRuntimeRecord)(
		options.stateDir,
		{
			...(options.legacyRecordDefaults
				? { legacyRecordDefaults: options.legacyRecordDefaults }
				: {}),
			log,
		},
	);
	if (!runtimeRecord) {
		return { cleanedUp: false, killedPid: null };
	}
	const scopeMismatch = validateRuntimeRecordCleanupScope({
		...(options.legacyRecordDefaults ? { legacyRecordDefaults: options.legacyRecordDefaults } : {}),
		projectNamespace: options.projectNamespace,
		runtimeRecord,
		stateDir: options.stateDir,
		zoneId: options.zoneId,
	});
	if (scopeMismatch !== null) {
		if (options.mode !== 'in-process-recovery') {
			throw new Error(scopeMismatch);
		}
		const cleanupWarning = `${scopeMismatch} Quarantining the stale runtime record without signaling its recorded process during in-process recovery.`;
		log(cleanupWarning);
		await (dependencies.quarantineGatewayRuntimeRecord ?? quarantineGatewayRuntimeRecord)(
			options.stateDir,
			{
				log,
				reason: cleanupWarning,
			},
		);
		return {
			cleanedUp: false,
			cleanupWarning,
			killedPid: null,
		};
	}
	log(
		`Found persisted gateway runtime for zone '${runtimeRecord.zoneId}' (pid ${runtimeRecord.qemuPid}, vm ${runtimeRecord.vmId}).`,
	);

	const killedPid = await killOrphanedGatewayProcess(runtimeRecord, {
		isProcessAlive: dependencies.isProcessAlive ?? isProcessAlive,
		killProcess: dependencies.killProcess ?? killProcess,
		readProcessCommand: dependencies.readProcessCommand ?? readProcessCommand,
		readProcessIdentity: dependencies.readProcessIdentity ?? readProcessIdentity,
		sleep: dependencies.sleep ?? sleep,
	});
	try {
		await (dependencies.deleteGatewayRuntimeRecord ?? deleteGatewayRuntimeRecord)(options.stateDir);
	} catch (error) {
		const cleanupWarning = `Failed to remove stale gateway runtime record for zone '${runtimeRecord.zoneId}' at '${options.stateDir}': ${error instanceof Error ? error.message : JSON.stringify(error)}`;
		log(cleanupWarning);
		return {
			cleanedUp: false,
			cleanupWarning,
			killedPid,
		};
	}
	log(
		killedPid === null
			? `Removed stale gateway runtime record for zone '${runtimeRecord.zoneId}' after confirming the orphaned process was already gone.`
			: `Removed stale gateway runtime record for zone '${runtimeRecord.zoneId}' after terminating orphaned gateway pid ${killedPid}.`,
	);

	return {
		cleanedUp: true,
		killedPid,
	};
}
