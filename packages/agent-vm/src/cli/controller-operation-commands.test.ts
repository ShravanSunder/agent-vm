import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { runControllerOperationCommand } from './controller-operation-commands.js';

function createWorkerSystemConfig(
	workerConfigPath: string,
	systemConfigPath: string,
): LoadedSystemConfig {
	return createLoadedSystemConfig(
		{
			cacheDir: './cache',
			host: {
				controllerPort: 18800,
				projectNamespace: 'agent-vm-test',
			},
			imageProfiles: {
				gateways: {
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
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: './workspaces/tools',
					imageProfile: 'default',
				},
			},
			zones: [
				{
					allowedHosts: ['api.openai.com'],
					gateway: {
						type: 'worker',
						imageProfile: 'worker',
						cpus: 2,
						memory: '2G',
						config: workerConfigPath,
						port: 18791,
						stateDir: './state/worker',
						workspaceDir: './workspaces/worker',
					},
					id: 'worker',
					secrets: {},
					toolProfile: 'standard',
					websocketBypass: [],
				},
			],
		},
		{ systemConfigPath },
	);
}

describe('runControllerOperationCommand', () => {
	it('reports worker prompt reference failures in doctor output', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'systemCacheIdentifier.json',
		);
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		await fs.writeFile(systemCacheIdentifierPath, '{"schemaVersion":1}\n', 'utf8');
		await fs.writeFile(
			workerConfigPath,
			JSON.stringify({
				phases: {
					plan: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: { path: './prompts/missing.md' },
						reviewerInstructions: null,
					},
					work: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					wrapup: { instructions: null },
				},
			}),
			'utf8',
		);
		const outputs: string[] = [];

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({}),
					releaseLease: async () => {},
					stopController: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				runControllerDoctor: () => ({ ok: true, checks: [] }),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: [],
			subcommand: 'doctor',
			systemConfig: createWorkerSystemConfig(workerConfigPath, systemConfigPath),
		});

		const result = JSON.parse(outputs.join('')) as {
			readonly ok: boolean;
			readonly checks: readonly {
				readonly name: string;
				readonly ok: boolean;
				readonly hint?: string;
			}[];
		};

		expect(result.ok).toBe(false);
		const workerConfigCheck = result.checks.find((check) => check.name === 'worker-config-worker');
		expect(workerConfigCheck?.ok).toBe(false);
		expect(workerConfigCheck?.hint).toMatch(/phases\.plan\.agentInstructions.*missing\.md/u);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports missing system cache identifier failures in doctor output', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		await fs.writeFile(
			workerConfigPath,
			JSON.stringify({
				phases: {
					plan: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					work: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					wrapup: { instructions: null },
				},
			}),
			'utf8',
		);
		const outputs: string[] = [];

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({}),
					releaseLease: async () => {},
					stopController: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				runControllerDoctor: () => ({ ok: true, checks: [] }),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: [],
			subcommand: 'doctor',
			systemConfig: createWorkerSystemConfig(workerConfigPath, systemConfigPath),
		});

		const result = JSON.parse(outputs.join('')) as {
			readonly ok: boolean;
			readonly checks: readonly {
				readonly name: string;
				readonly ok: boolean;
				readonly hint?: string;
			}[];
		};

		expect(result.ok).toBe(false);
		const identifierCheck = result.checks.find((check) => check.name === 'system-cache-identifier');
		expect(identifierCheck?.ok).toBe(false);
		expect(identifierCheck?.hint).toMatch(/Missing system cache identifier/u);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports malformed system cache identifier failures in doctor output', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'systemCacheIdentifier.json',
		);
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		await fs.writeFile(systemCacheIdentifierPath, '{not-json', 'utf8');
		await fs.writeFile(
			workerConfigPath,
			JSON.stringify({
				phases: {
					plan: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					work: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					wrapup: { instructions: null },
				},
			}),
			'utf8',
		);
		const outputs: string[] = [];

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({}),
					releaseLease: async () => {},
					stopController: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				runControllerDoctor: () => ({ ok: true, checks: [] }),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: [],
			subcommand: 'doctor',
			systemConfig: createWorkerSystemConfig(workerConfigPath, systemConfigPath),
		});

		const result = JSON.parse(outputs.join('')) as {
			readonly ok: boolean;
			readonly checks: readonly {
				readonly name: string;
				readonly ok: boolean;
				readonly hint?: string;
			}[];
		};

		expect(result.ok).toBe(false);
		const identifierCheck = result.checks.find((check) => check.name === 'system-cache-identifier');
		expect(identifierCheck?.ok).toBe(false);
		expect(identifierCheck?.hint).toMatch(/Failed to parse system cache identifier/u);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports missing vm-host-system files for container configs in doctor output', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'config',
			'systemCacheIdentifier.json',
		);
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		await fs.mkdir(path.dirname(systemConfigPath), { recursive: true });
		await fs.writeFile(
			systemCacheIdentifierPath,
			JSON.stringify({ schemaVersion: 1, hostSystemType: 'container' }),
			'utf8',
		);
		await fs.writeFile(
			workerConfigPath,
			JSON.stringify({
				phases: {
					plan: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					work: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					wrapup: { instructions: null },
				},
			}),
			'utf8',
		);
		const outputs: string[] = [];

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({}),
					releaseLease: async () => {},
					stopController: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				runControllerDoctor: () => ({ ok: true, checks: [] }),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: [],
			subcommand: 'doctor',
			systemConfig: createWorkerSystemConfig(workerConfigPath, systemConfigPath),
		});

		const result = JSON.parse(outputs.join('')) as {
			readonly ok: boolean;
			readonly checks: readonly {
				readonly name: string;
				readonly ok: boolean;
				readonly hint?: string;
			}[];
		};

		expect(result.ok).toBe(false);
		const vmHostSystemCheck = result.checks.find((check) => check.name === 'vm-host-system');
		expect(vmHostSystemCheck?.ok).toBe(false);
		expect(vmHostSystemCheck?.hint).toContain('vm-host-system/Dockerfile');

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});
});
