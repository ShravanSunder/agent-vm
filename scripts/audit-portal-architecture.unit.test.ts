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
					filePath:
						'packages/tool-portal/src/mcp-backed-capabilities/mcp-backed-capability-dispatcher.integration.test.ts',
					sourceText: "import { createPortalCore } from '@agent-vm/mcp-portal/core';\n",
				},
			],
		});

		expect(violations).toEqual([
			'packages/agent-portal-sdk/src/portal-call-surface/portal-call-request-parser.ts: agent-portal-sdk must not import runtime portal packages',
			'packages/controller-execution-contracts/src/controller-dispatch-boundary/controller-dispatch-intent-schema.ts: controller-execution-contracts must not import runtime portal packages',
			'packages/tool-portal/src/mcp-backed-capabilities/mcp-core-dispatcher.ts: Tool Portal may import only @agent-vm/mcp-portal/mcp-provider-backend from MCP Portal',
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
});
