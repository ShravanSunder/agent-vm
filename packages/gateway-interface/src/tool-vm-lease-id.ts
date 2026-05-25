import { v7 as uuidv7, validate as validateUuid, version as uuidVersion } from 'uuid';

declare const toolVmLeaseIdBrand: unique symbol;

export type ToolVmLeaseId = string & {
	readonly [toolVmLeaseIdBrand]: true;
};

export function createToolVmLeaseId(): ToolVmLeaseId {
	return parseToolVmLeaseId(uuidv7());
}

export function isToolVmLeaseId(value: unknown): value is ToolVmLeaseId {
	return typeof value === 'string' && validateUuid(value) && uuidVersion(value) === 7;
}

export function parseToolVmLeaseId(value: unknown): ToolVmLeaseId {
	if (isToolVmLeaseId(value)) {
		return value;
	}
	throw new TypeError('Tool VM lease id must be an opaque UUIDv7 string.');
}
