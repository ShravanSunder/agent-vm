import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.fn();

vi.mock('execa', () => ({
	execa: execaMock,
}));

describe('docker-service-routing', () => {
	afterEach(() => {
		vi.resetModules();
		execaMock.mockReset();
	});

	it('returns no routing when no docker compose file exists', async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-routing-none-'));
		const { startDockerServicesForTask } = await import('./docker-service-routing.js');

		const result = await startDockerServicesForTask(tempDir);

		expect(result).toEqual({
			composeFilePaths: [],
			tcpHosts: {},
		});
		expect(execaMock).not.toHaveBeenCalled();
	});

	it('starts docker compose and derives tcp hosts from inspected containers', async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-routing-compose-'));
		const composeDir = path.join(tempDir, '.agent-vm');
		await fs.mkdir(composeDir, { recursive: true });
		await fs.writeFile(path.join(composeDir, 'docker-compose.yml'), 'services: {}');

		execaMock
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({ stdout: 'container-1\ncontainer-2\n', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					{
						Config: {
							ExposedPorts: {
								'5432/tcp': {},
							},
							Labels: {
								'com.docker.compose.service': 'postgres',
							},
						},
						NetworkSettings: {
							Networks: {
								default: {
									IPAddress: '172.30.0.10',
								},
							},
						},
					},
				]),
				stderr: '',
				exitCode: 0,
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					{
						Config: {
							ExposedPorts: {
								'6379/tcp': {},
							},
							Labels: {
								'com.docker.compose.service': 'redis',
							},
						},
						NetworkSettings: {
							Networks: {
								default: {
									IPAddress: '172.30.0.11',
								},
							},
						},
					},
				]),
				stderr: '',
				exitCode: 0,
			});

		const { startDockerServicesForTask } = await import('./docker-service-routing.js');

		const result = await startDockerServicesForTask(tempDir);

		expect(result.composeFilePaths).toEqual([path.join(composeDir, 'docker-compose.yml')]);
		expect(result.tcpHosts).toEqual({
			'postgres.local:5432': '172.30.0.10:5432',
			'redis.local:6379': '172.30.0.11:6379',
		});
		expect(execaMock).toHaveBeenCalledWith(
			'docker',
			['compose', '-f', path.join(composeDir, 'docker-compose.yml'), 'up', '-d', '--wait'],
			expect.any(Object),
		);
	});

	it('discovers docker compose files in repo subdirectories', async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-routing-multi-'));
		const frontendComposeDir = path.join(tempDir, 'frontend', '.agent-vm');
		const backendComposeDir = path.join(tempDir, 'backend', '.agent-vm');
		await fs.mkdir(frontendComposeDir, { recursive: true });
		await fs.mkdir(backendComposeDir, { recursive: true });
		await fs.writeFile(path.join(frontendComposeDir, 'docker-compose.yml'), 'services: {}');
		await fs.writeFile(path.join(backendComposeDir, 'docker-compose.yml'), 'services: {}');

		execaMock
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

		const { startDockerServicesForTask } = await import('./docker-service-routing.js');

		const result = await startDockerServicesForTask(tempDir, [
			path.join(tempDir, 'frontend'),
			path.join(tempDir, 'backend'),
		]);

		expect(result.composeFilePaths).toEqual([
			path.join(frontendComposeDir, 'docker-compose.yml'),
			path.join(backendComposeDir, 'docker-compose.yml'),
		]);
	});

	it('reports already-started compose files when a later compose startup fails', async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-routing-partial-fail-'));
		const frontendComposeDir = path.join(tempDir, 'frontend', '.agent-vm');
		const backendComposeDir = path.join(tempDir, 'backend', '.agent-vm');
		await fs.mkdir(frontendComposeDir, { recursive: true });
		await fs.mkdir(backendComposeDir, { recursive: true });
		await fs.writeFile(path.join(frontendComposeDir, 'docker-compose.yml'), 'services: {}');
		await fs.writeFile(path.join(backendComposeDir, 'docker-compose.yml'), 'services: {}');

		execaMock
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({ stdout: 'container-1\n', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					{
						Config: {
							ExposedPorts: { '5432/tcp': {} },
							Labels: { 'com.docker.compose.service': 'postgres' },
						},
						NetworkSettings: {
							Networks: { default: { IPAddress: '172.30.0.10' } },
						},
					},
				]),
				stderr: '',
				exitCode: 0,
			})
			.mockRejectedValueOnce(new Error('compose up failed'));

		const { DockerServiceRoutingError, startDockerServicesForTask } =
			await import('./docker-service-routing.js');

		await expect(
			startDockerServicesForTask(tempDir, [
				path.join(tempDir, 'frontend'),
				path.join(tempDir, 'backend'),
			]),
		).rejects.toMatchObject({
			name: 'DockerServiceRoutingError',
			startedComposeFilePaths: [
				path.join(frontendComposeDir, 'docker-compose.yml'),
				path.join(backendComposeDir, 'docker-compose.yml'),
			],
		});
		expect(DockerServiceRoutingError).toBeDefined();
	});

	it('stops docker compose services when compose files were used', async () => {
		const { stopDockerServicesForTask } = await import('./docker-service-routing.js');

		await stopDockerServicesForTask([
			'/tmp/task/frontend/.agent-vm/docker-compose.yml',
			'/tmp/task/backend/.agent-vm/docker-compose.yml',
		]);

		expect(execaMock).toHaveBeenCalledWith(
			'docker',
			[
				'compose',
				'-f',
				'/tmp/task/frontend/.agent-vm/docker-compose.yml',
				'down',
				'--remove-orphans',
			],
			expect.any(Object),
		);
		expect(execaMock).toHaveBeenCalledWith(
			'docker',
			[
				'compose',
				'-f',
				'/tmp/task/backend/.agent-vm/docker-compose.yml',
				'down',
				'--remove-orphans',
			],
			expect.any(Object),
		);
	});
});
