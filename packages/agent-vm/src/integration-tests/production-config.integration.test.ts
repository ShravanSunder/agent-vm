import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');

function parseJsonFile(filePath: string): Record<string, unknown> {
	const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
	if (typeof parsed !== 'object' || parsed === null) {
		throw new TypeError(`Expected JSON object at ${filePath}`);
	}
	return parsed as Record<string, unknown>;
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
		const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');

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
			zones: [
				{
					secrets: {
						DISCORD_BOT_TOKEN: {
							injection: 'env',
							ref: 'op://agent-vm/shravan-discord/bot-token',
							source: '1password',
						},
						OPENCLAW_GATEWAY_TOKEN: {
							injection: 'env',
							ref: 'op://agent-vm/shravan-gateway-auth/password',
							source: '1password',
						},
						PERPLEXITY_API_KEY: {
							hosts: ['api.perplexity.ai'],
							injection: 'http-mediation',
							ref: 'op://agent-vm/shravan-perplexity/credential',
							source: '1password',
						},
					},
				},
			],
		});
		expect(envExample).not.toContain('DISCORD_BOT_TOKEN_REF=');
		expect(envExample).not.toContain('PERPLEXITY_API_KEY_REF=');
		expect(envExample).not.toContain('OPENCLAW_GATEWAY_TOKEN_REF=');
		expect(gatewayBuildConfig).toMatchObject({
			arch: 'aarch64',
		});
		expect(toolBuildConfig).toMatchObject({
			arch: 'aarch64',
		});
		expect(openClawConfig).toMatchObject({
			channels: {
				discord: {},
				whatsapp: {},
			},
			agents: {
				defaults: {
					model: {
						primary: 'openai-codex/gpt-5.4',
					},
					sandbox: {
						backend: 'gondolin',
						mode: 'all',
						scope: 'session',
					},
				},
			},
			tools: {
				elevated: {
					enabled: false,
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
