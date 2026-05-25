import { v7 as uuidv7, validate as validateUuid, version as uuidVersion } from 'uuid';

export function createToolVmLeaseId(): string {
	return uuidv7();
}

export function isToolVmLeaseId(value: unknown): value is string {
	return typeof value === 'string' && validateUuid(value) && uuidVersion(value) === 7;
}
