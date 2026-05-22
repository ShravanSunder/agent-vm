import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { SecretResolver } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../../config/system-config.js';
import { SandboxSeedingError, seedAgentSandboxWorkspace } from './agent-sandbox-seeding.js';

const createdDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		createdDirectories
			.splice(0)
			.map((directoryPath) => rm(directoryPath, { recursive: true, force: true })),
	);
});

async function createTempDirectory(prefix: string): Promise<string> {
	const directoryPath = await mkdtemp(path.join(os.tmpdir(), prefix));
	createdDirectories.push(directoryPath);
	return directoryPath;
}

function createSecretResolver(): SecretResolver {
	return {
		resolve: async (secretRef) =>
			secretRef.source === 'config' ? secretRef.value : `resolved:${secretRef.ref}`,
		resolveAll: async () => ({}),
	};
}

function createOpenClawZone(rootPath: string): SystemConfig['zones'][number] {
	return {
		id: 'home',
		gateway: {
			type: 'openclaw',
			imageProfile: 'openclaw',
			memory: '2G',
			cpus: 2,
			port: 18791,
			config: path.join(rootPath, 'openclaw.json'),
			stateDir: path.join(rootPath, 'state'),
			zoneFilesDir: path.join(rootPath, 'zone-files'),
			authProfilesByAgent: {},
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
		websocketBypass: [],
		defaultToolVmProfile: 'standard',
		agentToolVmProfiles: {},
		agentSandboxSeeds: {
			shravan: [
				{
					source: { source: '1password', ref: 'op://vault/gcloud-config' },
					target: '.config/gcloud/configurations/config_default',
					mode: 0o600,
				},
			],
		},
	};
}

describe('seedAgentSandboxWorkspace', () => {
	it('writes configured per-agent seed files into the sandbox workspace on first boot', async () => {
		const rootPath = await createTempDirectory('agent-vm-sandbox-seed-');
		const zone = createOpenClawZone(rootPath);
		const hostWorkMountDir = path.join(zone.gateway.stateDir, 'sandboxes', 'agent-shravan', 'work');
		await mkdir(hostWorkMountDir, { recursive: true });

		const result = await seedAgentSandboxWorkspace({
			scopeKey: 'agent:shravan',
			secretResolver: createSecretResolver(),
			hostWorkMountDir,
			zone,
		});

		expect(result).toEqual({
			agentId: 'shravan',
			alreadyExisted: 0,
			hostWorkMountDir: await realpath(hostWorkMountDir),
			kind: 'seeded',
			scopeKey: 'agent:shravan',
			written: 1,
			zoneId: 'home',
		});
		const seededFilePath = path.join(
			hostWorkMountDir,
			'.config',
			'gcloud',
			'configurations',
			'config_default',
		);
		await expect(readFile(seededFilePath, 'utf8')).resolves.toBe(
			'resolved:op://vault/gcloud-config',
		);
		expect((await stat(seededFilePath)).mode & 0o777).toBe(0o600);
	});

	it('does not overwrite an existing seeded file', async () => {
		const rootPath = await createTempDirectory('agent-vm-sandbox-seed-existing-');
		const zone = createOpenClawZone(rootPath);
		const hostWorkMountDir = path.join(zone.gateway.stateDir, 'sandboxes', 'agent-shravan', 'work');
		const seededFilePath = path.join(
			hostWorkMountDir,
			'.config',
			'gcloud',
			'configurations',
			'config_default',
		);
		await mkdir(path.dirname(seededFilePath), { recursive: true });
		await writeFile(seededFilePath, 'user-edited', 'utf8');

		const result = await seedAgentSandboxWorkspace({
			scopeKey: 'agent:shravan',
			secretResolver: createSecretResolver(),
			hostWorkMountDir,
			zone,
		});

		expect(result).toEqual({
			agentId: 'shravan',
			alreadyExisted: 1,
			hostWorkMountDir: await realpath(hostWorkMountDir),
			kind: 'seeded',
			scopeKey: 'agent:shravan',
			written: 0,
			zoneId: 'home',
		});
		await expect(readFile(seededFilePath, 'utf8')).resolves.toBe('user-edited');
	});

	it('writes config-backed seed files into the sandbox workspace', async () => {
		const rootPath = await createTempDirectory('agent-vm-sandbox-seed-config-');
		const zone = {
			...createOpenClawZone(rootPath),
			agentSandboxSeeds: {
				shravan: [
					{
						source: { source: 'config' as const, value: 'inline gcloud config' },
						target: '.config/gcloud/configurations/config_default',
						mode: 0o600,
					},
				],
			},
		} satisfies SystemConfig['zones'][number];
		const hostWorkMountDir = path.join(zone.gateway.stateDir, 'sandboxes', 'agent-shravan', 'work');
		await mkdir(hostWorkMountDir, { recursive: true });

		const result = await seedAgentSandboxWorkspace({
			scopeKey: 'agent:shravan',
			secretResolver: createSecretResolver(),
			hostWorkMountDir,
			zone,
		});

		expect(result.kind).toBe('seeded');
		await expect(
			readFile(
				path.join(hostWorkMountDir, '.config', 'gcloud', 'configurations', 'config_default'),
				'utf8',
			),
		).resolves.toBe('inline gcloud config');
	});

	it('seeds Discord sub-scopes for the owning agent', async () => {
		const rootPath = await createTempDirectory('agent-vm-sandbox-seed-discord-');
		const zone = createOpenClawZone(rootPath);
		const hostWorkMountDir = path.join(zone.gateway.stateDir, 'sandboxes', 'agent-shravan', 'work');
		await mkdir(hostWorkMountDir, { recursive: true });

		const result = await seedAgentSandboxWorkspace({
			scopeKey: 'agent:shravan:discord:channel:123:thread:456',
			secretResolver: createSecretResolver(),
			hostWorkMountDir,
			zone,
		});

		expect(result.kind).toBe('seeded');
		await expect(
			readFile(
				path.join(hostWorkMountDir, '.config', 'gcloud', 'configurations', 'config_default'),
				'utf8',
			),
		).resolves.toBe('resolved:op://vault/gcloud-config');
	});

	it('does not apply another agent seed to an unconfigured agent', async () => {
		const rootPath = await createTempDirectory('agent-vm-sandbox-seed-isolation-');
		const zone = createOpenClawZone(rootPath);
		const hostWorkMountDir = path.join(
			zone.gateway.stateDir,
			'sandboxes',
			'agent-alevtina',
			'work',
		);
		await mkdir(hostWorkMountDir, { recursive: true });

		const result = await seedAgentSandboxWorkspace({
			scopeKey: 'agent:alevtina',
			secretResolver: createSecretResolver(),
			hostWorkMountDir,
			zone,
		});

		expect(result).toEqual({
			agentId: 'alevtina',
			kind: 'no-seeds-configured',
			scopeKey: 'agent:alevtina',
			zoneId: 'home',
		});
		await expect(
			readFile(
				path.join(hostWorkMountDir, '.config', 'gcloud', 'configurations', 'config_default'),
			),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('seeds when the configured stateDir resolves through a symlink', async () => {
		const rootPath = await createTempDirectory('agent-vm-sandbox-seed-symlink-');
		const realStateDir = path.join(rootPath, 'real-state');
		const linkedStateDir = path.join(rootPath, 'linked-state');
		await mkdir(realStateDir, { recursive: true });
		await symlink(realStateDir, linkedStateDir, 'dir');
		const zone = createOpenClawZone(rootPath);
		zone.gateway.stateDir = linkedStateDir;
		const hostWorkMountDir = path.join(realStateDir, 'sandboxes', 'agent-shravan', 'work');
		await mkdir(hostWorkMountDir, { recursive: true });

		const result = await seedAgentSandboxWorkspace({
			scopeKey: 'agent:shravan',
			secretResolver: createSecretResolver(),
			hostWorkMountDir,
			zone,
		});

		expect(result.kind).toBe('seeded');
		await expect(
			readFile(
				path.join(hostWorkMountDir, '.config', 'gcloud', 'configurations', 'config_default'),
				'utf8',
			),
		).resolves.toBe('resolved:op://vault/gcloud-config');
	});

	it('does not seed shared zone files workspaces', async () => {
		const rootPath = await createTempDirectory('agent-vm-sandbox-seed-zone-files-');
		const zone = createOpenClawZone(rootPath);
		if (zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw fixture zone');
		}
		const hostWorkMountDir = path.join(zone.gateway.zoneFilesDir, 'project');
		await mkdir(path.join(zone.gateway.stateDir, 'sandboxes'), { recursive: true });
		await mkdir(hostWorkMountDir, { recursive: true });

		const result = await seedAgentSandboxWorkspace({
			scopeKey: 'agent:shravan',
			secretResolver: createSecretResolver(),
			hostWorkMountDir,
			zone,
		});

		const sandboxRoot = await realpath(path.join(zone.gateway.stateDir, 'sandboxes'));
		const resolvedWorkMountDir = await realpath(hostWorkMountDir);
		expect(result).toEqual({
			agentId: 'shravan',
			kind: 'work-mount-outside-sandbox',
			sandboxRoot,
			scopeKey: 'agent:shravan',
			hostWorkMountDir: resolvedWorkMountDir,
			zoneId: 'home',
		});
		await expect(
			readFile(
				path.join(hostWorkMountDir, '.config', 'gcloud', 'configurations', 'config_default'),
			),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('returns work-mount-missing when the resolved work mount disappears before seeding', async () => {
		const rootPath = await createTempDirectory('agent-vm-sandbox-seed-missing-work-');
		const zone = createOpenClawZone(rootPath);
		const hostWorkMountDir = path.join(zone.gateway.stateDir, 'sandboxes', 'agent-shravan', 'work');
		await mkdir(path.join(zone.gateway.stateDir, 'sandboxes'), { recursive: true });

		const result = await seedAgentSandboxWorkspace({
			scopeKey: 'agent:shravan',
			secretResolver: createSecretResolver(),
			hostWorkMountDir,
			zone,
		});

		expect(result).toEqual({
			agentId: 'shravan',
			kind: 'work-mount-missing',
			scopeKey: 'agent:shravan',
			hostWorkMountDir,
			zoneId: 'home',
		});
	});

	it('rejects seed parent symlinks before resolving secrets', async () => {
		const rootPath = await createTempDirectory('agent-vm-sandbox-seed-parent-link-');
		const zone = createOpenClawZone(rootPath);
		const hostWorkMountDir = path.join(zone.gateway.stateDir, 'sandboxes', 'agent-shravan', 'work');
		const outsideDir = path.join(rootPath, 'outside');
		await mkdir(hostWorkMountDir, { recursive: true });
		await mkdir(outsideDir, { recursive: true });
		await symlink(outsideDir, path.join(hostWorkMountDir, '.config'), 'dir');
		const secretResolver = {
			resolve: vi.fn(async (secretRef) => `resolved:${secretRef.ref}`),
			resolveAll: vi.fn(async () => ({})),
		} satisfies SecretResolver;

		await expect(
			seedAgentSandboxWorkspace({
				scopeKey: 'agent:shravan',
				secretResolver,
				hostWorkMountDir,
				zone,
			}),
		).rejects.toThrow(SandboxSeedingError);
		await expect(
			seedAgentSandboxWorkspace({
				scopeKey: 'agent:shravan',
				secretResolver,
				hostWorkMountDir,
				zone,
			}),
		).rejects.toMatchObject({ kind: 'parent-symlink' });
		expect(secretResolver.resolve).not.toHaveBeenCalled();
		await expect(
			readFile(path.join(outsideDir, 'gcloud', 'configurations', 'config_default'), 'utf8'),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('revalidates seed parents after resolving secrets and before writing', async () => {
		const rootPath = await createTempDirectory('agent-vm-sandbox-seed-parent-race-');
		const zone = createOpenClawZone(rootPath);
		const hostWorkMountDir = path.join(zone.gateway.stateDir, 'sandboxes', 'agent-shravan', 'work');
		const seedParentPath = path.join(hostWorkMountDir, '.config', 'gcloud', 'configurations');
		const outsideDir = path.join(rootPath, 'outside');
		await mkdir(seedParentPath, { recursive: true });
		await mkdir(outsideDir, { recursive: true });
		const secretResolver = {
			resolve: vi.fn(async (secretRef) => {
				await rm(seedParentPath, { recursive: true, force: true });
				await symlink(outsideDir, seedParentPath, 'dir');
				return `resolved:${secretRef.ref}`;
			}),
			resolveAll: vi.fn(async () => ({})),
		} satisfies SecretResolver;

		await expect(
			seedAgentSandboxWorkspace({
				scopeKey: 'agent:shravan',
				secretResolver,
				hostWorkMountDir,
				zone,
			}),
		).rejects.toMatchObject({ kind: 'parent-symlink' });
		expect(secretResolver.resolve).toHaveBeenCalledTimes(1);
		await expect(readFile(path.join(outsideDir, 'config_default'), 'utf8')).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('returns a malformed result for unsafe agent scope ids', async () => {
		const rootPath = await createTempDirectory('agent-vm-sandbox-seed-malformed-');
		const zone = createOpenClawZone(rootPath);
		const hostWorkMountDir = path.join(zone.gateway.stateDir, 'sandboxes', 'agent-shravan', 'work');
		await mkdir(hostWorkMountDir, { recursive: true });

		await expect(
			seedAgentSandboxWorkspace({
				scopeKey: 'agent:../shravan',
				secretResolver: createSecretResolver(),
				hostWorkMountDir,
				zone,
			}),
		).resolves.toEqual({
			kind: 'malformed-agent-scope',
			reason: "invalid agent id '../shravan'",
			scopeKey: 'agent:../shravan',
			zoneId: 'home',
		});
	});
});
