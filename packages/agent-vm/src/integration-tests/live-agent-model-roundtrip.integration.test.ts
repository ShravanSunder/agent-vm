import { execFileSync } from 'node:child_process';
import net from 'node:net';

import { describe, expect, it } from 'vitest';

import { loadSystemConfig } from '../config/system-config.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';

function canReadSecretRef(secretRef: string | undefined): boolean {
	if (typeof secretRef !== 'string' || secretRef.length === 0) {
		return false;
	}

	try {
		execFileSync('op', ['read', secretRef], {
			stdio: 'ignore',
		});
		return true;
	} catch {
		return false;
	}
}

const runLiveModelRoundtrip =
	typeof process.env.OP_SERVICE_ACCOUNT_TOKEN === 'string' &&
	process.env.OP_SERVICE_ACCOUNT_TOKEN.length > 0 &&
	canReadSecretRef(process.env.DISCORD_BOT_TOKEN_REF) &&
	canReadSecretRef(process.env.PERPLEXITY_API_KEY_REF) &&
	canReadSecretRef(process.env.OPENCLAW_GATEWAY_TOKEN_REF) &&
	typeof process.env.OPEN_AI_TEST_KEY === 'string' &&
	process.env.OPEN_AI_TEST_KEY.length > 0;

const describeLiveModelRoundtrip = runLiveModelRoundtrip ? describe : describe.skip;

async function findAvailablePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('Failed to determine an available port.')));
				return;
			}
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(address.port);
			});
		});
	});
}

async function waitForControllerHealth(controllerPort: number): Promise<void> {
	const poll = async (attempt: number): Promise<void> => {
		const response = await fetch(`http://127.0.0.1:${controllerPort}/health`);
		if (response.ok) {
			return;
		}
		if (attempt >= 20) {
			throw new Error('Controller health check did not become ready in time');
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
		await poll(attempt + 1);
	};

	await poll(0);
}

describeLiveModelRoundtrip('live integration: agent model roundtrip', () => {
	it('boots the controller and performs a real gateway exec roundtrip', async () => {
		const systemConfig = await loadSystemConfig('system.json');
		const controllerPort = await findAvailablePort();
		const gatewayPort = await findAvailablePort();
		const toolSshPort = await findAvailablePort();
		const isolatedSystemConfig = {
			...systemConfig,
			host: {
				...systemConfig.host,
				controllerPort,
			},
			tcpPool: {
				basePort: toolSshPort,
				size: 1,
			},
			zones: systemConfig.zones.map((configuredZone) => ({
				...configuredZone,
				gateway: {
					...configuredZone.gateway,
					port: gatewayPort,
				},
			})),
		};
		const zone = isolatedSystemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected at least one zone in system config');
		}

		const runtime = await startControllerRuntime(
			{
				systemConfig: isolatedSystemConfig,
				zoneId: zone.id,
			},
			{},
		);

		try {
			await waitForControllerHealth(runtime.controllerPort);

			const commandResponse = await fetch(
				`http://127.0.0.1:${runtime.controllerPort}/zones/${zone.id}/execute-command`,
				{
					body: JSON.stringify({
						command: 'openclaw agent -m "what is 2+2? answer one word" --agent main --local',
					}),
					headers: { 'content-type': 'application/json' },
					method: 'POST',
				},
			);
			expect(commandResponse.status).toBe(200);

			const commandBody = await commandResponse.json();
			if (typeof commandBody !== 'object' || commandBody === null) {
				throw new Error('Expected command response object');
			}
			const stdout =
				typeof (commandBody as { stdout?: unknown }).stdout === 'string'
					? (commandBody as { stdout: string }).stdout
					: '';
			const stderr =
				typeof (commandBody as { stderr?: unknown }).stderr === 'string'
					? (commandBody as { stderr: string }).stderr
					: '';
			const combinedOutput = `${stdout}\n${stderr}`.toLowerCase();

			expect(combinedOutput).not.toContain('traceback');
			expect(combinedOutput).not.toContain('error:');
			expect(['2', 'two', 'four'].some((candidate) => combinedOutput.includes(candidate))).toBe(
				true,
			);

			const leasesResponse = await fetch(`http://127.0.0.1:${runtime.controllerPort}/leases`);
			expect(leasesResponse.status).toBe(200);
			const leasesBody = await leasesResponse.json();
			if (!Array.isArray(leasesBody)) {
				throw new Error('Expected leases array');
			}
			expect(leasesBody.length).toBeGreaterThan(0);
		} finally {
			await runtime.close();
		}
	}, 300_000);
});
