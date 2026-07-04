import { describe, expect, it } from 'vitest';

import { collectPortalArchitectureViolations } from './audit-portal-architecture.ts';

describe('portal architecture audit', () => {
	it('rejects forbidden bucket folders and single-word portal files', () => {
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/tool-portal/src/schemas/tool-schema.ts',
					sourceText: '',
				},
				{
					filePath: 'packages/agent-portal-sdk/src/models/json-value-schema.ts',
					sourceText: '',
				},
				{
					filePath: 'packages/tool-portal/src/tool-portal-policy/policy.ts',
					sourceText: '',
				},
				{
					filePath: 'packages/tool-portal/src/index.ts',
					sourceText: '',
				},
				{
					filePath: 'packages/tool-portal/src/tool-portal-policy/tool-portal-policy-evaluator.ts',
					sourceText: '',
				},
			],
		});

		expect(violations).toEqual([
			'packages/agent-portal-sdk/src/models/json-value-schema.ts: new portal work must not use package-wide src/models',
			'packages/tool-portal/src/schemas/tool-schema.ts: new portal work must not use src/schemas',
			'packages/tool-portal/src/tool-portal-policy/policy.ts: new portal files must use descriptive multi-word names',
		]);
	});

	it('enforces package dependency direction for portal contract packages', () => {
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath:
						'packages/agent-portal-sdk/src/portal-call-surface/portal-call-request-parser.ts',
					sourceText: "import { createPortalCore } from '@agent-vm/mcp-portal/core';\n",
				},
				{
					filePath:
						'packages/controller-execution-contracts/src/controller-dispatch-boundary/controller-dispatch-intent-schema.ts',
					sourceText: "import { createToolPortal } from '@agent-vm/tool-portal';\n",
				},
				{
					filePath:
						'packages/tool-portal/src/mcp-backed-capabilities/mcp-backed-capability-dispatcher.ts',
					sourceText:
						"import { createMcpProviderCapabilityBackend } from '@agent-vm/mcp-portal/mcp-provider-backend';\n",
				},
				{
					filePath: 'packages/tool-portal/src/mcp-backed-capabilities/mcp-core-dispatcher.ts',
					sourceText: "import { createPortalCore } from '@agent-vm/mcp-portal/core';\n",
				},
				{
					filePath: 'packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.ts',
					sourceText: "import { createPortalCore } from '@agent-vm/mcp-portal/core';\n",
				},
				{
					filePath:
						'packages/tool-portal/src/mcp-backed-capabilities/mcp-backed-capability-dispatcher.integration.test.ts',
					sourceText: "import { createPortalCore } from '@agent-vm/mcp-portal/core';\n",
				},
			],
		});

		expect(violations).toEqual([
			'packages/agent-portal-sdk/src/portal-call-surface/portal-call-request-parser.ts: agent-portal-sdk must not import runtime portal packages',
			'packages/controller-execution-contracts/src/controller-dispatch-boundary/controller-dispatch-intent-schema.ts: controller-execution-contracts must not import runtime portal packages',
			'packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.ts: OpenClaw plugin must consume MCP providers through Tool Portal, not import MCP Portal directly',
			'packages/tool-portal/src/mcp-backed-capabilities/mcp-core-dispatcher.ts: Tool Portal must consume MCP Portal through @agent-vm/mcp-portal/mcp-provider-backend, not core internals',
		]);
	});

	it('rejects unsafe shared harness helpers', () => {
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'tests/harness/agent-portal/fake-tool-portal-controller.ts',
					sourceText: "import { spawn } from 'node:child_process';\n",
				},
				{
					filePath: 'tests/harness/agent-portal/fake-managed-vm-runner.ts',
					sourceText: "import { setTimeout } from 'node:timers/promises';\n",
				},
			],
		});

		expect(violations).toEqual([
			'tests/harness/agent-portal/fake-managed-vm-runner.ts: shared agent portal harnesses must not import wall-clock timer helpers',
			'tests/harness/agent-portal/fake-tool-portal-controller.ts: shared agent portal harnesses must not import process boundary helpers',
		]);
	});

	it('requires public exports to have matching tsdown entries', () => {
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/mcp-portal/package.json',
					sourceText: JSON.stringify({
						exports: {
							'./mcp-provider-backend': {
								import: './dist/mcp-provider-backend/index.js',
								types: './dist/mcp-provider-backend/index.d.ts',
							},
						},
					}),
				},
				{
					filePath: 'packages/mcp-portal/tsdown.config.ts',
					sourceText: "export default defineConfig({ entry: ['src/index.ts'] });\n",
				},
			],
		});

		expect(violations).toEqual([
			'packages/mcp-portal/package.json: export ./mcp-provider-backend points at dist/mcp-provider-backend/index.js but packages/mcp-portal/tsdown.config.ts does not include src/mcp-provider-backend/index.ts',
		]);
	});

	it('rejects direct model-visible zone_git_push OpenClaw plugin surfaces', () => {
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/openclaw-agent-vm-plugin/openclaw.plugin.json',
					sourceText: JSON.stringify({
						contracts: {
							tools: ['zone_git_push'],
						},
					}),
				},
				{
					filePath: 'packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts',
					sourceText: "api.registerTool({ name: 'zone_git_push', execute: async () => ({}) });\n",
				},
				{
					filePath: 'packages/openclaw-agent-vm-plugin/src/zone-git-tool.unit.test.ts',
					sourceText:
						"expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'zone_git_push' }));\n",
				},
			],
		});

		expect(violations).toEqual([
			'packages/openclaw-agent-vm-plugin/openclaw.plugin.json: managed OpenClaw must not expose zone_git_push as a direct plugin tool',
			'packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts: managed OpenClaw must not register zone_git_push as a direct model-visible tool',
		]);
	});

	it('rejects managed raw-control residue in production source files', () => {
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/worker-gateway/src/worker-lifecycle.ts',
					sourceText: "environment.CONTROLLER_BASE_URL = 'http://controller.vm.host:18800';\n",
				},
				{
					filePath: 'packages/openclaw-gateway/src/openclaw-lifecycle.ts',
					sourceText: "tcpHosts['controller.vm.host:18800'] = '127.0.0.1:18800';\n",
				},
				{
					filePath: 'packages/openclaw-gateway/src/openclaw-lifecycle.unit.test.ts',
					sourceText: "expect(tcpHosts['controller.vm.host:18800']).toBeUndefined();\n",
				},
			],
		});

		expect(violations).toEqual([
			'packages/openclaw-gateway/src/openclaw-lifecycle.ts: managed control-plane cutover must not use controller.vm.host:18800',
			'packages/worker-gateway/src/worker-lifecycle.ts: managed control-plane cutover must not use CONTROLLER_BASE_URL',
			'packages/worker-gateway/src/worker-lifecycle.ts: managed control-plane cutover must not use controller.vm.host:18800',
		]);
	});

	it('rejects retired managed control guidance in shippable docs and manual templates', () => {
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'docs/architecture/agent-worker-gateway.md',
					sourceText: 'Worker git push calls the controller push-branches API.\n',
				},
				{
					filePath: 'docs/getting-started/openclaw-guide.md',
					sourceText: 'Use controller.vm.host:18800 for managed control callbacks.\n',
				},
				{
					filePath: 'docs/reference/configuration/system-json.md',
					sourceText: 'Use `controller.vm.host:18800` for managed control callbacks.\n',
				},
				{
					filePath: 'docs/subsystems/controller.md',
					sourceText: 'The worker calls `push-branches` after task completion.\n',
				},
				{
					filePath: 'packages/agent-vm/src/cli/manual-templates.ts',
					sourceText: 'gateway-control-link remains the OpenClaw readiness loop.\n',
				},
				{
					filePath: 'packages/agent-vm/src/cli/manual-templates.ts',
					sourceText: 'Tool VM leases still use GET lease and POST renew.\n',
				},
				{
					filePath: 'packages/openclaw-agent-vm-plugin/openclaw.plugin.json',
					sourceText: JSON.stringify({
						description: 'Sandbox backend with controller lease API.',
					}),
				},
				{
					filePath: 'docs/specs/2026-06-30-gateway-control-session-hard-cutover.md',
					sourceText: 'Historical note: controller.vm.host:18800 was removed.\n',
				},
			],
		});

		expect(violations).toEqual([
			'docs/architecture/agent-worker-gateway.md: managed control-plane cutover docs must not teach push-branches API as a current Worker control path',
			'docs/getting-started/openclaw-guide.md: managed control-plane cutover must not use controller.vm.host:18800',
			'docs/reference/configuration/system-json.md: managed control-plane cutover must not use controller.vm.host:18800',
			'docs/subsystems/controller.md: managed control-plane cutover docs must not teach push-branches API as a current Worker control path',
			'packages/agent-vm/src/cli/manual-templates.ts: managed control-plane cutover docs must not teach GET lease as a current VM-facing control path',
			'packages/agent-vm/src/cli/manual-templates.ts: managed control-plane cutover docs must not teach POST renew as a current VM-facing control path',
			'packages/agent-vm/src/cli/manual-templates.ts: managed control-plane cutover must not use gateway-control-link',
			'packages/openclaw-agent-vm-plugin/openclaw.plugin.json: managed control-plane cutover docs must not teach controller lease API as a current VM-facing control path',
		]);
	});

	it('rejects public gateway-interface exports for raw controller helpers', () => {
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/gateway-interface/src/index.ts',
					sourceText:
						"export { fetchControllerWithPolicy, gatewayInternalControllerRequestOperations } from './health/controller-request-policy.js';\nexport type { FetchControllerWithPolicyOptions, GatewayInternalControllerRequestOperation } from './health/controller-request-policy.js';\n",
				},
			],
		});

		expect(violations).toEqual([
			'packages/gateway-interface/src/index.ts: gateway-interface must not publicly export raw controller helper fetchControllerWithPolicy',
			'packages/gateway-interface/src/index.ts: gateway-interface must not publicly export raw controller helper FetchControllerWithPolicyOptions',
			'packages/gateway-interface/src/index.ts: gateway-interface must not publicly export raw controller helper GatewayInternalControllerRequestOperation',
			'packages/gateway-interface/src/index.ts: gateway-interface must not publicly export raw controller helper gatewayInternalControllerRequestOperations',
		]);
	});
});
