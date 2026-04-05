export interface ControllerClient {
	destroyZone(zoneId: string, purge: boolean): Promise<unknown>;
	getLogs(zoneId: string): Promise<unknown>;
	getStatus(): Promise<unknown>;
	refreshCredentials(zoneId: string): Promise<unknown>;
	upgradeZone(zoneId: string): Promise<unknown>;
}

export function createControllerClient(options: {
	readonly baseUrl: string;
	readonly fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}): ControllerClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = options.baseUrl.replace(/\/$/u, '');

	return {
		destroyZone: async (zoneId: string, purge: boolean): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/destroy`, {
				body: JSON.stringify({ purge }),
				headers: {
					'content-type': 'application/json',
				},
				method: 'POST',
			});
			return await response.json();
		},
		getLogs: async (zoneId: string): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/logs`);
			return await response.json();
		},
		getStatus: async (): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/status`);
			return await response.json();
		},
		refreshCredentials: async (zoneId: string): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/credentials/refresh`, {
				method: 'POST',
			});
			return await response.json();
		},
		upgradeZone: async (zoneId: string): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/upgrade`, {
				method: 'POST',
			});
			return await response.json();
		},
	};
}
