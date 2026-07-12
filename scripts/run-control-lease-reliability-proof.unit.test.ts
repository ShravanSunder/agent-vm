import { describe, expect, it, vi } from 'vitest';

import type { ReliabilityScenarioEvidence } from './reliability-evidence-manifest.js';
import {
	createReliabilityAggregateManifest,
	runControlLeaseReliabilityScenarios,
	validateControlLeaseReliabilityAggregate,
} from './run-control-lease-reliability-proof.js';

const scenarios = [
	{
		operationId: 'control-session-recovery',
		project: 'e2e-openclaw',
		requiresQueryIdentity: false,
		testFile:
			'packages/agent-vm/src/integration-tests/control-session-recovery.openclaw.e2e.test.ts',
	},
	{
		operationId: 'controller-restart-cleanup',
		project: 'e2e-vm',
		requiresQueryIdentity: false,
		testFile: 'packages/agent-vm/src/integration-tests/controller-restart-cleanup.vm.e2e.test.ts',
	},
] as const;

const bindings = {
	dirtyHash: 'c'.repeat(64),
	evidenceDirectory: '/owned/evidence',
	headSha: 'a'.repeat(40),
	runId: 'reliability-run-a',
} as const;

function createScenarioEvidence(operationId: string, index: number): ReliabilityScenarioEvidence {
	return {
		artifacts: [{ operationId: `${operationId}-artifact`, sha256: 'b'.repeat(64) }],
		dirtyHash: bindings.dirtyHash,
		generationIdentities: [
			{ generation: index + 1, targetId: `target-${String(index)}`, targetKind: 'gateway' },
		],
		headSha: bindings.headSha,
		operationId,
		packageIdentities: [
			{
				checksumSha256: 'd'.repeat(64),
				name: '@agent-vm/agent-vm',
				version: '0.0.113',
			},
		],
		processIdentities: [
			{
				bootId: `boot-${String(index)}`,
				kind: 'gateway',
				processId: index + 100,
				startIdentity: `start-${String(index)}`,
			},
		],
		runId: bindings.runId,
		runtimeIdentities: [{ generation: index + 1, id: `runtime-${String(index)}`, kind: 'gateway' }],
		schemaVersion: 1,
	};
}

describe('runControlLeaseReliabilityScenarios', () => {
	it('constructs exact evidence-project invocations and continues after independent failure', async () => {
		const executeScenario = vi
			.fn()
			.mockResolvedValueOnce({
				evidenceInput: createScenarioEvidence(scenarios[0].operationId, 0),
				exitCode: 1,
				failedTests: 1,
				fileCount: 1,
				passedTests: 0,
				skippedTests: 0,
				todoTests: 0,
				totalTests: 1,
			})
			.mockResolvedValueOnce({
				evidenceInput: createScenarioEvidence(scenarios[1].operationId, 1),
				exitCode: 0,
				failedTests: 0,
				fileCount: 1,
				passedTests: 1,
				skippedTests: 0,
				todoTests: 0,
				totalTests: 1,
			});

		const results = await runControlLeaseReliabilityScenarios(scenarios, bindings, executeScenario);

		expect(executeScenario).toHaveBeenNthCalledWith(1, {
			args: [
				'tsx',
				'scripts/run-vitest-evidence-project.ts',
				'e2e-openclaw',
				scenarios[0].testFile,
			],
			environment: {
				AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1',
				AGENT_VM_RELIABILITY_DIRTY_HASH: bindings.dirtyHash,
				AGENT_VM_RELIABILITY_EVIDENCE_FILE: '/owned/evidence/control-session-recovery.json',
				AGENT_VM_RELIABILITY_HEAD_SHA: bindings.headSha,
				AGENT_VM_RELIABILITY_OPERATION_ID: scenarios[0].operationId,
				AGENT_VM_RELIABILITY_RUN_ID: bindings.runId,
			},
			evidenceFilePath: '/owned/evidence/control-session-recovery.json',
			operationId: scenarios[0].operationId,
		});
		expect(executeScenario).toHaveBeenNthCalledWith(2, {
			args: ['tsx', 'scripts/run-vitest-evidence-project.ts', 'e2e-vm', scenarios[1].testFile],
			environment: {
				AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1',
				AGENT_VM_RELIABILITY_DIRTY_HASH: bindings.dirtyHash,
				AGENT_VM_RELIABILITY_EVIDENCE_FILE: '/owned/evidence/controller-restart-cleanup.json',
				AGENT_VM_RELIABILITY_HEAD_SHA: bindings.headSha,
				AGENT_VM_RELIABILITY_OPERATION_ID: scenarios[1].operationId,
				AGENT_VM_RELIABILITY_RUN_ID: bindings.runId,
			},
			evidenceFilePath: '/owned/evidence/controller-restart-cleanup.json',
			operationId: scenarios[1].operationId,
		});
		expect(results.map(({ exitCode }) => exitCode)).toEqual([1, 0]);
	});

	it('aggregates typed receipts and fails validation on any scenario failure', () => {
		const manifest = createReliabilityAggregateManifest({
			dirtyHash: 'c'.repeat(64),
			headSha: 'a'.repeat(40),
			nowMs: 2_000,
			results: scenarios.map((scenario, index) => ({
				...scenario,
				evidence: createScenarioEvidence(scenario.operationId, index),
				exitCode: index,
				failedTests: index,
				fileCount: 1,
				passedTests: index === 0 ? 1 : 0,
				skippedTests: 0,
				todoTests: 0,
				totalTests: 1,
			})),
			runId: 'reliability-run-a',
		});

		expect(manifest.receipts.map(({ operationId }) => operationId)).toEqual(
			scenarios.map(({ operationId }) => operationId),
		);
		expect(manifest.receipts.some(({ exitCode }) => exitCode !== 0)).toBe(true);
		expect(validateControlLeaseReliabilityAggregate(manifest, scenarios)).toMatchObject({
			ok: false,
		});
	});

	it('rejects missing or forged scenario evidence instead of manufacturing runtime proof', async () => {
		const executeScenario = vi.fn().mockResolvedValue({
			evidenceInput: {
				...createScenarioEvidence(scenarios[0].operationId, 0),
				command: 'kill -9 1',
			},
			exitCode: 0,
			failedTests: 0,
			fileCount: 1,
			passedTests: 1,
			skippedTests: 0,
			todoTests: 0,
			totalTests: 1,
		});
		const [result] = await runControlLeaseReliabilityScenarios(
			[scenarios[0]],
			bindings,
			executeScenario,
		);
		expect(result?.evidence).toBeUndefined();

		const manifest = createReliabilityAggregateManifest({
			dirtyHash: bindings.dirtyHash,
			headSha: bindings.headSha,
			nowMs: 2_000,
			results: result === undefined ? [] : [result],
			runId: bindings.runId,
		});
		expect(validateControlLeaseReliabilityAggregate(manifest, [scenarios[0]])).toMatchObject({
			ok: false,
		});
	});
});
