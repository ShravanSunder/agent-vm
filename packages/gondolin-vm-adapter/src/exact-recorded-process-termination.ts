import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

import type {
	ManagedVmExactProcessTerminationCapability,
	ManagedVmExactProcessTerminationOutcome,
	ManagedVmHostProcessIdentity,
} from '@agent-vm/managed-vm';

const execFileAsync = promisify(execFile);
const terminationStageTimeoutMs = 2_000;
const processIdentityPollIntervalMs = 100;
const darwinProcessCommandNameLimit = 16;

export interface GondolinHostProcessIdentity {
	readonly command: string;
	readonly processState: string;
	readonly processStartIdentity: string;
}

export interface GondolinProcessTerminationDependencies {
	readonly now: () => number;
	readonly readProcessIdentity: (
		hostProcessId: number,
	) => Promise<GondolinHostProcessIdentity | null>;
	readonly sendSignal: (hostProcessId: number, signal: NodeJS.Signals) => void;
	readonly sleep: (delayMs: number) => Promise<void>;
}

type RecordedProcessObservation = 'absent' | 'exact';
type RecordedProcessObservationMode = 'after-signal' | 'before-signal';

function processErrorCode(error: unknown): unknown {
	return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function isManagedVmHostCommand(command: string): boolean {
	return /\b(qemu-system|krun)\b/u.test(command);
}

function isMatchingDarwinFallbackCommand(options: {
	readonly currentCommand: string;
	readonly recordedCommand: string;
}): boolean {
	const fallbackCommandMatch = /^\(([^()]+)\)$/u.exec(options.currentCommand);
	if (fallbackCommandMatch === null) {
		return false;
	}
	const recordedExecutable = options.recordedCommand.split(/[ \t]/u, 1)[0];
	if (recordedExecutable === undefined || recordedExecutable.length === 0) {
		return false;
	}
	return (
		fallbackCommandMatch[1] === basename(recordedExecutable).slice(0, darwinProcessCommandNameLimit)
	);
}

function findProcessCommandBoundary(processDescription: string): number | null {
	let tokenCount = 0;
	let insideToken = false;
	for (let index = 0; index < processDescription.length; index += 1) {
		const character = processDescription[index];
		const isWhitespace = character === ' ' || character === '\t';
		if (!isWhitespace && !insideToken) {
			insideToken = true;
		} else if (isWhitespace && insideToken) {
			insideToken = false;
			tokenCount += 1;
			if (tokenCount === 5) {
				return index;
			}
		}
	}
	return null;
}

function parseProcessIdentityOutput(
	hostProcessId: number,
	processDescription: string,
): GondolinHostProcessIdentity {
	const trimmedDescription = processDescription.trim();
	const processStateBoundary = trimmedDescription.search(/[ \t]/u);
	if (processStateBoundary === -1) {
		throw new Error(
			`Unable to confirm host process identity for pid ${String(hostProcessId)} because ps returned malformed identity output.`,
		);
	}
	const processState = trimmedDescription.slice(0, processStateBoundary).trim();
	const startAndCommandDescription = trimmedDescription.slice(processStateBoundary).trim();
	const commandBoundary = findProcessCommandBoundary(startAndCommandDescription);
	if (commandBoundary === null) {
		throw new Error(
			`Unable to confirm host process identity for pid ${String(hostProcessId)} because ps returned malformed identity output.`,
		);
	}
	const processStartIdentity = startAndCommandDescription.slice(0, commandBoundary).trim();
	const command = startAndCommandDescription.slice(commandBoundary).trim();
	if (processState.length === 0 || processStartIdentity.length === 0 || command.length === 0) {
		throw new Error(
			`Unable to confirm host process identity for pid ${String(hostProcessId)} because ps omitted the process state, start, or command.`,
		);
	}
	return { command, processStartIdentity, processState };
}

async function readGondolinHostProcessIdentity(
	hostProcessId: number,
): Promise<GondolinHostProcessIdentity | null> {
	try {
		const { stdout } = await execFileAsync('ps', [
			'-p',
			String(hostProcessId),
			'-o',
			'state=',
			'-o',
			'lstart=',
			'-o',
			'command=',
		]);
		if (stdout.trim().length === 0) {
			throw new Error(
				`Unable to confirm host process identity for pid ${String(hostProcessId)} because ps returned empty output.`,
			);
		}
		return parseProcessIdentityOutput(hostProcessId, stdout);
	} catch (error) {
		if (processErrorCode(error) === 1) {
			return null;
		}
		throw error;
	}
}

function sendHostProcessSignal(hostProcessId: number, signal: NodeJS.Signals): void {
	process.kill(hostProcessId, signal);
}

async function sleep(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

const defaultDependencies = {
	now: Date.now,
	readProcessIdentity: readGondolinHostProcessIdentity,
	sendSignal: sendHostProcessSignal,
	sleep,
} satisfies GondolinProcessTerminationDependencies;

function assertTerminationRequest(request: {
	readonly contextLabel: string;
	readonly identity: ManagedVmHostProcessIdentity;
}): void {
	if (request.contextLabel.trim().length === 0) {
		throw new Error('Exact managed VM process termination requires a non-empty context label.');
	}
	if (
		!Number.isSafeInteger(request.identity.hostProcessId) ||
		request.identity.hostProcessId <= 0
	) {
		throw new Error('Exact managed VM process termination requires a positive safe host pid.');
	}
	if (
		request.identity.vmId.length === 0 ||
		request.identity.processStartIdentity.length === 0 ||
		request.identity.command.length === 0
	) {
		throw new Error('Exact managed VM process termination requires complete recorded identity.');
	}
}

async function observeRecordedProcess(options: {
	readonly action: string;
	readonly contextLabel: string;
	readonly dependencies: GondolinProcessTerminationDependencies;
	readonly identity: ManagedVmHostProcessIdentity;
	readonly mode: RecordedProcessObservationMode;
}): Promise<RecordedProcessObservation> {
	const currentIdentity = await options.dependencies.readProcessIdentity(
		options.identity.hostProcessId,
	);
	if (currentIdentity === null) {
		return 'absent';
	}
	if (currentIdentity.processStartIdentity !== options.identity.processStartIdentity) {
		return 'absent';
	}
	if (currentIdentity.processState.startsWith('Z')) {
		return 'absent';
	}
	if (options.mode === 'after-signal' && currentIdentity.processState.includes('E')) {
		return 'exact';
	}
	if (
		options.mode === 'after-signal' &&
		(currentIdentity.processState.startsWith('U') ||
			currentIdentity.processState.startsWith('R')) &&
		isMatchingDarwinFallbackCommand({
			currentCommand: currentIdentity.command,
			recordedCommand: options.identity.command,
		})
	) {
		return 'exact';
	}
	if (currentIdentity.command !== options.identity.command) {
		throw new Error(
			`${options.contextLabel} refusing ${options.action} pid ${String(options.identity.hostProcessId)}: same process start identity was observed with state ${JSON.stringify(currentIdentity.processState)} but command changed (recorded ${JSON.stringify(options.identity.command)}, current ${JSON.stringify(currentIdentity.command)}).`,
		);
	}
	if (!isManagedVmHostCommand(currentIdentity.command)) {
		throw new Error(
			`${options.contextLabel} refusing ${options.action} pid ${String(options.identity.hostProcessId)} because the exact command is not a managed VM process.`,
		);
	}
	return 'exact';
}

async function waitForRecordedProcessAbsence(options: {
	readonly afterSignal: NodeJS.Signals;
	readonly contextLabel: string;
	readonly dependencies: GondolinProcessTerminationDependencies;
	readonly identity: ManagedVmHostProcessIdentity;
}): Promise<boolean> {
	const deadline = options.dependencies.now() + terminationStageTimeoutMs;
	while (options.dependencies.now() < deadline) {
		// oxlint-disable-next-line no-await-in-loop -- exact identity observations must remain ordered
		const observation = await observeRecordedProcess({
			action: `continued containment after ${options.afterSignal} for`,
			contextLabel: options.contextLabel,
			dependencies: options.dependencies,
			identity: options.identity,
			mode: 'after-signal',
		});
		if (observation === 'absent') {
			return true;
		}
		// oxlint-disable-next-line no-await-in-loop -- bounded process identity polling is sequential
		await options.dependencies.sleep(processIdentityPollIntervalMs);
	}
	return (
		(await observeRecordedProcess({
			action: `continued containment after ${options.afterSignal} for`,
			contextLabel: options.contextLabel,
			dependencies: options.dependencies,
			identity: options.identity,
			mode: 'after-signal',
		})) === 'absent'
	);
}

function signalRecordedProcess(options: {
	readonly dependencies: GondolinProcessTerminationDependencies;
	readonly hostProcessId: number;
	readonly signal: NodeJS.Signals;
}): void {
	try {
		options.dependencies.sendSignal(options.hostProcessId, options.signal);
	} catch (error) {
		if (processErrorCode(error) !== 'ESRCH') {
			throw error;
		}
	}
}

export async function terminateExactRecordedManagedVmHostProcess(options: {
	readonly contextLabel: string;
	readonly dependencies: GondolinProcessTerminationDependencies;
	readonly identity: ManagedVmHostProcessIdentity;
}): Promise<ManagedVmExactProcessTerminationOutcome> {
	assertTerminationRequest(options);
	const initialObservation = await observeRecordedProcess({
		action: 'SIGTERM to',
		contextLabel: options.contextLabel,
		dependencies: options.dependencies,
		identity: options.identity,
		mode: 'before-signal',
	});
	if (initialObservation === 'absent') {
		return { hostProcessId: options.identity.hostProcessId, kind: 'already-absent' };
	}

	signalRecordedProcess({
		dependencies: options.dependencies,
		hostProcessId: options.identity.hostProcessId,
		signal: 'SIGTERM',
	});
	if (
		await waitForRecordedProcessAbsence({
			afterSignal: 'SIGTERM',
			contextLabel: options.contextLabel,
			dependencies: options.dependencies,
			identity: options.identity,
		})
	) {
		return { hostProcessId: options.identity.hostProcessId, kind: 'terminated' };
	}

	const beforeKillObservation = await observeRecordedProcess({
		action: 'SIGKILL to',
		contextLabel: options.contextLabel,
		dependencies: options.dependencies,
		identity: options.identity,
		mode: 'after-signal',
	});
	if (beforeKillObservation === 'absent') {
		return { hostProcessId: options.identity.hostProcessId, kind: 'terminated' };
	}
	signalRecordedProcess({
		dependencies: options.dependencies,
		hostProcessId: options.identity.hostProcessId,
		signal: 'SIGKILL',
	});
	if (
		await waitForRecordedProcessAbsence({
			afterSignal: 'SIGKILL',
			contextLabel: options.contextLabel,
			dependencies: options.dependencies,
			identity: options.identity,
		})
	) {
		return { hostProcessId: options.identity.hostProcessId, kind: 'terminated' };
	}

	throw new Error(
		`Failed to terminate exact recorded managed VM process ${String(options.identity.hostProcessId)} (${options.contextLabel}).`,
	);
}

export function createGondolinExactProcessTerminationCapability(
	dependencies: GondolinProcessTerminationDependencies = defaultDependencies,
): ManagedVmExactProcessTerminationCapability {
	return {
		async terminateRecordedHostProcess(request): Promise<ManagedVmExactProcessTerminationOutcome> {
			return await terminateExactRecordedManagedVmHostProcess({
				contextLabel: request.contextLabel,
				dependencies,
				identity: request.identity,
			});
		},
	};
}
