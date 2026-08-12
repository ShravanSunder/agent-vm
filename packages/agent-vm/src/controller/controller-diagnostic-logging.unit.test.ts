import { configure, dispose, reset, type LogRecord } from '@logtape/logtape';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	createControllerDiagnosticProperties,
	writeControllerDiagnostic,
} from './controller-diagnostic-logging.js';

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
				if (record.category[0] === 'agent-vm') {
					capturedRecords.push(record);
				}
			},
		},
	});
});

afterEach(async () => {
	await dispose().catch(() => {});
	await reset();
});

describe('writeControllerDiagnostic', () => {
	it('uses info for diagnostics and warning for classified failures', () => {
		writeControllerDiagnostic('runtime', 'Controller heartbeat is healthy.');
		writeControllerDiagnostic('runtime', 'Controller startup failed.');

		expect(capturedRecords.map((record) => record.level)).toEqual(['info', 'warning']);
	});

	it('classifies connection refusal as unavailable while access refusal remains rejected', () => {
		expect(createControllerDiagnosticProperties('connect ECONNREFUSED')).toEqual({
			event: 'failure',
			failureClass: 'unavailable',
		});
		expect(createControllerDiagnosticProperties('connection refused by gateway')).toEqual({
			event: 'failure',
			failureClass: 'unavailable',
		});
		expect(createControllerDiagnosticProperties('access denied by gateway')).toEqual({
			event: 'failure',
			failureClass: 'rejected',
		});
	});

	it('omits arbitrary summaries even when they do not match known secret words', () => {
		for (const message of [
			'Controller flush failed: ghp_opaquecredential',
			'Controller flush failed: sk-opaquecredential',
			'Controller flush failed: Bearer opaquecredential',
		]) {
			expect(createControllerDiagnosticProperties(message)).toEqual({
				event: 'failure',
				failureClass: 'failure',
			});
		}
	});

	it('emits the six stable controller categories', () => {
		for (const domain of ['runtime', 'heartbeat', 'git', 'lease', 'gateway', 'resource'] as const) {
			writeControllerDiagnostic(domain, `diagnostic for ${domain}`);
		}

		expect(capturedRecords.map((record) => record.category.join('.'))).toEqual([
			'agent-vm.controller.runtime',
			'agent-vm.controller.heartbeat',
			'agent-vm.controller.git',
			'agent-vm.controller.lease',
			'agent-vm.controller.gateway',
			'agent-vm.controller.resource',
		]);
		expect(capturedRecords.every((record) => record.message[0] === 'Controller diagnostic')).toBe(
			true,
		);
	});

	it('omits raw error, URL, path, task, and secret content from properties', () => {
		const properties = createControllerDiagnosticProperties(
			'Failed to fetch https://example.test/repos/acme/repo?token=secret at /private/repo for task task-123: Error: private response payload',
		);

		writeControllerDiagnostic(
			'git',
			'Failed to fetch https://example.test/repos/acme/repo?token=secret at /private/repo for task task-123: Error: private response payload',
		);

		expect(properties).toEqual({ event: 'failure', failureClass: 'failure' });
		expect(capturedRecords[0]?.properties).toEqual({
			event: 'failure',
			failureClass: 'failure',
		});
		expect(JSON.stringify(capturedRecords[0])).not.toMatch(
			/example\.test|private\/repo|task-123|secret|response payload/u,
		);
	});
});
