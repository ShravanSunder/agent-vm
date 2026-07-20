import { describe, expect, it } from 'vitest';

import {
	auditLeaseManagerSoleAuthorityOwnership,
	auditStockGondolinDependencyBoundary,
	auditVmOwnershipBoundaries,
	readStockGondolinDependencyAuditSources,
	readVmOwnershipBoundaryAuditSources,
} from './audit-vm-ownership-boundaries.js';

describe('auditStockGondolinDependencyBoundary', () => {
	it('rejects pnpm patchedDependencies and Gondolin patch artifacts', () => {
		const findings = auditStockGondolinDependencyBoundary([
			{
				content:
					'{"pnpm":{"patchedDependencies":{"@earendil-works/gondolin@0.12.0":"patches/gondolin.patch"}}}',
				filePath: 'package.json',
			},
			{
				content: 'patch-package-content',
				filePath: 'patches/@earendil-works__gondolin@0.12.0.patch',
			},
		]);

		expect(findings.map((finding) => finding.reason)).toEqual([
			'pnpm patchedDependencies is forbidden',
			'Gondolin dependency patch artifact is present',
		]);
	});

	it.each(['file:', 'link:', 'local:', 'workspace:'] as const)(
		'rejects the %s Gondolin dependency resolution protocol',
		(resolutionProtocol) => {
			const findings = auditStockGondolinDependencyBoundary([
				{
					content: JSON.stringify({
						dependencies: { '@earendil-works/gondolin': `${resolutionProtocol}../gondolin` },
					}),
					filePath: 'packages/gondolin-vm-adapter/package.json',
				},
			]);

			expect(findings.map((finding) => finding.reason)).toEqual([
				`Gondolin dependency uses forbidden '${resolutionProtocol}' resolution`,
			]);
		},
	);

	it('rejects a Gondolin patch identity in the lockfile', () => {
		const findings = auditStockGondolinDependencyBoundary([
			{
				content: "'@earendil-works/gondolin@patch:0.12.0#./patches/gondolin.patch': {}",
				filePath: 'pnpm-lock.yaml',
			},
		]);

		expect(findings.map((finding) => finding.reason)).toEqual([
			'Gondolin dependency uses a forbidden patch identity',
		]);
	});

	it('rejects an exact Gondolin lock stanza without registry integrity', () => {
		const findings = auditStockGondolinDependencyBoundary([
			{
				content: [
					"  '@earendil-works/gondolin@0.12.0':",
					'    resolution: {}',
					'    engines: {node: ">=23.6.0"}',
				].join('\n'),
				filePath: 'pnpm-lock.yaml',
			},
		]);

		expect(findings.map((finding) => finding.reason)).toEqual([
			'Exact Gondolin lockfile package stanza must contain nonempty registry integrity',
		]);
	});

	it('rejects non-stock repository and installed Gondolin versions', () => {
		const findings = auditStockGondolinDependencyBoundary([
			{
				content: JSON.stringify({ dependencies: { '@earendil-works/gondolin': '0.13.0' } }),
				filePath: 'packages/gondolin-vm-adapter/package.json',
			},
			{
				content: JSON.stringify({ name: '@earendil-works/gondolin', version: '0.13.0' }),
				filePath:
					'node_modules/.pnpm/@earendil-works+gondolin@0.13.0/node_modules/@earendil-works/gondolin/package.json',
			},
		]);

		expect(findings.map((finding) => finding.reason)).toEqual([
			"Installed Gondolin must be '0.12.0', found '0.13.0'",
			"Gondolin repository dependency must be exact '0.12.0', found '0.13.0'",
		]);
	});

	it('accepts exact stock registry Gondolin 0.12.0 in repository and installed metadata', () => {
		const findings = auditStockGondolinDependencyBoundary([
			{
				content: JSON.stringify({
					dependencies: { '@earendil-works/gondolin': '0.12.0' },
				}),
				filePath: 'packages/gondolin-vm-adapter/package.json',
			},
			{
				content: "'@earendil-works/gondolin@0.12.0':\n  resolution: {integrity: sha512-safe}",
				filePath: 'pnpm-lock.yaml',
			},
			{
				content: JSON.stringify({ name: '@earendil-works/gondolin', version: '0.12.0' }),
				filePath:
					'node_modules/.pnpm/@earendil-works+gondolin@0.12.0/node_modules/@earendil-works/gondolin/package.json',
			},
		]);

		expect(findings).toEqual([]);
	});

	it('accepts the current repository and active installed Gondolin graph', async () => {
		const sources = await readStockGondolinDependencyAuditSources(process.cwd());

		expect(auditStockGondolinDependencyBoundary(sources, { requireCompleteGraph: true })).toEqual(
			[],
		);
	});
});

describe('auditVmOwnershipBoundaries', () => {
	it('rejects deleted receipt, reservation, and private lifecycle vocabulary', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: [
					"import { assertVmDestructionComplete } from '../shared/vm-destruction-receipt.js';",
					"import type { VmCreationOwnership } from '../vm-ownership/vm-creation-ownership.js';",
					'const ownershipReservation = options.ownershipReservation;',
					'const target = vm.getDestroyTarget();',
				].join('\n'),
				filePath: 'packages/agent-vm/src/controller/controller-runtime.ts',
			},
		]);

		expect(findings).toEqual([
			{
				filePath: 'packages/agent-vm/src/controller/controller-runtime.ts',
				line: 1,
				reason: "deleted VM lifecycle module '../shared/vm-destruction-receipt.js' is imported",
			},
			{
				filePath: 'packages/agent-vm/src/controller/controller-runtime.ts',
				line: 1,
				reason: "deleted VM lifecycle symbol 'assertVmDestructionComplete' is referenced",
			},
			{
				filePath: 'packages/agent-vm/src/controller/controller-runtime.ts',
				line: 2,
				reason:
					"deleted VM lifecycle module '../vm-ownership/vm-creation-ownership.js' is imported",
			},
			{
				filePath: 'packages/agent-vm/src/controller/controller-runtime.ts',
				line: 2,
				reason: "deleted VM lifecycle symbol 'VmCreationOwnership' is referenced",
			},
			{
				filePath: 'packages/agent-vm/src/controller/controller-runtime.ts',
				line: 3,
				reason: "deleted VM lifecycle symbol 'ownershipReservation' is referenced",
			},
			{
				filePath: 'packages/agent-vm/src/controller/controller-runtime.ts',
				line: 4,
				reason: "deleted VM lifecycle symbol 'getDestroyTarget' is referenced",
			},
		]);
	});

	it('rejects the old orphan-named cleanup API after the hard cutover', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: 'await cleanupOrphanedGatewayIfPresent(options);',
				filePath: 'packages/agent-vm/src/gateway/gateway-recovery.ts',
			},
			{
				content: 'await cleanupOrphanedToolVmsIfPresent(options);',
				filePath: 'packages/agent-vm/src/controller/leases/tool-vm-recovery.ts',
			},
			{
				content: 'await killOrphanedManagedVmProcess(options);',
				filePath: 'packages/agent-vm/src/shared/managed-vm-process.ts',
			},
		]);

		expect(findings.map((finding) => finding.reason)).toEqual([
			"deleted VM lifecycle symbol 'cleanupOrphanedToolVmsIfPresent' is referenced",
			"deleted VM lifecycle symbol 'cleanupOrphanedGatewayIfPresent' is referenced",
			"deleted VM lifecycle symbol 'killOrphanedManagedVmProcess' is referenced",
		]);
	});

	it('rejects bare close calls for known ManagedVm receivers', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: [
					'await managedVm.close();',
					'await exactManagedVm.close();',
					'await lease.vm.close();',
					'const destroyReceipt = await toolVm.close();',
					'void destroyReceipt;',
				].join('\n'),
				filePath: 'packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts',
			},
		]);

		expect(findings).toEqual([
			{
				filePath: 'packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts',
				line: 1,
				reason: "ManagedVm close 'managedVm.close()' has no lexical runner-absence proof",
			},
			{
				filePath: 'packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts',
				line: 2,
				reason: "ManagedVm close 'exactManagedVm.close()' has no lexical runner-absence proof",
			},
			{
				filePath: 'packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts',
				line: 3,
				reason: "ManagedVm close 'lease.vm.close()' has no lexical runner-absence proof",
			},
			{
				filePath: 'packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts',
				line: 4,
				reason: "ManagedVm close 'toolVm.close()' has no lexical runner-absence proof",
			},
		]);
	});

	it('allows close only in the controller-managed primitive or an explicit runner-absent branch', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: [
					'export async function terminateLiveManagedVm(options) {',
					'  await options.vm.close();',
					'}',
				].join('\n'),
				filePath: 'packages/agent-vm/src/shared/controller-managed-vm-termination.ts',
			},
			{
				content: [
					'async function cleanupRecordedVm(vm) {',
					'  if (vm.getHostProcessId() !== null) {',
					"    throw new Error('runner still active');",
					'  }',
					'  await vm.close();',
					'}',
				].join('\n'),
				filePath: 'packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts',
			},
			{
				content: [
					'async function createUnstartedToolVm() {',
					'  const toolVm = await createManagedVm();',
					'  try { await prepare(toolVm); } catch { await toolVm.close(); }',
					'}',
				].join('\n'),
				filePath: 'packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts',
			},
			{
				content: [
					'async function createManagedVmWithFilteredAgentWorkspace(options) {',
					'  const toolVm = await options.factory.createManagedVm(options.request);',
					'  if (!ownershipTransferred()) { await toolVm.close(); }',
					'  return toolVm;',
					'}',
				].join('\n'),
				filePath: 'packages/agent-vm/src/tool-vm/managed-agent-tool-vm-mounts.ts',
			},
		]);

		expect(findings).toEqual([]);
	});

	it('rejects filtered-workspace construction cleanup outside the exact owned module', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: [
					'async function createManagedVmWithFilteredAgentWorkspace(options) {',
					'  const toolVm = await options.factory.createManagedVm(options.request);',
					'  await toolVm.close();',
					'}',
				].join('\n'),
				filePath: 'packages/agent-vm/src/controller/fake-managed-agent-tool-vm-mounts.ts',
			},
		]);

		expect(findings).toEqual([
			{
				filePath: 'packages/agent-vm/src/controller/fake-managed-agent-tool-vm-mounts.ts',
				line: 3,
				reason: "ManagedVm close 'toolVm.close()' has no lexical runner-absence proof",
			},
		]);
	});

	it('allows the exact LeaseManager access fence to await provider containment', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: [
					'function fenceToolVmAccess(cleanupContext) {',
					'  return cleanupContext.vm.close().then(() => {',
					'    cleanupContext.membership?.recordAccessFenced();',
					'  });',
					'}',
				].join('\n'),
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
			},
		]);

		expect(findings).toEqual([]);
	});

	it('allows the exact LeaseManager cleanup to verify provider containment after close', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: [
					'async function completeToolVmResourceCleanup(cleanupContext) {',
					'  const managedVm = cleanupContext.vm;',
					'  await managedVm.close();',
					'  const postCloseHostProcessId = managedVm.getHostProcessId();',
					'  if (postCloseHostProcessId !== null) {',
					"    throw new Error('runner remained attached');",
					'  }',
					'}',
				].join('\n'),
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
			},
			{
				content: [
					'async function completeToolVmResourceCleanup(cleanupContext) {',
					'  const managedVm = cleanupContext.vm;',
					'  await managedVm.close();',
					'}',
				].join('\n'),
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
			},
			{
				content: [
					'async function completeToolVmResourceCleanup(cleanupContext) {',
					'  const managedVm = cleanupContext.vm;',
					'  const preCloseHostProcessId = managedVm.getHostProcessId();',
					'  await managedVm.close();',
					'  const unrelatedValue = 1;',
					'  if (preCloseHostProcessId !== null) {',
					"    throw new Error('runner remained attached');",
					'  }',
					'}',
				].join('\n'),
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
			},
		]);

		expect(findings).toEqual([
			{
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
				line: 3,
				reason: "ManagedVm close 'managedVm.close()' has no lexical runner-absence proof",
			},
			{
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
				line: 4,
				reason: "ManagedVm close 'managedVm.close()' has no lexical runner-absence proof",
			},
		]);
	});

	it('allows close projected into the exact controller-managed termination primitive', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: [
					'await terminateLiveManagedVm({',
					'  vm: {',
					'    close: async () => await managedVm.close(),',
					'    getHostProcessId: () => managedVm.getHostProcessId(),',
					'  },',
					'});',
				].join('\n'),
				filePath: 'packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts',
			},
		]);

		expect(findings).toEqual([]);
	});

	it('rejects raw close even when nested under authority-shaped callbacks', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: [
					'await vmOwnership.destroyLive(async () => {',
					'  await managedVm.close();',
					'});',
				].join('\n'),
				filePath: 'packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts',
			},
		]);

		expect(findings).toEqual([
			{
				filePath: 'packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts',
				line: 2,
				reason: "ManagedVm close 'managedVm.close()' has no lexical runner-absence proof",
			},
		]);
	});

	it('rejects a similarly named primitive outside the exact controller-owned module', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: [
					'async function terminateLiveManagedVm(options) {',
					'  await options.vm.close();',
					'}',
				].join('\n'),
				filePath: 'packages/agent-vm/src/controller/fake-termination.ts',
			},
		]);

		expect(findings).toEqual([
			{
				filePath: 'packages/agent-vm/src/controller/fake-termination.ts',
				line: 2,
				reason: "ManagedVm close 'options.vm.close()' has no lexical runner-absence proof",
			},
		]);
	});

	it('does not classify sockets, servers, files, databases, or generic handles as ManagedVm', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: [
					'await socket.close();',
					'await server.close();',
					'await fileHandle.close();',
					'lockDatabase.close();',
					'await handle.close();',
				].join('\n'),
				filePath: 'packages/agent-vm/src/controller/controller-runtime.ts',
			},
		]);

		expect(findings).toEqual([]);
	});

	it('ignores unit, spec, and integration-test sources', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: 'await managedVm.close();\nawait cleanupOrphanedGatewayIfPresent();',
				filePath: 'packages/agent-vm/src/controller/controller-runtime.unit.test.ts',
			},
			{
				content: 'await managedVm.close();\nawait cleanupOrphanedGatewayIfPresent();',
				filePath: 'packages/agent-vm/src/controller/controller-runtime.spec.ts',
			},
			{
				content: 'await managedVm.close();\nawait cleanupOrphanedGatewayIfPresent();',
				filePath: 'packages/agent-vm/src/integration-tests/controller.host.e2e.test.ts',
			},
		]);

		expect(findings).toEqual([]);
	});

	it('rejects every legacy mutable authority owned locally by LeaseManager', () => {
		const findings = auditLeaseManagerSoleAuthorityOwnership([
			{
				content: [
					"import { createToolVmCurrentLeaseRegistry } from './tool-vm-current-lease-registry.js';",
					'const currentLeaseRegistry = createToolVmCurrentLeaseRegistry();',
					'const activeUses = new Map();',
					'const endedUseTombstones = new Map();',
					'const releasingLeaseIds = new Set();',
				].join('\n'),
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
			},
		]);

		expect(findings).toEqual([
			{
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
				line: 1,
				reason: 'LeaseManager imports the legacy Tool VM current-lease registry',
			},
			{
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
				line: 2,
				reason:
					"LeaseManager calls legacy mutable authority factory 'createToolVmCurrentLeaseRegistry'",
			},
			{
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
				line: 2,
				reason: "LeaseManager declares legacy mutable authority store 'currentLeaseRegistry'",
			},
			{
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
				line: 3,
				reason: "LeaseManager declares legacy mutable authority store 'activeUses'",
			},
			{
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
				line: 4,
				reason: "LeaseManager declares legacy mutable authority store 'endedUseTombstones'",
			},
			{
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
				line: 5,
				reason: "LeaseManager declares legacy mutable authority store 'releasingLeaseIds'",
			},
		]);
	});

	it('accepts LeaseManager projection through the sole Tool VM authority runtime', () => {
		const findings = auditLeaseManagerSoleAuthorityOwnership([
			{
				content: [
					"import { createToolVmLeaseAuthorityRuntime } from './tool-vm-lease-authority-runtime.js';",
					'const authorityRuntime = createToolVmLeaseAuthorityRuntime();',
					'const activeUseCount = authorityRuntime.activeUseCount(leaseId);',
					'const lease = authorityRuntime.getLease(leaseId);',
				].join('\n'),
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
			},
			{
				content: 'const activeUses = new Map();',
				filePath: 'packages/agent-vm/src/controller/leases/legacy-fixture.ts',
			},
		]);

		expect(findings).toEqual([]);
	});

	it('accepts the current production ownership boundaries', async () => {
		const sources = await readVmOwnershipBoundaryAuditSources(process.cwd());

		expect(sources.length).toBeGreaterThan(0);
		expect(
			sources.every(
				(source) =>
					!source.filePath.includes('/integration-tests/') &&
					!source.filePath.endsWith('.test.ts') &&
					!source.filePath.endsWith('.spec.ts'),
			),
		).toBe(true);
		expect(auditVmOwnershipBoundaries(sources)).toEqual([]);
	});
});
