import { describe, expect, it } from 'vitest';

import {
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
});
