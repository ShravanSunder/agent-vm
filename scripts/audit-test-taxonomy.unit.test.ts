import { describe, expect, it } from 'vitest';

import { hasAllowedTestSuffix, isUnitTest } from './audit-test-taxonomy.js';

describe('hasAllowedTestSuffix', () => {
	it('accepts explicit unit, integration, and e2e lane suffixes', () => {
		expect(hasAllowedTestSuffix('packages/example/example.unit.test.ts')).toBe(true);
		expect(hasAllowedTestSuffix('packages/example/example.unit.spec.ts')).toBe(true);
		expect(hasAllowedTestSuffix('packages/example/example.integration.test.ts')).toBe(true);
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
