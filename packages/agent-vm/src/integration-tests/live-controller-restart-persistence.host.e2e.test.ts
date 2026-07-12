import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm, ManagedVmInstance } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LoadedSystemConfig } from '../config/system-config.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';
import { startControllerHttpServer } from '../controller/http/controller-http-server.js';
import type { GatewayVmLifecycleAuthority } from '../controller/vm-ownership/gateway-vm-lifecycle-authority.js';
import {
	deleteGatewayRuntimeRecord,
	loadGatewayRuntimeRecord,
	writeGatewayRuntimeRecord,
} from '../gateway/gateway-runtime-record.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../testing/managed-vm-test-helpers.js';

function createSystemConfig(
	controllerPort: number,
	stateDirectory: string,
	zoneFilesDirectory: string,
	openClawConfigPath: string,
): LoadedSystemConfig {
	return {
		schemaVersion: 1,
		cacheDir: path.join(path.dirname(stateDirectory), 'cache'),
		runtimeDir: path.join(path.dirname(stateDirectory), 'runtime'),
		systemConfigPath: path.join(path.dirname(stateDirectory), 'config', 'system.json'),
		host: {
			controllerPort,
			projectNamespace: 'claw-tests-a1b2c3d4',
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
				worker: {
					type: 'worker',
					buildConfig: './vm-images/gateways/worker/build-config.json',
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
					controlAuth: {
						mode: 'token',
						secret: 'OPENCLAW_GATEWAY_TOKEN',
					},
					imageProfile: 'openclaw',
					memory: '2G',
					cpus: 2,
					port: controllerPort + 100,
					config: openClawConfigPath,
					stateDir: stateDirectory,
					zoneFilesDir: zoneFilesDirectory,
				},
				secrets: {
					OPENCLAW_GATEWAY_TOKEN: {
						source: 'environment',
						envVar: 'OPENCLAW_GATEWAY_TOKEN',
						injection: 'env',
						audience: 'gateway',
					},
				},
				egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
				defaultToolVmProfile: 'standard',
				agentToolVmProfiles: {},
			},
		],
		toolVmProfiles: {
			standard: {
				memory: '1G',
				cpus: 1,
				imageProfile: 'default',
			},
		},
		tcpPool: {
			basePort: 19000,
			size: 5,
		},
	};
}

async function startManagedVmStub(): Promise<void> {}

async function enableIngressStub(): Promise<{
	close(): Promise<void>;
	readonly host: string;
	readonly port: number;
}> {
	return { close: async () => {}, host: '127.0.0.1', port: 18_791 };
}

function setIngressRoutesStub(): void {}

async function createGatewayVmMock(
	stateDirectory: string,
	vmOwnership: GatewayVmLifecycleAuthority,
): Promise<ManagedVm> {
	const vmId = `gateway-${vmOwnership.gatewaySeed.gatewayEpochId}`;
	let hostPid: number | null = 28_000;
	const close = async (): Promise<void> => {
		hostPid = null;
	};
	const start = startManagedVmStub;
	const enableIngress = enableIngressStub;
	const enableSsh: ManagedVm['enableSsh'] = async () => ({
		close: async () => {},
		command: 'ssh -i /tmp/gateway-key root@127.0.0.1 -p 19000',
		host: '127.0.0.1',
		identityFile: '/tmp/gateway-key',
		port: 19_000,
		serverHostKey: TEST_SSH_SERVER_HOST_KEY,
		user: 'root',
	});
	const exec: ManagedVm['exec'] = (command: string) => {
		if (command === 'write-state persistence.txt persistent-value') {
			fs.writeFileSync(path.join(stateDirectory, 'persistence.txt'), 'persistent-value', 'utf8');
			return createManagedExecProcessStub();
		}

		if (command === 'read-state persistence.txt') {
			return createManagedExecProcessStub({
				stdout: fs.readFileSync(path.join(stateDirectory, 'persistence.txt'), 'utf8'),
			});
		}

		if (command.includes('cat /agent-vm/logs/gateway-boot-latest.log')) {
			return createManagedExecProcessStub({ stdout: 'gateway-log' });
		}

		return createManagedExecProcessStub();
	};
	const fsStub = createManagedVmFsStub();
	const getHostPid = (): number | null => hostPid;
	const setIngressRoutes = setIngressRoutesStub;
	const vmInstance: ManagedVmInstance = {
		close,
		enableIngress,
		enableSsh: async () => ({
			close: async () => {},
			command: 'ssh -i /tmp/gateway-key root@127.0.0.1 -p 19000',
			host: '127.0.0.1',
			identityFile: '/tmp/gateway-key',
			port: 19_000,
			user: 'root',
		}),
		exec,
		fs: fsStub,
		getHostPid,
		id: vmId,
		setIngressRoutes,
		start,
	};
	const gatewayVm: ManagedVm = {
		close,
		enableIngress,
		enableSsh,
		exec,
		fs: fsStub,
		getHostPid,
		getVmInstance: () => vmInstance,
		id: vmId,
		setIngressRoutes,
		start,
	};
	vmOwnership.attachGatewayVm(vmId);
	return gatewayVm;
}

function createToolVmMock(identityFile: string): ManagedVm {
	let hostPid: number | null = 28_100;
	const close = async (): Promise<void> => {
		hostPid = null;
	};
	const start = startManagedVmStub;
	const enableIngress = enableIngressStub;
	const enableSsh: ManagedVm['enableSsh'] = async () => ({
		close: async () => {},
		command: 'ssh -i /tmp/tool-key sandbox@127.0.0.1 -p 19000',
		host: '127.0.0.1',
		identityFile,
		port: 19_000,
		serverHostKey: TEST_SSH_SERVER_HOST_KEY,
		user: 'sandbox',
	});
	const exec: ManagedVm['exec'] = () => createManagedExecProcessStub();
	const fsStub = createManagedVmFsStub();
	const getHostPid = (): number | null => hostPid;
	const setIngressRoutes = setIngressRoutesStub;
	const vmInstance: ManagedVmInstance = {
		close,
		enableIngress,
		enableSsh: async () => ({
			close: async () => {},
			command: 'ssh -i /tmp/tool-key sandbox@127.0.0.1 -p 19000',
			host: '127.0.0.1',
			identityFile,
			port: 19_000,
			user: 'sandbox',
		}),
		exec,
		fs: fsStub,
		getHostPid,
		id: 'tool-vm-live-restart',
		setIngressRoutes,
		start,
	};
	const toolVm: ManagedVm = {
		close,
		enableIngress,
		enableSsh,
		exec,
		fs: fsStub,
		getHostPid,
		getVmInstance: () => vmInstance,
		id: 'tool-vm-live-restart',
		setIngressRoutes,
		start,
	};
	return toolVm;
}

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { recursive: true, force: true });
	}
});

describe('live integration: controller restart persistence', () => {
	it('preserves state across stop and restart while restoring lease functionality', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-restart-live-'));
		createdDirectories.push(tempDirectory);

		const stateDirectory = path.join(tempDirectory, 'state');
		const zoneFilesDirectory = path.join(tempDirectory, 'zone-files');
		const zoneLeaseDirectory = path.join(zoneFilesDirectory, 'restart-work');
		const openClawConfigPath = path.join(tempDirectory, 'openclaw.json');
		fs.mkdirSync(stateDirectory, { recursive: true });
		fs.mkdirSync(zoneLeaseDirectory, { recursive: true });
		fs.writeFileSync(
			openClawConfigPath,
			JSON.stringify({
				agents: {
					defaults: {
						sandbox: {
							backend: 'gondolin',
							mode: 'all',
							scope: 'agent',
							workspaceAccess: 'rw',
						},
						workspace: '/zone/agents/default',
					},
					list: [],
				},
			}),
			'utf8',
		);

		const controllerPort = 18841;
		const systemConfig = createSystemConfig(
			controllerPort,
			stateDirectory,
			zoneFilesDirectory,
			openClawConfigPath,
		);
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected restart test zone.');
		}

		let currentServerClosed: Promise<void> | undefined;
		let gatewayStartOrdinal = 0;
		const gatewayVmIds: string[] = [];
		const startRuntime = async (): ReturnType<typeof startControllerRuntime> =>
			await startControllerRuntime(
				{
					systemConfig,
					zoneIds: ['shravan'],
				},
				{
					createManagedToolVm: vi.fn(async () =>
						createToolVmMock(path.join(tempDirectory, 'tool-vm-identity')),
					),
					createSecretResolver: async () => ({
						resolve: async () => '',
						resolveAll: async () => ({}),
					}),
					isProcessAlive: () => true,
					readProcessIdentity: async () => ({
						command: 'qemu-system-aarch64 -m 1G',
						lstart: 'Fri May 22 10:00:00 2026',
					}),
					readIdentityPem: async () => 'pem',
					setTimeoutImpl: (callback) => {
						queueMicrotask(callback);
						return {} as NodeJS.Timeout;
					},
					startHttpServer: async (startHttpServerOptions) => {
						let resolveServerClosed: () => void;
						let rejectServerClosed: (error: unknown) => void;
						let serverClosed = false;
						currentServerClosed = new Promise<void>((resolve, reject) => {
							resolveServerClosed = resolve;
							rejectServerClosed = reject;
						});
						const server = await startControllerHttpServer(startHttpServerOptions);
						return {
							close: async () => {
								if (serverClosed) {
									return;
								}
								try {
									await server.close();
									serverClosed = true;
									resolveServerClosed();
								} catch (error) {
									rejectServerClosed(error);
									throw error;
								}
							},
						};
					},
					startGatewayZone: vi.fn(async (startOptions) => {
						gatewayStartOrdinal += 1;
						const vmOwnership = await startOptions.createVmOwnership({
							controlIdentity: {
								bootId: `controller-restart-gateway-boot-${gatewayStartOrdinal}`,
								generationId: `controller-restart-gateway-generation-${gatewayStartOrdinal}`,
							},
							kind: 'gateway-epoch',
							sessionLabel: `controller-restart-gateway-${gatewayStartOrdinal}`,
							zoneId: zone.id,
						});
						const gatewayVm = await createGatewayVmMock(stateDirectory, vmOwnership);
						await gatewayVm.start();
						const gatewayIdentity = vmOwnership.gatewayIdentity;
						if (gatewayIdentity === undefined) {
							throw new Error('Expected attached Gateway identity before runtime publication.');
						}
						await writeGatewayRuntimeRecord(stateDirectory, {
							configPath: systemConfig.systemConfigPath,
							controllerPort: systemConfig.host.controllerPort,
							createdAt: new Date().toISOString(),
							gateway: gatewayIdentity,
							gatewayType: 'openclaw',
							guestListenPort: 18_789,
							ingressPort: 18_791,
							processIdentity: {
								command: 'qemu-system-aarch64 -m 1G',
								lstart: 'Fri May 22 10:00:00 2026',
							},
							projectNamespace: systemConfig.host.projectNamespace,
							qemuPid: gatewayVm.getHostPid() ?? 28_000,
							schemaVersion: 2,
							sessionLabel: `${systemConfig.host.projectNamespace}:${zone.id}:gateway`,
							vmId: gatewayVm.id,
							zoneId: zone.id,
						});
						gatewayVmIds.push(gatewayVm.id);
						return {
							image: {
								built: true,
								fingerprint: 'gateway-image',
								imagePath: '/tmp/gateway-image',
							},
							ingress: {
								host: '127.0.0.1',
								port: 18791,
							},
							processSpec: {
								bootstrapCommand: 'bootstrap-openclaw',
								guestListenPort: 18789,
								healthCheck: { type: 'http', port: 18789, path: '/' } as const,
								logPath: '/agent-vm/logs/gateway-boot-latest.log',
								startCommand: 'start-openclaw',
							},
							terminateVm: async () => {
								await gatewayVm.close();
								await deleteGatewayRuntimeRecord(stateDirectory);
							},
							vm: gatewayVm,
							vmOwnership,
							zone,
						};
					}),
				},
			);

		const runtime = await startRuntime();

		const writeResponse = await fetch(
			`http://127.0.0.1:${controllerPort}/zones/shravan/execute-command`,
			{
				body: JSON.stringify({ command: 'write-state persistence.txt persistent-value' }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			},
		);
		expect(await writeResponse.json()).toMatchObject({
			exitCode: 0,
			stderr: '',
			stdout: '',
		});
		await expect(loadGatewayRuntimeRecord(stateDirectory)).resolves.toMatchObject({
			schemaVersion: 2,
			vmId: gatewayVmIds[0],
		});

		const stopResponse = await fetch(`http://127.0.0.1:${controllerPort}/stop-controller`, {
			method: 'POST',
		});
		expect(stopResponse.status).toBe(200);

		if (currentServerClosed === undefined) {
			throw new Error('Expected controller server close promise to be captured.');
		}
		await currentServerClosed;
		await runtime.close();
		await expect(fetch(`http://127.0.0.1:${String(controllerPort)}/health`)).rejects.toThrow();
		await expect(loadGatewayRuntimeRecord(stateDirectory)).resolves.toBeNull();

		const restartedRuntime = await startRuntime();
		expect(gatewayVmIds).toHaveLength(2);
		expect(gatewayVmIds[1]).not.toBe(gatewayVmIds[0]);
		await expect(loadGatewayRuntimeRecord(stateDirectory)).resolves.toMatchObject({
			schemaVersion: 2,
			vmId: gatewayVmIds[1],
		});

		const readResponse = await fetch(
			`http://127.0.0.1:${controllerPort}/zones/shravan/execute-command`,
			{
				body: JSON.stringify({ command: 'read-state persistence.txt' }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			},
		);
		expect(readResponse.status).toBe(200);
		const readBody = (await readResponse.json()) as {
			readonly stdout: string;
		};
		expect(readBody.stdout).toBe('persistent-value');

		const leasesResponse = await fetch(`http://127.0.0.1:${controllerPort}/leases`);
		expect(leasesResponse.status).toBe(404);

		const runtimeStatusResponse = await fetch(
			`http://127.0.0.1:${controllerPort}/zones/shravan/openclaw-runtime-status`,
			{
				body: JSON.stringify({
					pluginId: 'gondolin',
					zoneId: 'shravan',
					findings: [
						{
							id: 'openclaw-tool-vm-agents-defaults-sandbox-backend-shravan-defaults',
							ok: true,
							hint: 'agents.defaults.sandbox.backend=gondolin',
						},
					],
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			},
		);
		expect(runtimeStatusResponse.status).toBe(404);

		const createLeaseResponse = await fetch(`http://127.0.0.1:${controllerPort}/lease`, {
			body: JSON.stringify({
				agentId: 'restart-test',
				agentWorkspaceDir: '/zone',
				profileId: 'standard',
				sessionKey: 'agent:restart-test:integration',
				workMountDir: '/zone/restart-work',
				zoneId: 'shravan',
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		expect(createLeaseResponse.status).toBe(404);

		await restartedRuntime.close();
		await expect(loadGatewayRuntimeRecord(stateDirectory)).resolves.toBeNull();
	});
});
