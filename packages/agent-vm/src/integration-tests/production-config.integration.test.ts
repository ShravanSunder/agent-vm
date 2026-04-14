import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scaffoldAgentVmProject } from '../cli/init-command.js';

function parseJsonFile(filePath: string): Record<string, unknown> {
	const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
	if (typeof parsed !== 'object' || parsed === null) {
		throw new TypeError(`Expected JSON object at ${filePath}`);
	}
	return parsed as Record<string, unknown>;
}

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { force: true, recursive: true });
	}
});

describe('production config artifacts', () => {
	it('scaffolds gateway and tool image build configs for production use', async () => {
		const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-production-config-'));
		createdDirectories.push(projectDirectory);
		await scaffoldAgentVmProject(
			{
				gatewayType: 'openclaw',
				targetDir: projectDirectory,
				zoneId: 'shravan',
			},
			{
				copyBundledOpenClawPlugin: async (targetDir: string): Promise<'created' | 'skipped'> => {
					const pluginDirectory = path.join(targetDir, 'images', 'gateway', 'vendor', 'gondolin');
					fs.mkdirSync(pluginDirectory, { recursive: true });
					fs.writeFileSync(
						path.join(pluginDirectory, 'openclaw.plugin.json'),
						'{"id":"gondolin"}\n',
						'utf8',
					);
					return 'created';
				},
				generateAgeIdentityKey: () => undefined,
			},
		);

		const gatewayBuildConfig = parseJsonFile(
			path.join(projectDirectory, 'images', 'gateway', 'build-config.json'),
		);
		const toolBuildConfig = parseJsonFile(
			path.join(projectDirectory, 'images', 'tool', 'build-config.json'),
		);
		const envLocal = fs.readFileSync(path.join(projectDirectory, '.env.local'), 'utf8');

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
			fs.readFileSync(path.join(projectDirectory, 'images', 'gateway', 'Dockerfile'), 'utf8'),
		).toContain('COPY vendor/gondolin /home/openclaw/.openclaw/extensions/gondolin');
	});
});
