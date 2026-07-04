import { CONTROL_SESSION_TIMING_MS } from '@agent-vm/control-protocol-contracts';
import { describe, expect, it } from 'vitest';

import {
	classifyControlSessionDeathGrace,
	recordControlSessionDisconnected,
	recordControlSessionReconnected,
} from './control-session-death-grace.js';

describe('control session death grace', () => {
	it('waits through the death grace and cancels pending recovery when reconnect succeeds', () => {
		const disconnectedAtMs = 1_000;
		const disconnectedState = recordControlSessionDisconnected({
			nowMs: disconnectedAtMs,
			previousState: { kind: 'connected' },
		});

		expect(
			classifyControlSessionDeathGrace({
				nowMs: disconnectedAtMs + CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace - 1,
				state: disconnectedState,
			}),
		).toEqual({
			disconnectedAtMs,
			elapsedMs: CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace - 1,
			kind: 'within_grace',
		});

		const reconnectedState = recordControlSessionReconnected({
			previousState: disconnectedState,
		});

		expect(
			classifyControlSessionDeathGrace({
				nowMs: disconnectedAtMs + CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace * 2,
				state: reconnectedState,
			}),
		).toEqual({ kind: 'connected' });

		const secondDisconnectedAtMs =
			disconnectedAtMs + CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace * 3;
		const secondDisconnectedState = recordControlSessionDisconnected({
			nowMs: secondDisconnectedAtMs,
			previousState: reconnectedState,
		});

		expect(
			classifyControlSessionDeathGrace({
				nowMs: secondDisconnectedAtMs + CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace,
				state: secondDisconnectedState,
			}),
		).toEqual({
			disconnectedAtMs: secondDisconnectedAtMs,
			elapsedMs: CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace,
			kind: 'recovery_due',
		});
	});
});
