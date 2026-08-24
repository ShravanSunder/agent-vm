import { describe, expect, it } from 'vitest';

import {
	GENERATED_MANUAL_MARKER,
	buildAgentVmAgentsTemplate,
	buildManualTemplateFiles,
} from './manual-templates.js';

function buildTestManualFiles(): ReturnType<typeof buildManualTemplateFiles> {
	return buildManualTemplateFiles({
		defaultZoneId: 'shravan',
		systemConfigPath: 'config/system.jsonc',
	});
}

function findManual(
	files: ReturnType<typeof buildManualTemplateFiles>,
	relativePath: string,
): string {
	const content = files.find((file) => file.relativePath === relativePath)?.content;
	expect(content, relativePath).toBeDefined();
	return content ?? '';
}

describe('manual templates', () => {
	it('builds a Hermes and Worker agent-facing AGENTS.md index', () => {
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
		expect(content).toContain('docs/manual/observability.md');
		expect(content).toContain('docs/manual/mcp-portal.md');
		expect(content).toContain('Hermes profile assignments');
		expect(content).toContain('lease-heartbeat');
		expect(content).toContain('Do not silently edit privileged host/deployment config');
		expect(content).not.toMatch(/openclaw/iu);
	});

	it('generates the Hermes and Worker manual topology without removed pages', () => {
		const files = buildTestManualFiles();

		expect(files.map((file) => file.relativePath)).toEqual([
			'docs/manual/README.md',
			'docs/manual/layout.md',
			'docs/manual/image-versioning.md',
			'docs/manual/tool-vm-leases.md',
			'docs/manual/operations.md',
			'docs/manual/hermes.md',
			'docs/manual/observability.md',
			'docs/manual/gateway-ingress.md',
			'docs/manual/mcp-portal.md',
			'docs/manual/agent-worker.md',
			'docs/manual/secrets.md',
			'docs/manual/tool-access.md',
			'docs/manual/channels.md',
			'docs/manual/runtime-paths.md',
			'docs/manual/per-agent-setup.md',
			'docs/manual/troubleshooting.md',
		]);
		expect(files.every((file) => file.content.includes(GENERATED_MANUAL_MARKER))).toBe(true);
		expect(files.some((file) => file.relativePath.endsWith('openclaw.md'))).toBe(false);
		expect(files.some((file) => file.relativePath.endsWith('openclaw-defaults.md'))).toBe(false);
		expect(files.some((file) => file.relativePath.endsWith('migration-discord.md'))).toBe(false);
		expect(files.some((file) => file.relativePath.endsWith('scope.md'))).toBe(false);
	});

	it('documents the complete managed Hermes operator journey', () => {
		const files = buildTestManualFiles();
		const readme = findManual(files, 'docs/manual/README.md');
		const hermes = findManual(files, 'docs/manual/hermes.md');
		const layout = findManual(files, 'docs/manual/layout.md');
		const imageVersioning = findManual(files, 'docs/manual/image-versioning.md');
		const ingress = findManual(files, 'docs/manual/gateway-ingress.md');
		const secrets = findManual(files, 'docs/manual/secrets.md');
		const channels = findManual(files, 'docs/manual/channels.md');
		const perAgent = findManual(files, 'docs/manual/per-agent-setup.md');

		expect(readme).toContain('hermes.md explains the managed Hermes Gateway');
		expect(hermes).toContain(
			'Managed Gateway boot starts one common Tool Portal service process beside one Hermes framework process',
		);
		expect(hermes).toContain('The controller remains durable lease authority');
		expect(hermes).toContain('agent-vm-tool-portal enabled');
		expect(hermes).toContain('gateway.profilesByAgent');
		expect(hermes).toContain('gateway.profileSecretProjectionsByAgent');
		expect(hermes).toContain('platforms.api_server.enabled: false');
		expect(hermes).toContain('/p/<profile>/...');
		expect(hermes).toContain('Run agent-vm validate');
		expect(hermes).toContain('agent-vm doctor');

		expect(layout).toContain('config/gateways/<zone>/hermes-managed/config.yaml');
		expect(layout).toContain('config/gateways/<zone>/mcp.config.jsonc');
		expect(layout).toContain('config/gateways/<zone>/tool-portal.config.jsonc');
		expect(layout).toContain('Hermes gateway VMs mount zoneFilesDir at /zone');
		expect(layout).toContain(
			"Managed Hermes Tool VMs expose only the selected agent's filtered durable workspace at /workspace",
		);

		expect(imageVersioning).toContain('package.json owns which installed @agent-vm/*');
		expect(imageVersioning).toContain(
			'The installed @agent-vm/hermes-gateway package owns the Hermes image recipe',
		);
		expect(imageVersioning).toContain('immutable upstream distribution pin');
		expect(imageVersioning).toContain('packageOverrides.npm');
		expect(imageVersioning).toContain('Do not edit cacheDir/generated-dockerfiles');
		expect(imageVersioning).not.toContain('packageOverrides.pnpm');

		expect(ingress).toContain('zones[].gateway.port');
		expect(ingress).toContain('Hermes serves the root API listener');
		expect(ingress).toContain('framework root route');
		expect(ingress).toContain('/health');
		expect(ingress).toContain('/p/<profile>/...');
		expect(ingress).toContain('SSE and streaming responses');
		expect(ingress).toContain('additional Gondolin ingress routes');
		expect(ingress).toContain('Raw TCP services are not HTTP ingress');

		expect(secrets).toContain('Zones scaffold controller SSH adminAccess as mode: "none"');
		expect(secrets).toContain('agent-vm controller ssh --zone <zoneId>');
		expect(secrets).toContain(
			'Hermes admin shells load HERMES_HOME, the Hermes CLI path, and Gondolin CA bundle variables',
		);
		expect(secrets).toContain('hermes auth add <provider>');
		expect(secrets).toContain('Controller SSH opens an interactive shell only');
		expect(secrets).toContain('agent-vm auth 1password <op-ref-or-url>');
		expect(secrets).toContain('Tool VMs and agent sandboxes do not receive gateway SSH secrets');

		expect(channels).toContain('Hermes Discord recipe');
		expect(channels).toContain('gateway.profileSecretProjectionsByAgent');
		expect(channels).toContain(
			'Map the API_SERVER_KEY target to one distinct injection env, audience gateway zone secret per agent',
		);
		expect(channels).toContain('separate root source named API_SERVER_KEY remains reserved');
		expect(channels).toContain("Use each profile's own API key for /p/<profile>/... requests");
		expect(channels).toContain(
			'The only additional profile environment targets allowed for Hermes are DISCORD_ALLOW_BOTS and DISCORD_BOTS_REQUIRE_INLINE_MENTION',
		);
		expect(channels).toContain('exact memory-backed profiles/<profile>/.env files');
		expect(channels).toContain('/etc/hermes/config.yaml');
		expect(channels).toContain('wss://gateway-*.discord.gg/');
		expect(channels).toContain('Tool VM secrets must use injection http-mediation');

		expect(perAgent).toContain('gateway.profilesByAgent');
		expect(perAgent).toContain('gateway.profileSecretProjectionsByAgent');
		expect(perAgent).toContain(
			'distinct projected sources for API_SERVER_KEY and DISCORD_BOT_TOKEN',
		);
		expect(perAgent).toContain('controller-owned workspace_git_push Tool Portal action');
		expect(perAgent).toContain('Tool VM Git SSH is read-only');
	});

	it('preserves generic Tool Portal, Tool VM, controller, storage, and Worker guidance', () => {
		const files = buildTestManualFiles();
		const leases = findManual(files, 'docs/manual/tool-vm-leases.md');
		const operations = findManual(files, 'docs/manual/operations.md');
		const observability = findManual(files, 'docs/manual/observability.md');
		const portal = findManual(files, 'docs/manual/mcp-portal.md');
		const runtimePaths = findManual(files, 'docs/manual/runtime-paths.md');
		const worker = findManual(files, 'docs/manual/agent-worker.md');
		const toolAccess = findManual(files, 'docs/manual/tool-access.md');

		expect(leases).toContain('one compatible Tool VM per zone and Agent VM agent id');
		expect(leases).toContain('The lease identity remains zoneId + agentId');
		expect(leases).toContain('Caller-supplied Gateway or host paths do not select storage');
		expect(leases).toContain(
			'common Tool Portal service owns current-epoch agent bindings, per-agent strict SSH connections',
		);
		expect(leases).toContain('old lease id is correlation only, not authority');
		expect(leases).toContain('No later shell, file, exec, heartbeat, or finalize work');
		expect(leases).toContain('Framework integrations never receive lease ids or SSH material');
		expect(leases).toContain('lease-heartbeat');
		expect(leases).toContain('lease-renew');

		expect(operations).toContain('agent-vm controller health --config');
		expect(operations).toContain('agent-vm controller service-health --config');
		expect(operations).toContain('agent-vm controller health-snapshot --config');
		expect(operations).toContain('gateway-recovery-suspended');
		expect(operations).toContain('whole-Gateway VM recovery');
		expect(operations).toContain('61 minute cooldown');
		expect(operations).toContain('3 consecutive failed automatic Gateway recoveries');
		expect(operations).toContain('agent-channel-provider-health');
		expect(operations).toContain('secret-resolution-failed is a recovery blocker');
		expect(operations).toContain('<controllerRuntimeDir>/controller-health/events.jsonl');
		expect(operations).toContain('exported telemetry are not lifecycle authority');
		expect(operations).toContain('stale_to_reacquired');
		expect(operations).toContain(
			'Tool VM lease failures retire or quarantine one lease before gateway restart',
		);

		expect(observability).toContain('at least one selected managed Hermes zone');
		expect(observability).toContain('zones[].observability.services');
		expect(observability).toContain('agent-vm-hermes and agent-vm-tool-portal');
		expect(observability).toContain('Do not author serviceName');
		expect(observability).toContain('agent-vm build --no-observability');
		expect(observability).toContain('host.observability.stack.mode=managed');
		expect(observability).toContain('host.observability.stack.mode=external');
		expect(observability).toContain(
			'host.observability.stack.scrubbing.responsibility=external-collector',
		);
		expect(observability).toContain('Tool VM SSH is the only managed gateway raw TCP exception');
		expect(observability).toContain('Never log secrets');

		expect(portal).toContain(
			'Managed Gateway Tool Portal, standalone Tool Portal, and standalone MCP Portal are separate operating surfaces',
		);
		expect(portal).toContain('Tool Portal is the model-visible cross-backend contract layer');
		expect(portal).toContain('mcp.config.jsonc plus tool-portal.config.jsonc');
		expect(portal).toContain('mcp.config.jsonc plus mcp-portal.config.jsonc');
		expect(portal).toContain('tool_portal_list');
		expect(portal).toContain('tool_portal_search');
		expect(portal).toContain('tool_portal_describe');
		expect(portal).toContain('tool_portal_call');
		expect(portal).toContain('namespace + name');
		expect(portal).toContain('every namespace must select an explicit backend.kind');
		expect(portal).toContain('mcp_provider, controller_execution, or tool_vm_runner');
		expect(portal).toContain('Namespaces absent from the profile are denied');
		expect(portal).toContain('calls.requiresApproval requires zone approvalAccess');
		expect(portal).toContain('Static validation and Gateway preflight fail closed');
		expect(portal).toContain('Hermes presents managed approvals natively');
		expect(portal).toContain('controller_host or a fresh one-shot ephemeral_managed_vm');
		expect(portal).toContain('tool_vm_runner remains direct Gateway-to-leased-Tool-VM SSH');
		expect(portal).toContain('Prefer http-mediation for MCP provider API keys');
		expect(portal).toContain(
			'Live validate follows only active Tool Portal namespaces whose backend.kind is mcp_provider',
		);

		expect(runtimePaths).toContain('Managed Hermes Tool VMs run commands in rootfs/COW /work');
		expect(runtimePaths).toContain(
			"/workspace is the current agent's filtered durable RealFS workspace",
		);
		expect(runtimePaths).toContain('/gitdirs/workspace.git');
		expect(runtimePaths).toContain('persistent zone files live at /zone');
		expect(runtimePaths).toContain('stateDir/profiles/<profileName>');
		expect(runtimePaths).toContain('Controller restart adopts no VM');
		expect(runtimePaths).toContain('HTTP health and telemetry remain diagnostic only');
		expect(runtimePaths).toContain('worker repo edits live under /work/repos');

		expect(worker).toContain('plan, work, review, and wrapup');
		expect(worker).toContain('/work/repos/<repoId>');
		expect(toolAccess).toContain('agentToolVmProfiles');
		expect(toolAccess).toContain('Tool Portal capability policy');
		expect(toolAccess).toContain('Per-zone Tool VM images');
	});

	it('keeps the only OpenClaw guidance in the ordered predecessor shutdown boundary', () => {
		const files = buildTestManualFiles();
		const operations = findManual(files, 'docs/manual/operations.md');
		const nonOperationsContent = files
			.filter((file) => file.relativePath !== 'docs/manual/operations.md')
			.map((file) => file.content)
			.join('\n');

		expect(nonOperationsContent).not.toMatch(/openclaw/iu);
		expect(operations).toContain('OpenClaw predecessor shutdown boundary');
		expect(operations).toContain('use the still-installed pre-cutover release');
		expect(operations).toContain(
			'Prove its Tool VM lease records and Gateway runtime record are cleared and the configured ingress is no longer owned',
		);
		expect(operations).toContain('Only then replace the package train');
		expect(operations).toContain(
			'The new release does not parse, migrate, or delete predecessor state',
		);
	});

	it('omits removed compatibility and stale storage vocabulary', () => {
		const files = buildTestManualFiles();
		const allManualContent = files.map((file) => file.content).join('\n');

		expect(allManualContent).not.toContain('codex-harness');
		expect(allManualContent).not.toContain('--all-secrets');
		expect(allManualContent).not.toContain('auth openclaw');
		expect(allManualContent).not.toContain('gateway.authProfilesByAgent');
		expect(allManualContent).not.toContain('gateway.authLogin');
		expect(allManualContent).not.toContain('agent-vm-openclaw');
		expect(allManualContent).not.toContain('@openclaw/');
		expect(allManualContent).not.toContain('@agent-vm/openclaw');
		expect(allManualContent).not.toContain('gateway.zoneGit');
		expect(allManualContent).not.toContain('zone_git_push');
		expect(allManualContent).not.toContain('agentSandboxSeeds');
		expect(allManualContent).not.toContain('workMountDir');
		expect(allManualContent).not.toContain('hostWorkMountDir');
		expect(allManualContent).not.toContain('/scratch');
		expect(allManualContent).not.toContain('/agent-vm/zone-git');
		expect(allManualContent).not.toContain('toolProfile');
		expect(allManualContent).not.toContain('toolProfiles');
		expect(allManualContent).not.toContain('<stateDir>/gateway-runtime.json');
		expect(allManualContent).not.toContain('<stateDir>/tool-leases');
	});

	it('documents graceful stop and scoped offline cleanup without broad qemu pkill', () => {
		const files = buildManualTemplateFiles({
			defaultZoneId: 'beta',
			systemConfigPath: 'config/system.jsonc',
		});
		const operations = findManual(files, 'docs/manual/operations.md');

		expect(operations).toContain('agent-vm controller stop --config config/system.jsonc');
		expect(operations).toContain(
			'agent-vm controller cleanup --config config/system.jsonc --zone beta',
		);
		expect(operations).toContain('--force');
		expect(operations).toContain('never bypasses the ownership lock or exact-evidence checks');
		expect(operations).toContain(
			'controllerStateDir/zones/<zoneId>/tool-leases/<recordId>.json first, then controllerStateDir/zones/<zoneId>/gateway-runtime.json',
		);
		expect(operations).toContain(
			'never adopts an old VM, and deletes a record only after exact process and endpoint absence is proven',
		);
		expect(operations).toContain(
			'Unknown identity preserves the evidence and prevents Gateway replacement or Tool TCP-slot reuse',
		);
		expect(operations).toContain('at most four child destroys concurrently');
		expect(operations).toContain('whole subtree has a 300 second deadline');
		expect(operations).not.toContain('pkill -f qemu-system');
	});
});
