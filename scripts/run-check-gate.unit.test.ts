import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
	createCheckGatePlan,
	formatCheckGateDuration,
	runCheckGate,
	type CheckGateCommand,
	type CheckGateCommandResult,
} from './run-check-gate.ts';

function createSilentWritable(): NodeJS.WritableStream {
	return new Writable({
		write(_chunk, _encoding, callback): void {
			callback();
		},
	});
}

function passedResult(command: CheckGateCommand, durationMs: number): CheckGateCommandResult {
	return {
		command,
		durationMs,
		exitCode: 0,
		signal: null,
		status: 'passed',
		stderr: '',
		stdout: `${command.id} ok\n`,
	};
}

function failedResult(command: CheckGateCommand, durationMs: number): CheckGateCommandResult {
	return {
		command,
		durationMs,
		exitCode: 1,
		signal: null,
		status: 'failed',
		stderr: `${command.id} failed\n`,
		stdout: '',
	};
}

describe('check gate plan', () => {
	it('keeps quick checks before heavy checks', () => {
		const plan = createCheckGatePlan();

		expect(plan.map((phase) => phase.name)).toEqual([
			'build artifacts',
			'fast independent checks',
			'heavy static checks',
		]);
		expect(plan[0]?.commands.map((command) => command.id)).toEqual(['build']);
		expect(plan[1]?.commands.map((command) => command.id)).toEqual([
			'package-versions',
			'zod-version',
			'test-taxonomy',
			'portal-architecture',
			'portal-exports',
			'lint',
			'format',
		]);
		expect(plan[2]?.commands.map((command) => command.id)).toEqual([
			'type-aware-lint',
			'typecheck',
		]);
	});

	it('does not define duplicate command ids', () => {
		const commandIds = createCheckGatePlan().flatMap((phase) =>
			phase.commands.map((command) => command.id),
		);

		expect(new Set(commandIds).size).toBe(commandIds.length);
	});
});

describe('check gate runner', () => {
	it('runs commands in parallel within each phase and waits before the next phase', async () => {
		const plan = createCheckGatePlan();
		const startedCommandIds: string[] = [];
		const completedCommandIds: string[] = [];
		const heavyPhaseStartOrder: string[] = [];

		const summary = await runCheckGate(plan, {
			commandRunner: async (command) => {
				startedCommandIds.push(command.id);
				if (command.id === 'type-aware-lint' || command.id === 'typecheck') {
					heavyPhaseStartOrder.push(command.id);
				}
				completedCommandIds.push(command.id);
				return passedResult(command, 10);
			},
			now: () => 100,
			stderr: createSilentWritable(),
			stdout: createSilentWritable(),
		});

		expect(summary.ok).toBe(true);
		expect(startedCommandIds.slice(0, 1)).toEqual(['build']);
		expect(startedCommandIds.slice(1, 8)).toEqual([
			'package-versions',
			'zod-version',
			'test-taxonomy',
			'portal-architecture',
			'portal-exports',
			'lint',
			'format',
		]);
		expect(completedCommandIds.slice(0, 1)).toEqual(['build']);
		expect(completedCommandIds.slice(1, 8)).toEqual([
			'package-versions',
			'zod-version',
			'test-taxonomy',
			'portal-architecture',
			'portal-exports',
			'lint',
			'format',
		]);
		expect(heavyPhaseStartOrder).toEqual(['type-aware-lint', 'typecheck']);
	});

	it('stops before heavy checks when a quick guard fails', async () => {
		const runCommandIds: string[] = [];

		const summary = await runCheckGate(createCheckGatePlan(), {
			commandRunner: async (command) => {
				runCommandIds.push(command.id);
				if (command.id === 'test-taxonomy') {
					return failedResult(command, 5);
				}
				return passedResult(command, 5);
			},
			now: () => 100,
			stderr: createSilentWritable(),
			stdout: createSilentWritable(),
		});

		expect(summary.ok).toBe(false);
		expect(runCommandIds).toEqual([
			'build',
			'package-versions',
			'zod-version',
			'test-taxonomy',
			'portal-architecture',
			'portal-exports',
			'lint',
			'format',
		]);
	});

	it('formats durations for stable evidence summaries', () => {
		expect(formatCheckGateDuration(1234)).toBe('1.23s');
	});
});
