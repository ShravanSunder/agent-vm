import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scaffoldAgentVmProject } from '../cli/init-command.js';
import { loadJsonConfigFile } from '../config/json-config-file.js';

async function loadJsonObjectConfigFile(filePath: string): Promise<Record<string, unknown>> {
	const parsed = await loadJsonConfigFile(filePath);
	if (typeof parsed !== 'object' || parsed === null) {
		throw new TypeError(`Expected JSONC object at ${filePath}`);
	}
	return Object.fromEntries(Object.entries(parsed));
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

const createdDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		createdDirectories
			.splice(0)
			.map(async (directoryPath) => await fs.rm(directoryPath, { force: true, recursive: true })),
	);
});

describe('production config artifacts', () => {
	it('scaffolds gateway and tool image build configs for production use', async () => {
		const projectDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-production-config-'),
		);
		createdDirectories.push(projectDirectory);
		await scaffoldAgentVmProject(
			{
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
				targetDir: projectDirectory,
				writeLocalEnvironmentFile: true,
				zoneId: 'shravan',
			},
			{
				copyBundledOpenClawPlugin: async (targetDir: string): Promise<'created' | 'skipped'> => {
					const pluginDirectory = path.join(
						targetDir,
						'vm-images',
						'gateways',
						'openclaw',
						'vendor',
						'gondolin',
					);
					await fs.mkdir(pluginDirectory, { recursive: true });
					await fs.writeFile(
						path.join(pluginDirectory, 'openclaw.plugin.json'),
						'{"id":"gondolin"}\n',
						'utf8',
					);
					return 'created';
				},
			},
		);

		const gatewayBuildConfig = await loadJsonObjectConfigFile(
			path.join(projectDirectory, 'vm-images', 'gateways', 'openclaw', 'build-config.jsonc'),
		);
		const gatewayOverlayConfig = await loadJsonObjectConfigFile(
			path.join(projectDirectory, 'vm-images', 'gateways', 'openclaw', 'overlay.jsonc'),
		);
		const systemConfig = await loadJsonObjectConfigFile(
			path.join(projectDirectory, 'config', 'system.jsonc'),
		);
		const toolBuildConfig = await loadJsonObjectConfigFile(
			path.join(projectDirectory, 'vm-images', 'tool-vms', 'default', 'build-config.jsonc'),
		);
		const toolOverlayConfig = await loadJsonObjectConfigFile(
			path.join(projectDirectory, 'vm-images', 'tool-vms', 'default', 'overlay.jsonc'),
		);
		const envLocal = await fs.readFile(path.join(projectDirectory, '.env.local'), 'utf8');

		expect(envLocal).not.toContain('DISCORD_BOT_TOKEN_REF=');
		expect(envLocal).not.toContain('PERPLEXITY_API_KEY_REF=');
		expect(envLocal).not.toContain('OPENCLAW_GATEWAY_TOKEN_REF=');
		expect(gatewayBuildConfig).toMatchObject({
			arch: 'aarch64',
		});
		expect(toolBuildConfig).toMatchObject({
			arch: 'aarch64',
		});
		expect(gatewayOverlayConfig).toMatchObject({
			extraAptPackages: [],
			schemaVersion: 1,
		});
		expect(toolOverlayConfig).toMatchObject({
			extraAptPackages: [],
			schemaVersion: 1,
		});
		expect(systemConfig).toMatchObject({
			imageProfiles: {
				gateways: {
					openclaw: {
						source: {
							base: 'openclaw-gateway',
							kind: 'managedBase',
							overlay: '../vm-images/gateways/openclaw/overlay.jsonc',
						},
					},
				},
				toolVms: {
					default: {
						source: {
							base: 'tool-vm',
							kind: 'managedBase',
							overlay: '../vm-images/tool-vms/default/overlay.jsonc',
						},
					},
				},
			},
		});
		await expect(
			pathExists(path.join(projectDirectory, 'vm-images', 'gateways', 'openclaw', 'Dockerfile')),
		).resolves.toBe(false);
	});
});
