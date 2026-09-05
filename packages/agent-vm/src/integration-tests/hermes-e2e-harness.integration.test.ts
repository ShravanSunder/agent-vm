import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { removeE2eTempRoot } from './e2e-harness.js';
import { scaffoldHermesE2eProject } from './hermes-e2e-harness.js';

const temporaryProjectRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryProjectRoots
			.splice(0)
			.map(async (projectRoot) => await removeE2eTempRoot(projectRoot)),
	);
});

describe('Hermes E2E project scaffold', () => {
	it('releases its TCP pool reservation when scaffold validation fails', async () => {
		await expect(
			scaffoldHermesE2eProject({
				agents: ['main'],
				architecture: 'aarch64',
				prefix: 'agent-vm-hermes-e2e-harness-',
				zoneId: 'invalid zone id',
			}),
		).rejects.toThrow();

		const project = await scaffoldHermesE2eProject({
			agents: ['main'],
			architecture: 'aarch64',
			prefix: 'agent-vm-hermes-e2e-harness-',
			zoneId: 'hermes-smoke',
		});
		temporaryProjectRoots.push(project.tempRoot);
		expect(project.systemConfig.tcpPool.basePort).toBe(30_001);
	});

	it('uses the public Hermes scaffold without materializing OpenClaw project files', async () => {
		const project = await scaffoldHermesE2eProject({
			agents: ['main', 'beta'],
			architecture: 'aarch64',
			prefix: 'agent-vm-hermes-e2e-harness-',
			zoneId: 'hermes-smoke',
		});
		temporaryProjectRoots.push(project.tempRoot);

		expect(project.zone.gateway.type).toBe('hermes');
		expect(project.zone.gateway.profilesByAgent).toEqual({ main: 'main', beta: 'beta' });
		expect(project.systemConfig.host.controllerPort).toBe(project.controllerPort);
		expect(project.zone.gateway.cpus).toBe(1);
		expect(project.zone.gateway.port).toBe(project.gatewayPort);
		expect(project.zone.gateway.config).toBe(
			path.join(
				project.tempRoot,
				'config',
				'gateways',
				'hermes-smoke',
				'hermes-managed',
				'config.yaml',
			),
		);
		await expect(
			fs.access(path.join(project.tempRoot, 'vm-images', 'gateways', 'hermes', 'Dockerfile')),
		).resolves.toBeUndefined();
		await expect(
			fs.access(path.join(project.tempRoot, 'vm-images', 'gateways', 'openclaw')),
		).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(
			fs.access(path.join(project.tempRoot, 'config', 'gateways', 'hermes-smoke', 'openclaw.json')),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});
});
