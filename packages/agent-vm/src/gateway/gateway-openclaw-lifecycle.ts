import type { ManagedVm } from 'gondolin-core';

async function waitForGatewayReadiness(
	managedVm: ManagedVm,
	attempt: number,
	maxAttempts: number,
): Promise<void> {
	if (attempt >= maxAttempts) {
		return;
	}

	const readinessCheck = await managedVm.exec(
		'curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:18789/ 2>/dev/null || echo 000',
	);
	if (readinessCheck.stdout.trim() !== '000') {
		return;
	}

	await new Promise((resolve) => setTimeout(resolve, 500));
	await waitForGatewayReadiness(managedVm, attempt + 1, maxAttempts);
}

export async function startOpenClawInGateway(
	options: {
		readonly gatewayPort: number;
		readonly managedVm: ManagedVm;
	},
): Promise<{
	readonly host: string;
	readonly port: number;
}> {
	await options.managedVm.exec(
		'cd /home/openclaw && nohup openclaw gateway --port 18789 > /tmp/openclaw.log 2>&1 &',
	);
	await waitForGatewayReadiness(options.managedVm, 0, 30);

	options.managedVm.setIngressRoutes([
		{
			port: 18789,
			prefix: '/',
			stripPrefix: true,
		},
	]);

	return await options.managedVm.enableIngress({
		listenPort: options.gatewayPort,
	});
}
