import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
	createE2eProofLanes,
	runE2eProofLanes,
	type E2eProofLane,
	type E2eProofLaneResult,
} from './run-e2e-proof-lanes.ts';

function createSilentWritable(): NodeJS.WritableStream {
	return new Writable({
		write(_chunk, _encoding, callback): void {
			callback();
		},
	});
}

function passedResult(lane: E2eProofLane, durationMs: number): E2eProofLaneResult {
	return {
		durationMs,
		exitCode: 0,
		lane,
		signal: null,
		status: 'passed',
	};
}

describe('e2e proof lane plan', () => {
	it('runs only independent live VM proof lanes after the shared build', () => {
		const lanes = createE2eProofLanes();

		expect(lanes.map((lane) => lane.id)).toEqual(['e2e-vm', 'e2e-vm-mediation']);
		for (const lane of lanes) {
			expect(lane.env).toEqual({ AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1' });
		}
	});
});

describe('e2e proof lane runner', () => {
	it('builds once before starting proof lanes in parallel', async () => {
		const events: string[] = [];

		const summary = await runE2eProofLanes(createE2eProofLanes(), {
			laneRunner: async (lane) => {
				events.push(`start:${lane.id}`);
				return passedResult(lane, 10);
			},
			now: () => 100,
			runWorkspaceBuild: () => {
				events.push('build');
			},
			stderr: createSilentWritable(),
			stdout: createSilentWritable(),
		});

		expect(summary.ok).toBe(true);
		expect(events).toEqual(['build', 'start:e2e-vm', 'start:e2e-vm-mediation']);
	});
});
