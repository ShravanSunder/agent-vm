import { describe, expect, it } from 'vitest';

import {
	auditControllerStateRecordBoundaries,
	type ControllerStateRecordBoundaryAuditSource,
} from './audit-controller-state-record-boundaries.js';

function productionSource(options: {
	readonly content: string;
	readonly filePath?: string;
}): ControllerStateRecordBoundaryAuditSource {
	return {
		content: options.content,
		filePath:
			options.filePath ?? 'packages/agent-vm/src/controller/durable-state/example-record.ts',
	};
}

describe('auditControllerStateRecordBoundaries', () => {
	it('accepts typed controller-state record targets and legitimate Gateway-owned state data', () => {
		const findings = auditControllerStateRecordBoundaries([
			productionSource({
				content: [
					'interface ControllerManagedGatewayRuntimeRecordTarget { readonly filePath: string }',
					'export async function writeManagedGatewayRuntimeRecord(',
					'  target: ControllerManagedGatewayRuntimeRecordTarget,',
					'  record: unknown,',
					'): Promise<void> { await writeFile(target.filePath, record); }',
				].join('\n'),
			}),
			productionSource({
				content: "const sandboxPath = path.join(options.zone.gateway.stateDir, 'sandboxes');",
				filePath: 'packages/agent-vm/src/controller/leases/lease-work-mount-paths.ts',
			}),
			productionSource({
				content: [
					'const fallbackGatewayCacheRecord = await readGatewayCacheRecord();',
					'await writeGatewayCacheRecord(options.zone.gateway.stateDir, fallbackGatewayCacheRecord);',
				].join('\n'),
				filePath: 'packages/agent-vm/src/gateway/gateway-owned-cache-record.ts',
			}),
			productionSource({
				content: 'export async function createBackup(stateDir: string): Promise<void> {}',
				filePath: 'packages/agent-vm/src/operations/backup-create-operation.ts',
			}),
		]);

		expect(findings).toEqual([]);
	});

	it('rejects a record call site passing an indirect generic state-directory value', () => {
		const findings = auditControllerStateRecordBoundaries([
			productionSource({
				content: 'await writeRuntimeRecord(options.stateDirFor(zoneId), runtimeRecord);',
				filePath: 'packages/agent-vm/src/controller/leases/lease-manager.ts',
			}),
		]);

		expect(findings.map((finding) => finding.reason)).toContain(
			'record call site must pass a typed controller-state target, not generic stateDir/stateDirectory data',
		);
	});

	it.each(['stateDir', 'stateDirectory'] as const)(
		'rejects a record module API accepting generic %s',
		(parameterName) => {
			const findings = auditControllerStateRecordBoundaries([
				productionSource({
					content: `export async function loadManagedGatewayRuntimeRecord(${parameterName}: string): Promise<unknown> {}`,
				}),
			]);

			expect(findings.map((finding) => finding.reason)).toContain(
				'record module API must accept a typed controller-state record target, not generic stateDir/stateDirectory',
			);
		},
	);

	it('rejects a record call site passing Gateway-owned stateDir', () => {
		const findings = auditControllerStateRecordBoundaries([
			productionSource({
				content:
					'await writeWorkerRuntimeRecord(prepared.taskZoneConfig.gateway.stateDir, runtimeRecord);',
				filePath: 'packages/agent-vm/src/controller/worker-task-runner.ts',
			}),
		]);

		expect(findings).toEqual([
			{
				filePath: 'packages/agent-vm/src/controller/worker-task-runner.ts',
				line: 1,
				reason: 'record call site must not pass Gateway-owned .gateway.stateDir',
			},
		]);
	});

	it.each([
		[
			"path.join(stateDirectory, 'gateway-runtime.json')",
			'legacy managed Gateway runtime record layout is forbidden outside the legacy evidence scanner',
		],
		[
			"path.join(options.stateDir, 'approvals')",
			'legacy approval record layout is forbidden outside the legacy evidence scanner',
		],
		[
			"path.join(gatewayStateDirectoryPath, 'tool-leases')",
			'legacy Tool-lease record layout is forbidden outside the legacy evidence scanner',
		],
		[
			"path.join(zone.gateway.stateDir, 'tasks', taskId, 'state', 'gateway-runtime.json')",
			'legacy Worker task runtime record layout is forbidden outside the legacy evidence scanner',
		],
	] as const)('rejects legacy controller record layout knowledge in %s', (expression, reason) => {
		const findings = auditControllerStateRecordBoundaries([
			productionSource({
				content: `const recordPath = ${expression};`,
				filePath: 'packages/agent-vm/src/controller/controller-runtime.ts',
			}),
		]);

		expect(findings.map((finding) => finding.reason)).toContain(reason);
	});

	it('allows all legacy layout knowledge in the single evidence scanner', () => {
		const findings = auditControllerStateRecordBoundaries([
			productionSource({
				content: [
					"const legacyRecordPath = path.join(options.gatewayStateDirectoryPath, 'gateway-runtime.json');",
					"const approvals = path.join(options.gatewayStateDirectoryPath, 'approvals');",
					"const leases = path.join(options.gatewayStateDirectoryPath, 'tool-leases');",
					"const worker = path.join(options.gatewayStateDirectoryPath, 'tasks', taskId, 'state', 'gateway-runtime.json');",
				].join('\n'),
				filePath:
					'packages/agent-vm/src/controller/durable-state/legacy-controller-record-evidence.ts',
			}),
		]);

		expect(findings).toEqual([]);
	});

	it.each([
		'const legacyControllerRecordDirectory = options.controllerRecordTarget.directoryPath;',
		'const fallbackStateDirectory = options.controllerRecordTarget.directoryPath;',
		'await migrateApprovalRecords();',
		'const controllerRecordCompatibilityAlias = currentTarget;',
	] as const)('rejects fallback, migration, or compatibility alias: %s', (content) => {
		const findings = auditControllerStateRecordBoundaries([
			productionSource({
				content,
				filePath: 'packages/agent-vm/src/controller/controller-runtime.ts',
			}),
		]);

		expect(findings.map((finding) => finding.reason)).toContain(
			'controller-state record fallback, migration, or compatibility alias is forbidden',
		);
	});

	it('rejects nullish and logical dual-read fallbacks', () => {
		const findings = auditControllerStateRecordBoundaries([
			productionSource({
				content: [
					'const first = (await loadCurrentManagedGatewayRuntimeRecord()) ?? (await loadLegacyManagedGatewayRuntimeRecord());',
					'const second = (await readControllerApproval()) || (await readLegacyApproval());',
				].join('\n'),
				filePath: 'packages/agent-vm/src/controller/controller-runtime.ts',
			}),
		]);

		expect(
			findings.filter(
				(finding) => finding.reason === 'controller-state record dual-read fallback is forbidden',
			),
		).toHaveLength(2);
	});

	it('excludes tests, fixtures, and docs from production findings', () => {
		const forbiddenContent =
			"await writeManagedGatewayRuntimeRecord(zone.gateway.stateDir, record); path.join(stateDir, 'gateway-runtime.json');";
		const findings = auditControllerStateRecordBoundaries([
			productionSource({
				content: forbiddenContent,
				filePath: 'packages/agent-vm/src/gateway/gateway-runtime-record.unit.test.ts',
			}),
			productionSource({
				content: forbiddenContent,
				filePath: 'packages/agent-vm/src/gateway/fixtures/legacy-record-fixture.ts',
			}),
			productionSource({ content: forbiddenContent, filePath: 'docs/architecture/controller.md' }),
		]);

		expect(findings).toEqual([]);
	});

	it('normalizes paths and sorts findings deterministically', () => {
		const findings = auditControllerStateRecordBoundaries([
			productionSource({
				content: 'await writeManagedGatewayRuntimeRecord(zone.gateway.stateDir, record);',
				filePath: 'packages\\agent-vm\\src\\gateway\\z-record.ts',
			}),
			productionSource({
				content: "const value = path.join(stateDir, 'approvals');",
				filePath: 'packages/agent-vm/src/gateway/a-record.ts',
			}),
		]);

		expect(findings.map((finding) => finding.filePath)).toEqual([
			'packages/agent-vm/src/gateway/a-record.ts',
			'packages/agent-vm/src/gateway/z-record.ts',
		]);
	});
});
