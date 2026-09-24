import { configure, dispose, reset, type LogRecord } from '@logtape/logtape';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	classifyOAuthGoogleCallbackFailureReason,
	writeOAuthGoogleCallbackFailureDiagnostic,
} from './oauth-google-callback-diagnostics.js';

const capturedRecords: LogRecord[] = [];

beforeEach(async () => {
	capturedRecords.length = 0;
	await configure({
		loggers: [
			{
				category: ['agent-vm', 'controller'],
				lowestLevel: 'trace',
				sinks: ['capture'],
			},
		],
		reset: true,
		sinks: {
			capture: (record): void => {
				if (record.category[0] === 'agent-vm') capturedRecords.push(record);
			},
		},
	});
});

afterEach(async () => {
	await dispose().catch(() => {});
	await reset();
});

describe('OAuth Google callback diagnostics', () => {
	it('retains a known bounded failure reason', () => {
		expect(classifyOAuthGoogleCallbackFailureReason('scope-mismatch')).toBe('scope-mismatch');
	});

	it('replaces secret-shaped provider data before it reaches the logger payload', () => {
		const providerData =
			'provider rejected code=secret-code cookie=secret-cookie scope=https://private.example';
		writeOAuthGoogleCallbackFailureDiagnostic(
			classifyOAuthGoogleCallbackFailureReason(providerData),
		);

		expect(capturedRecords).toHaveLength(1);
		expect(capturedRecords[0]?.properties).toEqual({
			event: 'controller-operation-failed',
			failureClass: 'rejected',
			operation: 'oauth-google-callback',
			reason: 'callback-failed',
		});
		expect(JSON.stringify(capturedRecords)).not.toContain(providerData);
	});
});
