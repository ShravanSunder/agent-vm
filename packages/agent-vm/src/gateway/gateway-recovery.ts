import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { GatewayRuntimeRecord } from './gateway-runtime-record.js';
import { deleteGatewayRuntimeRecord, loadGatewayRuntimeRecord } from './gateway-runtime-record.js';

const execFileAsync = promisify(execFile);

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function readProcessCommand(pid: number): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
		const command = stdout.trim();
		return command.length > 0 ? command : null;
	} catch {
		return null;
	}
}

function isManagedGatewayProcess(command: string): boolean {
	return /\b(qemu-system|krun)\b/u.test(command);
}

function killProcess(pid: number, signal: NodeJS.Signals): void {
	process.kill(pid, signal);
}

async function sleep(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForExit(
	pid: number,
	processIsAlive: (pid: number) => boolean,
	sleepImpl: (delayMs: number) => Promise<void>,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processIsAlive(pid)) {
			return true;
		}
		await sleepImpl(100);
	}
	return !processIsAlive(pid);
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

	dependencies.killProcess(runtimeRecord.qemuPid, 'SIGTERM');
	if (
		await waitForExit(runtimeRecord.qemuPid, dependencies.isProcessAlive, dependencies.sleep, 2_000)
	) {
		return runtimeRecord.qemuPid;
	}

	dependencies.killProcess(runtimeRecord.qemuPid, 'SIGKILL');
	if (
		await waitForExit(runtimeRecord.qemuPid, dependencies.isProcessAlive, dependencies.sleep, 2_000)
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
	const runtimeRecord = await (dependencies.loadGatewayRuntimeRecord ?? loadGatewayRuntimeRecord)(
		options.stateDir,
	);
	if (!runtimeRecord) {
		return { cleanedUp: false, killedPid: null };
	}

	const killedPid = await killOrphanedGatewayProcess(runtimeRecord, {
		isProcessAlive: dependencies.isProcessAlive ?? isProcessAlive,
		killProcess: dependencies.killProcess ?? killProcess,
		readProcessCommand: dependencies.readProcessCommand ?? readProcessCommand,
		sleep: dependencies.sleep ?? sleep,
	});
	await (dependencies.deleteGatewayRuntimeRecord ?? deleteGatewayRuntimeRecord)(options.stateDir);

	return {
		cleanedUp: true,
		killedPid,
	};
}
