import { describe, expect, it } from 'vitest';

import {
	auditLeaseManagerSoleAuthorityOwnership,
	auditVmOwnershipBoundaries,
	readVmOwnershipBoundaryAuditSources,
} from './audit-vm-ownership-boundaries.js';

describe('auditVmOwnershipBoundaries', () => {
	it('rejects legacy VM cleanup references outside the legacy implementation boundary', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content:
					"import { cleanupOrphanedGatewayIfPresent } from '../gateway/gateway-recovery.js';\nawait cleanupOrphanedGatewayIfPresent(options);",
				filePath: 'packages/agent-vm/src/controller/controller-runtime.ts',
			},
			{
				content: 'await cleanupOrphanedToolVmsIfPresent(options);',
				filePath: 'packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts',
			},
			{
				content: 'await killOrphanedManagedVmProcess(options);',
				filePath: 'packages/agent-vm/src/controller/worker-task-runner.ts',
			},
		]);

		expect(findings).toEqual([
			{
				filePath: 'packages/agent-vm/src/controller/controller-runtime.ts',
				line: 1,
				reason:
					"legacy VM cleanup symbol 'cleanupOrphanedGatewayIfPresent' is referenced outside its legacy boundary",
			},
			{
				filePath: 'packages/agent-vm/src/controller/controller-runtime.ts',
				line: 2,
				reason:
					"legacy VM cleanup symbol 'cleanupOrphanedGatewayIfPresent' is referenced outside its legacy boundary",
			},
			{
				filePath: 'packages/agent-vm/src/controller/worker-task-runner.ts',
				line: 1,
				reason:
					"legacy VM cleanup symbol 'killOrphanedManagedVmProcess' is referenced outside its legacy boundary",
			},
			{
				filePath: 'packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts',
				line: 1,
				reason:
					"legacy VM cleanup symbol 'cleanupOrphanedToolVmsIfPresent' is referenced outside its legacy boundary",
			},
		]);
	});

	it('allows legacy definitions and their internal exact-process cleanup chain', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content:
					'export async function cleanupOrphanedGatewayIfPresent() { return await killOrphanedManagedVmProcess({}); }',
				filePath: 'packages/agent-vm/src/gateway/gateway-recovery.ts',
			},
			{
				content:
					'export async function cleanupOrphanedToolVmsIfPresent() { return await killOrphanedManagedVmProcess({}); }',
				filePath: 'packages/agent-vm/src/controller/leases/tool-vm-recovery.ts',
			},
			{
				content: 'export async function killOrphanedManagedVmProcess() {}',
				filePath: 'packages/agent-vm/src/shared/managed-vm-process.ts',
			},
			{
				content:
					"// cleanupOrphanedGatewayIfPresent is legacy.\nconst note = 'cleanupOrphanedToolVmsIfPresent';",
				filePath: 'packages/agent-vm/src/controller/controller-runtime.ts',
			},
		]);

		expect(findings).toEqual([]);
	});

	it('rejects bare close calls for known ManagedVm receivers', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: [
					'await managedVm.close();',
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
				reason:
					"ManagedVm close 'managedVm.close()' is not protected by an ownership destruction receipt",
			},
			{
				filePath: 'packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts',
				line: 2,
				reason:
					"ManagedVm close 'lease.vm.close()' is not protected by an ownership destruction receipt",
			},
			{
				filePath: 'packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts',
				line: 3,
				reason:
					"ManagedVm close 'toolVm.close()' is not protected by an ownership destruction receipt",
			},
		]);
	});

	it('allows ManagedVm close calls wrapped by ownership or an asserted destruction receipt', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: [
					'const destroyReceipt = await ownership.destroyLive(',
					'  async () => await activeGateway.vm.close(),',
					');',
				].join('\n'),
				filePath: 'packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts',
			},
			{
				content: [
					'const destroyReceipt = await toolVm.close();',
					"assertVmDestructionComplete(destroyReceipt, 'Tool VM create rollback');",
				].join('\n'),
				filePath: 'packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts',
			},
		]);

		expect(findings).toEqual([]);
	});

	it('allows ManagedVm close callbacks owned by exact authority-runtime destruction', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: [
					'await authorityRuntime.destroyExact({',
					"  mode: { kind: 'live', closeLiveVm: async () => await lease.vm.close() },",
					'});',
					'const admission = authorityRuntime.admitExactDestruction({',
					"  mode: { kind: 'live', closeLiveVm: async () => await currentLease.vm.close() },",
					'});',
				].join('\n'),
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
			},
		]);

		expect(findings).toEqual([]);
	});

	it('rejects similarly named destruction wrappers outside the exact authority runtime', () => {
		const findings = auditVmOwnershipBoundaries([
			{
				content: [
					'await cleanupFacade.destroyExact({',
					"  mode: { kind: 'live', closeLiveVm: async () => await lease.vm.close() },",
					'});',
					'const admission = otherRuntime.admitExactDestruction({',
					"  mode: { kind: 'live', closeLiveVm: async () => await currentLease.vm.close() },",
					'});',
				].join('\n'),
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
			},
		]);

		expect(findings).toEqual([
			{
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
				line: 2,
				reason:
					"ManagedVm close 'lease.vm.close()' is not protected by an ownership destruction receipt",
			},
			{
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
				line: 5,
				reason:
					"ManagedVm close 'currentLease.vm.close()' is not protected by an ownership destruction receipt",
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
