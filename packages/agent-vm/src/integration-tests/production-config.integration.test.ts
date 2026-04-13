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
	it('ships gateway and tool image build configs', () => {
		const gatewayBuildConfig = parseJsonFile(
			path.join(repoRoot, 'images', 'gateway', 'build-config.json'),
		);
		const toolBuildConfig = parseJsonFile(
			path.join(repoRoot, 'images', 'tool', 'build-config.json'),
		);
		const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');

		expect(envExample).not.toContain('DISCORD_BOT_TOKEN_REF=');
		expect(envExample).not.toContain('PERPLEXITY_API_KEY_REF=');
		expect(envExample).not.toContain('OPENCLAW_GATEWAY_TOKEN_REF=');
		expect(gatewayBuildConfig).toMatchObject({
			arch: 'aarch64',
		});
		expect(toolBuildConfig).toMatchObject({
			arch: 'aarch64',
		});
		expect(
			fs.readFileSync(path.join(repoRoot, 'images', 'gateway', 'Dockerfile'), 'utf8'),
		).toContain('COPY vendor/gondolin /home/openclaw/.openclaw/extensions/gondolin');
	});
});
