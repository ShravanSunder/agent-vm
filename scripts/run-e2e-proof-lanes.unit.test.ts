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
	it('runs independent host and live VM proof lanes after the shared build', () => {
		const lanes = createE2eProofLanes();

		expect(lanes.map((lane) => lane.id)).toEqual([
			'e2e-host-docker',
			'e2e-host',
			'e2e-vm',
			'e2e-vm-mediation',
			'e2e-openclaw',
			'e2e-worker',
			'e2e-secrets',
		]);
		expect(lanes.map((lane) => lane.env)).toEqual([
			{ AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1' },
			{ AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1' },
			{ AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1' },
			{ AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1' },
			{ AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1' },
			{ AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1' },
			{ AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1' },
		]);
		expect(lanes.map((lane) => lane.requiredEnv)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			{ name: 'AGENT_VM_OPENCLAW_E2E', value: '1' },
			{ name: 'AGENT_VM_WORKER_E2E', value: '1' },
			{ name: 'AGENT_VM_1PASSWORD_E2E', value: '1' },
		]);
	});
});

describe('e2e proof lane runner', () => {
	it('builds once before starting proof lanes in parallel', async () => {
		const events: string[] = [];

		const summary = await runE2eProofLanes(createE2eProofLanes(), {
			env: {},
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
		expect(events).toEqual([
			'build',
			'start:e2e-host-docker',
			'start:e2e-host',
			'start:e2e-vm',
			'start:e2e-vm-mediation',
		]);
	});

	it('awaits an asynchronous shared build before starting proof lanes', async () => {
		const events: string[] = [];
		let finishBuild: (() => void) | undefined;
		const buildFinished = new Promise<void>((resolve) => {
			finishBuild = resolve;
		});

		const summaryPromise = runE2eProofLanes(createE2eProofLanes(), {
			env: {},
			laneRunner: async (lane) => {
				events.push(`start:${lane.id}`);
				return passedResult(lane, 10);
			},
			now: () => 100,
			runWorkspaceBuild: async () => {
				events.push('build-start');
				await buildFinished;
				events.push('build-finish');
			},
			stderr: createSilentWritable(),
			stdout: createSilentWritable(),
		});

		await Promise.resolve();
		expect(events).toEqual(['build-start']);
		finishBuild?.();
		const summary = await summaryPromise;

		expect(summary.ok).toBe(true);
		expect(events).toEqual([
			'build-start',
			'build-finish',
			'start:e2e-host-docker',
			'start:e2e-host',
			'start:e2e-vm',
			'start:e2e-vm-mediation',
		]);
	});

	it('skips the shared build when the caller already built the workspace', async () => {
		const events: string[] = [];

		const summary = await runE2eProofLanes(createE2eProofLanes(), {
			env: {},
			laneRunner: async (lane) => {
				events.push(`start:${lane.id}`);
				return passedResult(lane, 10);
			},
			now: () => 100,
			runWorkspaceBuild: () => {
				events.push('build');
			},
			skipWorkspaceBuild: true,
			stderr: createSilentWritable(),
			stdout: createSilentWritable(),
		});

		expect(summary.ok).toBe(true);
		expect(events).toEqual([
			'start:e2e-host-docker',
			'start:e2e-host',
			'start:e2e-vm',
			'start:e2e-vm-mediation',
		]);
	});

	it('isolates the Docker-backed host lane before starting other proof lanes when requested', async () => {
		const events: string[] = [];
		let finishHostDockerLane: (() => void) | undefined;
		const hostDockerLaneFinished = new Promise<void>((resolve) => {
			finishHostDockerLane = resolve;
		});

		const summaryPromise = runE2eProofLanes(createE2eProofLanes(), {
			env: {},
			isolateHostDockerLane: true,
			laneRunner: async (lane) => {
				events.push(`start:${lane.id}`);
				if (lane.id === 'e2e-host-docker') {
					await hostDockerLaneFinished;
					events.push(`finish:${lane.id}`);
				}
				return passedResult(lane, 10);
			},
			now: () => 100,
			skipWorkspaceBuild: true,
			stderr: createSilentWritable(),
			stdout: createSilentWritable(),
		});

		await Promise.resolve();
		expect(events).toEqual(['start:e2e-host-docker']);
		finishHostDockerLane?.();
		const summary = await summaryPromise;

		expect(summary.ok).toBe(true);
		expect(events).toEqual([
			'start:e2e-host-docker',
			'finish:e2e-host-docker',
			'start:e2e-host',
			'start:e2e-vm',
			'start:e2e-vm-mediation',
		]);
	});

	it('skips gated lanes with explicit reasons when gate env vars are absent', async () => {
		const events: string[] = [];

		const summary = await runE2eProofLanes(createE2eProofLanes(), {
			env: {},
			laneRunner: async (lane) => {
				events.push(`start:${lane.id}`);
				return passedResult(lane, 10);
			},
			now: () => 100,
			skipWorkspaceBuild: true,
			stderr: createSilentWritable(),
			stdout: createSilentWritable(),
		});

		expect(summary.ok).toBe(true);
		expect(summary.passedCount).toBe(4);
		expect(summary.skippedCount).toBe(3);
		expect(events).toEqual([
			'start:e2e-host-docker',
			'start:e2e-host',
			'start:e2e-vm',
			'start:e2e-vm-mediation',
		]);
		expect(summary.lines).toContain(
			'SKIP e2e-openclaw: OpenClaw gateway e2e skipped: gate AGENT_VM_OPENCLAW_E2E=1 absent',
		);
		expect(summary.lines).toContain(
			'SKIP e2e-worker: Worker runtime e2e skipped: gate AGENT_VM_WORKER_E2E=1 absent',
		);
		expect(summary.lines).toContain(
			'SKIP e2e-secrets: 1Password e2e skipped: gate AGENT_VM_1PASSWORD_E2E=1 absent',
		);
	});

	it('runs gated lanes when their gate env vars are present', async () => {
		const events: string[] = [];

		const summary = await runE2eProofLanes(createE2eProofLanes(), {
			env: {
				AGENT_VM_1PASSWORD_E2E: '1',
				AGENT_VM_OPENCLAW_E2E: '1',
				AGENT_VM_WORKER_E2E: '1',
			},
			laneRunner: async (lane) => {
				events.push(`start:${lane.id}`);
				return passedResult(lane, 10);
			},
			now: () => 100,
			skipWorkspaceBuild: true,
			stderr: createSilentWritable(),
			stdout: createSilentWritable(),
		});

		expect(summary.ok).toBe(true);
		expect(summary.passedCount).toBe(7);
		expect(summary.skippedCount).toBe(0);
		expect(events).toEqual([
			'start:e2e-host-docker',
			'start:e2e-host',
			'start:e2e-vm',
			'start:e2e-vm-mediation',
			'start:e2e-openclaw',
			'start:e2e-worker',
			'start:e2e-secrets',
		]);
	});
});
