import { describe, expect, it } from 'vitest';

import { formatTaskFailureReason } from './coordinator-helpers.js';

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
});
