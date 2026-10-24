import { describe, expect, it } from 'vitest';

import { privateDeployFixture } from '#worker-host/deployed-checks/deploy-configuration/test-fixtures/private-deploy-fixture';
import {
	assertAnalyticsShape,
	assertNoLogCanaries,
	expectedWorkspaceRecordsSchema,
} from '#worker-host/deployed-checks/deployed-check-suites/analytics-observations';
import type { TailRecord } from '#worker-host/deployed-checks/deployed-check-suites/models/deployed-evidence';

const configuration = privateDeployFixture('/tmp/synthetic-evidence');
const workspaces = [
	{
		organizationId: configuration.organizations[0].organizationId,
		workspaceId: '33333333-3333-4333-8333-333333333333',
		label: 'alpha',
	},
];
const agentIds = [configuration.agentId, configuration.otherAgentId];
const context = { runId: configuration.runId, workspaces, agentIds };
const row = {
	index1: workspaces[0]?.workspaceId,
	blob1: configuration.organizations[0].organizationId,
	blob2: `${configuration.runId}:alpha`,
	blob3: configuration.agentId,
	blob4: 'indirect',
	blob5: 'same-server',
	blob6: 'read',
	blob7: 'ran',
	blob8: 'none',
	blob9: 'no',
	double1: 1,
	double2: 100,
	double3: 100,
};
describe('deployed analytics and log assertion sensitivity', () => {
	it('accepts a current-run refused call whose server is unknown', () => {
		expect(() =>
			assertAnalyticsShape(
				{ data: [{ ...row, blob5: 'unknown', blob7: 'refused', blob8: 'authorization' }] },
				context,
			),
		).not.toThrow();
	});
	it.each([
		{ index1: '44444444-4444-4444-8444-444444444444' },
		{ blob2: 'foreign-run:alpha' },
		{ blob3: 'foreign-agent' },
	])('rejects foreign run membership %j even when the server is unknown', (foreignMembership) => {
		expect(() =>
			assertAnalyticsShape({ data: [{ ...row, blob5: 'unknown', ...foreignMembership }] }, context),
		).toThrow('do not belong');
	});
	it('still applies the byte bound to server text after checking run membership', () => {
		expect(() =>
			assertAnalyticsShape({ data: [{ ...row, blob6: '工具'.repeat(100) }] }, context),
		).toThrow('byte bounds');
	});
	it('accepts current-run shape and rejects empty, old-run, wrong-type and oversized Unicode rows', () => {
		expect(() => assertAnalyticsShape({ data: [row] }, context)).not.toThrow();
		expect(() => assertAnalyticsShape({ data: [] }, context)).toThrow();
		expect(() =>
			assertAnalyticsShape({ data: [{ ...row, blob2: 'old-run:alpha' }] }, context),
		).toThrow();
		expect(() => assertAnalyticsShape({ data: [{ ...row, double1: 'wrong' }] }, context)).toThrow();
		expect(() =>
			assertAnalyticsShape({ data: [{ ...row, blob6: '工具'.repeat(100) }] }, context),
		).toThrow();
	});
	it('rejects eight-blob and swapped organization/workspace rows', () => {
		const { blob9: _forPerson, ...eightBlobs } = row;
		expect(() => assertAnalyticsShape({ data: [eightBlobs] }, context)).toThrow();
		expect(() =>
			assertAnalyticsShape({ data: [{ ...row, index1: row.blob1, blob1: row.index1 }] }, context),
		).toThrow('do not belong');
	});
	it('parses a closed nonempty workspace inventory with unique workspace IDs', () => {
		expect(expectedWorkspaceRecordsSchema.parse(workspaces)).toEqual(workspaces);
		for (const invalid of [
			[],
			[{ ...workspaces[0], extra: true }],
			[workspaces[0], workspaces[0]],
			[{ ...workspaces[0], organizationId: 'invalid' }],
		]) {
			expect(expectedWorkspaceRecordsSchema.safeParse(invalid).success).toBe(false);
		}
	});
	it('rejects stale expected records together with matching stale rows against the current run', () => {
		const staleWorkspaces = [
			{ organizationId: row.blob1, workspaceId: row.index1 ?? '', label: 'old-run:alpha' },
		];
		expect(() =>
			assertAnalyticsShape(
				{ data: [{ ...row, blob2: 'old-run:alpha' }] },
				{ ...context, workspaces: staleWorkspaces },
			),
		).toThrow('do not belong');
		expect(
			expectedWorkspaceRecordsSchema.safeParse([
				{ ...workspaces[0], workspaceName: 'old-run:alpha' },
			]).success,
		).toBe(false);
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
