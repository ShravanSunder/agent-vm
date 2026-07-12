import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { GatewayType } from '@agent-vm/gateway-lifecycle';

import type { GatewayLifecycleErrorCode } from './gateway-zone-state-machine.js';

export const gatewayLifecycleOperationRecordKinds = [
	'start-requested',
	'restart-requested',
	'cold-start-requested',
	'credentials-refresh-requested',
	'stop-requested',
	'vm-close-started',
	'vm-close-finished',
	'runtime-record-written',
	'runtime-record-deleted',
	'operation-failed',
	'operation-finished',
] as const;

export type GatewayLifecycleOperationRecordKind =
	(typeof gatewayLifecycleOperationRecordKinds)[number];

export const gatewayLifecycleOperationTriggers = [
	'controller-start',
	'operator-start',
	'operator-stop',
	'operator-restart',
	'credentials-refresh',
	'auto-recovery',
	'upgrade',
] as const;

export type GatewayLifecycleOperationTrigger = (typeof gatewayLifecycleOperationTriggers)[number];

export interface GatewayLifecycleGatewayIdentity {
	readonly bootedAt?: string | undefined;
	readonly hostPid?: number | undefined;
	readonly vmId: string;
}

export interface GatewayLifecycleOperationRecord {
	readonly controllerPid: number;
	readonly controllerStartedAt?: string | undefined;
	readonly currentGateway?: GatewayLifecycleGatewayIdentity | undefined;
	readonly errorCode?: GatewayLifecycleErrorCode | undefined;
	readonly errorMessage?: string | undefined;
	readonly gatewayType: GatewayType;
	readonly kind: GatewayLifecycleOperationRecordKind;
	readonly observedAtMs: number;
	readonly operationId: string;
	readonly operationTrigger: GatewayLifecycleOperationTrigger;
	readonly previousGateway?: GatewayLifecycleGatewayIdentity | undefined;
	readonly zoneId: string;
}

export interface GatewayLifecycleOperationLogLocator {
	readonly runtimeDir: string;
	readonly zoneId: string;
}

export interface AppendGatewayLifecycleOperationRecordOptions extends GatewayLifecycleOperationLogLocator {
	readonly record: GatewayLifecycleOperationRecord;
}

export function resolveGatewayLifecycleOperationLogPath(
	options: GatewayLifecycleOperationLogLocator,
): string {
	return path.join(
		options.runtimeDir,
		'zones',
		options.zoneId,
		'gateway-lifecycle',
		'events.jsonl',
	);
}

export async function appendGatewayLifecycleOperationRecord(
	options: AppendGatewayLifecycleOperationRecordOptions,
): Promise<void> {
	const logPath = resolveGatewayLifecycleOperationLogPath(options);
	await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
	await appendFile(logPath, `${JSON.stringify(options.record)}\n`, 'utf8');
}

export async function readGatewayLifecycleOperationRecords(
	options: GatewayLifecycleOperationLogLocator,
): Promise<readonly GatewayLifecycleOperationRecord[]> {
	const logPath = resolveGatewayLifecycleOperationLogPath(options);
	const contents = await readOptionalUtf8File(logPath);
	if (contents === null) {
		return [];
	}
	const lines = contents.split('\n').filter((line) => line.trim().length > 0);
	const records: GatewayLifecycleOperationRecord[] = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		if (line === undefined) {
			continue;
		}
		const isLatestLine = lineIndex === lines.length - 1;
		try {
			const parsedRecord: unknown = JSON.parse(line);
			if (!isGatewayLifecycleOperationRecord(parsedRecord)) {
				throw new Error('record does not match gateway lifecycle operation schema');
			}
			records.push(parsedRecord);
		} catch (error) {
			if (isLatestLine) {
				continue;
			}
			throw new Error(
				`Corrupt gateway lifecycle operation record at line ${String(lineIndex + 1)} in ${logPath}: ${getErrorMessage(error)}`,
				{ cause: error },
			);
		}
	}
	return records;
}

export async function readLatestGatewayLifecycleOperationRecord(
	options: GatewayLifecycleOperationLogLocator,
): Promise<GatewayLifecycleOperationRecord | null> {
	const records = await readGatewayLifecycleOperationRecords(options);
	return records.at(-1) ?? null;
}

function isGatewayLifecycleOperationRecord(
	value: unknown,
): value is GatewayLifecycleOperationRecord {
	if (!isRecord(value)) {
		return false;
	}
	return (
		typeof value.controllerPid === 'number' &&
		Number.isInteger(value.controllerPid) &&
		value.controllerPid > 0 &&
		optionalString(value.controllerStartedAt) &&
		optionalGatewayIdentity(value.currentGateway) &&
		optionalString(value.errorCode) &&
		optionalString(value.errorMessage) &&
		isGatewayType(value.gatewayType) &&
		isOneOf(gatewayLifecycleOperationRecordKinds, value.kind) &&
		typeof value.observedAtMs === 'number' &&
		Number.isFinite(value.observedAtMs) &&
		typeof value.operationId === 'string' &&
		value.operationId.length > 0 &&
		isOneOf(gatewayLifecycleOperationTriggers, value.operationTrigger) &&
		optionalGatewayIdentity(value.previousGateway) &&
		typeof value.zoneId === 'string' &&
		value.zoneId.length > 0
	);
}

function optionalGatewayIdentity(value: unknown): boolean {
	if (value === undefined) {
		return true;
	}
	if (!isRecord(value)) {
		return false;
	}
	return (
		optionalString(value.bootedAt) &&
		(value.hostPid === undefined ||
			(typeof value.hostPid === 'number' &&
				Number.isInteger(value.hostPid) &&
				value.hostPid > 0)) &&
		typeof value.vmId === 'string' &&
		value.vmId.length > 0
	);
}

function isGatewayType(value: unknown): value is GatewayType {
	return value === 'openclaw' || value === 'worker';
}

function isOneOf<TValue extends string>(
	values: readonly TValue[],
	value: unknown,
): value is TValue {
	return typeof value === 'string' && values.some((candidateValue) => candidateValue === value);
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

async function readOptionalUtf8File(filePath: string): Promise<string | null> {
	try {
		return await readFile(filePath, 'utf8');
	} catch (error) {
		if (isNodeErrorWithCode(error, 'ENOENT')) {
			return null;
		}
		throw error;
	}
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
