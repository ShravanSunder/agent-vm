import { describe, expect, it } from 'vitest';

import {
	GENERATED_MANUAL_MARKER,
	buildAgentVmAgentsTemplate,
	buildManualTemplateFiles,
} from './manual-templates.js';

describe('manual templates', () => {
	it('builds an agent-facing AGENTS.md index that points at the manual', () => {
		const content = buildAgentVmAgentsTemplate({
			defaultZoneId: 'shravan',
			systemConfigPath: 'config/system.json',
		});

		expect(content).toContain(GENERATED_MANUAL_MARKER);
		expect(content).toContain('docs/manual/README.md');
		expect(content).toContain('config/system.json');
		expect(content).toContain('shravan');
		expect(content).toContain('Do not silently edit privileged host/deployment config');
		expect(content).not.toContain('Discord is enabled by default');
	});

	it('builds progressive manual files for humans and agents', () => {
		const files = buildManualTemplateFiles({
			defaultZoneId: 'shravan',
			systemConfigPath: 'config/system.json',
		});

		expect(files.map((file) => file.relativePath)).toEqual([
			'docs/manual/README.md',
			'docs/manual/layout.md',
			'docs/manual/scope.md',
			'docs/manual/openclaw.md',
			'docs/manual/agent-worker.md',
			'docs/manual/secrets.md',
			'docs/manual/tool-access.md',
			'docs/manual/channels.md',
			'docs/manual/runtime-paths.md',
			'docs/manual/per-agent-setup.md',
			'docs/manual/migration-discord.md',
			'docs/manual/troubleshooting.md',
		]);
		expect(files.every((file) => file.content.includes(GENERATED_MANUAL_MARKER))).toBe(true);
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).toContain(
			'DISCORD_BOT_TOKEN',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'OpenClaw Tool VMs run commands in /work',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'worker repo edits live under /work/repos',
		);
	});
});
