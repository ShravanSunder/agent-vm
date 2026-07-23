import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { isAgentVmHealthEvent, type AgentVmHealthEvent } from '@agent-vm/gateway-lifecycle';

export interface AppendDurableHealthEventOptions {
	readonly controllerPid: number;
	readonly controllerPort: number;
	readonly event: AgentVmHealthEvent;
	readonly operationId?: string | undefined;
	readonly controllerRuntimeDir: string;
}

export interface DurableHealthEventRecord {
	readonly body: AgentVmHealthEvent;
	readonly controllerPid: number;
	readonly controllerPort: number;
	readonly eventKind: AgentVmHealthEvent['kind'];
	readonly observedAtMs: number;
	readonly operationId?: string | undefined;
	readonly zoneId: string;
}

export interface ReadDurableHealthEventsOptions {
	readonly controllerRuntimeDir: string;
}

export function controllerHealthEventLogPath(controllerRuntimeDir: string): string {
	return path.join(controllerRuntimeDir, 'controller-health', 'events.jsonl');
}

export async function appendDurableHealthEvent(
	options: AppendDurableHealthEventOptions,
): Promise<void> {
	const logPath = controllerHealthEventLogPath(options.controllerRuntimeDir);
	await mkdir(path.dirname(logPath), { recursive: true });
	const operationId = options.operationId ?? operationIdForHealthEvent(options.event);
	const record: DurableHealthEventRecord = {
		body: options.event,
		controllerPid: options.controllerPid,
		controllerPort: options.controllerPort,
		eventKind: options.event.kind,
		observedAtMs: options.event.observedAtMs,
		...(operationId === undefined ? {} : { operationId }),
		zoneId: options.event.zoneId,
	};
	await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function readDurableHealthEvents(
	options: ReadDurableHealthEventsOptions,
): Promise<readonly DurableHealthEventRecord[]> {
	const logPath = controllerHealthEventLogPath(options.controllerRuntimeDir);
	let logText: string;
	try {
		logText = await readFile(logPath, 'utf8');
	} catch (error) {
		if (isNodeFileSystemError(error) && error.code === 'ENOENT') {
			return [];
		}
		throw error;
	}
	return logText
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => parseDurableHealthEventRecord(line));
}

function parseDurableHealthEventRecord(line: string): DurableHealthEventRecord {
	const parsedRecord: unknown = JSON.parse(line);
	if (!isDurableHealthEventRecord(parsedRecord)) {
		throw new Error('Durable health event record does not match expected schema.');
	}
	return parsedRecord;
}

function isDurableHealthEventRecord(value: unknown): value is DurableHealthEventRecord {
	if (!isUnknownRecord(value)) {
		return false;
	}
	return (
		isAgentVmHealthEvent(value.body) &&
		typeof value.controllerPid === 'number' &&
		Number.isInteger(value.controllerPid) &&
		value.controllerPid > 0 &&
		typeof value.controllerPort === 'number' &&
		Number.isInteger(value.controllerPort) &&
		value.controllerPort > 0 &&
		value.eventKind === value.body.kind &&
		typeof value.observedAtMs === 'number' &&
		value.observedAtMs === value.body.observedAtMs &&
		(value.operationId === undefined || typeof value.operationId === 'string') &&
		value.zoneId === value.body.zoneId
	);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeFileSystemError(value: unknown): value is { readonly code: string } {
	return (
		typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
	);
}

function operationIdForHealthEvent(event: AgentVmHealthEvent): string | undefined {
	switch (event.kind) {
		case 'gateway-recovery':
		case 'gateway-recovery-suspended':
			return event.operationId;
		case 'controller-request':
		case 'caller-context-rejection':
		case 'gateway-control-session':
		case 'gateway-plugin-health':
		case 'gateway-service-health':
		case 'lease-heartbeat':
		case 'lease-renew':
		case 'agent-channel-provider-health':
		case 'tool-vm-ssh':
			return undefined;
	}
	return assertNeverHealthEvent(event);
}

function assertNeverHealthEvent(event: never): never {
	throw new Error(`Unhandled health event kind for operation join key: ${JSON.stringify(event)}`);
}
