import { configure, dispose, reset, type LogRecord } from '@logtape/logtape';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	createControllerDiagnosticProperties,
	writeControllerDiagnostic,
	type ControllerDiagnosticDescriptor,
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
				if (record.category[0] === 'agent-vm') capturedRecords.push(record);
			},
		},
	});
});

afterEach(async () => {
	await dispose().catch(() => {});
	await reset();
});

describe('writeControllerDiagnostic', () => {
	it('uses the explicit descriptor level and failure class', () => {
		const diagnostic: ControllerDiagnosticDescriptor = {
			event: 'runtime-diagnostic',
			level: 'info',
		};
		writeControllerDiagnostic('runtime', diagnostic);
		writeControllerDiagnostic('runtime', {
			event: 'controller-operation-failed',
			level: 'warning',
			failureClass: 'unavailable',
		});

		expect(capturedRecords.map((record) => record.level)).toEqual(['info', 'warning']);
		expect(capturedRecords.map((record) => record.properties)).toEqual([
			{ event: 'runtime-diagnostic' },
			{ event: 'controller-operation-failed', failureClass: 'unavailable' },
		]);
	});

	it('does not derive event or severity from prose', () => {
		const diagnostic: ControllerDiagnosticDescriptor = {
			event: 'runtime-diagnostic',
			level: 'info',
		};

		expect(createControllerDiagnosticProperties(diagnostic)).toEqual({
			event: 'runtime-diagnostic',
		});
	});

	it('emits stable controller categories', () => {
		for (const domain of ['runtime', 'heartbeat', 'git', 'lease', 'gateway', 'resource'] as const) {
			writeControllerDiagnostic(domain, {
				event: 'controller-diagnostic',
				level: 'info',
			});
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

	it('keeps diagnostics bounded to the typed allowlist', () => {
		const properties = createControllerDiagnosticProperties({
			event: 'controller-operation-failed',
			level: 'warning',
			failureClass: 'failure',
		});

		expect(properties).toEqual({
			event: 'controller-operation-failed',
			failureClass: 'failure',
		});
		expect(JSON.stringify(properties)).not.toMatch(
			/example\.test|private\/repo|task-123|secret|response payload/u,
		);
	});
});
