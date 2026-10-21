import { describe, expect, it } from 'vitest';

import { privateDeployFixture } from '#worker-host/deployed-checks/deploy-configuration/test-fixtures/private-deploy-fixture';
import {
	assertAnalyticsShape,
	assertNoLogCanaries,
} from '#worker-host/deployed-checks/deployed-check-suites/analytics-observations';
import type { TailRecord } from '#worker-host/deployed-checks/deployed-check-suites/models/deployed-evidence';

const configuration = privateDeployFixture('/tmp/synthetic-evidence');
const row = {
	index1: configuration.organizations[0].organizationId,
	blob1: `${configuration.runId}:alpha`,
	blob2: configuration.agentId,
	blob3: 'indirect',
	blob4: 'same-server',
	blob5: 'read',
	blob6: 'ran',
	blob7: 'none',
	blob8: 'no',
	double1: 1,
	double2: 100,
	double3: 100,
};
describe('deployed analytics and log assertion sensitivity', () => {
	it('accepts a current-run refused call whose server is unknown', () => {
		expect(() =>
			assertAnalyticsShape(
				{ data: [{ ...row, blob4: 'unknown', blob6: 'refused', blob7: 'authorization' }] },
				configuration,
			),
		).not.toThrow();
	});
	it.each([
		{ index1: '33333333-3333-4333-8333-333333333333' },
		{ blob1: 'foreign-run:alpha' },
		{ blob2: 'foreign-agent' },
	])('rejects foreign run membership %j even when the server is unknown', (foreignMembership) => {
		expect(() =>
			assertAnalyticsShape(
				{ data: [{ ...row, blob4: 'unknown', ...foreignMembership }] },
				configuration,
			),
		).toThrow('do not belong');
	});
	it('still applies the byte bound to server text after checking run membership', () => {
		expect(() =>
			assertAnalyticsShape({ data: [{ ...row, blob4: '工具'.repeat(100) }] }, configuration),
		).toThrow('byte bounds');
	});
	it('accepts current-run shape and rejects empty, old-run, wrong-type and oversized Unicode rows', () => {
		expect(() => assertAnalyticsShape({ data: [row] }, configuration)).not.toThrow();
		expect(() => assertAnalyticsShape({ data: [] }, configuration)).toThrow();
		expect(() =>
			assertAnalyticsShape({ data: [{ ...row, blob1: 'old-run:alpha' }] }, configuration),
		).toThrow();
		expect(() =>
			assertAnalyticsShape({ data: [{ ...row, double1: 'wrong' }] }, configuration),
		).toThrow();
		expect(() =>
			assertAnalyticsShape({ data: [{ ...row, blob5: '工具'.repeat(100) }] }, configuration),
		).toThrow();
	});
	it('accepts observed safe logs and rejects a canary in logs, exceptions or absent observations', () => {
		const record: TailRecord = {
			outcome: 'ok',
			eventTimestamp: 100,
			event: { request: { url: 'https://portal.invalid/mcp?runId=unit' } },
			logs: [{ timestamp: 100, message: ['safe-observation'] }],
		};
		expect(() => assertNoLogCanaries([record], ['private-canary'])).not.toThrow();
		expect(() =>
			assertNoLogCanaries(
				[{ ...record, logs: [{ timestamp: 100, message: ['private-canary'] }] }],
				['private-canary'],
			),
		).toThrow();
		expect(() =>
			assertNoLogCanaries([{ ...record, exceptions: ['private-canary'] }], ['private-canary']),
		).toThrow();
		expect(() => assertNoLogCanaries([], ['private-canary'])).toThrow();
	});
});
