import {
	createGatewayRuntimeClientReadState,
	reduceGatewayRuntimeClientReadState,
	type GatewayRuntimeClientFrame,
	type GatewayRuntimeClientReadEffect,
	type GatewayRuntimeClientReadEvent,
	type GatewayRuntimeClientReadState,
	type GatewayRuntimeStreamTerminalOutcome,
} from './gateway-runtime-flow-control.js';

export interface GatewayRuntimeReadableSocketControl {
	readonly pause: () => unknown;
	readonly resume: () => unknown;
}

export interface GatewayRuntimePauseDeadlineScheduler {
	readonly schedule: (options: {
		readonly afterMilliseconds: number;
		readonly onDeadline: () => void;
	}) => { readonly cancel: () => void };
}

export interface GatewayRuntimeCompletedStreamEvidence {
	readonly outcome: GatewayRuntimeStreamTerminalOutcome;
	readonly streamId: string;
}

export interface GatewayRuntimeSocketReadFlowOptions {
	readonly deadlineScheduler?: GatewayRuntimePauseDeadlineScheduler;
	readonly forwardFrame: (frame: GatewayRuntimeClientFrame) => void;
	readonly onStreamCompleted: (evidence: GatewayRuntimeCompletedStreamEvidence) => void;
	readonly pauseDeadlineMilliseconds: number;
	readonly socket: GatewayRuntimeReadableSocketControl;
}

const defaultPauseDeadlineScheduler: GatewayRuntimePauseDeadlineScheduler = {
	schedule: ({ afterMilliseconds, onDeadline }) => {
		const timeout = setTimeout(onDeadline, afterMilliseconds);
		return { cancel: () => clearTimeout(timeout) };
	},
};

/** Apply bounded per-stream discard state to one globally paused UDS reader. */
export class GatewayRuntimeSocketReadFlow {
	readonly #deadlineScheduler: GatewayRuntimePauseDeadlineScheduler;
	readonly #forwardFrame: (frame: GatewayRuntimeClientFrame) => void;
	readonly #onStreamCompleted: (evidence: GatewayRuntimeCompletedStreamEvidence) => void;
	readonly #pauseDeadlineMilliseconds: number;
	readonly #socket: GatewayRuntimeReadableSocketControl;
	readonly #streamStates = new Map<string, GatewayRuntimeClientReadState>();
	#activePauseDeadline: { readonly cancel: () => void } | undefined;
	#pausedStreamId: string | undefined;

	constructor(options: GatewayRuntimeSocketReadFlowOptions) {
		this.#deadlineScheduler = options.deadlineScheduler ?? defaultPauseDeadlineScheduler;
		this.#forwardFrame = options.forwardFrame;
		this.#onStreamCompleted = options.onStreamCompleted;
		this.#pauseDeadlineMilliseconds = options.pauseDeadlineMilliseconds;
		this.#socket = options.socket;
	}

	#createStreamState(streamId: string): GatewayRuntimeClientReadState {
		return createGatewayRuntimeClientReadState({
			pauseDeadlineMilliseconds: this.#pauseDeadlineMilliseconds,
			streamId,
		});
	}

	#applyEffects(streamId: string, effects: readonly GatewayRuntimeClientReadEffect[]): void {
		for (const effect of effects) {
			switch (effect.kind) {
				case 'pause-socket-read':
					this.#socket.pause();
					this.#pausedStreamId = streamId;
					break;
				case 'resume-socket-read':
					this.#socket.resume();
					if (this.#pausedStreamId === streamId) this.#pausedStreamId = undefined;
					break;
				case 'schedule-pause-deadline':
					this.#activePauseDeadline = this.#deadlineScheduler.schedule({
						afterMilliseconds: effect.afterMilliseconds,
						onDeadline: () => this.#transitionStream(streamId, { kind: 'pause-deadline-expired' }),
					});
					break;
				case 'cancel-pause-deadline':
					this.#activePauseDeadline?.cancel();
					this.#activePauseDeadline = undefined;
					break;
				case 'discard-stream-data':
					break;
				case 'forward-frame':
					this.#forwardFrame(effect.frame);
					break;
				case 'complete-stream':
					this.#onStreamCompleted({ outcome: effect.outcome, streamId: effect.streamId });
					break;
			}
		}
	}

	#transitionStream(streamId: string, event: GatewayRuntimeClientReadEvent): void {
		const currentState = this.#streamStates.get(streamId) ?? this.#createStreamState(streamId);
		const transition = reduceGatewayRuntimeClientReadState(currentState, event);
		this.#streamStates.set(streamId, transition.state);
		this.#applyEffects(streamId, transition.effects);
		if (transition.state.phase === 'completed') this.#streamStates.delete(streamId);
	}

	applyDownstreamPressure(streamId: string): void {
		if (this.#pausedStreamId !== undefined && this.#pausedStreamId !== streamId) {
			throw new Error(
				`Gateway runtime socket is already paused for stream '${this.#pausedStreamId}'.`,
			);
		}
		this.#transitionStream(streamId, { kind: 'downstream-pressure' });
	}

	resumeDownstream(streamId: string): void {
		this.#transitionStream(streamId, { kind: 'downstream-resumed' });
	}

	cancelStream(streamId: string): void {
		this.#transitionStream(streamId, { kind: 'local-cancel' });
	}

	closeStream(streamId: string): void {
		this.#transitionStream(streamId, { kind: 'local-close' });
	}

	retireAttachment(streamId: string): void {
		this.#transitionStream(streamId, { kind: 'attachment-retired' });
	}

	receiveFrame(frame: GatewayRuntimeClientFrame): void {
		if (frame.kind === 'control') {
			this.#forwardFrame(frame);
			return;
		}
		const streamState = this.#streamStates.get(frame.streamId);
		if (streamState === undefined) {
			this.#forwardFrame(frame);
			return;
		}
		this.#transitionStream(frame.streamId, { frame, kind: 'frame-received' });
	}
}
