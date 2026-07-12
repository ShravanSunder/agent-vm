import { describe, expect, it } from 'vitest';

import {
	createGatewayControlAdmissionScheduler,
	createGatewayControlProcessAdmission,
	GATEWAY_CONTROL_ADMISSION_LIMITS,
	type GatewayControlAdmissionClass,
} from './gateway-control-admission.js';

function message(options: {
	readonly byteLength?: number;
	readonly coalesceKey?: string;
	readonly id: string;
	readonly messageClass: GatewayControlAdmissionClass;
	readonly principal?: string;
}): {
	readonly byteLength: number;
	readonly coalesceKey?: string;
	readonly id: string;
	readonly messageClass: GatewayControlAdmissionClass;
	readonly payload: string;
	readonly stablePrincipal?: string;
} {
	return {
		byteLength: options.byteLength ?? 1,
		...(options.coalesceKey === undefined ? {} : { coalesceKey: options.coalesceKey }),
		id: options.id,
		messageClass: options.messageClass,
		payload: options.id,
		...(options.principal === undefined ? {} : { stablePrincipal: options.principal }),
	};
}

describe('Gateway control admission scheduler', () => {
	it('keeps the safety reserve non-borrowable by authority traffic', () => {
		const scheduler = createGatewayControlAdmissionScheduler<string>();

		for (let index = 0; index < 8; index += 1) {
			expect(
				scheduler.enqueue(
					message({ id: `authority-${String(index)}`, messageClass: 'authority', principal: 'a' }),
				),
			).toEqual({ status: 'admitted' });
		}
		expect(
			scheduler.enqueue(
				message({ id: 'authority-over', messageClass: 'authority', principal: 'a' }),
			),
		).toEqual({ reason: 'principal_capacity', status: 'refused' });
		expect(scheduler.enqueue(message({ id: 'safety', messageClass: 'safety' }))).toEqual({
			status: 'admitted',
		});
		expect(scheduler.diagnostics()).toMatchObject({ authorityMessages: 8, safetyMessages: 1 });
	});

	it('round-robins authority principals', () => {
		const scheduler = createGatewayControlAdmissionScheduler<string>();
		for (const principal of ['a', 'b', 'a', 'b']) {
			const index = scheduler.diagnostics().authorityMessages;
			scheduler.enqueue(
				message({ id: `${principal}-${String(index)}`, messageClass: 'authority', principal }),
			);
		}

		expect([
			scheduler.dequeue()?.message.stablePrincipal,
			scheduler.dequeue()?.message.stablePrincipal,
		]).toEqual(['a', 'b']);
	});

	it('services pending authority after at most eight safety messages', () => {
		const scheduler = createGatewayControlAdmissionScheduler<string>();
		for (let index = 0; index < 12; index += 1) {
			scheduler.enqueue(message({ id: `s-${String(index)}`, messageClass: 'safety' }));
		}
		scheduler.enqueue(message({ id: 'a-0', messageClass: 'authority', principal: 'a' }));

		const firstNine = Array.from({ length: 9 }, () => scheduler.dequeue()?.message.messageClass);
		expect(firstNine).toEqual([
			'safety',
			'safety',
			'safety',
			'safety',
			'safety',
			'safety',
			'safety',
			'safety',
			'authority',
		]);
	});

	it('holds capacity through handler and response completion', () => {
		const scheduler = createGatewayControlAdmissionScheduler<string>();
		for (let index = 0; index < GATEWAY_CONTROL_ADMISSION_LIMITS.safety.maxMessages; index += 1) {
			scheduler.enqueue(message({ id: `s-${String(index)}`, messageClass: 'safety' }));
		}

		const inFlight = scheduler.dequeue();
		if (inFlight === undefined) {
			throw new Error('expected one admitted safety message');
		}
		expect(scheduler.diagnostics().safetyMessages).toBe(
			GATEWAY_CONTROL_ADMISSION_LIMITS.safety.maxMessages,
		);
		expect(scheduler.enqueue(message({ id: 'still-full', messageClass: 'safety' }))).toEqual({
			reason: 'safety_capacity',
			status: 'fence',
		});
		scheduler.complete(inFlight.completionToken);
		expect(() => scheduler.complete(inFlight.completionToken)).toThrow(
			'gateway control admission message is not in flight',
		);
		expect(() => scheduler.complete({ completionTokenId: Symbol('unknown-completion') })).toThrow(
			'gateway control admission message is not in flight',
		);
		expect(scheduler.enqueue(message({ id: 'after-complete', messageClass: 'safety' }))).toEqual({
			status: 'admitted',
		});
	});

	it('replaces liveness by exact key and coalesces diagnostics', () => {
		const scheduler = createGatewayControlAdmissionScheduler<string>();

		expect(
			scheduler.enqueue(
				message({ coalesceKey: 'lease-a', id: 'live-1', messageClass: 'liveness' }),
			),
		).toEqual({ status: 'admitted' });
		const replacedLiveness = scheduler.enqueue(
			message({ coalesceKey: 'lease-a', id: 'live-2', messageClass: 'liveness' }),
		);
		expect(replacedLiveness).toMatchObject({
			replacedMessage: { id: 'live-1' },
			status: 'replaced',
		});
		expect(
			scheduler.enqueue(
				message({ coalesceKey: 'diag-a', id: 'diag-1', messageClass: 'diagnostic' }),
			),
		).toEqual({ status: 'admitted' });
		const replacedDiagnostic = scheduler.enqueue(
			message({ coalesceKey: 'diag-a', id: 'diag-2', messageClass: 'diagnostic' }),
		);
		expect(replacedDiagnostic).toMatchObject({
			replacedMessage: { id: 'diag-1' },
			status: 'replaced',
		});
		expect(scheduler.diagnostics()).toMatchObject({
			coalescedMessages: 2,
			diagnosticMessages: 1,
			livenessMessages: 1,
		});
		expect(scheduler.dequeue()?.message.id).toBe('live-2');
		expect(scheduler.dequeue()?.message.id).toBe('diag-2');
	});

	it('fences safety overflow, sheds liveness overflow, and drops diagnostic overflow', () => {
		const scheduler = createGatewayControlAdmissionScheduler<string>();
		for (let index = 0; index < GATEWAY_CONTROL_ADMISSION_LIMITS.safety.maxMessages; index += 1) {
			scheduler.enqueue(message({ id: `s-${String(index)}`, messageClass: 'safety' }));
		}
		expect(scheduler.enqueue(message({ id: 's-over', messageClass: 'safety' }))).toEqual({
			reason: 'safety_capacity',
			status: 'fence',
		});
		for (let index = 0; index < GATEWAY_CONTROL_ADMISSION_LIMITS.liveness.maxMessages; index += 1) {
			scheduler.enqueue(
				message({
					coalesceKey: `l-${String(index)}`,
					id: `l-${String(index)}`,
					messageClass: 'liveness',
				}),
			);
		}
		expect(
			scheduler.enqueue(message({ coalesceKey: 'l-over', id: 'l-over', messageClass: 'liveness' })),
		).toEqual({ reason: 'liveness_capacity', status: 'shed' });
		for (
			let index = 0;
			index < GATEWAY_CONTROL_ADMISSION_LIMITS.diagnostic.maxMessages;
			index += 1
		) {
			scheduler.enqueue(
				message({
					coalesceKey: `d-${String(index)}`,
					id: `d-${String(index)}`,
					messageClass: 'diagnostic',
				}),
			);
		}
		expect(
			scheduler.enqueue(
				message({ coalesceKey: 'd-over', id: 'd-over', messageClass: 'diagnostic' }),
			),
		).toEqual({ reason: 'diagnostic_capacity', status: 'dropped' });
		expect(scheduler.diagnostics()).toMatchObject({ droppedMessages: 1, shedMessages: 1 });
	});

	it('rejects invalid and oversized frames before admission', () => {
		const scheduler = createGatewayControlAdmissionScheduler<string>();

		expect(
			scheduler.enqueue(message({ byteLength: 0, id: 'bad', messageClass: 'safety' })),
		).toEqual({ reason: 'invalid_message', status: 'fence' });
		expect(
			scheduler.enqueue(
				message({
					byteLength: GATEWAY_CONTROL_ADMISSION_LIMITS.maxFrameBytes + 1,
					id: 'large',
					messageClass: 'safety',
				}),
			),
		).toEqual({ reason: 'frame_too_large', status: 'fence' });
	});
});

describe('Gateway control process admission', () => {
	it('round-robins zones and preserves sibling progress under one-zone pressure', () => {
		const admission = createGatewayControlProcessAdmission<string>();
		expect(admission.registerZone('zone-a')).toEqual({ status: 'admitted' });
		expect(admission.registerZone('zone-b')).toEqual({ status: 'admitted' });
		for (let index = 0; index < 8; index += 1) {
			admission.enqueue({
				...message({
					id: `a-${String(index)}`,
					messageClass: 'authority',
					principal: 'principal-a',
				}),
				zoneId: 'zone-a',
			});
		}
		admission.enqueue({
			...message({ id: 'b-0', messageClass: 'authority', principal: 'principal-b' }),
			zoneId: 'zone-b',
		});

		expect([admission.dequeue()?.message.zoneId, admission.dequeue()?.message.zoneId]).toEqual([
			'zone-a',
			'zone-b',
		]);
	});

	it('refuses global non-safety pressure without consuming another zone safety reserve', () => {
		const admission = createGatewayControlProcessAdmission<string>({
			maxNonSafetyBytes: 2,
			maxNonSafetyMessages: 2,
		});
		admission.registerZone('zone-a');
		admission.registerZone('zone-b');
		expect(
			admission.enqueue({
				...message({ id: 'a-0', messageClass: 'authority', principal: 'principal-a' }),
				zoneId: 'zone-a',
			}),
		).toEqual({ status: 'admitted' });
		expect(
			admission.enqueue({
				...message({ id: 'a-1', messageClass: 'authority', principal: 'principal-b' }),
				zoneId: 'zone-a',
			}),
		).toEqual({ status: 'admitted' });
		expect(
			admission.enqueue({
				...message({ id: 'b-authority', messageClass: 'authority', principal: 'principal-c' }),
				zoneId: 'zone-b',
			}),
		).toEqual({ reason: 'global_capacity', status: 'refused' });
		expect(
			admission.enqueue({
				...message({ id: 'b-safety', messageClass: 'safety' }),
				zoneId: 'zone-b',
			}),
		).toEqual({ status: 'admitted' });
		expect(admission.diagnostics()).toEqual({
			activeSessions: 2,
			nonSafetyBytes: 2,
			nonSafetyMessages: 2,
		});
	});

	it('replaces coalesced process work at message and byte caps using the exact delta', () => {
		const admission = createGatewayControlProcessAdmission<string>({
			maxNonSafetyBytes: 10,
			maxNonSafetyMessages: 1,
		});
		admission.registerZone('zone-a');
		expect(
			admission.enqueue({
				byteLength: 10,
				coalesceKey: 'heartbeat',
				id: 'old-heartbeat',
				messageClass: 'liveness',
				payload: 'old',
				zoneId: 'zone-a',
			}),
		).toEqual({ status: 'admitted' });
		expect(
			admission.enqueue({
				byteLength: 10,
				coalesceKey: 'heartbeat',
				id: 'new-heartbeat',
				messageClass: 'liveness',
				payload: 'new',
				zoneId: 'zone-a',
			}),
		).toMatchObject({
			replacedMessage: { id: 'old-heartbeat', payload: 'old' },
			status: 'replaced',
		});
		expect(admission.diagnostics()).toEqual({
			activeSessions: 1,
			nonSafetyBytes: 10,
			nonSafetyMessages: 1,
		});
		expect(admission.dequeue()?.message).toMatchObject({
			id: 'new-heartbeat',
			payload: 'new',
		});
	});

	it('keeps the current coalesced payload when its replacement byte delta exceeds process cap', () => {
		const admission = createGatewayControlProcessAdmission<string>({
			maxNonSafetyBytes: 10,
			maxNonSafetyMessages: 1,
		});
		admission.registerZone('zone-a');
		admission.enqueue({
			byteLength: 6,
			coalesceKey: 'runtime-status',
			id: 'current-status',
			messageClass: 'liveness',
			payload: 'current',
			zoneId: 'zone-a',
		});
		expect(
			admission.enqueue({
				byteLength: 11,
				coalesceKey: 'runtime-status',
				id: 'oversized-status',
				messageClass: 'liveness',
				payload: 'oversized',
				zoneId: 'zone-a',
			}),
		).toEqual({ reason: 'global_capacity', status: 'shed' });
		expect(admission.diagnostics()).toMatchObject({
			nonSafetyBytes: 6,
			nonSafetyMessages: 1,
		});
		expect(admission.dequeue()?.message).toMatchObject({
			id: 'current-status',
			payload: 'current',
		});
	});

	it('reserves at most 32 active session safety allocations', () => {
		const admission = createGatewayControlProcessAdmission<string>();
		for (let index = 0; index < 32; index += 1) {
			expect(admission.registerZone(`zone-${String(index)}`)).toEqual({ status: 'admitted' });
		}
		expect(admission.registerZone('zone-overflow')).toEqual({ status: 'capacity_refused' });
	});
});
