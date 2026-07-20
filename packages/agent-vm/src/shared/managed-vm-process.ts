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

export async function sleep(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

type RecordedProcessIdentityObservation =
	| { readonly kind: 'absent' }
	| { readonly currentIdentity: ProcessIdentity; readonly kind: 'exact' }
	| { readonly currentIdentity: ProcessIdentity; readonly kind: 'inconsistent-command' }
	| { readonly currentIdentity: ProcessIdentity; readonly kind: 'reused-pid' };

function classifyRecordedProcessIdentity(
	recordedIdentity: ProcessIdentity,
	currentIdentity: ProcessIdentity | null,
): RecordedProcessIdentityObservation {
	if (currentIdentity === null) {
		return { kind: 'absent' };
	}
	if (currentIdentity.lstart !== recordedIdentity.lstart) {
		return { currentIdentity, kind: 'reused-pid' };
	}
	if (currentIdentity.command !== recordedIdentity.command) {
		return { currentIdentity, kind: 'inconsistent-command' };
	}
	return { currentIdentity, kind: 'exact' };
}

function throwInconsistentRecordedProcessIdentity(options: {
	readonly contextLabel: string;
	readonly currentIdentity: ProcessIdentity;
	readonly pid: number;
	readonly recordedIdentity: ProcessIdentity;
	readonly refusalAction: string;
}): never {
	throw new Error(
		`${options.contextLabel} refusing ${options.refusalAction} pid ${options.pid}: same process start identity was observed but command changed (recorded ${JSON.stringify(options.recordedIdentity)}, current ${JSON.stringify(options.currentIdentity)}).`,
	);
}

// Re-verify the recorded process identity (lstart + command) immediately before
// sending a signal. A missing identity or different process start means the
// recorded predecessor is absent. A same-start command inconsistency throws
// and refuses the signal.
export async function verifyRecordedManagedVmHostProcess(options: {
	readonly contextLabel: string;
	readonly currentSignalLabel?: string;
	readonly pid: number;
	readonly readProcessCommand: (pid: number) => Promise<string | null>;
	readonly readProcessIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
	readonly recordedIdentity?: ProcessIdentity;
}): Promise<{ readonly proceed: true } | { readonly proceed: false }> {
	const refusalAction =
		options.currentSignalLabel === undefined ? 'cleanup of' : `${options.currentSignalLabel} to`;
	if (options.recordedIdentity !== undefined && options.readProcessIdentity !== undefined) {
		const currentIdentity = await options.readProcessIdentity(options.pid);
		const observation = classifyRecordedProcessIdentity(options.recordedIdentity, currentIdentity);
		if (observation.kind === 'absent' || observation.kind === 'reused-pid') {
			return { proceed: false };
		}
		if (observation.kind === 'inconsistent-command') {
			throwInconsistentRecordedProcessIdentity({
				contextLabel: options.contextLabel,
				currentIdentity: observation.currentIdentity,
				pid: options.pid,
				recordedIdentity: options.recordedIdentity,
				refusalAction,
			});
		}
		if (!isManagedVmProcess(observation.currentIdentity.command)) {
			throw new Error(
				`${options.contextLabel} refusing ${refusalAction} pid ${options.pid}: current command is not a managed VM process: ${observation.currentIdentity.command}.`,
			);
		}
		return { proceed: true };
	}
	throw new Error(
		`${options.contextLabel} refusing ${refusalAction} pid ${options.pid}: recorded process identity and a live identity reader are required before a destructive signal.`,
	);
}
