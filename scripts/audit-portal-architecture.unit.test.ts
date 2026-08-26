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
				{
					filePath:
						'packages/tool-portal/src/mcp-backed-capabilities/hermes-managed-capability.hermes.e2e.test.ts',
					sourceText: "import { createPortalCore } from '@agent-vm/mcp-portal/core';\n",
				},
			],
		});

		expect(violations).toEqual([
			'packages/agent-portal-sdk/src/portal-call-surface/portal-call-request-parser.ts: agent-portal-sdk must not import runtime portal packages',
			'packages/controller-execution-contracts/src/controller-dispatch-boundary/controller-dispatch-intent-schema.ts: controller-execution-contracts must not import runtime portal packages',
			'packages/tool-portal/src/mcp-backed-capabilities/mcp-core-dispatcher.ts: Tool Portal must consume MCP Portal through @agent-vm/mcp-portal/mcp-provider-backend, not core internals',
		]);
	});

	it('rejects Gateway runtime imports from Agent Portal SDK production source', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath:
						'packages/agent-portal-sdk/src/gateway-runtime-client/bare-gateway-runtime-import.ts',
					sourceText: "import { createGatewayRuntime } from '@agent-vm/gateway-runtime';\n",
				},
				{
					filePath:
						'packages/agent-portal-sdk/src/gateway-runtime-client/gateway-runtime-protocol-import.ts',
					sourceText:
						"import { gatewayRuntimeProtocolVersion } from '@agent-vm/gateway-runtime/protocol';\n",
				},
				{
					filePath:
						'packages/agent-portal-sdk/src/gateway-runtime-client/gateway-runtime-flow-control-import.ts',
					sourceText:
						"import { createFlowController } from '@agent-vm/gateway-runtime/flow-control';\n",
				},
				{
					filePath:
						'packages/agent-portal-sdk/src/gateway-runtime-client/gateway-runtime-import.unit.test.ts',
					sourceText: "import { createGatewayRuntime } from '@agent-vm/gateway-runtime';\n",
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/agent-portal-sdk/src/gateway-runtime-client/bare-gateway-runtime-import.ts: Agent Portal SDK must not import Gateway runtime (@agent-vm/gateway-runtime)',
			'packages/agent-portal-sdk/src/gateway-runtime-client/gateway-runtime-flow-control-import.ts: Agent Portal SDK must not import Gateway runtime (@agent-vm/gateway-runtime/flow-control)',
			'packages/agent-portal-sdk/src/gateway-runtime-client/gateway-runtime-protocol-import.ts: Agent Portal SDK must not import Gateway runtime (@agent-vm/gateway-runtime/protocol)',
		]);
	});

	it('rejects Agent Portal SDK package dependencies on Gateway runtime', () => {
		// Arrange
		const packageJsonWithDependency = JSON.stringify({
			dependencies: {
				'@agent-vm/gateway-runtime': 'workspace:*',
			},
		});
		const packageJsonWithDevelopmentDependency = JSON.stringify({
			devDependencies: {
				'@agent-vm/gateway-runtime': 'workspace:*',
			},
		});

		// Act
		const dependencyViolations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/agent-portal-sdk/package.json',
					sourceText: packageJsonWithDependency,
				},
			],
		});
		const developmentDependencyViolations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/agent-portal-sdk/package.json',
					sourceText: packageJsonWithDevelopmentDependency,
				},
			],
		});

		// Assert
		expect({
			dependencies: dependencyViolations,
			devDependencies: developmentDependencyViolations,
		}).toEqual({
			dependencies: [
				'packages/agent-portal-sdk/package.json: Agent Portal SDK must not declare @agent-vm/gateway-runtime in dependencies',
			],
			devDependencies: [
				'packages/agent-portal-sdk/package.json: Agent Portal SDK must not declare @agent-vm/gateway-runtime in devDependencies',
			],
		});
	});

	it('allows only managed Gateway runtime production to construct ToolPortalService', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/agent-portal-sdk/src/cli/tool-portal-cli.ts',
					sourceText:
						'export function createCli(): unknown { return createToolPortalService({}); }\n',
				},
				{
					filePath: 'packages/tool-portal/src/duplicate-tool-portal-service.ts',
					sourceText:
						"import { createToolPortalService } from '../tool-portal-service.js';\ncreateToolPortalService({});\n",
				},
				{
					filePath: 'packages/gateway-runtime/src/managed-tool-portal-composition.ts',
					sourceText:
						"import { createToolPortalService } from '@agent-vm/tool-portal';\ncreateToolPortalService({});\n",
				},
				{
					filePath: 'packages/tool-portal/src/tool-portal-service.ts',
					sourceText:
						'export function createToolPortalService(): ToolPortalService { return service; }\n',
				},
				{
					filePath: 'packages/tool-portal/src/tool-portal-service-test-fixture.ts',
					sourceText:
						"import { createToolPortalService } from './tool-portal-service.js';\ncreateToolPortalService({});\n",
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/agent-portal-sdk/src/cli/tool-portal-cli.ts: only Gateway runtime may construct ToolPortalService',
			'packages/tool-portal/src/duplicate-tool-portal-service.ts: only Gateway runtime may construct ToolPortalService',
		]);
	});

	it('rejects the retired public in-process Tool Portal runtime and subpath', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/tool-portal/package.json',
					sourceText: JSON.stringify({
						exports: {
							'./in-process-entrypoint': {
								import: './dist/in-process-entrypoint/index.js',
							},
						},
					}),
				},
				{
					filePath: 'packages/tool-portal/src/in-process-entrypoint/index.ts',
					sourceText: "export * from './managed-tool-portal-runtime.js';\n",
				},
				{
					filePath: 'packages/tool-portal/src/index.ts',
					sourceText: "export * from './in-process-entrypoint/index.js';\n",
				},
				{
					filePath: 'packages/tool-portal/src/restored-runtime.ts',
					sourceText: 'export function createManagedToolPortalInProcessRuntime(): void {}\n',
				},
				{
					filePath: 'packages/tool-portal/tsdown.config.ts',
					sourceText:
						"export default defineConfig({ entry: ['src/index.ts', 'src/in-process-entrypoint/index.ts'], hash: false });\n",
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/tool-portal/package.json: Tool Portal must not publish the retired ./in-process-entrypoint subpath',
			'packages/tool-portal/src/in-process-entrypoint/index.ts: retired in-process Tool Portal runtime source and tests must not return',
			'packages/tool-portal/src/index.ts: Tool Portal root must not export the retired in-process runtime',
			'packages/tool-portal/src/restored-runtime.ts: Tool Portal must not restore retired in-process runtime declarations',
			'packages/tool-portal/tsdown.config.ts: Tool Portal must not build the retired in-process runtime entrypoint',
		]);
	});

	it('allows only the managed Gateway runtime composition to import, construct, or export ToolPortalService', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/gateway-runtime/src/managed-tool-portal-composition.ts',
					sourceText:
						"import { createToolPortalService } from '@agent-vm/tool-portal';\ncreateToolPortalService({});\n",
				},
				{
					filePath: 'packages/gateway-runtime/src/duplicate-tool-portal-import.ts',
					sourceText:
						"import { createToolPortalService as buildToolPortalService } from '@agent-vm/tool-portal';\n",
				},
				{
					filePath: 'packages/gateway-runtime/src/duplicate-tool-portal-constructor.ts',
					sourceText: 'const duplicateService = createToolPortalService({});\n',
				},
				{
					filePath: 'packages/gateway-runtime/src/duplicate-tool-portal-export.ts',
					sourceText: "export { createToolPortalService } from '@agent-vm/tool-portal';\n",
				},
				{
					filePath: 'packages/gateway-runtime/src/tool-portal-projections.ts',
					sourceText:
						'const service = props.createToolPortalService({ approvalPort, semanticSnapshot });\n',
				},
				{
					filePath: 'packages/gateway-runtime/src/duplicate-tool-portal-constructor.unit.test.ts',
					sourceText:
						"import { createToolPortalService } from '@agent-vm/tool-portal';\ncreateToolPortalService({});\n",
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/gateway-runtime/src/duplicate-tool-portal-constructor.ts: only packages/gateway-runtime/src/managed-tool-portal-composition.ts may import, construct, or export createToolPortalService',
			'packages/gateway-runtime/src/duplicate-tool-portal-export.ts: only packages/gateway-runtime/src/managed-tool-portal-composition.ts may import, construct, or export createToolPortalService',
			'packages/gateway-runtime/src/duplicate-tool-portal-import.ts: only packages/gateway-runtime/src/managed-tool-portal-composition.ts may import, construct, or export createToolPortalService',
		]);
	});

	it('rejects managed VM and Gondolin imports from Gateway runtime production', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/gateway-runtime/src/gondolin-adapter-leak.ts',
					sourceText:
						"import { createGondolinManagedVmProvider } from '@agent-vm/gondolin-vm-adapter';\n",
				},
				{
					filePath: 'packages/gateway-runtime/src/gondolin-sdk-leak.ts',
					sourceText: "import { VM } from '@gondolin/gondolin';\n",
				},
				{
					filePath: 'packages/gateway-runtime/src/managed-vm-leak.ts',
					sourceText: "import type { ManagedVm } from '@agent-vm/managed-vm';\n",
				},
				{
					filePath: 'packages/gateway-runtime/src/runtime-composition.unit.test.ts',
					sourceText:
						"import type { ManagedVm } from '@agent-vm/managed-vm';\nimport { VM } from '@gondolin/gondolin';\n",
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/gateway-runtime/src/gondolin-adapter-leak.ts: Gateway runtime must not import managed VM or Gondolin packages (@agent-vm/gondolin-vm-adapter)',
			'packages/gateway-runtime/src/gondolin-sdk-leak.ts: Gateway runtime must not import managed VM or Gondolin packages (@gondolin/gondolin)',
			'packages/gateway-runtime/src/managed-vm-leak.ts: Gateway runtime must not import managed VM or Gondolin packages (@agent-vm/managed-vm)',
		]);
	});

	it('rejects standalone MCP Portal config ownership from managed Tool Portal paths', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/agent-vm/src/gateway/mcp-portal-effective-config.ts',
					sourceText: "loadConfig('mcp-portal.config.jsonc');\n",
				},
				{
					filePath: 'packages/agent-vm/src/operations/config-validation.ts',
					sourceText: "validateConfig('mcp-portal.config.jsonc');\n",
				},
				{
					filePath: 'packages/agent-vm/src/cli/init-command.ts',
					sourceText: "scaffoldConfig('mcp-portal.config.jsonc');\n",
				},
				{
					filePath: 'packages/mcp-portal/src/bin/mcp-portal.ts',
					sourceText: "loadConfig('mcp-portal.config.jsonc');\n",
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/agent-vm/src/cli/init-command.ts: managed Tool Portal paths must not consume or scaffold standalone mcp-portal.config.jsonc',
			'packages/agent-vm/src/gateway/mcp-portal-effective-config.ts: managed Tool Portal paths must not consume or scaffold standalone mcp-portal.config.jsonc',
			'packages/agent-vm/src/operations/config-validation.ts: managed Tool Portal paths must not consume or scaffold standalone mcp-portal.config.jsonc',
		]);
	});

	it('allows semantic router declarations only in the canonical Tool Portal result router', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/gateway-runtime/src/copied-tool-portal-router.ts',
					sourceText: 'async function routePortalCall(): Promise<unknown> { return {}; }\n',
				},
				{
					filePath: 'packages/tool-portal/src/copied-tool-portal-router.ts',
					sourceText:
						'async function routePortalCall(): Promise<unknown> { return {}; }\nasync function mergePortalList(): Promise<unknown> { return {}; }\n',
				},
				{
					filePath: 'packages/tool-portal/src/tool-portal-result-router.ts',
					sourceText:
						'export async function routePortalCall(): Promise<unknown> { return {}; }\nexport async function mergePortalList(): Promise<unknown> { return {}; }\n',
				},
				{
					filePath: 'packages/tool-portal/src/tool-portal-result-router.unit.test.ts',
					sourceText:
						'function routePortalCall(): unknown { return {}; }\nconst mergePortalList = (): unknown => ({});\n',
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/gateway-runtime/src/copied-tool-portal-router.ts: Tool Portal semantic router helper routePortalCall must be declared only in packages/tool-portal/src/tool-portal-result-router.ts',
			'packages/tool-portal/src/copied-tool-portal-router.ts: Tool Portal semantic router helper mergePortalList must be declared only in packages/tool-portal/src/tool-portal-result-router.ts',
			'packages/tool-portal/src/copied-tool-portal-router.ts: Tool Portal semantic router helper routePortalCall must be declared only in packages/tool-portal/src/tool-portal-result-router.ts',
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

	it('requires collision-safe SDK chunks and deterministic single-entry declaration names', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/agent-portal-sdk/tsdown.config.ts',
					sourceText: 'export default defineConfig({ dts: true, hash: false });\n',
				},
				{
					filePath: 'packages/tool-portal/tsdown.config.ts',
					sourceText: 'export default defineConfig({ dts: true });\n',
				},
				{
					filePath: 'packages/gateway-runtime/tsdown.config.ts',
					sourceText: 'export default defineConfig({ dts: true });\n',
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/agent-portal-sdk/tsdown.config.ts: Agent Portal SDK must retain content-hashed internal chunks so multi-entry declaration names cannot collide',
			'packages/gateway-runtime/tsdown.config.ts: Gateway runtime builds must disable hashed chunk names so frozen declaration filenames stay stable',
			'packages/tool-portal/tsdown.config.ts: Tool Portal builds must disable hashed chunk names so frozen declaration filenames stay stable',
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
					filePath: 'packages/hermes-gateway/src/hermes-lifecycle.ts',
					sourceText: "tcpHosts['controller.vm.host:18800'] = '127.0.0.1:18800';\n",
				},
				{
					filePath: 'packages/hermes-gateway/src/hermes-lifecycle.unit.test.ts',
					sourceText: "expect(tcpHosts['controller.vm.host:18800']).toBeUndefined();\n",
				},
			],
		});

		expect(violations).toEqual([
			'packages/hermes-gateway/src/hermes-lifecycle.ts: managed control-plane cutover must not use controller.vm.host:18800',
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
					filePath: 'docs/getting-started/hermes-guide.md',
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
					sourceText: 'gateway-control-link remains the managed readiness loop.\n',
				},
				{
					filePath: 'packages/agent-vm/src/cli/manual-templates.ts',
					sourceText: 'Tool VM leases still use GET lease and POST renew.\n',
				},
				{
					filePath: 'docs/specs/2026-06-30-gateway-control-session-hard-cutover.md',
					sourceText: 'Historical note: controller.vm.host:18800 was removed.\n',
				},
			],
		});

		expect(violations).toEqual([
			'docs/architecture/agent-worker-gateway.md: managed control-plane cutover docs must not teach push-branches API as a current Worker control path',
			'docs/getting-started/hermes-guide.md: managed control-plane cutover must not use controller.vm.host:18800',
			'docs/reference/configuration/system-json.md: managed control-plane cutover must not use controller.vm.host:18800',
			'docs/subsystems/controller.md: managed control-plane cutover docs must not teach push-branches API as a current Worker control path',
			'packages/agent-vm/src/cli/manual-templates.ts: managed control-plane cutover docs must not teach GET lease as a current VM-facing control path',
			'packages/agent-vm/src/cli/manual-templates.ts: managed control-plane cutover docs must not teach POST renew as a current VM-facing control path',
			'packages/agent-vm/src/cli/manual-templates.ts: managed control-plane cutover must not use gateway-control-link',
		]);
	});

	it('rejects public gateway-lifecycle exports for raw controller helpers', () => {
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/gateway-lifecycle/src/index.ts',
					sourceText:
						"export { fetchControllerWithPolicy, gatewayInternalControllerRequestOperations } from './health/controller-request-policy.js';\nexport type { FetchControllerWithPolicyOptions, GatewayInternalControllerRequestOperation } from './health/controller-request-policy.js';\n",
				},
			],
		});

		expect(violations).toEqual([
			'packages/gateway-lifecycle/src/index.ts: gateway-lifecycle must not publicly export raw controller helper fetchControllerWithPolicy',
			'packages/gateway-lifecycle/src/index.ts: gateway-lifecycle must not publicly export raw controller helper FetchControllerWithPolicyOptions',
			'packages/gateway-lifecycle/src/index.ts: gateway-lifecycle must not publicly export raw controller helper GatewayInternalControllerRequestOperation',
			'packages/gateway-lifecycle/src/index.ts: gateway-lifecycle must not publicly export raw controller helper gatewayInternalControllerRequestOperations',
		]);
	});

	it('rejects the managed framework child topology while allowing direct Worker processes', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/gateway-runtime/src/runtime/managed-framework-child-supervisor.ts',
					sourceText: 'export function createManagedFrameworkChildSupervisor(): void {}\n',
				},
				{
					filePath: 'packages/gateway-runtime/src/runtime/index.ts',
					sourceText: "export * from './managed-framework-child-supervisor.js';\n",
				},
				{
					filePath: 'packages/gateway-lifecycle/src/gateway-process-spec.ts',
					sourceText:
						"type ProcessSpec = { kind: 'managed-framework-runtime'; childRecipe: ManagedFrameworkChildRecipe };\n",
				},
				{
					filePath: 'packages/gateway-lifecycle/src/runtime-contracts/index.ts',
					sourceText: 'export interface ManagedFrameworkChildRecipe {}\n',
				},
				{
					filePath: 'packages/gateway-runtime/package.json',
					sourceText: JSON.stringify({
						description: 'Gateway-local Tool Portal and managed-framework runtime.',
						dependencies: { '@agent-vm/gateway-lifecycle': 'workspace:*' },
					}),
				},
				{
					filePath: 'packages/gateway-lifecycle/package.json',
					sourceText: JSON.stringify({
						exports: { './runtime-contracts': './dist/runtime-contracts/index.js' },
					}),
				},
				{
					filePath: 'packages/gateway-lifecycle/tsdown.config.ts',
					sourceText:
						"export default defineConfig({ entry: ['src/index.ts', 'src/runtime-contracts/index.ts'] });\n",
				},
				{
					filePath: 'packages/worker-gateway/src/worker-lifecycle.ts',
					sourceText:
						"import { spawn } from 'node:child_process';\nexport const worker = { kind: 'direct-gateway-process', spawn };\n",
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/gateway-lifecycle/package.json: Gateway lifecycle must not publish the rejected child runtime-contracts entry',
			'packages/gateway-lifecycle/src/gateway-process-spec.ts: Gateway lifecycle must not declare a framework child recipe or runtime-parent variant',
			'packages/gateway-lifecycle/src/runtime-contracts/index.ts: Gateway lifecycle must not declare a framework child recipe or runtime-parent variant',
			'packages/gateway-lifecycle/tsdown.config.ts: Gateway lifecycle must not build the rejected child runtime-contracts entry',
			'packages/gateway-runtime/package.json: Gateway runtime must not depend on gateway-lifecycle for framework child ownership',
			'packages/gateway-runtime/package.json: Gateway runtime package metadata must not describe framework child ownership',
			'packages/gateway-runtime/src/runtime/index.ts: Gateway runtime must not expose managed framework child declarations or exports',
			'packages/gateway-runtime/src/runtime/managed-framework-child-supervisor.ts: Gateway runtime must not own or test a managed framework child supervisor',
		]);
	});

	it('allows negative contract tests to name rejected child-topology fields', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/gateway-lifecycle/src/managed-gateway-boot-contract.unit.test.ts',
					sourceText:
						"expect(() => parseBootContract({ childRecipe: { kind: 'managed-framework-runtime' } })).toThrow();\n",
				},
			],
		});

		// Assert
		expect(violations).toEqual([]);
	});
});
