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

export function createLeaseClient(options: {
	readonly controllerUrl: string;
	readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}): LeaseClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = options.controllerUrl.replace(/\/$/u, '');

	return {
		getLeaseStatus: async (leaseId: string): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/lease/${leaseId}`);
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
			return (await response.json()) as GondolinLeaseResponse;
		},
	};
}
