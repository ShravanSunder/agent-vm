import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { materializeManagedAgentRootStorage } from '../gateway/managed-agent-root-storage.js';
import { runControllerDestroy } from './destroy-zone.js';

describe('managed agent root destruction boundary', () => {
	const temporaryRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryRoots.splice(0).map(async (temporaryRoot) => {
				await rm(temporaryRoot, { force: true, recursive: true });
			}),
		);
	});

	it('purges the canonical agent workspace with zone files while preserving controller state', async () => {
		const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'managed-agent-root-destroy-'));
		temporaryRoots.push(temporaryRoot);
		const controllerStateDir = path.join(temporaryRoot, 'controller-state');
		const stateDir = path.join(temporaryRoot, 'state');
		const zoneFilesDir = path.join(temporaryRoot, 'zone-files');
		const zoneRuntimeDir = path.join(temporaryRoot, 'runtime');
		await Promise.all([mkdir(controllerStateDir), mkdir(stateDir)]);
		const [agentRoots] = await materializeManagedAgentRootStorage({
			agentIds: ['alpha'],
			controllerStateDir,
			stateDir,
			zoneFilesDir,
		});
		if (agentRoots === undefined) {
			throw new Error('Expected materialized managed agent roots.');
		}
		await writeFile(path.join(controllerStateDir, 'controller-record.json'), '{}\n');
		const systemConfig = {
			schemaVersion: 2,
			storageRootDir: temporaryRoot,
			cacheDir: path.join(temporaryRoot, 'cache'),
			controllerStateDir,
			controllerRuntimeDir: path.join(temporaryRoot, 'controller-runtime'),
			host: { controllerPort: 18800, projectNamespace: 'managed-agent-destroy' },
			imageProfiles: {
				gateways: {
					hermes: {
						buildConfig: './vm-images/gateways/hermes/build-config.json',
						type: 'hermes',
					},
				},
				toolVms: {
					default: {
						buildConfig: './vm-images/tool-vms/default/build-config.json',
						type: 'toolVm',
					},
				},
			},
			zones: [
				{
					agents: [{ id: 'alpha' }],
					defaultToolVmProfile: 'standard',
					egressHosts: [],
					gateway: {
						config: './config/hermes.json',
						cpus: 1,
						imageProfile: 'hermes',
						memory: '1G',
						port: 18791,
						stateDir,
						type: 'hermes',
						profileSecretProjectionsByAgent: { main: {} },
						profilesByAgent: { main: 'main' },
						zoneFilesDir,
						zoneRuntimeDir,
					},
					id: 'zone-a',
					secrets: {},
				},
			],
			toolVmProfiles: {
				standard: { cpus: 1, imageProfile: 'default', memory: '1G' },
			},
			tcpPool: { basePort: 19000, size: 2 },
		} satisfies SystemConfig;

		await runControllerDestroy(
			{ purge: true, systemConfig, zoneId: 'zone-a' },
			{
				releaseZoneLeases: async () => {},
				stopGatewayZone: async () => {},
			},
		);

		await expect(access(agentRoots.hostWorkspaceRoot)).rejects.toThrow();
		await expect(access(stateDir)).rejects.toThrow();
		await expect(
			readFile(path.join(controllerStateDir, 'controller-record.json'), 'utf8'),
		).resolves.toBe('{}\n');
	});
});
