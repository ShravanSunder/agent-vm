import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { GatewayRuntimeRecord } from './gateway-runtime-record.js';
import { deleteGatewayRuntimeRecord, loadGatewayRuntimeRecord } from './gateway-runtime-record.js';

const execFileAsync = promisify(execFile);

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error) {
			if (error.code === 'EPERM') {
				return true;
			}
			if (error.code === 'ESRCH') {
				return false;
			}
		}
		throw error;
	}
}

async function readProcessCommand(pid: number): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
		const command = stdout.trim();
		return command.length > 0 ? command : null;
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
			return null;
		}
		throw error;
	}
}

function isManagedGatewayProcess(command: string): boolean {
	return /\b(qemu-system|krun)\b/u.test(command);
}

function writeRecoveryLog(message: string): void {
	process.stderr.write(`[agent-vm] ${message}\n`);
}

function killProcess(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') {
			return;
		}
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM') {
			throw new Error(
				`Permission denied while sending ${signal} to orphaned gateway pid ${pid}. The process is still running and may require elevated privileges to terminate.`,
				{ cause: error },
			);
		}
		throw error;
	}
}

function isNoSuchProcessError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

async function sleep(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForExit(options: {
	readonly pid: number;
	readonly processIsAlive: (pid: number) => boolean;
	readonly sleep: (delayMs: number) => Promise<void>;
	readonly timeoutMs: number;
}): Promise<boolean> {
	const deadline = Date.now() + options.timeoutMs;
	while (Date.now() < deadline) {
		if (!options.processIsAlive(options.pid)) {
			return true;
		}
		// oxlint-disable-next-line no-await-in-loop -- polling loop must wait between liveness checks
		await options.sleep(100);
	}
	return !options.processIsAlive(options.pid);
}

async function killOrphanedGatewayProcess(
	runtimeRecord: GatewayRuntimeRecord,
	dependencies: Required<
		Pick<
			GatewayRecoveryDependencies,
			'isProcessAlive' | 'killProcess' | 'readProcessCommand' | 'sleep'
		>
	>,
): Promise<number | null> {
	if (!dependencies.isProcessAlive(runtimeRecord.qemuPid)) {
		return null;
	}

	const processCommand = await dependencies.readProcessCommand(runtimeRecord.qemuPid);
	if (!processCommand || !isManagedGatewayProcess(processCommand)) {
		throw new Error(
			`Gateway runtime record for zone '${runtimeRecord.zoneId}' points at unexpected live process ${runtimeRecord.qemuPid}: ${processCommand ?? '(command unavailable)'}.`,
		);
	}

	try {
		dependencies.killProcess(runtimeRecord.qemuPid, 'SIGTERM');
	} catch (error) {
		if (!isNoSuchProcessError(error)) {
			throw error;
		}
	}
	if (
		await waitForExit({
			pid: runtimeRecord.qemuPid,
			processIsAlive: dependencies.isProcessAlive,
			sleep: dependencies.sleep,
			timeoutMs: 2_000,
		})
	) {
		return runtimeRecord.qemuPid;
	}

	try {
		dependencies.killProcess(runtimeRecord.qemuPid, 'SIGKILL');
	} catch (error) {
		if (!isNoSuchProcessError(error)) {
			throw error;
		}
	}
	if (
		await waitForExit({
			pid: runtimeRecord.qemuPid,
			processIsAlive: dependencies.isProcessAlive,
			sleep: dependencies.sleep,
			timeoutMs: 2_000,
		})
	) {
		return runtimeRecord.qemuPid;
	}

	throw new Error(
		`Failed to terminate orphaned gateway VM process ${runtimeRecord.qemuPid} for zone '${runtimeRecord.zoneId}'.`,
	);
}

export interface GatewayRecoveryDependencies {
	readonly deleteGatewayRuntimeRecord?: typeof deleteGatewayRuntimeRecord;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
	readonly loadGatewayRuntimeRecord?: typeof loadGatewayRuntimeRecord;
	readonly log?: (message: string) => void;
	readonly readProcessCommand?: (pid: number) => Promise<string | null>;
	readonly sleep?: (delayMs: number) => Promise<void>;
}

export async function cleanupOrphanedGatewayIfPresent(
	options: {
		readonly stateDir: string;
		readonly zoneId: string;
	},
	dependencies: GatewayRecoveryDependencies = {},
): Promise<{
	readonly cleanedUp: boolean;
	readonly killedPid: number | null;
}> {
	const log = dependencies.log ?? writeRecoveryLog;
	const runtimeRecord = await (dependencies.loadGatewayRuntimeRecord ?? loadGatewayRuntimeRecord)(
		options.stateDir,
		{ log },
	);
	if (!runtimeRecord) {
		return { cleanedUp: false, killedPid: null };
	}
	log(
		`Found persisted gateway runtime for zone '${runtimeRecord.zoneId}' (pid ${runtimeRecord.qemuPid}, vm ${runtimeRecord.vmId}).`,
	);

	const killedPid = await killOrphanedGatewayProcess(runtimeRecord, {
		isProcessAlive: dependencies.isProcessAlive ?? isProcessAlive,
		killProcess: dependencies.killProcess ?? killProcess,
		readProcessCommand: dependencies.readProcessCommand ?? readProcessCommand,
		sleep: dependencies.sleep ?? sleep,
	});
	try {
		await (dependencies.deleteGatewayRuntimeRecord ?? deleteGatewayRuntimeRecord)(options.stateDir);
	} catch (error) {
		log(
			`Failed to remove stale gateway runtime record for zone '${runtimeRecord.zoneId}' at '${options.stateDir}': ${error instanceof Error ? error.message : JSON.stringify(error)}`,
		);
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
