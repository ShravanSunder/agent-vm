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

async function readJsonResponse(response: Response, context: string): Promise<unknown> {
	if (!response.ok) {
		const body = await response.text().catch(() => '(unreadable)');
		throw new Error(`${context} failed with HTTP ${response.status}: ${body}`);
	}

	try {
		return await response.json();
	} catch (error) {
		const body = await response.text().catch(() => '(unreadable)');
		throw new Error(
			`${context} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}. Body: ${body}`,
		);
	}
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
			return await readJsonResponse(response, `Enable SSH for zone '${zoneId}'`);
		},
		destroyZone: async (zoneId: string, purge: boolean): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/destroy`, {
				body: JSON.stringify({ purge }),
				headers: {
					'content-type': 'application/json',
				},
				method: 'POST',
			});
			return await readJsonResponse(response, `Destroy zone '${zoneId}'`);
		},
		getControllerStatus: async (): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/controller-status`);
			return await readJsonResponse(response, 'Get controller status');
		},
		getZoneLogs: async (zoneId: string): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/logs`);
			return await readJsonResponse(response, `Get logs for zone '${zoneId}'`);
		},
		refreshZoneCredentials: async (zoneId: string): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/credentials/refresh`, {
				method: 'POST',
			});
			return await readJsonResponse(response, `Refresh credentials for zone '${zoneId}'`);
		},
		listLeases: async (): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/leases`);
			return await readJsonResponse(response, 'List leases');
		},
		releaseLease: async (leaseId: string): Promise<void> => {
			await fetchImpl(`${baseUrl}/lease/${leaseId}`, { method: 'DELETE' });
		},
		stopController: async (): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/stop-controller`, { method: 'POST' });
			return await readJsonResponse(response, 'Stop controller');
		},
		upgradeZone: async (zoneId: string): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/upgrade`, {
				method: 'POST',
			});
			return await readJsonResponse(response, `Upgrade zone '${zoneId}'`);
		},
	};
}
