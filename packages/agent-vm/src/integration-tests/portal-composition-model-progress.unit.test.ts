import { describe, expect, it } from 'vitest';

import { snapshotPortalCompositionModelProgress } from './portal-composition-hermes-e2e-support.js';

describe('portal composition model progress', () => {
	it('retains only closed stage fields when tool results contain private text', () => {
		const snapshot = snapshotPortalCompositionModelProgress({
			executeCodeRequestCount: () => 2,
			finalResponseIssued: () => false,
			firstExecuteCodeResultObserved: () => true,
			generatedTerminalRequestCount: () => 1,
			latestExecuteCodeResult: () => 'private-first-result',
			latestGeneratedTerminalResult: () => undefined,
			promptedModelRequestCount: () => 3,
			secondExecuteCodeResult: () => 'private-second-result',
		});

		expect(snapshot).toEqual({
			executeCodeToolCallsPrepared: 2,
			finalResponseIssued: false,
			firstExecuteCodeMarkerAccepted: true,
			firstExecuteCodeResultObserved: true,
			generatedTerminalToolCallsPrepared: 1,
			generatedTerminalResultPresent: false,
			promptedModelRequests: 3,
			secondExecuteCodeResultPresent: true,
		});
		expect(JSON.stringify(snapshot)).not.toContain('private');
	});
});
