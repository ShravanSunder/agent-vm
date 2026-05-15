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
			systemConfigPath: 'config/system.jsonc',
		});

		expect(content).toContain(GENERATED_MANUAL_MARKER);
		expect(content).toContain('docs/manual/README.md');
		expect(content).toContain('config/system.jsonc');
		expect(content).toContain('shravan');
		expect(content).toContain('docs/manual/image-versioning.md');
		expect(content).toContain('Do not silently edit privileged host/deployment config');
		expect(content).not.toContain('Discord is enabled by default');
	});

	it('builds progressive manual files for agents helping end users', () => {
		const files = buildManualTemplateFiles({
			defaultZoneId: 'shravan',
			systemConfigPath: 'config/system.jsonc',
		});

		expect(files.map((file) => file.relativePath)).toEqual([
			'docs/manual/README.md',
			'docs/manual/layout.md',
			'docs/manual/image-versioning.md',
			'docs/manual/scope.md',
			'docs/manual/openclaw.md',
			'docs/manual/openclaw-defaults.md',
			'docs/manual/mcp-portal.md',
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
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).toContain(
			'cdn.discordapp.com',
		);
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).toContain(
			'media.discordapp.net',
		);
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).not.toContain(
			'Add runtimeAuthHints',
		);
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).toContain(
			'Do not add runtimeAuthHints to OpenClaw zones',
		);
		expect(files.find((file) => file.relativePath.endsWith('README.md'))?.content).toContain(
			'coding agents helping end users set up and operate agent-vm deployments',
		);
		expect(
			files.find((file) => file.relativePath.endsWith('troubleshooting.md'))?.content,
		).toContain('blocked URL fetch');
		expect(
			files.find((file) => file.relativePath.endsWith('troubleshooting.md'))?.content,
		).toContain('curl -6');
		expect(
			files.find((file) => file.relativePath.endsWith('troubleshooting.md'))?.content,
		).toContain('allowedInternalHosts');
		const imageVersioningManual = files.find((file) =>
			file.relativePath.endsWith('image-versioning.md'),
		)?.content;
		expect(imageVersioningManual).toContain('There is one owner for each version decision');
		expect(imageVersioningManual).toContain('package.json owns which installed @agent-vm/*');
		expect(imageVersioningManual).toContain('managed-images.json');
		expect(imageVersioningManual).toContain('extraOpenClawPackages');
		expect(imageVersioningManual).toContain('cacheDir/generated-dockerfiles');
		expect(imageVersioningManual).toContain('validation tool mirror');
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'op://agent-vm/<zoneId>-ssh-access/token',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'agent-vm controller ssh --zone <zoneId> --with-secrets',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'Controller SSH opens an interactive shell only',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'Do not use it as a one-shot command runner',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'agent-vm auth-interactive <provider> --zone <zoneId>',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).not.toContain(
			'controller ssh -- <remote command>',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).not.toContain(
			'/execute-command',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'Tool VMs and agent sandboxes do not receive gateway SSH secrets',
		);
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('workspaceAccess');
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('scope is agent');
		expect(files.map((file) => file.content).join('\n')).toContain(
			'Tool VM secrets must use injection http-mediation',
		);
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('plugins.slots.memory');
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('plugins.load.paths');
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('@openclaw/discord');
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('session.dmScope');
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('::ffff:198.18.0.1');
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('@agent-vm/openclaw-agent-vm-plugin');
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('@agent-vm/openclaw-mcp-portal-plugin');
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'mcp_portal_describe',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'Denied tools do not enter',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'diagnostics',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'deny-all',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'trusted only for configured namespaces',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'config/schemas/*.schema.json',
		);
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('message_tool_only');
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'OpenClaw Tool VMs run commands in /work',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'workMountDir',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'hostWorkMountDir',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'persistent zone files live at /zone',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'worker repo edits live under /work/repos',
		);
		expect(files.find((file) => file.relativePath.endsWith('scope.md'))?.content).toContain(
			'defaultToolVmProfile',
		);
		expect(files.find((file) => file.relativePath.endsWith('tool-access.md'))?.content).toContain(
			'agentToolVmProfiles',
		);
		expect(
			files.find((file) => file.relativePath.endsWith('per-agent-setup.md'))?.content,
		).toContain('gateway.authProfilesByAgent');
		expect(files.map((file) => file.content).join('\n')).not.toContain('toolProfile');
		expect(files.map((file) => file.content).join('\n')).not.toContain('toolProfiles');
		expect(files.map((file) => file.content).join('\n')).not.toContain('/home/openclaw/zone-files');
		expect(files.map((file) => file.content).join('\n')).not.toContain('/workspace');
		expect(files.map((file) => file.content).join('\n')).not.toContain('stable workspace');
		expect(files.map((file) => file.content).join('\n')).not.toContain('one workspace');
		expect(files.map((file) => file.content).join('\n')).not.toContain('which workspace');
		expect(files.map((file) => file.content).join('\n')).not.toContain('allowedHosts');
	});
});
