import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SystemConfig } from '../../config/system-config.js';
import { resolveLeaseWorkspaceDir } from './lease-workspace-paths.js';

type ZoneConfig = SystemConfig['zones'][number];

describe('resolveLeaseWorkspaceDir', () => {
	let tempDir: string;
	let zoneFilesDir: string;
	let stateDir: string;
	let zone: ZoneConfig;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), 'agent-vm-lease-workspace-'));
		zoneFilesDir = path.join(tempDir, 'zone-files', 'shravan');
		stateDir = path.join(tempDir, 'state', 'shravan');
		await mkdir(path.join(zoneFilesDir, 'project'), { recursive: true });
		await mkdir(path.join(stateDir, 'sandboxes', 'agent', 'work'), { recursive: true });
		zone = {
			allowedHosts: ['api.openai.com'],
			gateway: {
				type: 'openclaw',
				imageProfile: 'openclaw',
				cpus: 2,
				memory: '2G',
				config: path.join(tempDir, 'openclaw.json'),
				port: 18791,
				stateDir,
				zoneFilesDir,
			},
			id: 'shravan',
			secrets: {},
			toolProfile: 'standard',
			websocketBypass: [],
		};
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('maps OpenClaw gateway sandbox paths to host stateDir sandboxes', async () => {
		await expect(
			resolveLeaseWorkspaceDir({
				workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
				zone,
			}),
		).resolves.toBe(await realpath(path.join(stateDir, 'sandboxes', 'agent', 'work')));
	});

	it('maps OpenClaw gateway zone-files paths to host zoneFilesDir', async () => {
		await expect(
			resolveLeaseWorkspaceDir({
				workspaceDir: '/home/openclaw/zone-files/project',
				zone,
			}),
		).resolves.toBe(await realpath(path.join(zoneFilesDir, 'project')));
	});

	it('rejects traversal before path translation', async () => {
		await expect(
			resolveLeaseWorkspaceDir({
				workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/../../../etc',
				zone,
			}),
		).rejects.toThrow(/must not contain '\.\.' path segments/u);
		await expect(
			resolveLeaseWorkspaceDir({
				workspaceDir: '/home/openclaw/zone-files/../../../etc',
				zone,
			}),
		).rejects.toThrow(/must not contain '\.\.' path segments/u);
	});

	it('rejects symlinks that resolve outside allowed roots', async () => {
		const sensitiveDir = path.join(tempDir, 'sensitive');
		const linkPath = path.join(stateDir, 'sandboxes', 'agent', 'ssh-link');
		await mkdir(sensitiveDir, { recursive: true });
		await symlink(sensitiveDir, linkPath);

		await expect(
			resolveLeaseWorkspaceDir({
				workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/agent/ssh-link',
				zone,
			}),
		).rejects.toThrow(/outside allowed OpenClaw tool workspace roots/u);
	});

	it('rejects cache runtime and unrelated host paths', async () => {
		const unrelatedPath = path.join(tempDir, 'cache', 'project');
		await mkdir(unrelatedPath, { recursive: true });

		await expect(
			resolveLeaseWorkspaceDir({
				workspaceDir: unrelatedPath,
				zone,
			}),
		).rejects.toThrow(/outside allowed OpenClaw tool workspace roots/u);
	});
});
