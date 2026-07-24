import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
	GENERATED_MANUAL_MARKER,
	buildAgentVmAgentsTemplate,
	buildManualTemplateFiles,
} from './manual-templates.js';

describe('manual templates', () => {
	it('keeps active OpenClaw docs free of stale single-agent cutover wording', async () => {
		const activeDocPaths = [
			'docs/architecture/openclaw-gateway.md',
			'docs/getting-started/openclaw-guide.md',
			'docs/reference/configuration/system-json.md',
			'docs/subsystems/controller.md',
		] as const;
		const stalePhrases = [
			'exactly one trusted agent',
			'controller-signed agent attestation',
			'OpenClaw zones declaring more than one `zones[].agents` entry during the',
		] as const;

		const activeDocContents = await Promise.all(
			activeDocPaths.map(async (activeDocPath) => ({
				content: await readFile(activeDocPath, 'utf8'),
				path: activeDocPath,
			})),
		);

		for (const activeDocContent of activeDocContents) {
			for (const stalePhrase of stalePhrases) {
				expect(activeDocContent.content, activeDocContent.path).not.toContain(stalePhrase);
			}
		}
	});

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
		expect(content).toContain('docs/manual/observability.md');
		expect(content).toContain('docs/manual/mcp-portal.md');
		expect(content).toContain('Do not silently edit privileged host/deployment config');
		expect(content).not.toContain('Discord is enabled by default');
	});

	it('describes managed Gateway zone files and backups without stale OpenClaw or Git admission claims', () => {
		const files = buildManualTemplateFiles({
			defaultZoneId: 'shravan',
			systemConfigPath: 'config/system.jsonc',
		});
		const generatedManual = files.map((file) => file.content).join('\n');

		expect(generatedManual).toContain(
			'zoneFilesDir stores durable shared zone files and per-agent workspaces for managed Gateway zones.',
		);
		expect(generatedManual).toContain(
			'Generated local, user-dir, and pod scaffolds scope it by host.projectNamespace.',
		);
		expect(generatedManual).not.toContain('per-agent workspaces for OpenClaw zones');
		expect(generatedManual).not.toContain('clean and fully pushed before backup publication');
		expect(generatedManual).toContain(
			'gateway.backupIdentity selects the host-resolved Age identity required by backup create and restore.',
		);
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
			'docs/manual/observability.md',
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
			'gateway.discordBotTokenSecretsByAgent',
		);
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).toContain(
			'exact memory-backed profiles/<profile>/.env files',
		);
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).toContain(
			'secrets.preserve_existing',
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
			'wss://gateway-*.discord.gg/',
		);
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).toContain(
			'Run agent-vm validate',
		);
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).not.toContain(
			'websocketBypass',
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
		const observabilityManual = files.find((file) =>
			file.relativePath.endsWith('observability.md'),
		)?.content;
		expect(observabilityManual).toContain('agent-vm build --no-observability');
		expect(observabilityManual).toContain('host.observability.stack.mode=managed');
		expect(observabilityManual).toContain('host.observability.stack.mode=external');
		expect(observabilityManual).toContain(
			'at least one selected managed OpenClaw or Hermes zone has zones[].observability enabled',
		);
		expect(observabilityManual).toContain('zones[].observability.services');
		expect(observabilityManual).toContain('agent-vm-openclaw, agent-vm-hermes');
		expect(observabilityManual).toContain('Do not author serviceName');
		expect(observabilityManual).toContain(
			'host.observability.stack.scrubbing.responsibility=external-collector',
		);
		expect(observabilityManual).toContain('Controller startup does not start Docker Compose');
		expect(observabilityManual).toContain(
			'External mode checks only the configured OpenTelemetry collector',
		);
		expect(observabilityManual).toContain('controllerStartPolicy=degraded');
		expect(observabilityManual).toContain('host.observability.dataDir');
		expect(observabilityManual).toContain('Gondolin HTTP mediation');
		expect(observabilityManual).toContain(
			'Tool VM SSH is the only managed gateway raw TCP exception',
		);
		expect(observabilityManual).toContain('Never log secrets');
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
		const discordMigrationManual = files.find((file) =>
			file.relativePath.endsWith('migration-discord.md'),
		)?.content;
		expect(discordMigrationManual).toContain(
			'Delete any stale raw WebSocket TCP passthrough field',
		);
		expect(discordMigrationManual).toContain('Run agent-vm validate before rebuilding');
		expect(discordMigrationManual).not.toContain('websocketBypass');
		const imageVersioningManual = files.find((file) =>
			file.relativePath.endsWith('image-versioning.md'),
		)?.content;
		expect(imageVersioningManual).toContain('There is one owner for each version decision');
		expect(imageVersioningManual).toContain('package.json owns which installed @agent-vm/*');
		expect(imageVersioningManual).toContain('managed-images.json');
		expect(imageVersioningManual).toContain('packageOverrides');
		expect(imageVersioningManual).toContain('packageOverrides.pnpm');
		expect(imageVersioningManual).toContain('Do not restate the managed default package set');
		expect(imageVersioningManual).toContain('Managed package defaults');
		expect(imageVersioningManual).toContain(
			'overrides undici@8.5.0[managed-images.json/packageOverrides.pnpm]',
		);
		expect(imageVersioningManual).not.toContain('openclaw@2026.6.8 or @openclaw/discord@2026.6.8');
		expect(imageVersioningManual).not.toContain('openClawPackageOverrides');
		expect(imageVersioningManual).not.toContain('pnpmOverrides');
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
			'agent-vm auth 1password <op-ref-or-url>',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'configured macOS Keychain service/account',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'agent-vm auth openclaw login <provider> --zone <zoneId> --all-configured-profiles',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'Use --dry-run to print the resolved plan without opening SSH.',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'gateway.authLogin.providers.<provider>.profileIds',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'Native Codex-runtime agents use agent-vm auth codex-harness --zone <zoneId> --agent <agentId>',
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
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'agentAccess is required',
		);
		expect(files.find((file) => file.relativePath.endsWith('secrets.md'))?.content).toContain(
			'filters by agentId before resolving secret refs',
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
		expect(files.map((file) => file.content).join('\n')).toContain('declare agentAccess as "all"');
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
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('controller-owned approval surface');
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'The controller approval surface handles managed calls.requiresApproval',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'Any managed namespace that effectively admits a tool through calls.requiresApproval requires zone approvalAccess',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'Static validation and Gateway preflight fail closed when approvalAccess is absent',
		);
		expect(
			files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content,
		).not.toContain('rejects calls.requiresApproval');
		expect(
			files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content,
		).not.toContain('approvals.plugin.mode=session');
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('::ffff:198.18.0.1');
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('@agent-vm/openclaw-agent-vm-plugin');
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).not.toContain('@agent-vm/openclaw-mcp-portal-plugin');
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'tool_portal_describe',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'namespace + name',
		);
		expect(
			files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content,
		).not.toContain('namespace + toolName');
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'Tool Portal is the model-visible',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'Managed Gateway Tool Portal, standalone Tool Portal, and standalone MCP Portal are separate operating surfaces',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'mcp.config.jsonc plus tool-portal.config.jsonc',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'mcp.config.jsonc plus mcp-portal.config.jsonc',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'one common Tool Portal service process beside the selected OpenClaw or Hermes framework process',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'Capability API above is distinct from the managed-only SSH Sandbox API',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'exposes no Tool Portal HTTP/MCP/stdio listener or public ingress',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'Managed Gateway does not load mcp-portal.config.jsonc',
		);
		expect(
			files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content,
		).not.toContain('MCP Portal remains the MCP-provider backend');
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'Denied tools do not enter',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'diagnostics',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'items',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'status',
		);
		expect(
			files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content,
		).not.toContain('results is keyed by request/call id');
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'Namespaces absent from the profile are denied',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'trusted only for configured MCP-provider namespaces',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'every namespace must select an explicit backend.kind',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'mcp_provider, controller_host_action, or tool_vm_runner',
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
			'Live validate follows only active Tool Portal namespaces whose backend.kind is mcp_provider',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'not referenced by an active mcp_provider namespace',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'Store MCP provider secrets as raw values',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'format: { "kind": "bearer" }',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'format: { "kind": "prefix", "prefix": "Token" }',
		);
		expect(files.find((file) => file.relativePath.endsWith('mcp-portal.md'))?.content).toContain(
			'raw secret or mediated placeholder',
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
			'runtime-paths.md explains /workspace, /work, optional /gitdirs, and other in-VM paths',
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
			"OpenClaw Tool VMs expose only the selected agent's filtered durable workspace at /workspace",
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'Managed OpenClaw Tool VMs run commands in rootfs/COW /work by default',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'/work is disposable execution space and is deleted with the Tool VM',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			"/workspace is the current agent's filtered durable RealFS workspace",
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'/gitdirs/workspace.git is present only when the current agent enables zones[].agents[].workspaceGit',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'workspaceDir. In managed mode it must identify the configured agent workspace under /zone/agents/<agentId>',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'never sends the Gateway path or a host path as Tool VM storage authority',
		);
		expect(files.find((file) => file.relativePath.endsWith('layout.md'))?.content).toContain(
			'controllerStateDir is required',
		);
		expect(files.find((file) => file.relativePath.endsWith('layout.md'))?.content).toContain(
			'never mounted into a Gateway or Tool VM',
		);
		expect(files.find((file) => file.relativePath.endsWith('layout.md'))?.content).toContain(
			'controllerStateDir/zones/<zoneId>',
		);
		expect(files.find((file) => file.relativePath.endsWith('layout.md'))?.content).toContain(
			'worker-tasks/<taskId>/gateway-runtime.json',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'acquires <controllerRuntimeDir>/vm-ownership/controller-ownership.lock before secret resolution',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'controllerStateDir/zones/<zoneId>/tool-leases/<recordId>.json',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'Controller restart adopts no VM',
		);
		expect(files.find((file) => file.relativePath.endsWith('runtime-paths.md'))?.content).toContain(
			'HTTP health and telemetry remain diagnostic only',
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
		expect(toolVmLeaseManual).toContain('one compatible Tool VM per zone and Agent VM agent id');
		expect(toolVmLeaseManual).toContain(
			'filtered durable workspace at /workspace and disposable rootfs/COW work at /work',
		);
		expect(toolVmLeaseManual).toContain(
			'Caller-supplied Gateway or host paths do not select storage',
		);
		expect(toolVmLeaseManual).toContain(
			'Managed OpenClaw and Hermes support multiple declared agents in the same zone',
		);
		expect(toolVmLeaseManual).toContain(
			'common Tool Portal service owns current-epoch agent bindings, per-agent strict SSH connections',
		);
		expect(toolVmLeaseManual).toContain(
			'sends typed requests to the common Tool Portal service over the private UDS',
		);
		expect(toolVmLeaseManual).toContain('old lease id is correlation only, not authority');
		expect(toolVmLeaseManual).toContain('No later shell, file, exec, heartbeat, or finalize work');
		expect(toolVmLeaseManual).toContain(
			'Framework integrations never receive lease ids or SSH material',
		);
		expect(toolVmLeaseManual).not.toContain('controller lease request');
		expect(toolVmLeaseManual).not.toContain('GET lease');
		expect(toolVmLeaseManual).not.toContain('POST renew');
		expect(toolVmLeaseManual).not.toContain('scopeKey');
		expect(toolVmLeaseManual).not.toContain('gateway_control_rpc');
		expect(toolVmLeaseManual).toContain('lease-heartbeat');
		expect(toolVmLeaseManual).toContain('lease-renew');
		expect(files.find((file) => file.relativePath.endsWith('operations.md'))?.content).toContain(
			'GET /zones/<zoneId>/health-snapshot',
		);
		const operationsManual = files.find((file) =>
			file.relativePath.endsWith('operations.md'),
		)?.content;
		expect(operationsManual).toContain('agent-vm controller health --config');
		expect(operationsManual).toContain('agent-vm controller service-health --config');
		expect(operationsManual).toContain('agent-vm controller health-snapshot --config');
		expect(operationsManual).toContain('gateway-recovery');
		expect(operationsManual).toContain('gateway-recovery-suspended');
		expect(operationsManual).toContain('whole-Gateway VM recovery');
		expect(operationsManual).toContain('neither supervises or restarts the other');
		expect(operationsManual).toContain('61 minute cooldown');
		expect(operationsManual).toContain('3 consecutive failed automatic Gateway recoveries');
		expect(operationsManual).toContain(
			'gateway infrastructure, gateway service, channel-provider, and Tool VM lease health',
		);
		expect(operationsManual).toContain('agent-channel-provider-health');
		expect(operationsManual).toContain('unhealthy-recoverable');
		expect(operationsManual).toContain('unhealthy-unrecoverable');
		expect(operationsManual).toContain('secret-resolution-failed is a recovery blocker');
		expect(operationsManual).toContain('<controllerRuntimeDir>/controller-health/events.jsonl');
		expect(operationsManual).toContain(
			'schema-v2 runtime records plus revalidated process and endpoint identity',
		);
		expect(operationsManual).toContain('exported telemetry are not lifecycle authority');
		expect(operationsManual).toContain('controller_final');
		expect(operationsManual).toContain('stale_to_reacquired');
		expect(operationsManual).toContain(
			'tool-vm-ssh lifecycle events distinguish Tool Portal service observations',
		);
		expect(operationsManual).not.toContain('plugin observations');
		expect(operationsManual).toContain(
			'Tool VM lease failures retire or quarantine one lease before gateway restart',
		);
		expect(files.find((file) => file.relativePath.endsWith('operations.md'))?.content).toContain(
			'Health timeouts are operation-specific',
		);
		expect(files.find((file) => file.relativePath.endsWith('openclaw.md'))?.content).toContain(
			'The controller remains durable lease authority',
		);
		expect(files.find((file) => file.relativePath.endsWith('openclaw.md'))?.content).toContain(
			'ToolPortalService owns current-epoch bindings, per-agent strict SSH connections',
		);
		expect(files.find((file) => file.relativePath.endsWith('openclaw.md'))?.content).toContain(
			'OpenClaw application heartbeat turns are not infrastructure health checks',
		);
		expect(files.find((file) => file.relativePath.endsWith('openclaw.md'))?.content).toContain(
			'gateway-to-Tool-VM SSH data path',
		);
		expect(files.find((file) => file.relativePath.endsWith('openclaw.md'))?.content).toContain(
			'Channel-provider details stay inside OpenClaw/plugin payloads',
		);
		expect(files.find((file) => file.relativePath.endsWith('openclaw.md'))?.content).toContain(
			'The controller branches only on generic channel-provider health',
		);
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('agents.defaults.model.primary is openai/gpt-5.5');
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('agents.defaults.models["openai/gpt-5.5"].agentRuntime.id is pi');
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).not.toContain('openai-codex/gpt-5.5 with thinkingDefault low');
		expect(files.find((file) => file.relativePath.endsWith('tool-access.md'))?.content).toContain(
			'agentToolVmProfiles',
		);
		expect(files.find((file) => file.relativePath.endsWith('tool-access.md'))?.content).toContain(
			'Managed OpenClaw zones may declare multiple trusted agents',
		);
		expect(
			files.find((file) => file.relativePath.endsWith('per-agent-setup.md'))?.content,
		).toContain('gateway.authProfilesByAgent');
		expect(
			files.find((file) => file.relativePath.endsWith('per-agent-setup.md'))?.content,
		).toContain('auth openclaw login <provider> --all-configured-profiles logs in');
		expect(
			files.find((file) => file.relativePath.endsWith('per-agent-setup.md'))?.content,
		).toContain('Use --dry-run before a refresh');
		expect(
			files.find((file) => file.relativePath.endsWith('per-agent-setup.md'))?.content,
		).toContain('Native Codex-runtime agents use codex-harness --all-agents');
		expect(
			files.find((file) => file.relativePath.endsWith('per-agent-setup.md'))?.content,
		).toContain('controller-owned workspace_git_push Tool Portal action');
		expect(
			files.find((file) => file.relativePath.endsWith('per-agent-setup.md'))?.content,
		).toContain('Tool VM Git SSH is read-only');
		const allManualContent = files.map((file) => file.content).join('\n');
		expect(allManualContent).not.toContain('gateway.zoneGit');
		expect(allManualContent).not.toContain('zone_git_push');
		expect(allManualContent).not.toContain('agentSandboxSeeds');
		expect(allManualContent).not.toContain('workMountDir');
		expect(allManualContent).not.toContain('hostWorkMountDir');
		expect(allManualContent).not.toContain('/scratch');
		expect(allManualContent).not.toContain('/agent-vm/zone-git');
		expect(files.map((file) => file.content).join('\n')).not.toContain('toolProfile');
		expect(files.map((file) => file.content).join('\n')).not.toContain('toolProfiles');
		expect(files.map((file) => file.content).join('\n')).not.toContain('/home/openclaw/zone-files');
		expect(files.map((file) => file.content).join('\n')).not.toContain('stable workspace');
		expect(files.map((file) => file.content).join('\n')).not.toContain('one workspace');
		expect(files.map((file) => file.content).join('\n')).not.toContain('which workspace');
		expect(files.map((file) => file.content).join('\n')).not.toContain('allowedHosts');
		expect(files.map((file) => file.content).join('\n')).not.toContain('exactly one trusted agent');
		expect(files.map((file) => file.content).join('\n')).not.toContain(
			'controller-signed agent attestation',
		);
		expect(files.map((file) => file.content).join('\n')).not.toContain(
			'<stateDir>/gateway-runtime.json',
		);
		expect(files.map((file) => file.content).join('\n')).not.toContain('<stateDir>/tool-leases');
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
		expect(operations?.content).toContain(
			'never bypasses the ownership lock or exact-evidence checks',
		);
		expect(operations?.content).toContain(
			'controllerStateDir/zones/<zoneId>/tool-leases/<recordId>.json first, then controllerStateDir/zones/<zoneId>/gateway-runtime.json',
		);
		expect(operations?.content).toContain(
			'never adopts an old VM, and deletes a record only after exact process and endpoint absence is proven',
		);
		expect(operations?.content).toContain(
			'Unknown identity preserves the evidence and prevents Gateway replacement or Tool TCP-slot reuse',
		);
		expect(operations?.content).toContain('at most four child destroys concurrently');
		expect(operations?.content).toContain('whole subtree has a 300 second deadline');
		expect(operations?.content).not.toContain('<stateDir>/gateway-runtime.json');
		expect(operations?.content).not.toContain('<stateDir>/tool-leases');
		expect(operations?.content).not.toContain('private Gateway membership journal');
		expect(operations?.content).not.toContain('resource-by-resource destruction receipts');
		expect(operations?.content).not.toContain('pkill -f qemu-system');
	});
});
