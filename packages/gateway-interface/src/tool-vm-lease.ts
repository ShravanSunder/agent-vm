import {
	isVmCapabilityLease,
	isVmSshEndpoint,
	isVmSshPublicEndpoint,
	type VmCapabilityLease,
	type VmSshLease,
	type VmSshPublicEndpoint,
} from './vm-capability-lease.js';

export interface ToolVmSshLease extends VmSshLease<'ssh-sandbox'> {
	readonly tcpSlot: number;
	readonly workdir: string;
}

export interface ToolVmLeasePeek extends VmCapabilityLease<'ssh-sandbox'> {
	readonly createdAt: number;
	readonly lastUsedAt: number;
	readonly profileId: string;
	readonly scopeKey: string;
	readonly ssh: VmSshPublicEndpoint;
	readonly tcpSlot: number;
	readonly workdir: string;
	readonly zoneId: string;
}

function objectValue(value: unknown): object | undefined {
	return typeof value === 'object' && value !== null ? value : undefined;
}

export function isToolVmSshLease(value: unknown): value is ToolVmSshLease {
	const record = objectValue(value);
	return (
		isVmCapabilityLease(record, 'ssh-sandbox') &&
		isVmSshEndpoint(Reflect.get(record, 'ssh')) &&
		typeof Reflect.get(record, 'tcpSlot') === 'number' &&
		typeof Reflect.get(record, 'workdir') === 'string'
	);
}

export function isToolVmLeasePeek(value: unknown): value is ToolVmLeasePeek {
	const record = objectValue(value);
	return (
		isVmCapabilityLease(record, 'ssh-sandbox') &&
		typeof Reflect.get(record, 'createdAt') === 'number' &&
		typeof Reflect.get(record, 'lastUsedAt') === 'number' &&
		typeof Reflect.get(record, 'profileId') === 'string' &&
		typeof Reflect.get(record, 'scopeKey') === 'string' &&
		isVmSshPublicEndpoint(Reflect.get(record, 'ssh')) &&
		typeof Reflect.get(record, 'tcpSlot') === 'number' &&
		typeof Reflect.get(record, 'workdir') === 'string' &&
		typeof Reflect.get(record, 'zoneId') === 'string'
	);
}
