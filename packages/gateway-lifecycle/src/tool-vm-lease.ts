import { isToolVmLeaseId, type ToolVmLeaseId } from './tool-vm-lease-id.js';
import {
	isVmCapabilityLease,
	isVmSshEndpoint,
	isVmSshPublicEndpoint,
	type VmCapabilityLease,
	type VmSshLease,
	type VmSshPublicEndpoint,
} from './vm-capability-lease.js';

export const defaultToolVmLeaseAuthorityTombstoneTtlMs = 10 * 60 * 1000;
export const TOOL_VM_WORK_GUEST_ROOT = '/work';

export interface ToolVmSshLease extends VmSshLease<'ssh-sandbox'> {
	readonly agentId: string;
	readonly idleTtlMs: number;
	readonly leaseId: ToolVmLeaseId;
	readonly tcpSlot: number;
	readonly workdir: string;
}

export interface ToolVmLeasePeek extends VmCapabilityLease<'ssh-sandbox'> {
	readonly agentId: string;
	readonly createdAt: number;
	readonly idleTtlMs: number;
	readonly lastUsedAt: number;
	readonly leaseId: ToolVmLeaseId;
	readonly profileId: string;
	readonly ssh: VmSshPublicEndpoint;
	readonly tcpSlot: number;
	readonly workdir: string;
	readonly zoneId: string;
}

function objectValue(value: unknown): object | undefined {
	return typeof value === 'object' && value !== null ? value : undefined;
}

const deprecatedScopeKeyPropertyName = ['scope', 'Key'].join('');

export function isToolVmSshLease(value: unknown): value is ToolVmSshLease {
	const record = objectValue(value);
	return (
		isVmCapabilityLease(record, 'ssh-sandbox') &&
		isToolVmLeaseId(Reflect.get(record, 'leaseId')) &&
		isVmSshEndpoint(Reflect.get(record, 'ssh')) &&
		typeof Reflect.get(record, 'agentId') === 'string' &&
		typeof Reflect.get(record, 'idleTtlMs') === 'number' &&
		typeof Reflect.get(record, 'tcpSlot') === 'number' &&
		typeof Reflect.get(record, 'workdir') === 'string' &&
		!Reflect.has(record, deprecatedScopeKeyPropertyName)
	);
}

export function isToolVmLeasePeek(value: unknown): value is ToolVmLeasePeek {
	const record = objectValue(value);
	return (
		isVmCapabilityLease(record, 'ssh-sandbox') &&
		isToolVmLeaseId(Reflect.get(record, 'leaseId')) &&
		typeof Reflect.get(record, 'agentId') === 'string' &&
		typeof Reflect.get(record, 'createdAt') === 'number' &&
		typeof Reflect.get(record, 'idleTtlMs') === 'number' &&
		typeof Reflect.get(record, 'lastUsedAt') === 'number' &&
		typeof Reflect.get(record, 'profileId') === 'string' &&
		isVmSshPublicEndpoint(Reflect.get(record, 'ssh')) &&
		typeof Reflect.get(record, 'tcpSlot') === 'number' &&
		typeof Reflect.get(record, 'workdir') === 'string' &&
		typeof Reflect.get(record, 'zoneId') === 'string' &&
		!Reflect.has(record, deprecatedScopeKeyPropertyName)
	);
}
