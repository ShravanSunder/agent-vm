import { describe, expect, it } from 'vitest';

import {
	assertCallEffects,
	assertWorkspaceCatalogTools,
	assertOneApprovalUse,
	assertOwnCredential,
	assertRefusedCall,
} from '#worker-host/deployed-checks/deployed-check-suites/authorization-observations';
import type { RunObservations } from '#worker-host/deployed-checks/test-helper-worker/models/helper-contracts';
import { emptyObservations } from '#worker-host/deployed-checks/test-helper-worker/observation-counters';

function observation(effects = 1, credential = 'own-credential'): RunObservations {
	return {
		runId: 'unit',
		activeCalls: 0,
		peakCalls: 1,
		calls: [
			{
				callId: 'one',
				workspaceLabel: 'alpha',
				toolName: 'read',
				credential,
				effects,
				inFlight: 0,
			},
		],
	};
}
describe('authorization proof sensitivity', () => {
	it('accepts one cross-copy approval use and rejects double effects or double successes', () => {
		expect(() => assertOneApprovalUse(observation(), 'one', [{}, { isError: true }])).not.toThrow();
		expect(() => assertOneApprovalUse(observation(2), 'one', [{}, { isError: true }])).toThrow();
		expect(() => assertOneApprovalUse(observation(), 'one', [{}, {}])).toThrow();
	});
	it('accepts own organization credential and rejects foreign credentials or missing control effects', () => {
		expect(() =>
			assertOwnCredential(observation(), 'one', 'own-credential', 'alpha'),
		).not.toThrow();
		expect(() =>
			assertOwnCredential(observation(1, 'foreign-credential'), 'one', 'own-credential', 'alpha'),
		).toThrow();
		expect(() =>
			assertOwnCredential(emptyObservations('unit'), 'one', 'own-credential', 'alpha'),
		).toThrow();
	});
	it('accepts zero-effect authentication and tool refusals and rejects a removed agent being served', () => {
		const empty = emptyObservations('unit');
		expect(() => assertRefusedCall(empty, 'one', { status: 401 })).not.toThrow();
		expect(() =>
			assertRefusedCall(empty, 'one', { status: 200, result: { isError: true } }),
		).not.toThrow();
		expect(() => assertRefusedCall(observation(), 'one', { status: 401 })).toThrow();
		expect(() => assertRefusedCall(empty, 'one', { status: 200, result: {} })).toThrow();
	});
	it('accepts replay keeping exactly one effect and rejects a second effect', () => {
		expect(() => assertCallEffects(observation(), 'one', 1)).not.toThrow();
		expect(() => assertCallEffects(observation(2), 'one', 1)).toThrow();
	});
});

describe('organization catalog label boundaries', () => {
	it.each([
		['alpha-long', 'alpha'],
		['alpha', 'alpha-long'],
		['my-alpha', 'alpha'],
	])('accepts own %s when the other label is %s', (ownLabel, otherLabel) => {
		expect(() =>
			assertWorkspaceCatalogTools({
				names: [`same-server__only-${ownLabel}__hash`],
				ownLabel,
				otherLabel,
			}),
		).not.toThrow();
	});
	it('rejects an exact foreign organization tool and a missing own tool', () => {
		expect(() =>
			assertWorkspaceCatalogTools({
				names: ['same-server__only-alpha-long__hash', 'same-server__only-alpha__hash'],
				ownLabel: 'alpha-long',
				otherLabel: 'alpha',
			}),
		).toThrow();
		expect(() =>
			assertWorkspaceCatalogTools({
				names: ['same-server__read__hash'],
				ownLabel: 'alpha-long',
				otherLabel: 'alpha',
			}),
		).toThrow();
	});
});
