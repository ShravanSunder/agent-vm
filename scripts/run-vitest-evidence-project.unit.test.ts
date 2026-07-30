import { describe, expect, it } from 'vitest';

import {
	createVitestEvidenceObservabilityEnvironment,
	formatVitestEvidenceSummary,
	normalizeVitestFilters,
	parseVitestJsonResults,
	resolveVitestJsonOutputFilePath,
	validateProofProjectResults,
} from './run-vitest-evidence-project.js';

describe('resolveVitestJsonOutputFilePath', () => {
	it('uses a unique JSON result path for each proof run', () => {
		const firstPath = resolveVitestJsonOutputFilePath('/repo/agent-vm', 'e2e-vm', 'first');
		const secondPath = resolveVitestJsonOutputFilePath('/repo/agent-vm', 'e2e-vm', 'second');

		expect(firstPath).toBe('/repo/agent-vm/tmp/vitest-results/e2e-vm-first/results.json');
		expect(secondPath).toBe('/repo/agent-vm/tmp/vitest-results/e2e-vm-second/results.json');
		expect(firstPath).not.toBe(secondPath);
	});
});

describe('createVitestEvidenceObservabilityEnvironment', () => {
	it('creates stable proof marker environment for a Vitest evidence run', () => {
		const result = createVitestEvidenceObservabilityEnvironment({
			now: () => new Date('2026-06-20T13:25:00.000Z'),
			projectName: 'e2e-openclaw',
			runDirectory: '/repo/tmp/vitest-results/e2e-openclaw-1234-abcd',
			runId: '1234-abcd',
		});

		expect(result.env).toEqual({
			AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES: '1',
			AGENT_VM_OBSERVABILITY_MARKER: 'agent-vm-e2e-openclaw-1234-abcd',
			AGENT_VM_OBSERVABILITY_QUERY_START: '2026-06-20T13:25:00.000Z',
			AGENT_VM_OBSERVABILITY_RELEASE_CHANNEL: 'local',
			AGENT_VM_OBSERVABILITY_RUNTIME_FLAVOR: 'e2e',
			AGENT_VM_OBSERVABILITY_STATE_FILE:
				'/repo/tmp/vitest-results/e2e-openclaw-1234-abcd/observability-state.json',
		});
		expect(result.state).toEqual({
			marker: 'agent-vm-e2e-openclaw-1234-abcd',
			projectName: 'e2e-openclaw',
			queryStart: '2026-06-20T13:25:00.000Z',
			runId: '1234-abcd',
			stateFilePath: '/repo/tmp/vitest-results/e2e-openclaw-1234-abcd/observability-state.json',
		});
	});

	it('does not enable local Tool VM packages for non-live evidence projects', () => {
		const result = createVitestEvidenceObservabilityEnvironment({
			projectName: 'e2e-host',
			runDirectory: '/repo/tmp/vitest-results/e2e-host-1234-abcd',
			runId: '1234-abcd',
		});

		expect(result.env).not.toHaveProperty('AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES');
	});
});

describe('normalizeVitestFilters', () => {
	it('removes the pnpm argument separator before forwarding filters to Vitest', () => {
		expect(
			normalizeVitestFilters([
				'--',
				'packages/agent-vm/src/integration-tests/live-openclaw-control-link.openclaw.e2e.test.ts',
			]),
		).toEqual([
			'packages/agent-vm/src/integration-tests/live-openclaw-control-link.openclaw.e2e.test.ts',
		]);
	});

	it('keeps direct Vitest filters unchanged', () => {
		expect(normalizeVitestFilters(['packages/**/*.vm.e2e.test.ts'])).toEqual([
			'packages/**/*.vm.e2e.test.ts',
		]);
	});
});

describe('parseVitestJsonResults', () => {
	it('reads Vitest JSON counts and assertion results', () => {
		const results = parseVitestJsonResults(
			JSON.stringify({
				numPendingTests: 0,
				numTodoTests: 0,
				numTotalTests: 1,
				testResults: [
					{
						assertionResults: [
							{
								fullName: 'e2e proof passes',
								status: 'passed',
							},
						],
						name: '/repo/packages/example.vm.e2e.test.ts',
					},
				],
			}),
		);

		expect(results.numTotalTests).toBe(1);
		expect(results.testResults[0]?.assertionResults[0]?.fullName).toBe('e2e proof passes');
	});
});

describe('validateProofProjectResults', () => {
	it('fails proof projects that run zero tests', () => {
		const result = validateProofProjectResults('e2e-vm', {
			numPendingTests: 0,
			numTodoTests: 0,
			numTotalTests: 0,
			testResults: [],
		});

		expect(result.ok).toBe(false);
		expect(result.messages).toEqual(['e2e-vm: expected at least one test, found zero.']);
	});

	it('fails proof projects that skip tests', () => {
		const result = validateProofProjectResults('e2e-openclaw', {
			numPendingTests: 2,
			numTodoTests: 1,
			numTotalTests: 3,
			testResults: [],
		});

		expect(result.ok).toBe(false);
		expect(result.messages).toEqual([
			'e2e-openclaw: expected zero skipped tests, found 2.',
			'e2e-openclaw: expected zero todo tests, found 1.',
		]);
	});

	it('passes proof projects with tests and no skips', () => {
		const result = validateProofProjectResults('e2e-worker', {
			numPendingTests: 0,
			numTodoTests: 0,
			numTotalTests: 4,
			testResults: [],
		});

		expect(result.ok).toBe(true);
		expect(result.messages).toEqual([]);
	});

	it('includes proof counts and artifact path when result path is provided', () => {
		const result = validateProofProjectResults(
			'e2e-vm',
			{
				numPendingTests: 0,
				numTodoTests: 0,
				numTotalTests: 10,
				testResults: [{ assertionResults: [], name: '/repo/packages/example.vm.e2e.test.ts' }],
			},
			'/repo/tmp/vitest-results/e2e-vm/results.json',
		);

		expect(result.summary).toEqual({
			pendingTests: 0,
			projectName: 'e2e-vm',
			resultFilePath: '/repo/tmp/vitest-results/e2e-vm/results.json',
			testFiles: 1,
			todoTests: 0,
			totalTests: 10,
		});
		if (result.summary === undefined) {
			throw new Error('expected proof summary');
		}
		expect(formatVitestEvidenceSummary(result.summary)).toBe(
			'e2e-vm: 10 tests, 1 files, 0 skipped, 0 todo, result=/repo/tmp/vitest-results/e2e-vm/results.json',
		);
	});
});
