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

export interface LeaseClient {
	getLeaseStatus(leaseId: string): Promise<unknown>;
	releaseLease(leaseId: string): Promise<void>;
	requestLease(request: {
		readonly agentWorkspaceDir: string;
		readonly profileId: string;
		readonly scopeKey: string;
		readonly workspaceDir: string;
		readonly zoneId: string;
	}): Promise<GondolinLeaseResponse>;
}

function isGondolinLeaseResponse(value: unknown): value is GondolinLeaseResponse {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { leaseId?: unknown }).leaseId === 'string' &&
		typeof (value as { tcpSlot?: unknown }).tcpSlot === 'number' &&
		typeof (value as { workdir?: unknown }).workdir === 'string'
	);
}

export function createLeaseClient(options: {
	readonly controllerUrl: string;
	readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}): LeaseClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = options.controllerUrl.replace(/\/$/u, '');

	return {
		getLeaseStatus: async (leaseId: string): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/lease/${leaseId}`);
			if (!response.ok) {
				const errorBody = await response.text().catch(() => '(unreadable)');
				throw new TypeError(
					`Controller lease status API returned HTTP ${response.status}: ${errorBody}`,
				);
			}
			return await response.json();
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
