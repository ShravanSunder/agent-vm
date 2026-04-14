import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { TaskEvent, TimestampedEvent } from './task-event-types.js';

function isTimestampedEvent(value: unknown): value is TimestampedEvent {
	if (typeof value !== 'object' || value === null) return false;
	if (!('ts' in value) || !('data' in value)) return false;
	if (typeof value.ts !== 'string') return false;
	if (typeof value.data !== 'object' || value.data === null) return false;
	return 'event' in value.data;
}

export function appendEvent(filePath: string, event: TaskEvent): void {
	try {
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const timestampedEvent: TimestampedEvent = {
			ts: new Date().toISOString(),
			data: event,
		};

		appendFileSync(filePath, JSON.stringify(timestampedEvent) + '\n', 'utf-8');
	} catch (error) {
		throw new Error(
			`Failed to append event to ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

export function replayEvents(filePath: string): readonly TimestampedEvent[] {
	if (!existsSync(filePath)) {
		return [];
	}

	const fileContents = readFileSync(filePath, 'utf-8');
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
			const parsed: unknown = JSON.parse(line);
			if (!isTimestampedEvent(parsed)) {
				throw new Error(`Invalid event structure at line ${lineIndex + 1}`);
			}
			events.push(parsed);
		} catch (error) {
			if (isLastLine) {
				console.warn(`Skipping incomplete final line in ${filePath}: ${line.slice(0, 50)}...`);
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
