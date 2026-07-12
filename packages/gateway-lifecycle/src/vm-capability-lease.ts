const VM_SSH_PUBLIC_ENDPOINT_KEYS = new Set(['host', 'port', 'user']);

/**
 * Small host-issued capability envelope shared by VM-backed transports. The
 * transport tag keeps SSH Tool VM leases distinct from future host-side
 * VM RPC or bridge capabilities without inventing a transport object.
 */
export interface VmCapabilityLease<TTransport extends string> {
	readonly leaseId: string;
	readonly transport: TTransport;
}

export interface VmSshEndpoint {
	readonly host: string;
	readonly identityPem: string;
	readonly knownHostsLine: string;
	readonly port: number;
	readonly user: string;
}

export interface VmSshPublicEndpoint {
	readonly host: string;
	readonly port: number;
	readonly user: string;
}

export interface VmSshLease<TTransport extends string> extends VmCapabilityLease<TTransport> {
	readonly ssh: VmSshEndpoint;
}

function objectValue(value: unknown): object | undefined {
	return typeof value === 'object' && value !== null ? value : undefined;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

export function isVmCapabilityLease<TTransport extends string>(
	value: unknown,
	transport: TTransport,
): value is VmCapabilityLease<TTransport> {
	const record = objectValue(value);
	return (
		record !== undefined &&
		typeof Reflect.get(record, 'leaseId') === 'string' &&
		Reflect.get(record, 'transport') === transport
	);
}

export function isVmSshEndpoint(value: unknown): value is VmSshEndpoint {
	const record = objectValue(value);
	return (
		record !== undefined &&
		typeof Reflect.get(record, 'host') === 'string' &&
		isNonEmptyString(Reflect.get(record, 'identityPem')) &&
		isNonEmptyString(Reflect.get(record, 'knownHostsLine')) &&
		typeof Reflect.get(record, 'port') === 'number' &&
		typeof Reflect.get(record, 'user') === 'string'
	);
}

export function isVmSshPublicEndpoint(value: unknown): value is VmSshPublicEndpoint {
	const record = objectValue(value);
	if (record === undefined) {
		return false;
	}
	for (const key of Object.keys(record)) {
		if (!VM_SSH_PUBLIC_ENDPOINT_KEYS.has(key)) {
			return false;
		}
	}
	return (
		typeof Reflect.get(record, 'host') === 'string' &&
		typeof Reflect.get(record, 'port') === 'number' &&
		typeof Reflect.get(record, 'user') === 'string'
	);
}
