import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function isProcessAlive(pid: number): boolean {
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

export async function readProcessCommand(pid: number): Promise<string | null> {
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

// Strong identity captured at VM creation time and stored in the runtime
// record. On recovery we re-read the current identity for the same PID and
// require an EXACT match before signaling — this defends against PID reuse
// during the window between record-load and kill. ps `lstart` is a fixed
// human-readable timestamp (e.g. "Fri May 22 10:00:00 2026") that is unique
// per process invocation; combined with the full `command` it would require
// a same-second PID reuse of a similarly-named QEMU/krun command to collide.
export interface ProcessIdentity {
	readonly lstart: string;
	readonly command: string;
}

export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
	try {
		// `lstart` and `command` are separated by whitespace by default. Use a
		// custom delimiter via two separate columns so we can split safely.
		// macOS + Linux both support `-o lstart=,command=`.
		const { stdout } = await execFileAsync('ps', [
			'-p',
			String(pid),
			'-o',
			'lstart=',
			'-o',
			'command=',
		]);
		const trimmed = stdout.trim();
		if (trimmed.length === 0) {
			return null;
		}
		return parseProcessIdentityOutput(trimmed);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
			return null;
		}
		throw error;
	}
}

export function parseProcessIdentityOutput(line: string): ProcessIdentity | null {
	const splitIndex = findLstartCommandBoundary(line.trim());
	if (splitIndex === null) {
		return null;
	}
	const lstart = line.slice(0, splitIndex).trim();
	const command = line.slice(splitIndex).trim();
	if (lstart.length === 0 || command.length === 0) {
		return null;
	}
	return { command, lstart };
}

function findLstartCommandBoundary(line: string): number | null {
	// `lstart` is "Day Mon DD HH:MM:SS YYYY" — exactly five
	// whitespace-separated tokens. Find the end of the fifth token; everything
	// after is `command`.
	let tokenCount = 0;
	let inToken = false;
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index];
		const isSpace = character === ' ' || character === '\t';
		if (!isSpace && !inToken) {
			inToken = true;
		} else if (isSpace && inToken) {
			inToken = false;
			tokenCount += 1;
			if (tokenCount === 5) {
				return index;
			}
		}
	}
	return null;
}

// Gateway VMs and Tool VMs are both backed by the same Gondolin runtime
// (qemu-system on the QEMU backend or krun on the libkrun backend). Cleanup
// flows MUST verify the recorded host PID still maps to one of these process
// commands before signaling, so a recycled PID belonging to an unrelated
// program is never killed by mistake.
export function isManagedVmProcess(command: string): boolean {
	return /\b(qemu-system|krun)\b/u.test(command);
}

export function processIdentityMatches(
	recorded: ProcessIdentity,
	current: ProcessIdentity,
): boolean {
	return recorded.lstart === current.lstart && recorded.command === current.command;
}

export function killProcess(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') {
			return;
		}
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM') {
			throw new Error(
				`Permission denied while sending ${signal} to managed VM pid ${pid}. The process is still running and may require elevated privileges to terminate.`,
				{ cause: error },
			);
		}
		throw error;
	}
}

export function isNoSuchProcessError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

export async function sleep(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function waitForExit(options: {
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

export interface ManagedVmKillDependencies {
	readonly isProcessAlive: (pid: number) => boolean;
	readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
	readonly readProcessCommand: (pid: number) => Promise<string | null>;
	readonly readProcessIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
	readonly sleep: (delayMs: number) => Promise<void>;
}

// Re-verify the recorded process identity (lstart + command) immediately before
// sending a signal. Returns `null` if the process is gone (signal not needed),
// otherwise either resolves to the matching identity or throws to refuse the
// signal because PID was reused by an unrelated process.
async function verifyIdentityBeforeSignal(options: {
	readonly contextLabel: string;
	readonly currentSignalLabel: string;
	readonly pid: number;
	readonly readProcessCommand: (pid: number) => Promise<string | null>;
	readonly readProcessIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
	readonly recordedIdentity?: ProcessIdentity;
}): Promise<{ readonly proceed: true } | { readonly proceed: false }> {
	if (options.recordedIdentity !== undefined && options.readProcessIdentity !== undefined) {
		const currentIdentity = await options.readProcessIdentity(options.pid);
		if (currentIdentity === null) {
			return { proceed: false };
		}
		if (!processIdentityMatches(options.recordedIdentity, currentIdentity)) {
			throw new Error(
				`${options.contextLabel} refusing ${options.currentSignalLabel} to pid ${options.pid}: process identity changed (recorded ${JSON.stringify(options.recordedIdentity)}, current ${JSON.stringify(currentIdentity)}). PID was likely reused.`,
			);
		}
		if (!isManagedVmProcess(currentIdentity.command)) {
			throw new Error(
				`${options.contextLabel} refusing ${options.currentSignalLabel} to pid ${options.pid}: current command is not a managed VM process: ${currentIdentity.command}.`,
			);
		}
		return { proceed: true };
	}
	// No recorded identity (legacy record) → fall back to the looser command-
	// only check at the SIGTERM point. Subsequent signals trust the first
	// check. This is the pre-identity behavior.
	const command = await options.readProcessCommand(options.pid);
	if (command === null) {
		return { proceed: false };
	}
	if (!isManagedVmProcess(command)) {
		throw new Error(
			`${options.contextLabel} points at unexpected live process ${options.pid}: ${command}.`,
		);
	}
	return { proceed: true };
}

// Generic "kill an orphaned managed VM process" with a SIGTERM→2s→SIGKILL→2s
// bounded sequence (total ≤ 4 s). The caller is responsible for owning the
// runtime record (read + fence-check + delete after this returns).
//
// Strong PID identity defense: if `recordedIdentity` is supplied, the live
// process identity (ps `lstart` + `command`) is re-read IMMEDIATELY before
// each signal and must match exactly. This makes PID reuse during the
// read-record → signal window detectable; we refuse rather than killing the
// wrong process.
//
// Returns the PID that was signalled, or null if it was already dead before
// the first signal landed.
//
// Throws if:
//   - the recorded PID is alive but its identity does not match (PID reused)
//   - the recorded PID is alive but its command is NOT a managed VM process
//   - the process survives both SIGTERM and SIGKILL (a stuck D-state QEMU)
export async function killOrphanedManagedVmProcess(options: {
	readonly contextLabel: string; // for error messages, e.g. "gateway runtime record for zone 'X'"
	readonly dependencies: ManagedVmKillDependencies;
	readonly pid: number;
	readonly recordedIdentity?: ProcessIdentity;
}): Promise<number | null> {
	const { contextLabel, dependencies, pid, recordedIdentity } = options;
	if (!dependencies.isProcessAlive(pid)) {
		return null;
	}

	const beforeTerm = await verifyIdentityBeforeSignal({
		contextLabel,
		currentSignalLabel: 'SIGTERM',
		pid,
		readProcessCommand: dependencies.readProcessCommand,
		...(dependencies.readProcessIdentity !== undefined
			? { readProcessIdentity: dependencies.readProcessIdentity }
			: {}),
		...(recordedIdentity !== undefined ? { recordedIdentity } : {}),
	});
	if (!beforeTerm.proceed) {
		return null;
	}

	try {
		dependencies.killProcess(pid, 'SIGTERM');
	} catch (error) {
		if (!isNoSuchProcessError(error)) {
			throw error;
		}
	}
	if (
		await waitForExit({
			pid,
			processIsAlive: dependencies.isProcessAlive,
			sleep: dependencies.sleep,
			timeoutMs: 2_000,
		})
	) {
		return pid;
	}

	const beforeKill = await verifyIdentityBeforeSignal({
		contextLabel,
		currentSignalLabel: 'SIGKILL',
		pid,
		readProcessCommand: dependencies.readProcessCommand,
		...(dependencies.readProcessIdentity !== undefined
			? { readProcessIdentity: dependencies.readProcessIdentity }
			: {}),
		...(recordedIdentity !== undefined ? { recordedIdentity } : {}),
	});
	if (!beforeKill.proceed) {
		return pid;
	}

	try {
		dependencies.killProcess(pid, 'SIGKILL');
	} catch (error) {
		if (!isNoSuchProcessError(error)) {
			throw error;
		}
	}
	if (
		await waitForExit({
			pid,
			processIsAlive: dependencies.isProcessAlive,
			sleep: dependencies.sleep,
			timeoutMs: 2_000,
		})
	) {
		return pid;
	}

	throw new Error(`Failed to terminate orphaned managed VM process ${pid} (${contextLabel}).`);
}
