import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runBuildCommand } from '../cli/build-command.js';
import { loadSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';
import {
	createLiveRoundtripDeploymentConfig,
	resolveLiveRoundtripCacheDir,
} from './live-agent-model-roundtrip-deployment.js';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function canReadSecretRef(secretRef: string | undefined, serviceAccountToken: string): boolean {
	if (typeof secretRef !== 'string' || secretRef.length === 0) {
		return false;
	}

	try {
		execFileSync('op', ['read', secretRef], {
			env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: serviceAccountToken },
			stdio: 'ignore',
		});
		return true;
	} catch {
		return false;
	}
}

function canReadConfiguredZoneSecretRefs(serviceAccountToken: string): boolean {
	let rawSystemConfig: unknown;
	try {
		rawSystemConfig = JSON.parse(fs.readFileSync('config/system.json', 'utf8')) as unknown;
	} catch {
		return false;
	}
	if (!isObjectRecord(rawSystemConfig)) {
		return false;
	}
	const rawZones = rawSystemConfig.zones;
	if (!Array.isArray(rawZones)) {
		return false;
	}
	const firstZone = rawZones[0];
	if (!isObjectRecord(firstZone) || !isObjectRecord(firstZone.secrets)) {
		return false;
	}
	const secrets = firstZone.secrets;

	const readRef = (secretName: string): string | undefined => {
		const secretValue = secrets[secretName];
		if (!isObjectRecord(secretValue)) {
			return undefined;
		}
		return typeof secretValue.ref === 'string' ? secretValue.ref : undefined;
	};

	return (
		canReadSecretRef(readRef('DISCORD_BOT_TOKEN'), serviceAccountToken) &&
		canReadSecretRef(readRef('PERPLEXITY_API_KEY'), serviceAccountToken) &&
		canReadSecretRef(readRef('OPENCLAW_GATEWAY_TOKEN'), serviceAccountToken)
	);
}

const testOpServiceAccountToken = process.env.AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN;
const runLiveModelRoundtrip =
	typeof testOpServiceAccountToken === 'string' &&
	testOpServiceAccountToken.length > 0 &&
	canReadConfiguredZoneSecretRefs(testOpServiceAccountToken) &&
	typeof process.env.AGENT_VM_TEST_OPENAI_API_KEY === 'string' &&
	process.env.AGENT_VM_TEST_OPENAI_API_KEY.length > 0;

const describeLiveModelRoundtrip = runLiveModelRoundtrip ? describe : describe.skip;

const liveRoundtripFixtureSystemConfig = {
	schemaVersion: 1,
	cacheDir: './cache',
	runtimeDir: './runtime',
	systemConfigPath: './config/system.json',
	host: {
		controllerPort: 18_800,
		projectNamespace: 'live-roundtrip-fixture',
		secretsProvider: {
			type: '1password',
			tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
		},
	},
	imageProfiles: {
		gateways: {
			openclaw: {
				type: 'openclaw',
				buildConfig: './vm-images/gateways/openclaw/build-config.json',
			},
		},
		toolVms: {
			default: {
				type: 'toolVm',
				buildConfig: './vm-images/tool-vms/default/build-config.json',
			},
		},
	},
	zones: [
		{
			id: 'shravan',
			gateway: {
				type: 'openclaw',
				config: './config/shravan/openclaw.json',
				controlAuth: {
					mode: 'token',
					secret: 'OPENCLAW_GATEWAY_TOKEN',
				},
				cpus: 2,
				imageProfile: 'openclaw',
				memory: '2G',
				port: 18_791,
				stateDir: './state/shravan',
				zoneFilesDir: './zone-files/shravan',
			},
			secrets: {},
			egressHosts: [],
			websocketBypass: [],
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
	],
	toolVmProfiles: {
		standard: {
			cpus: 1,
			imageProfile: 'default',
			memory: '1G',
		},
	},
	tcpPool: {
		basePort: 19_000,
		size: 1,
	},
} satisfies LoadedSystemConfig;

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

describe('live integration: agent model roundtrip deployment config', () => {
	it('keeps generated deployment state in a temp root while reusing a shared image cache', () => {
		const deploymentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-live-roundtrip-'));
		try {
			const liveConfig = createLiveRoundtripDeploymentConfig({
				controllerPort: 18_801,
				gatewayPort: 18_789,
				systemConfig: liveRoundtripFixtureSystemConfig,
				toolSshPort: 19_000,
				deploymentRoot,
			});

			expect(liveConfig.cacheDir).toBe(resolveLiveRoundtripCacheDir());
			expect(path.resolve(liveConfig.cacheDir)).not.toContain(path.resolve(deploymentRoot));
			expect(path.resolve(liveConfig.runtimeDir)).toContain(path.resolve(deploymentRoot));
			for (const zone of liveConfig.zones) {
				expect(path.resolve(zone.gateway.stateDir)).toContain(path.resolve(deploymentRoot));
				if (zone.gateway.type === 'openclaw') {
					expect(path.resolve(zone.gateway.zoneFilesDir)).toContain(path.resolve(deploymentRoot));
				}
			}
		} finally {
			fs.rmSync(deploymentRoot, { force: true, recursive: true });
		}
	});
});

describeLiveModelRoundtrip('live integration: agent model roundtrip', () => {
	it('boots the controller and performs a real gateway exec roundtrip', async () => {
		if (typeof testOpServiceAccountToken !== 'string') {
			throw new Error('AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN is required for llm e2e.');
		}
		const previousOpToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
		process.env.OP_SERVICE_ACCOUNT_TOKEN = testOpServiceAccountToken;
		const deploymentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-live-roundtrip-'));
		let runtime: Awaited<ReturnType<typeof startControllerRuntime>> | undefined;

		try {
			const systemConfig = await loadSystemConfig('config/system.json');
			const controllerPort = await findAvailablePort();
			const gatewayPort = await findAvailablePort();
			const toolSshPort = await findAvailablePort();
			const liveSystemConfig = createLiveRoundtripDeploymentConfig({
				controllerPort,
				deploymentRoot,
				gatewayPort,
				systemConfig,
				toolSshPort,
			});
			const zone = liveSystemConfig.zones[0];
			if (!zone) {
				throw new Error('Expected at least one zone in system config');
			}
			await runBuildCommand(
				{
					systemConfig: liveSystemConfig,
				},
				{
					runTask: async (_title, fn) => await fn(),
				},
			);

			runtime = await startControllerRuntime(
				{
					systemConfig: liveSystemConfig,
					zoneIds: [zone.id],
				},
				{},
			);
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
			await runtime?.close();
			if (previousOpToken === undefined) {
				delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
			} else {
				process.env.OP_SERVICE_ACCOUNT_TOKEN = previousOpToken;
			}
			fs.rmSync(deploymentRoot, { force: true, recursive: true });
		}
	}, 300_000);
});
