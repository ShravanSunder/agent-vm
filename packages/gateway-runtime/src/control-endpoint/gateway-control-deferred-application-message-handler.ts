import { createGatewayRuntimeControlMessageHandler } from './gateway-control-default-message-handler.js';
import type { GatewayControlApplicationMessageHandler } from './gateway-control-endpoint-contracts.js';

type GatewayControlDeferredApplicationMessageHandlerState =
	| { readonly kind: 'pending' }
	| {
			readonly handler: GatewayControlApplicationMessageHandler;
			readonly kind: 'bound';
	  }
	| {
			readonly error: Error;
			readonly kind: 'failed';
	  };

type GatewayControlDeferredApplicationMessageHandlerSettlement = 'bind' | 'fail';

export class GatewayControlDeferredApplicationMessageHandlerSettlementError extends Error {
	constructor(
		readonly attemptedSettlement: GatewayControlDeferredApplicationMessageHandlerSettlement,
		readonly currentState: Exclude<
			GatewayControlDeferredApplicationMessageHandlerState['kind'],
			'pending'
		>,
	) {
		super(
			`gateway control deferred application message handler cannot ${attemptedSettlement} after ${currentState}`,
		);
		this.name = 'GatewayControlDeferredApplicationMessageHandlerSettlementError';
	}
}

export interface GatewayControlDeferredApplicationMessageHandler {
	readonly bind: (handler: GatewayControlApplicationMessageHandler) => void;
	readonly fail: (error: unknown) => void;
	readonly handler: GatewayControlApplicationMessageHandler;
}

function normalizeTerminalFailure(error: unknown): Error {
	return error instanceof Error
		? error
		: new Error('gateway control application message handler composition failed', {
				cause: error,
			});
}

export function createGatewayControlDeferredApplicationMessageHandler(): GatewayControlDeferredApplicationMessageHandler {
	const protocolHandler = createGatewayRuntimeControlMessageHandler();
	let resolveBinding: ((handler: GatewayControlApplicationMessageHandler) => void) | undefined;
	let rejectBinding: ((error: Error) => void) | undefined;
	const binding = new Promise<GatewayControlApplicationMessageHandler>((resolve, reject) => {
		resolveBinding = resolve;
		rejectBinding = reject;
	});
	void binding.catch(() => undefined);
	if (resolveBinding === undefined || rejectBinding === undefined) {
		throw new Error('gateway control deferred handler promise was not initialized');
	}
	const settleBinding = resolveBinding;
	const settleFailure = rejectBinding;
	let state: GatewayControlDeferredApplicationMessageHandlerState = { kind: 'pending' };

	const waitForHandler = (): Promise<GatewayControlApplicationMessageHandler> => {
		switch (state.kind) {
			case 'bound':
				return Promise.resolve(state.handler);
			case 'failed':
				return Promise.reject(state.error);
			case 'pending':
				return binding;
		}
	};

	return {
		bind: (handler) => {
			if (state.kind !== 'pending') {
				throw new GatewayControlDeferredApplicationMessageHandlerSettlementError(
					'bind',
					state.kind,
				);
			}
			state = { handler, kind: 'bound' };
			settleBinding(handler);
		},
		fail: (error) => {
			if (state.kind !== 'pending') {
				throw new GatewayControlDeferredApplicationMessageHandlerSettlementError(
					'fail',
					state.kind,
				);
			}
			const terminalFailure = normalizeTerminalFailure(error);
			state = { error: terminalFailure, kind: 'failed' };
			settleFailure(terminalFailure);
		},
		handler: {
			...(protocolHandler.buildHandlerFailureResult === undefined
				? {}
				: {
						buildHandlerFailureResult: (context, error) =>
							protocolHandler.buildHandlerFailureResult?.(context, error),
					}),
			handle: async (context) => await (await waitForHandler()).handle(context),
			messageIdentity: (context) => protocolHandler.messageIdentity(context),
		},
	};
}
