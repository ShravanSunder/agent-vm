import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scaffoldAgentVmProject } from '../cli/init-command.js';

async function parseJsonFile(filePath: string): Promise<Record<string, unknown>> {
	const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
	if (typeof parsed !== 'object' || parsed === null) {
		throw new TypeError(`Expected JSON object at ${filePath}`);
	}
	return parsed as Record<string, unknown>;
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

		const gatewayBuildConfig = await parseJsonFile(
			path.join(projectDirectory, 'vm-images', 'gateways', 'openclaw', 'build-config.json'),
		);
		const toolBuildConfig = await parseJsonFile(
			path.join(projectDirectory, 'vm-images', 'tool-vms', 'default', 'build-config.json'),
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
		expect(
			await fs.readFile(
				path.join(projectDirectory, 'vm-images', 'gateways', 'openclaw', 'Dockerfile'),
				'utf8',
			),
		).toContain('COPY vendor/gondolin /home/openclaw/.openclaw/extensions/gondolin');
	});
});
