import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTaskEventRecorder, formatTaskFailureReason } from './coordinator-helpers.js';

describe('coordinator helpers', () => {
	it('formats task failure reasons with nested causes', () => {
		const error = new Error('wrapup failed', {
			cause: new Error('push failed', {
				cause: new Error('https://x-access-token:secret-token@github.com/acme/widgets.git'),
			}),
		});

		expect(formatTaskFailureReason(error)).toBe(
			'wrapup failed\nCaused by: push failed\nCaused by: https://x-access-token:***@github.com/acme/widgets.git',
		);
	});

	it('formats aggregate task failure reasons with aggregate messages and causes', () => {
		const error = new AggregateError(
			[
				new AggregateError([new Error('repo setup failed')], 'repo resources failed'),
				new Error('cleanup failed', { cause: new Error('docker compose down failed') }),
			],
			'task failed',
			{ cause: new Error('primary failure') },
		);

		expect(formatTaskFailureReason(error)).toBe(
			'task failed\nCaused by: repo resources failed\nCaused by: repo setup failed\nCaused by: cleanup failed\nCaused by: docker compose down failed\nCaused by: primary failure',
		);
	});

	it('awaits root-owned fatal shutdown when task failure persistence fails', async () => {
		vi.useFakeTimers();
		const tempDir = await mkdtemp(join(tmpdir(), 'agent-vm-worker-fatal-persistence-'));
		const statePath = join(tempDir, 'state-file');
		await writeFile(statePath, 'not a directory', 'utf8');
		const onFatalPersistenceFailure = vi.fn(async (): Promise<void> => undefined);
		try {
			const recorder = createTaskEventRecorder(
				statePath,
				new Map(),
				new Set(),
				onFatalPersistenceFailure,
			);

			await recorder.recordTaskFailure('task-1', 'task failed');

			expect(onFatalPersistenceFailure).toHaveBeenCalledOnce();
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
			await rm(tempDir, { force: true, recursive: true });
		}
	});
});
