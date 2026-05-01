import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { SecretResolver } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../../config/system-config.js';
import { seedAgentSandboxWorkspace } from './agent-sandbox-seeding.js';

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
		resolve: async (secretRef) => `resolved:${secretRef.ref}`,
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
		secrets: {},
		allowedHosts: ['api.openai.com'],
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
		const workspaceDir = path.join(zone.gateway.stateDir, 'sandboxes', 'agent-shravan', 'work');
		await mkdir(workspaceDir, { recursive: true });

		const result = await seedAgentSandboxWorkspace({
			scopeKey: 'agent:shravan',
			secretResolver: createSecretResolver(),
			workspaceDir,
			zone,
		});

		expect(result).toEqual({
			agentId: 'shravan',
			alreadyExisted: 0,
			kind: 'seeded',
			scopeKey: 'agent:shravan',
			written: 1,
			zoneId: 'home',
		});
		const seededFilePath = path.join(
			workspaceDir,
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
		const workspaceDir = path.join(zone.gateway.stateDir, 'sandboxes', 'agent-shravan', 'work');
		const seededFilePath = path.join(
			workspaceDir,
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
			workspaceDir,
			zone,
		});

		expect(result).toEqual({
			agentId: 'shravan',
			alreadyExisted: 1,
			kind: 'seeded',
			scopeKey: 'agent:shravan',
			written: 0,
			zoneId: 'home',
		});
		await expect(readFile(seededFilePath, 'utf8')).resolves.toBe('user-edited');
	});

	it('seeds Discord sub-scopes for the owning agent', async () => {
		const rootPath = await createTempDirectory('agent-vm-sandbox-seed-discord-');
		const zone = createOpenClawZone(rootPath);
		const workspaceDir = path.join(zone.gateway.stateDir, 'sandboxes', 'agent-shravan', 'work');
		await mkdir(workspaceDir, { recursive: true });

		const result = await seedAgentSandboxWorkspace({
			scopeKey: 'agent:shravan:discord:channel:123:thread:456',
			secretResolver: createSecretResolver(),
			workspaceDir,
			zone,
		});

		expect(result.kind).toBe('seeded');
		await expect(
			readFile(
				path.join(workspaceDir, '.config', 'gcloud', 'configurations', 'config_default'),
				'utf8',
			),
		).resolves.toBe('resolved:op://vault/gcloud-config');
	});

	it('does not apply another agent seed to an unconfigured agent', async () => {
		const rootPath = await createTempDirectory('agent-vm-sandbox-seed-isolation-');
		const zone = createOpenClawZone(rootPath);
		const workspaceDir = path.join(zone.gateway.stateDir, 'sandboxes', 'agent-alevtina', 'work');
		await mkdir(workspaceDir, { recursive: true });

		const result = await seedAgentSandboxWorkspace({
			scopeKey: 'agent:alevtina',
			secretResolver: createSecretResolver(),
			workspaceDir,
			zone,
		});

		expect(result).toEqual({
			agentId: 'alevtina',
			kind: 'no-seeds-configured',
			scopeKey: 'agent:alevtina',
			zoneId: 'home',
		});
		await expect(
			readFile(path.join(workspaceDir, '.config', 'gcloud', 'configurations', 'config_default')),
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
		const workspaceDir = path.join(realStateDir, 'sandboxes', 'agent-shravan', 'work');
		await mkdir(workspaceDir, { recursive: true });

		const result = await seedAgentSandboxWorkspace({
			scopeKey: 'agent:shravan',
			secretResolver: createSecretResolver(),
			workspaceDir,
			zone,
		});

		expect(result.kind).toBe('seeded');
		await expect(
			readFile(
				path.join(workspaceDir, '.config', 'gcloud', 'configurations', 'config_default'),
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
		const workspaceDir = path.join(zone.gateway.zoneFilesDir, 'project');
		await mkdir(path.join(zone.gateway.stateDir, 'sandboxes'), { recursive: true });
		await mkdir(workspaceDir, { recursive: true });

		const result = await seedAgentSandboxWorkspace({
			scopeKey: 'agent:shravan',
			secretResolver: createSecretResolver(),
			workspaceDir,
			zone,
		});

		const sandboxRoot = await realpath(path.join(zone.gateway.stateDir, 'sandboxes'));
		const resolvedWorkspaceDir = await realpath(workspaceDir);
		expect(result).toEqual({
			agentId: 'shravan',
			kind: 'workspace-outside-sandbox',
			sandboxRoot,
			scopeKey: 'agent:shravan',
			workspaceDir: resolvedWorkspaceDir,
			zoneId: 'home',
		});
		await expect(
			readFile(path.join(workspaceDir, '.config', 'gcloud', 'configurations', 'config_default')),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('rejects seed parent symlinks that escape the workspace before resolving secrets', async () => {
		const rootPath = await createTempDirectory('agent-vm-sandbox-seed-parent-link-');
		const zone = createOpenClawZone(rootPath);
		const workspaceDir = path.join(zone.gateway.stateDir, 'sandboxes', 'agent-shravan', 'work');
		const outsideDir = path.join(rootPath, 'outside');
		await mkdir(workspaceDir, { recursive: true });
		await mkdir(outsideDir, { recursive: true });
		await symlink(outsideDir, path.join(workspaceDir, '.config'), 'dir');
		const secretResolver = {
			resolve: vi.fn(async (secretRef) => `resolved:${secretRef.ref}`),
			resolveAll: vi.fn(async () => ({})),
		} satisfies SecretResolver;

		await expect(
			seedAgentSandboxWorkspace({
				scopeKey: 'agent:shravan',
				secretResolver,
				workspaceDir,
				zone,
			}),
		).rejects.toThrow(/resolves outside workspace/u);
		expect(secretResolver.resolve).not.toHaveBeenCalled();
		await expect(
			readFile(path.join(outsideDir, 'gcloud', 'configurations', 'config_default'), 'utf8'),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('returns a malformed result for unsafe agent scope ids', async () => {
		const rootPath = await createTempDirectory('agent-vm-sandbox-seed-malformed-');
		const zone = createOpenClawZone(rootPath);
		const workspaceDir = path.join(zone.gateway.stateDir, 'sandboxes', 'agent-shravan', 'work');
		await mkdir(workspaceDir, { recursive: true });

		await expect(
			seedAgentSandboxWorkspace({
				scopeKey: 'agent:../shravan',
				secretResolver: createSecretResolver(),
				workspaceDir,
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
