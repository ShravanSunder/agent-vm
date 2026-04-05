import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = '/Users/shravansunder/dev/agent-vm';

function parseJsonFile(filePath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

describe('production config artifacts', () => {
	it('ships gateway and tool image build configs plus a shravan OpenClaw config', () => {
		const systemConfig = parseJsonFile(path.join(repoRoot, 'system.json'));
		const gatewayBuildConfig = parseJsonFile(
			path.join(repoRoot, 'images', 'gateway', 'build-config.json'),
		);
		const toolBuildConfig = parseJsonFile(
			path.join(repoRoot, 'images', 'tool', 'build-config.json'),
		);
		const openClawConfig = parseJsonFile(path.join(repoRoot, 'config', 'shravan', 'openclaw.json'));

		expect(systemConfig).toMatchObject({
			host: {
				controllerPort: 18800,
			},
			images: {
				gateway: {
					buildConfig: './images/gateway/build-config.json',
				},
				tool: {
					buildConfig: './images/tool/build-config.json',
				},
			},
		});
		expect(gatewayBuildConfig).toMatchObject({
			arch: 'aarch64',
		});
		expect(toolBuildConfig).toMatchObject({
			arch: 'aarch64',
		});
		expect(openClawConfig).toMatchObject({
			agents: {
				defaults: {
					sandbox: {
						backend: 'gondolin',
						mode: 'all',
					},
				},
			},
			plugins: {
				entries: {
					gondolin: {
						config: {
							controllerUrl: 'http://controller.vm.host:18800',
							zoneId: 'shravan',
						},
						enabled: true,
					},
				},
			},
		});
	});
});
