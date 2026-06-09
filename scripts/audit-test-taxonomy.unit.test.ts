import { describe, expect, it } from 'vitest';

import {
	hasAllowedTestSuffix,
	isUnitTest,
	resolveTestFileProjectNames,
} from './audit-test-taxonomy.js';

describe('hasAllowedTestSuffix', () => {
	it('accepts explicit unit, integration, and e2e lane suffixes', () => {
		expect(hasAllowedTestSuffix('packages/example/example.unit.test.ts')).toBe(true);
		expect(hasAllowedTestSuffix('packages/example/example.unit.spec.ts')).toBe(true);
		expect(hasAllowedTestSuffix('packages/example/example.integration.test.ts')).toBe(true);
		expect(hasAllowedTestSuffix('packages/example/example.host.e2e.test.ts')).toBe(true);
		expect(hasAllowedTestSuffix('packages/example/example.vm.e2e.test.ts')).toBe(true);
		expect(hasAllowedTestSuffix('packages/example/example.openclaw.e2e.test.ts')).toBe(true);
		expect(hasAllowedTestSuffix('packages/example/example.worker.e2e.test.ts')).toBe(true);
		expect(hasAllowedTestSuffix('packages/example/example.secrets.e2e.test.ts')).toBe(true);
		expect(hasAllowedTestSuffix('packages/example/example.llm.e2e.test.ts')).toBe(true);
	});

	it('rejects ambiguous smoke and old llm integration suffixes', () => {
		expect(hasAllowedTestSuffix('packages/example/example.test.ts')).toBe(false);
		expect(hasAllowedTestSuffix('packages/example/example.smoke.test.ts')).toBe(false);
		expect(hasAllowedTestSuffix('packages/example/example.llm.integration.test.ts')).toBe(false);
	});
});

describe('isUnitTest', () => {
	it('only treats unit suffixes as unit tests', () => {
		expect(isUnitTest('packages/example/example.unit.test.ts')).toBe(true);
		expect(isUnitTest('packages/example/example.unit.spec.ts')).toBe(true);
		expect(isUnitTest('packages/example/example.integration.test.ts')).toBe(false);
		expect(isUnitTest('packages/example/example.vm.e2e.test.ts')).toBe(false);
	});
});

describe('resolveTestFileProjectNames', () => {
	it('maps every accepted package suffix to exactly one Vitest project', () => {
		expect(resolveTestFileProjectNames('packages/example/example.unit.test.ts')).toEqual(['unit']);
		expect(resolveTestFileProjectNames('packages/example/example.unit.spec.ts')).toEqual(['unit']);
		expect(resolveTestFileProjectNames('packages/example/example.integration.test.ts')).toEqual([
			'integration',
		]);
		expect(resolveTestFileProjectNames('packages/example/example.host.e2e.test.ts')).toEqual([
			'e2e-host',
		]);
		expect(resolveTestFileProjectNames('packages/example/example.vm.e2e.test.ts')).toEqual([
			'e2e-vm',
		]);
		expect(resolveTestFileProjectNames('packages/example/example.openclaw.e2e.test.ts')).toEqual([
			'e2e-openclaw',
		]);
		expect(resolveTestFileProjectNames('packages/example/example.worker.e2e.test.ts')).toEqual([
			'e2e-worker',
		]);
		expect(resolveTestFileProjectNames('packages/example/example.secrets.e2e.test.ts')).toEqual([
			'e2e-secrets',
		]);
		expect(resolveTestFileProjectNames('packages/example/example.llm.e2e.test.ts')).toEqual([
			'e2e-llm',
		]);
	});

	it('rejects script test suffixes that no Vitest project runs', () => {
		expect(resolveTestFileProjectNames('scripts/example.unit.test.ts')).toEqual(['unit']);
		expect(resolveTestFileProjectNames('scripts/example.unit.spec.ts')).toEqual([]);
		expect(resolveTestFileProjectNames('scripts/example.integration.test.ts')).toEqual([]);
		expect(resolveTestFileProjectNames('scripts/example.vm.e2e.test.ts')).toEqual([]);
	});
});
