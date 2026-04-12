export interface ControllerClient {
	destroyZone(zoneId: string, purge: boolean): Promise<unknown>;
	enableZoneSsh(zoneId: string): Promise<unknown>;
	getControllerStatus(): Promise<unknown>;
	getZoneLogs(zoneId: string): Promise<unknown>;
	listLeases(): Promise<unknown>;
	refreshZoneCredentials(zoneId: string): Promise<unknown>;
	releaseLease(leaseId: string): Promise<void>;
	stopController(): Promise<unknown>;
	upgradeZone(zoneId: string): Promise<unknown>;
}

export function createControllerClient(options: {
	readonly baseUrl: string;
	readonly fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}): ControllerClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = options.baseUrl.replace(/\/$/u, '');

	return {
		enableZoneSsh: async (zoneId: string): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/enable-ssh`, {
				method: 'POST',
			});
			return await response.json();
		},
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
		getControllerStatus: async (): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/controller-status`);
			return await response.json();
		},
		getZoneLogs: async (zoneId: string): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/logs`);
			return await response.json();
		},
		refreshZoneCredentials: async (zoneId: string): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/credentials/refresh`, {
				method: 'POST',
			});
			return await response.json();
		},
		listLeases: async (): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/leases`);
			return await response.json();
		},
		releaseLease: async (leaseId: string): Promise<void> => {
			await fetchImpl(`${baseUrl}/lease/${leaseId}`, { method: 'DELETE' });
		},
		stopController: async (): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/stop-controller`, { method: 'POST' });
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
