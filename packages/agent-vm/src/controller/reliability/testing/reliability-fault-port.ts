import {
	reliabilityFaultReceiptSchema,
	type ReliabilityFaultAction,
	type ReliabilityFaultApplyRequest,
	type ReliabilityFaultReceipt,
	type ReliabilityFaultRefusalReason,
} from './reliability-test-fault-contracts.js';

export type ReliabilityFaultHandler = (
	request: ReliabilityFaultApplyRequest,
) => Promise<ReliabilityFaultReceipt>;

export type ReliabilityFaultHandlerSet = Readonly<
	Partial<Record<ReliabilityFaultAction, ReliabilityFaultHandler>>
>;

export type ReliabilityFaultRefusalReceiptFactory = (
	request: ReliabilityFaultApplyRequest,
	reason: ReliabilityFaultRefusalReason,
) => ReliabilityFaultReceipt;

interface ReliabilityFaultPortOptions {
	readonly createRefusalReceipt: ReliabilityFaultRefusalReceiptFactory;
	readonly handlers: ReliabilityFaultHandlerSet;
}

export interface ReliabilityFaultPort {
	apply(request: ReliabilityFaultApplyRequest): Promise<ReliabilityFaultReceipt>;
	refuse(
		request: ReliabilityFaultApplyRequest,
		reason: ReliabilityFaultRefusalReason,
	): ReliabilityFaultReceipt;
}

function parseClosedReceipt(receipt: ReliabilityFaultReceipt): ReliabilityFaultReceipt {
	return reliabilityFaultReceiptSchema.parse(receipt);
}

export function createReliabilityFaultPort(
	options?: ReliabilityFaultPortOptions,
): ReliabilityFaultPort | undefined {
	if (options === undefined) {
		return undefined;
	}
	return {
		async apply(request: ReliabilityFaultApplyRequest): Promise<ReliabilityFaultReceipt> {
			const handler = options.handlers[request.action];
			return handler === undefined
				? this.refuse(request, 'unsupported-action')
				: parseClosedReceipt(await handler(request));
		},
		refuse(
			request: ReliabilityFaultApplyRequest,
			reason: ReliabilityFaultRefusalReason,
		): ReliabilityFaultReceipt {
			return parseClosedReceipt(options.createRefusalReceipt(request, reason));
		},
	};
}
