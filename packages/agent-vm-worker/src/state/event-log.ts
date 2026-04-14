import fs from 'node:fs/promises';
import { dirname } from 'node:path';

import type { TaskEvent, TimestampedEvent } from './task-event-types.js';

function isTimestampedEvent(value: unknown): value is TimestampedEvent {
	if (typeof value !== 'object' || value === null) return false;
	if (!('ts' in value) || !('data' in value)) return false;
	if (typeof value.ts !== 'string') return false;
	if (typeof value.data !== 'object' || value.data === null) return false;
	return 'event' in value.data;
}

function writeStderr(message: string): void {
	process.stderr.write(`${message}\n`);
}

export async function appendEvent(filePath: string, event: TaskEvent): Promise<void> {
	try {
		await fs.mkdir(dirname(filePath), { recursive: true });
		const timestampedEvent: TimestampedEvent = {
			ts: new Date().toISOString(),
			data: event,
		};
		await fs.appendFile(filePath, `${JSON.stringify(timestampedEvent)}\n`, 'utf-8');
	} catch (error) {
		throw new Error(
			`Failed to append event to ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

export async function replayEvents(filePath: string): Promise<readonly TimestampedEvent[]> {
	let fileContents: string;
	try {
		fileContents = await fs.readFile(filePath, 'utf-8');
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return [];
		}
		throw error;
	}

	const lines = fileContents.split('\n').filter((line) => line.trim() !== '');
	if (lines.length === 0) {
		return [];
	}

	const events: TimestampedEvent[] = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		if (!line) continue;

		const isLastLine = lineIndex === lines.length - 1;
		try {
			const parsedJson: unknown = JSON.parse(line);
			if (!isTimestampedEvent(parsedJson)) {
				throw new Error(`Invalid event structure at line ${lineIndex + 1}`);
			}
			events.push(parsedJson);
		} catch (error) {
			if (isLastLine) {
				writeStderr(`Skipping incomplete final line in ${filePath}: ${line.slice(0, 50)}...`);
			} else {
				throw new Error(
					`Corrupt event at line ${lineIndex + 1} in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
		}
	}

	return events;
}
