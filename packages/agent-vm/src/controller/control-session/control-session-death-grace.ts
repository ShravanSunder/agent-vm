import { CONTROL_SESSION_TIMING_MS } from '@agent-vm/control-protocol-contracts';

export type ControlSessionDeathGraceState =
	| { readonly kind: 'connected' }
	| {
			readonly disconnectedAtMs: number;
			readonly kind: 'disconnected';
	  };

export type ControlSessionDeathGraceClassification =
	| { readonly kind: 'connected' }
	| {
			readonly disconnectedAtMs: number;
			readonly elapsedMs: number;
			readonly kind: 'within_grace' | 'recovery_due';
	  };

export interface RecordControlSessionDisconnectedOptions {
	readonly nowMs: number;
	readonly previousState: ControlSessionDeathGraceState;
}

export interface RecordControlSessionReconnectedOptions {
	readonly previousState: ControlSessionDeathGraceState;
}

export interface ClassifyControlSessionDeathGraceOptions {
	readonly graceMs?: number;
	readonly nowMs: number;
	readonly state: ControlSessionDeathGraceState;
}

export function recordControlSessionDisconnected(
	options: RecordControlSessionDisconnectedOptions,
): ControlSessionDeathGraceState {
	if (options.previousState.kind === 'disconnected') {
		return options.previousState;
	}
	return {
		disconnectedAtMs: options.nowMs,
		kind: 'disconnected',
	};
}

export function recordControlSessionReconnected(
	_options: RecordControlSessionReconnectedOptions,
): ControlSessionDeathGraceState {
	return { kind: 'connected' };
}

export function classifyControlSessionDeathGrace(
	options: ClassifyControlSessionDeathGraceOptions,
): ControlSessionDeathGraceClassification {
	if (options.state.kind === 'connected') {
		return { kind: 'connected' };
	}
	const graceMs = options.graceMs ?? CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace;
	const elapsedMs = Math.max(0, options.nowMs - options.state.disconnectedAtMs);
	return {
		disconnectedAtMs: options.state.disconnectedAtMs,
		elapsedMs,
		kind: elapsedMs >= graceMs ? 'recovery_due' : 'within_grace',
	};
}
