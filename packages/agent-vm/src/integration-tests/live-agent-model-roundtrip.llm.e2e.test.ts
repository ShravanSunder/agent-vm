import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runBuildCommand } from '../cli/build-command.js';
import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';
import { currentE2eArchitecture } from './e2e-harness.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';
import {
	hermesE2eProfileApiServerKey,
	hermesE2eProfileApiServerKeyEnvironmentName,
	scaffoldHermesE2eProject,
} from './hermes-e2e-harness.js';
import {
	createLiveRoundtripDeploymentConfig,
	resolveLiveRoundtripCacheDir,
} from './live-agent-model-roundtrip-deployment.js';
import { shouldRunLiveModelRoundtripE2e } from './live-agent-model-roundtrip-gates.js';

const runLiveModelRoundtrip = shouldRunLiveModelRoundtripE2e({
	env: process.env,
});

const describeLiveModelRoundtrip = runLiveModelRoundtrip ? describe : describe.skip;

const liveRoundtripFixtureSystemConfig = {
	schemaVersion: 2,
	storageRootDir: '/storage-root-test',
	cacheDir: '/storage-root-test/cache',
	controllerStateDir: '/storage-root-test/controller-state',
	controllerRuntimeDir: '/storage-root-test/controller-runtime',
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
			hermes: {
				type: 'hermes',
				buildConfig: './vm-images/gateways/hermes/build-config.json',
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
				type: 'hermes',
				profileSecretProjectionsByAgent: { main: {} },
				profilesByAgent: { main: 'main' },
				config: './config/shravan/hermes.yaml',
				cpus: 2,
				imageProfile: 'hermes',
				memory: '2G',
				port: 18_791,
				stateDir: '/storage-root-test/shravan/state',
				zoneFilesDir: '/storage-root-test/shravan/zone-files',
				zoneRuntimeDir: '/storage-root-test/shravan/runtime',
			},
			secrets: {},
			egressHosts: [],
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
	const timeoutMs = 5_000;
	const retryIntervalMs = 50;
	const startedAtMs = performance.now();
	let lastError = 'not attempted';
	while (performance.now() - startedAtMs <= timeoutMs) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- controller startup readiness must observe sequential protocol state.
			const response = await fetch(`http://127.0.0.1:${String(controllerPort)}/health`, {
				signal: AbortSignal.timeout(1_000),
			});
			if (response.ok) {
				return;
			}
			lastError = `HTTP ${String(response.status)}`;
		} catch (error) {
			const networkErrorCode = readNodeNetworkErrorCode(error);
			if (!['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(networkErrorCode ?? '')) {
				throw error;
			}
			lastError = error instanceof Error ? error.message : String(error);
		}
		// oxlint-disable-next-line no-await-in-loop -- controller readiness has no event source from the runtime boundary.
		await waitForProtocolRetryInterval(retryIntervalMs);
	}
	throw new Error(
		`Controller health did not report ready within ${String(timeoutMs)}ms. Last error: ${lastError}`,
	);
}

async function waitForHermesZoneHealth(options: {
	readonly controllerPort: number;
	readonly zoneId: string;
}): Promise<void> {
	const timeoutMs = 60_000;
	const retryIntervalMs = 250;
	const startedAtMs = performance.now();
	let lastStatus = 'not attempted';
	while (performance.now() - startedAtMs <= timeoutMs) {
		try {
			const response = await fetch(
				`http://127.0.0.1:${String(options.controllerPort)}/zones/${encodeURIComponent(options.zoneId)}/health`,
				{ signal: AbortSignal.timeout(2_000) },
			);
			if (response.ok) {
				return;
			}
			lastStatus = `HTTP ${String(response.status)}: ${await response.text()}`;
		} catch (error) {
			const networkErrorCode = readNodeNetworkErrorCode(error);
			if (!['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(networkErrorCode ?? '')) {
				throw error;
			}
			lastStatus = error instanceof Error ? error.message : String(error);
		}
		// oxlint-disable-next-line no-await-in-loop -- zone readiness has no event source outside the controller protocol.
		await waitForProtocolRetryInterval(retryIntervalMs);
	}
	throw new Error(
		`Hermes zone '${options.zoneId}' did not become healthy within ${String(timeoutMs)}ms. Last status: ${lastStatus}`,
	);
}

function readNodeNetworkErrorCode(error: unknown): string | null {
	if (!(error instanceof TypeError) || error.message !== 'fetch failed') {
		return null;
	}
	const cause = error.cause;
	if (typeof cause !== 'object' || cause === null || !('code' in cause)) {
		return null;
	}
	return typeof cause.code === 'string' ? cause.code : null;
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
			expect(path.resolve(liveConfig.controllerRuntimeDir)).toContain(path.resolve(deploymentRoot));
			for (const zone of liveConfig.zones) {
				expect(path.resolve(zone.gateway.stateDir)).toContain(path.resolve(deploymentRoot));
				if (zone.gateway.type === 'hermes') {
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
		const project = await scaffoldHermesE2eProject({
			agents: ['main'],
			architecture: currentE2eArchitecture(),
			prefix: 'agent-vm-live-roundtrip-',
			zoneId: 'live-model-roundtrip',
		});
		const deploymentRoot = project.tempRoot;
		let runtime: Awaited<ReturnType<typeof startControllerRuntime>> | undefined;

		try {
			const systemConfig = project.systemConfig;
			const configuredZone = systemConfig.zones[0];
			if (configuredZone === undefined || configuredZone.gateway.type !== 'hermes') {
				throw new Error('Expected the live model scaffold to contain a Hermes zone.');
			}
			systemConfig.zones[0] = {
				...configuredZone,
				egressHosts: configuredZone.egressHosts.some(
					(egressHost) => egressHost.host === 'api.openai.com',
				)
					? configuredZone.egressHosts
					: [...configuredZone.egressHosts, { audience: 'gateway', host: 'api.openai.com' }],
				gateway: {
					...configuredZone.gateway,
					profileSecretProjectionsByAgent: {
						...configuredZone.gateway.profileSecretProjectionsByAgent,
						main: {
							API_SERVER_KEY: hermesE2eProfileApiServerKeyEnvironmentName('main'),
							OPENAI_API_KEY: 'TEST_OPENAI_API_KEY',
						},
					},
				},
				secrets: {
					...configuredZone.secrets,
					[hermesE2eProfileApiServerKeyEnvironmentName('main')]: {
						audience: 'gateway',
						injection: 'env',
						source: 'config',
						value: hermesE2eProfileApiServerKey('main'),
					},
					TEST_OPENAI_API_KEY: {
						audience: 'gateway',
						envVar: 'AGENT_VM_TEST_OPENAI_API_KEY',
						hosts: ['api.openai.com'],
						injection: 'http-mediation',
						source: 'environment',
					},
				},
			};
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
			if (zone.gateway.type !== 'hermes' || zone.gateway.profilesByAgent.main !== 'main') {
				throw new Error('Live model roundtrip requires the managed Hermes main profile.');
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
				createManagedVmRuntimeComposition(),
			);
			await waitForControllerHealth(runtime.controllerPort);
			await waitForHermesZoneHealth({
				controllerPort: runtime.controllerPort,
				zoneId: zone.id,
			});

			const commandResponse = await fetch(
				`http://127.0.0.1:${runtime.controllerPort}/zones/${zone.id}/execute-command`,
				{
					body: JSON.stringify({
						command:
							'HERMES_HOME=/home/hermes/.hermes/profiles/main hermes -z "what is 2+2? answer one word" --model gpt-4.1-mini --provider openai-api',
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
			const exitCode =
				typeof (commandBody as { exitCode?: unknown }).exitCode === 'number'
					? (commandBody as { exitCode: number }).exitCode
					: undefined;
			const combinedOutput = `${stdout}\n${stderr}`.toLowerCase();

			expect(exitCode, `Hermes one-shot failed: ${JSON.stringify({ stderr, stdout })}`).toBe(0);
			expect(combinedOutput).not.toContain('traceback');
			expect(combinedOutput).not.toContain('error:');
			expect(['4', 'four'].some((candidate) => combinedOutput.includes(candidate))).toBe(true);

			const controllerStatusResponse = await fetch(
				`http://127.0.0.1:${runtime.controllerPort}/controller-status`,
			);
			expect(controllerStatusResponse.status).toBe(200);
			const controllerStatusBody = await controllerStatusResponse.json();
			if (
				typeof controllerStatusBody !== 'object' ||
				controllerStatusBody === null ||
				!Array.isArray((controllerStatusBody as { readonly zones?: unknown }).zones)
			) {
				throw new Error('Expected controller status zones array');
			}
			const zones = (
				controllerStatusBody as {
					readonly zones: readonly {
						readonly gatewayType?: unknown;
						readonly id?: unknown;
						readonly readiness?: unknown;
						readonly running?: unknown;
					}[];
				}
			).zones;
			expect(
				zones.some(
					(statusZone) =>
						statusZone.id === zone.id &&
						statusZone.gatewayType === 'hermes' &&
						statusZone.readiness === 'running' &&
						statusZone.running === true,
				),
			).toBe(true);
		} finally {
			await runtime?.close();
			fs.rmSync(deploymentRoot, { force: true, recursive: true });
		}
	}, 300_000);
});
