import { describe, expect, it } from 'vitest';

import { ActiveTaskRegistry } from './active-task-registry.js';

describe('ActiveTaskRegistry', () => {
	it('reserves, activates, resolves, and clears a task for a zone', () => {
		const registry = new ActiveTaskRegistry();
		const reservationId = registry.tryReserve('shravan', 1);
		expect(reservationId).not.toBeNull();
		registry.activateReservation('shravan', reservationId ?? 'missing', {
			taskId: 'task-1',
			zoneId: 'shravan',
			taskRoot: '/tmp/task-1',
			branchPrefix: 'agent/',
			repos: [],
			workerIngress: null,
		});

		expect(registry.get('shravan', 'task-1')).toMatchObject({
			taskId: 'task-1',
			zoneId: 'shravan',
		});

		registry.clear('shravan', 'task-1');
		expect(registry.get('shravan', 'task-1')).toBeNull();
	});

	it('counts reservations against zone capacity', () => {
		const registry = new ActiveTaskRegistry();
		const firstReservationId = registry.tryReserve('shravan', 1);

		expect(firstReservationId).not.toBeNull();
		expect(registry.tryReserve('shravan', 1)).toBeNull();
		expect(registry.countOccupiedForZone('shravan')).toBe(1);
	});

	it('allows multiple active tasks in the same zone when capacity allows', () => {
		const registry = new ActiveTaskRegistry();
		const firstReservationId = registry.tryReserve('shravan', 2);
		const secondReservationId = registry.tryReserve('shravan', 2);
		expect(firstReservationId).not.toBeNull();
		expect(secondReservationId).not.toBeNull();
		registry.activateReservation('shravan', firstReservationId ?? 'missing', {
			taskId: 'task-1',
			zoneId: 'shravan',
			taskRoot: '/tmp/task-1',
			branchPrefix: 'agent/',
			repos: [],
			workerIngress: null,
		});
		registry.activateReservation('shravan', secondReservationId ?? 'missing', {
			taskId: 'task-2',
			zoneId: 'shravan',
			taskRoot: '/tmp/task-2',
			branchPrefix: 'agent/',
			repos: [],
			workerIngress: null,
		});

		expect(
			registry
				.listForZone('shravan')
				.map((task) => task.taskId)
				.toSorted(),
		).toEqual(['task-1', 'task-2']);
		expect(registry.countOccupiedForZone('shravan')).toBe(2);
	});

	it('sets worker ingress only for the targeted task', () => {
		const registry = new ActiveTaskRegistry();
		const firstReservationId = registry.tryReserve('shravan', 2);
		const secondReservationId = registry.tryReserve('shravan', 2);
		expect(firstReservationId).not.toBeNull();
		expect(secondReservationId).not.toBeNull();
		registry.activateReservation('shravan', firstReservationId ?? 'missing', {
			taskId: 'task-1',
			zoneId: 'shravan',
			taskRoot: '/tmp/task-1',
			branchPrefix: 'agent/',
			repos: [],
			workerIngress: null,
		});
		registry.activateReservation('shravan', secondReservationId ?? 'missing', {
			taskId: 'task-2',
			zoneId: 'shravan',
			taskRoot: '/tmp/task-2',
			branchPrefix: 'agent/',
			repos: [],
			workerIngress: null,
		});

		registry.setWorkerIngress('shravan', 'task-1', { host: '127.0.0.1', port: 18789 });

		expect(registry.get('shravan', 'task-1')?.workerIngress).toEqual({
			host: '127.0.0.1',
			port: 18789,
		});
		expect(registry.get('shravan', 'task-2')?.workerIngress).toBeNull();
	});

	it('clearing one task leaves sibling tasks active', () => {
		const registry = new ActiveTaskRegistry();
		const firstReservationId = registry.tryReserve('shravan', 2);
		const secondReservationId = registry.tryReserve('shravan', 2);
		expect(firstReservationId).not.toBeNull();
		expect(secondReservationId).not.toBeNull();
		registry.activateReservation('shravan', firstReservationId ?? 'missing', {
			taskId: 'task-1',
			zoneId: 'shravan',
			taskRoot: '/tmp/task-1',
			branchPrefix: 'agent/',
			repos: [],
			workerIngress: null,
		});
		registry.activateReservation('shravan', secondReservationId ?? 'missing', {
			taskId: 'task-2',
			zoneId: 'shravan',
			taskRoot: '/tmp/task-2',
			branchPrefix: 'agent/',
			repos: [],
			workerIngress: null,
		});

		registry.clear('shravan', 'task-1');

		expect(registry.get('shravan', 'task-1')).toBeNull();
		expect(registry.get('shravan', 'task-2')).toMatchObject({ taskId: 'task-2' });
		expect(registry.countOccupiedForZone('shravan')).toBe(1);
	});

	it('releases reservations that never activate', () => {
		const registry = new ActiveTaskRegistry();
		const reservationId = registry.tryReserve('shravan', 1);

		expect(reservationId).not.toBeNull();
		expect(registry.countOccupiedForZone('shravan')).toBe(1);

		registry.releaseReservation('shravan', reservationId ?? 'missing');

		expect(registry.countOccupiedForZone('shravan')).toBe(0);
		expect(registry.tryReserve('shravan', 1)).not.toBeNull();
	});
});
