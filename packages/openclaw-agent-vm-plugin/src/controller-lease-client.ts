export interface GondolinLeaseResponse {
	readonly leaseId: string;
	readonly ssh: {
		readonly host: string;
		readonly identityPem: string;
		readonly knownHostsLine: string;
		readonly port: number;
		readonly user: string;
	};
	readonly tcpSlot: number;
	readonly workdir: string;
}

export interface LeasePeekResponse {
	readonly createdAt: number;
	readonly lastUsedAt: number;
	readonly leaseId: string;
	readonly profileId: string;
	readonly scopeKey: string;
	readonly ssh: {
		readonly host: string;
		readonly port: number;
		readonly user: string;
	};
	readonly tcpSlot: number;
	readonly zoneId: string;
}

export interface LeaseClient {
	// Cached handles use keepalive; read-only runtime probes use peekLease.
	keepLeaseAlive(leaseId: string): Promise<GondolinLeaseResponse>;
	peekLease(leaseId: string): Promise<LeasePeekResponse>;
	releaseLease(leaseId: string): Promise<void>;
	requestLease(request: {
		readonly agentWorkspaceDir: string;
		readonly profileId: string;
		readonly scopeKey: string;
		readonly workspaceDir: string;
		readonly zoneId: string;
	}): Promise<GondolinLeaseResponse>;
}

function objectValue(value: unknown): object | undefined {
	return typeof value === 'object' && value !== null ? value : undefined;
}

function isSshResponse(value: unknown): value is GondolinLeaseResponse['ssh'] {
	const record = objectValue(value);
	return (
		record !== undefined &&
		typeof Reflect.get(record, 'host') === 'string' &&
		typeof Reflect.get(record, 'identityPem') === 'string' &&
		typeof Reflect.get(record, 'knownHostsLine') === 'string' &&
		typeof Reflect.get(record, 'port') === 'number' &&
		typeof Reflect.get(record, 'user') === 'string'
	);
}

function isLeasePeekSshResponse(value: unknown): value is LeasePeekResponse['ssh'] {
	const record = objectValue(value);
	return (
		record !== undefined &&
		typeof Reflect.get(record, 'host') === 'string' &&
		typeof Reflect.get(record, 'port') === 'number' &&
		typeof Reflect.get(record, 'user') === 'string'
	);
}

function isGondolinLeaseResponse(value: unknown): value is GondolinLeaseResponse {
	const record = objectValue(value);
	return (
		record !== undefined &&
		typeof Reflect.get(record, 'leaseId') === 'string' &&
		isSshResponse(Reflect.get(record, 'ssh')) &&
		typeof Reflect.get(record, 'tcpSlot') === 'number' &&
		typeof Reflect.get(record, 'workdir') === 'string'
	);
}

function isLeasePeekResponse(value: unknown): value is LeasePeekResponse {
	const record = objectValue(value);
	return (
		record !== undefined &&
		typeof Reflect.get(record, 'createdAt') === 'number' &&
		typeof Reflect.get(record, 'lastUsedAt') === 'number' &&
		typeof Reflect.get(record, 'leaseId') === 'string' &&
		typeof Reflect.get(record, 'profileId') === 'string' &&
		typeof Reflect.get(record, 'scopeKey') === 'string' &&
		isLeasePeekSshResponse(Reflect.get(record, 'ssh')) &&
		typeof Reflect.get(record, 'tcpSlot') === 'number' &&
		typeof Reflect.get(record, 'zoneId') === 'string'
	);
}

async function readJsonResponse<TValue>(
	response: Response,
	context: string,
	isExpectedResponse: (value: unknown) => value is TValue,
): Promise<TValue> {
	if (!response.ok) {
		const errorBody = await response.text().catch(() => '(unreadable)');
		throw new TypeError(`${context} returned HTTP ${response.status}: ${errorBody}`);
	}
	const payload = await response.json();
	if (!isExpectedResponse(payload)) {
		throw new TypeError(
			`${context} returned an invalid response: ${JSON.stringify(payload).slice(0, 200)}`,
		);
	}
	return payload;
}

export function createLeaseClient(options: {
	readonly controllerUrl: string;
	readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}): LeaseClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = options.controllerUrl.replace(/\/$/u, '');

	return {
		keepLeaseAlive: async (leaseId: string): Promise<GondolinLeaseResponse> => {
			const response = await fetchImpl(`${baseUrl}/lease/${leaseId}`);
			return await readJsonResponse(
				response,
				'Controller lease keepalive API',
				isGondolinLeaseResponse,
			);
		},
		peekLease: async (leaseId: string): Promise<LeasePeekResponse> => {
			const response = await fetchImpl(`${baseUrl}/lease/${leaseId}/peek`);
			return await readJsonResponse(response, 'Controller lease peek API', isLeasePeekResponse);
		},
		releaseLease: async (leaseId: string): Promise<void> => {
			await fetchImpl(`${baseUrl}/lease/${leaseId}`, {
				method: 'DELETE',
			});
		},
		requestLease: async (request): Promise<GondolinLeaseResponse> => {
			const response = await fetchImpl(`${baseUrl}/lease`, {
				body: JSON.stringify(request),
				headers: {
					'content-type': 'application/json',
				},
				method: 'POST',
			});
			if (!response.ok) {
				const errorBody = await response.text().catch(() => '(unreadable)');
				throw new TypeError(`Controller lease API returned HTTP ${response.status}: ${errorBody}`);
			}
			const payload = await response.json();
			if (!isGondolinLeaseResponse(payload)) {
				throw new TypeError(
					`Controller returned an invalid lease response: ${JSON.stringify(payload).slice(0, 200)}`,
				);
			}
			return payload;
		},
	};
}
