import { describe, expect, it } from 'vitest';

import {
	classifyTimerPromisesImportViolation,
	classifyUnitBoundaryViolation,
	classifyWallClockWaitViolation,
	hasAllowedTestSuffix,
	isE2eTest,
	isIntegrationTest,
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
		expect(hasAllowedTestSuffix('packages/example/example.hermes.e2e.test.ts')).toBe(true);
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

describe('classifyWallClockWaitViolation', () => {
	it('rejects wall-clock waits in unit and integration tests', () => {
		expect(
			classifyWallClockWaitViolation(
				'packages/example/example.unit.test.ts',
				'it("waits", async () => { await delay(10); });',
			),
		).toContain('unit tests must not wait on wall-clock time');
		expect(
			classifyWallClockWaitViolation(
				'packages/example/example.integration.test.ts',
				'it("waits", async () => { setTimeout(resolve, 10); });',
			),
		).toContain('integration tests must not wait on wall-clock time');
	});

	it('rejects direct wall-clock sleeps in e2e tests', () => {
		expect(
			classifyWallClockWaitViolation(
				'packages/example/example.host.e2e.test.ts',
				'it("waits for a process", async () => { await delay(50); });',
			),
		).toContain('e2e tests must wait on real process');
		expect(
			classifyWallClockWaitViolation(
				'packages/example/example.host.e2e.test.ts',
				[
					'it("waits for a process", async () => {',
					'  await new Promise((resolve) =>',
					'    setTimeout(resolve, 50),',
					'  );',
					'});',
				].join('\n'),
			),
		).toContain('e2e tests must wait on real process');
	});

	it('rejects wall-clock waits inside template literal interpolation', () => {
		expect(
			classifyWallClockWaitViolation(
				'packages/example/example.host.e2e.test.ts',
				'it("waits", async () => `${await sleep(50)}`);',
			),
		).toContain('e2e tests must wait on real process');
	});

	it('allows e2e protocol safety timers that are not awaited sleeps', () => {
		expect(
			classifyWallClockWaitViolation(
				'packages/example/example.openclaw.e2e.test.ts',
				'const timer = setTimeout(() => reject(new Error("protocol timeout")), timeoutMs);',
			),
		).toBeNull();
	});
});

describe('classifyTimerPromisesImportViolation', () => {
	it('rejects direct timer-promises imports in tests', () => {
		expect(
			classifyTimerPromisesImportViolation(
				'packages/example/example.vm.e2e.test.ts',
				"import { setTimeout as waitForRetryInterval } from 'node:timers/promises';",
			),
		).toContain('tests must use named protocol wait helpers');
		expect(
			classifyTimerPromisesImportViolation(
				'packages/example/example.vm.e2e.test.ts',
				[
					'import {',
					'  setTimeout as waitForRetryInterval,',
					"} from 'node:timers/promises';",
				].join('\n'),
			),
		).toContain('tests must use named protocol wait helpers');
		expect(
			classifyTimerPromisesImportViolation(
				'packages/example/example.vm.e2e.test.ts',
				"const timers = await import('node:timers/promises');",
			),
		).toContain('tests must use named protocol wait helpers');
		expect(
			classifyTimerPromisesImportViolation(
				'packages/example/example.vm.e2e.test.ts',
				"import { setTimeout as waitForRetryInterval } from 'timers/promises';",
			),
		).toContain('tests must use named protocol wait helpers');
		expect(
			classifyTimerPromisesImportViolation(
				'packages/example/example.vm.e2e.test.ts',
				"const timers = require('node:timers/promises');",
			),
		).toContain('tests must use named protocol wait helpers');
		expect(
			classifyTimerPromisesImportViolation(
				'packages/example/example.vm.e2e.test.ts',
				"export { setTimeout as waitForRetryInterval } from 'node:timers/promises';",
			),
		).toContain('tests must use named protocol wait helpers');
		expect(
			classifyTimerPromisesImportViolation(
				'packages/example/example.vm.e2e.test.ts',
				"import timers = require('node:timers/promises');",
			),
		).toContain('tests must use named protocol wait helpers');
	});

	it('allows non-test protocol wait helpers to own timer-promises imports', () => {
		expect(
			classifyTimerPromisesImportViolation(
				'packages/example/e2e-protocol-wait.ts',
				"import { setTimeout as waitForRetryInterval } from 'node:timers/promises';",
			),
		).toBeNull();
	});

	it('ignores timer-promises import examples inside fixture strings', () => {
		expect(
			classifyTimerPromisesImportViolation(
				'packages/example/example.unit.test.ts',
				[
					'const fixture = [',
					'  "import { setTimeout as waitForRetryInterval } from \'node:timers/promises\';",',
					'  "const timers = await import(\'node:timers/promises\');",',
					'].join("\\n");',
				].join('\n'),
			),
		).toBeNull();
	});
});

describe('classifyUnitBoundaryViolation', () => {
	it('rejects unit tests that import subprocess APIs', () => {
		expect(
			classifyUnitBoundaryViolation(
				'packages/example/example.unit.test.ts',
				[
					"import { execa } from 'execa';",
					"import { spawn } from 'node:child_process';",
					"await execa('git', ['status']);",
				].join('\n'),
			),
		).toContain('unit tests must not cross real process/network boundaries');
		expect(
			classifyUnitBoundaryViolation(
				'packages/example/example.unit.test.ts',
				["import { spawn } from 'node:child_process';", "spawn('git', ['status']);"].join('\n'),
			),
		).toContain('unit tests must not cross real process/network boundaries');
	});

	it('ignores subprocess-looking text outside unit tests', () => {
		expect(
			classifyUnitBoundaryViolation(
				'packages/example/example.host.e2e.test.ts',
				"import { execa } from 'execa';",
			),
		).toBeNull();
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

describe('isIntegrationTest', () => {
	it('only treats integration suffixes as integration tests', () => {
		expect(isIntegrationTest('packages/example/example.integration.test.ts')).toBe(true);
		expect(isIntegrationTest('packages/example/example.unit.test.ts')).toBe(false);
		expect(isIntegrationTest('packages/example/example.host.e2e.test.ts')).toBe(false);
	});
});

describe('isE2eTest', () => {
	it('treats explicit e2e lane suffixes as e2e tests', () => {
		expect(isE2eTest('packages/example/example.host.e2e.test.ts')).toBe(true);
		expect(isE2eTest('packages/example/example.vm.e2e.test.ts')).toBe(true);
		expect(isE2eTest('packages/example/example.openclaw.e2e.test.ts')).toBe(true);
		expect(isE2eTest('packages/example/example.hermes.e2e.test.ts')).toBe(true);
		expect(isE2eTest('packages/example/example.integration.test.ts')).toBe(false);
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
		expect(resolveTestFileProjectNames('packages/example/example.hermes.e2e.test.ts')).toEqual([
			'e2e-hermes',
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
