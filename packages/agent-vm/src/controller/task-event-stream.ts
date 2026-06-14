import { readFile } from 'node:fs/promises';

import type { TaskEvent, TimestampedEvent } from '@agent-vm/agent-vm-worker';

import type { SystemConfig } from '../config/system-config.js';
import { readTaskFailureSentinelPath, resolveTaskStatePaths } from './task-state-reader.js';

const defaultPollIntervalMs = 250;
const terminalTaskEventNames = new Set<TaskEvent['event']>([
	'task-completed',
	'task-failed',
	'task-closed',
]);

async function* emptyTaskEventStream(): AsyncGenerator<TaskEventStreamRecord> {}

export interface TaskEventStreamRecord {
	readonly event: TimestampedEvent;
	readonly id: number;
}

export interface ReadTaskEventLogRecordsResult {
	readonly exists: boolean;
	readonly hasIncompleteFinalLine: boolean;
	readonly records: readonly TaskEventStreamRecord[];
}

export interface CreateTaskEventStreamOptions {
	readonly afterLineIndex?: number;
	readonly eventLogPath: string;
	readonly failureSentinelPath?: string;
	readonly pollIntervalMs?: number;
	readonly signal?: AbortSignal;
	readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface CreateTaskEventStreamForTaskOptions extends Omit<
	CreateTaskEventStreamOptions,
	'eventLogPath' | 'failureSentinelPath'
> {
	readonly systemConfig: SystemConfig;
	readonly taskId: string;
	readonly zoneId: string;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { readonly code?: unknown }).code === code
	);
}

function isTimestampedEvent(value: unknown): value is TimestampedEvent {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as { readonly data?: unknown; readonly ts?: unknown };
	const timestamp = candidate.ts;
	const data = candidate.data;
	if (typeof timestamp !== 'string' || typeof data !== 'object' || data === null) {
		return false;
	}
	return typeof (data as { readonly event?: unknown }).event === 'string';
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted === true) {
			resolve();
			return;
		}
		const timeout = setTimeout(finish, milliseconds);
		function finish(): void {
			signal?.removeEventListener('abort', abort);
			resolve();
		}
		function abort(): void {
			clearTimeout(timeout);
			finish();
		}
		signal?.addEventListener('abort', abort, { once: true });
	});
}

function normalizeAfterLineIndex(afterLineIndex: number | undefined): number {
	return afterLineIndex ?? -1;
}

export function isTerminalTaskEventRecord(record: TaskEventStreamRecord): boolean {
	return terminalTaskEventNames.has(record.event.data.event);
}

export async function readTaskEventLogRecords(options: {
	readonly afterLineIndex?: number;
	readonly eventLogPath: string;
}): Promise<ReadTaskEventLogRecordsResult> {
	let fileContents: string;
	try {
		fileContents = await readFile(options.eventLogPath, 'utf8');
	} catch (error) {
		if (isNodeErrorWithCode(error, 'ENOENT')) {
			return { exists: false, hasIncompleteFinalLine: false, records: [] };
		}
		throw error;
	}

	const afterLineIndex = normalizeAfterLineIndex(options.afterLineIndex);
	const fileEndsWithNewline = fileContents.endsWith('\n');
	const candidateLines = fileContents
		.split('\n')
		.map((line, index) => ({ index, line }))
		.filter((entry) => entry.line.trim().length > 0 && entry.index > afterLineIndex);
	const records: TaskEventStreamRecord[] = [];
	for (let entryIndex = 0; entryIndex < candidateLines.length; entryIndex += 1) {
		const entry = candidateLines[entryIndex];
		if (!entry) continue;
		const isFinalCandidateLine = entryIndex === candidateLines.length - 1;
		try {
			const parsedJson: unknown = JSON.parse(entry.line);
			if (!isTimestampedEvent(parsedJson)) {
				throw new Error(`Invalid event structure at line ${String(entry.index + 1)}`);
			}
			records.push({ event: parsedJson, id: entry.index });
		} catch (error) {
			if (isFinalCandidateLine && !fileEndsWithNewline) {
				return { exists: true, hasIncompleteFinalLine: true, records };
			}
			throw new Error(
				`Corrupt event at line ${String(entry.index + 1)} in ${options.eventLogPath}: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}
	return { exists: true, hasIncompleteFinalLine: false, records };
}

async function readFailureSentinelRecord(options: {
	readonly failureSentinelPath: string | undefined;
	readonly id: number;
}): Promise<TaskEventStreamRecord | null> {
	if (!options.failureSentinelPath) {
		return null;
	}
	const sentinelState = await readTaskFailureSentinelPath(options.failureSentinelPath);
	if (!sentinelState) {
		return null;
	}
	return {
		id: options.id,
		event: {
			ts: sentinelState.updatedAt,
			data: {
				event: 'task-failed',
				reason: sentinelState.failureReason ?? 'Task failed before event log was available.',
			},
		},
	};
}

export async function* createTaskEventStream(
	options: CreateTaskEventStreamOptions,
): AsyncGenerator<TaskEventStreamRecord> {
	let afterLineIndex = normalizeAfterLineIndex(options.afterLineIndex);
	const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
	const sleep = options.sleep ?? defaultSleep;
	while (options.signal?.aborted !== true) {
		// oxlint-disable-next-line no-await-in-loop -- tailing requires sequential reads between sleeps.
		const readResult = await readTaskEventLogRecords({
			afterLineIndex,
			eventLogPath: options.eventLogPath,
		});
		for (const record of readResult.records) {
			afterLineIndex = record.id;
			yield record;
			if (isTerminalTaskEventRecord(record)) {
				return;
			}
		}
		if (readResult.records.length === 0 || !readResult.hasIncompleteFinalLine) {
			// oxlint-disable-next-line no-await-in-loop -- sentinel fallback is checked after each read.
			const sentinelRecord = await readFailureSentinelRecord({
				failureSentinelPath: options.failureSentinelPath,
				id: afterLineIndex + 1,
			});
			if (sentinelRecord) {
				yield sentinelRecord;
				return;
			}
		}
		// oxlint-disable-next-line no-await-in-loop -- polling delay is the tail loop boundary.
		await sleep(pollIntervalMs, options.signal);
	}
}

export function createTaskEventStreamForTask(
	options: CreateTaskEventStreamForTaskOptions,
): AsyncGenerator<TaskEventStreamRecord> {
	const paths = resolveTaskStatePaths({
		systemConfig: options.systemConfig,
		taskId: options.taskId,
		zoneId: options.zoneId,
	});
	if (!paths) {
		return emptyTaskEventStream();
	}
	return createTaskEventStream({
		...options,
		eventLogPath: paths.eventLogPath,
		failureSentinelPath: paths.failureSentinelPath,
	});
}
