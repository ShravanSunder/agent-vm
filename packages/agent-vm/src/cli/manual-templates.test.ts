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
		expect(content).toContain('docs/manual/gateway-ingress.md');
		expect(content).toContain('lease-heartbeat');
		expect(content).toContain('docs/manual/mcp-portal.md');
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
			'docs/manual/tool-vm-leases.md',
			'docs/manual/operations.md',
			'docs/manual/openclaw.md',
			'docs/manual/gateway-ingress.md',
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
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).toContain(
			'*.discord.gg',
		);
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).toContain(
			'*.discord.media',
		);
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).toContain(
			'gateway-us-east1-c.discord.gg:443',
		);
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).toContain(
			'wildcard websocketBypass',
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
		const gatewayIngressManual = files.find((file) =>
			file.relativePath.endsWith('gateway-ingress.md'),
		)?.content;
		expect(gatewayIngressManual).toContain('zones[].gateway.port');
		expect(gatewayIngressManual).toContain('SSE streaming');
		expect(gatewayIngressManual).toContain('additional Gondolin ingress routes');
		expect(gatewayIngressManual).toContain('Raw TCP services are not HTTP ingress');
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
		expect(imageVersioningManual).toContain('openClawPackageOverrides');
		expect(imageVersioningManual).toContain('cacheDir/generated-dockerfiles');
		expect(imageVersioningManual).toContain('validation tool mirror');
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'Zones scaffold controller SSH adminAccess as mode: "none"',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'agent-vm controller ssh --zone <zoneId>',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'--all-secrets',
		);
		expect(
			files.find((file) => file.relativePath.endsWith('gateway-ingress.md'))?.content,
		).toContain('Use "openclaw" or "openclaw/<agentId>"');
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'Controller SSH opens an interactive shell only',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'Do not use it as a one-shot command runner',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'agent-vm auth openclaw <provider> --zone <zoneId>',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'--all-agents to repeat the same provider login',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'agent-vm auth codex-harness --zone <zoneId> --agent <agentId>',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'Managed OpenClaw gateway builds install the native Codex CLI version pinned by managed-images.json',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'@openai/codex',
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
		).toContain('approvals.plugin.mode');
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'approvals.plugin.mode=session',
		);
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
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'private-network upstream URLs',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'Prefer http-mediation for MCP provider API keys, including stdio providers',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'Use raw env injection only as an explicit exception',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'authored config is trusted deployment config',
		);
		expect(
			files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content,
		).not.toContain('loopback server in the gateway');
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('message_tool_only');
		expect(files.find((file) => file.relativePath.endsWith('README.md'))?.content).toContain(
			'runtime-paths.md explains /workspace, /work, and other in-VM paths',
		);
		expect(files.find((file) => file.relativePath.endsWith('README.md'))?.content).toContain(
			'tool-vm-leases.md explains agent-keyed Tool VM lease identity and reuse',
		);
		expect(files.find((file) => file.relativePath.endsWith('README.md'))?.content).toContain(
			'health snapshots',
		);
		expect(
			files.find((file) => file.relativePath.endsWith('tool-vm-leases.md'))?.content,
		).toContain('The lease identity remains zoneId + agentId');
		expect(files.some((file) => file.relativePath.endsWith('scope.md'))).toBe(false);
		expect(files.find((file) => file.relativePath.endsWith('layout.md'))?.content).toContain(
			'OpenClaw Tool VMs mount the validated lease work mount at /workspace',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'OpenClaw Tool VMs run commands in the lease workdir returned by the controller',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'/workspace is the Tool VM guest RealFS mount',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'/work is Tool VM-local rootfs/COW scratch',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'The OpenClaw plugin may accept Tool VM guest cwd intent',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'The controller `/lease workMountDir` is stricter',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'Direct Tool VM guest paths such as `/workspace` and `/work` are rejected at the controller boundary',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'workMountDir',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'hostWorkMountDir',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'binds the controller port before recovery',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'uses `lsof` to check TCP listener ownership',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'persistent zone files live at /zone',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'worker repo edits live under /work/repos',
		);
		const toolVmLeaseManual = files.find((file) =>
			file.relativePath.endsWith('tool-vm-leases.md'),
		)?.content;
		expect(toolVmLeaseManual).toContain('defaultToolVmProfile');
		expect(toolVmLeaseManual).toContain('one compatible Tool VM per zone and OpenClaw agent id');
		expect(toolVmLeaseManual).toContain('discarded before the controller lease request');
		expect(toolVmLeaseManual).not.toContain('scopeKey');
		expect(toolVmLeaseManual).toContain('active shell/file operations heartbeat per-use records');
		expect(toolVmLeaseManual).toContain('lease-heartbeat');
		expect(toolVmLeaseManual).toContain('lease-renew');
		expect(files.find((file) => file.relativePath.endsWith('operations.md'))?.content).toContain(
			'GET /zones/<zoneId>/health-snapshot',
		);
		const operationsManual = files.find((file) =>
			file.relativePath.endsWith('operations.md'),
		)?.content;
		expect(operationsManual).toContain('gateway-recovery');
		expect(operationsManual).toContain('gateway-recovery-suspended');
		expect(operationsManual).toContain(
			'10 consecutive gateway-service or gateway-control-link failures',
		);
		expect(operationsManual).toContain('61 minute cooldown');
		expect(operationsManual).toContain('3 consecutive failed automatic recoveries');
		expect(files.find((file) => file.relativePath.endsWith('operations.md'))?.content).toContain(
			'Health timeouts are operation-specific',
		);
		expect(files.find((file) => file.relativePath.endsWith('openclaw.md'))?.content).toContain(
			'The controller is the control plane',
		);
		expect(files.find((file) => file.relativePath.endsWith('openclaw.md'))?.content).toContain(
			'OpenClaw application heartbeat turns are not infrastructure health checks',
		);
		expect(files.find((file) => file.relativePath.endsWith('openclaw.md'))?.content).toContain(
			'gateway-to-Tool-VM SSH data path',
		);
		expect(files.find((file) => file.relativePath.endsWith('tool-access.md'))?.content).toContain(
			'agentToolVmProfiles',
		);
		expect(
			files.find((file) => file.relativePath.endsWith('per-agent-setup.md'))?.content,
		).toContain('gateway.authProfilesByAgent');
		expect(
			files.find((file) => file.relativePath.endsWith('per-agent-setup.md'))?.content,
		).toContain('auth openclaw <provider> --all-agents repeats');
		expect(
			files.find((file) => file.relativePath.endsWith('per-agent-setup.md'))?.content,
		).toContain('codex-harness --all-agents runs one device-auth session per agent');
		expect(files.map((file) => file.content).join('\n')).not.toContain('toolProfile');
		expect(files.map((file) => file.content).join('\n')).not.toContain('toolProfiles');
		expect(files.map((file) => file.content).join('\n')).not.toContain('/home/openclaw/zone-files');
		expect(files.map((file) => file.content).join('\n')).not.toContain('stable workspace');
		expect(files.map((file) => file.content).join('\n')).not.toContain('one workspace');
		expect(files.map((file) => file.content).join('\n')).not.toContain('which workspace');
		expect(files.map((file) => file.content).join('\n')).not.toContain('allowedHosts');
	});

	it('documents graceful stop and scoped offline cleanup without broad qemu pkill', () => {
		const files = buildManualTemplateFiles({
			defaultZoneId: 'beta',
			systemConfigPath: 'config/system.jsonc',
		});

		const operations = files.find((file) => file.relativePath === 'docs/manual/operations.md');
		expect(operations?.content).toContain('agent-vm controller stop --config config/system.jsonc');
		expect(operations?.content).toContain(
			'agent-vm controller cleanup --config config/system.jsonc --zone beta',
		);
		expect(operations?.content).toContain('--force');
		expect(operations?.content).not.toContain('pkill -f qemu-system');
	});
});
