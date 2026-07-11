import {
	createGatewayControlAdmissionScheduler,
	type GatewayControlAdmissionClass,
	type GatewayControlAdmissionMessage,
	type GatewayControlAdmissionResult,
	type GatewayControlAdmissionScheduler,
} from './gateway-control-admission.js';

export const GATEWAY_CONTROL_ADMISSION_EXECUTION_LIMITS = {
	authority: 4,
	diagnostic: 1,
	liveness: 2,
	safety: 8,
} as const satisfies Readonly<Record<GatewayControlAdmissionClass, number>>;

const GATEWAY_CONTROL_ADMISSION_CLASSES: readonly GatewayControlAdmissionClass[] = [
	'authority',
	'diagnostic',
	'liveness',
	'safety',
];

type GatewayControlAdmissionNonExecutionResult<TPayload> = Exclude<
	GatewayControlAdmissionResult<TPayload>,
	{ readonly status: 'admitted' | 'replaced' }
>;

export type GatewayControlAdmissionExecutionResult =
	| { readonly reason: string; readonly status: 'closed' }
	| { readonly status: 'executed' }
	| { readonly status: 'replaced' }
	| GatewayControlAdmissionNonExecutionResult<unknown>;

export type GatewayControlAdmissionSubmissionResult =
	| { readonly reason: string; readonly status: 'closed' }
	| { readonly status: 'admitted' | 'replaced' }
	| GatewayControlAdmissionNonExecutionResult<unknown>;

export interface GatewayControlAdmissionSubmission {
	readonly admission: GatewayControlAdmissionSubmissionResult;
	readonly completion: Promise<GatewayControlAdmissionExecutionResult>;
}

export interface GatewayControlAdmissionExecutionRequest<TPayload> {
	readonly byteLength: number;
	readonly coalesceKey?: string;
	readonly execute: () => Promise<void>;
	readonly id: string;
	readonly messageClass: GatewayControlAdmissionClass;
	readonly onCancel?: (reason: string) => void;
	readonly payload: TPayload;
	readonly stablePrincipal?: string;
}

export interface GatewayControlAdmissionExecutor<TPayload> {
	close(reason: string): void;
	diagnostics(): {
		readonly activeByClass: Readonly<Record<GatewayControlAdmissionClass, number>>;
		readonly scheduler: ReturnType<GatewayControlAdmissionScheduler<unknown>['diagnostics']>;
	};
	submit(
		request: GatewayControlAdmissionExecutionRequest<TPayload>,
	): GatewayControlAdmissionSubmission;
}

interface PendingGatewayControlAdmissionExecution<TPayload> {
	readonly admissionGeneration: number;
	readonly execute: () => Promise<void>;
	readonly onCancel?: (reason: string) => void;
	readonly payload: TPayload;
	readonly reject: (error: unknown) => void;
	readonly resolve: (result: GatewayControlAdmissionExecutionResult) => void;
	settled: boolean;
}

function executionMessage<TPayload>(
	request: GatewayControlAdmissionExecutionRequest<TPayload>,
	work: PendingGatewayControlAdmissionExecution<TPayload>,
): GatewayControlAdmissionMessage<PendingGatewayControlAdmissionExecution<TPayload>> {
	return {
		byteLength: request.byteLength,
		...(request.coalesceKey === undefined ? {} : { coalesceKey: request.coalesceKey }),
		id: request.id,
		messageClass: request.messageClass,
		payload: work,
		...(request.stablePrincipal === undefined ? {} : { stablePrincipal: request.stablePrincipal }),
	};
}

export function createGatewayControlAdmissionExecutor<TPayload>(
	options: {
		readonly executionLimits?: Partial<Readonly<Record<GatewayControlAdmissionClass, number>>>;
		readonly scheduleImmediate?: (callback: () => void) => void;
	} = {},
): GatewayControlAdmissionExecutor<TPayload> {
	const scheduler =
		createGatewayControlAdmissionScheduler<PendingGatewayControlAdmissionExecution<TPayload>>();
	const scheduleImmediate =
		options.scheduleImmediate ?? ((callback: () => void) => setImmediate(callback));
	const executionLimits = {
		...GATEWAY_CONTROL_ADMISSION_EXECUTION_LIMITS,
		...options.executionLimits,
	};
	const activeByClass: Record<GatewayControlAdmissionClass, number> = {
		authority: 0,
		diagnostic: 0,
		liveness: 0,
		safety: 0,
	};
	let pumpScheduled = false;
	let admissionGeneration = 0;
	let closedReason: string | undefined;
	const activeWork = new Set<PendingGatewayControlAdmissionExecution<TPayload>>();

	for (const messageClass of GATEWAY_CONTROL_ADMISSION_CLASSES) {
		const limit = executionLimits[messageClass];
		if (!Number.isSafeInteger(limit) || limit <= 0) {
			throw new RangeError(`${messageClass} execution limit must be a positive safe integer.`);
		}
	}

	const schedulePump = (): void => {
		if (pumpScheduled || closedReason !== undefined) {
			return;
		}
		pumpScheduled = true;
		scheduleImmediate(() => {
			pumpScheduled = false;
			pump();
		});
	};

	const pump = (): void => {
		if (closedReason !== undefined) {
			return;
		}
		for (;;) {
			const allowedMessageClasses = GATEWAY_CONTROL_ADMISSION_CLASSES.filter(
				(messageClass) => activeByClass[messageClass] < executionLimits[messageClass],
			);
			if (allowedMessageClasses.length === 0) {
				return;
			}
			const admittedWork = scheduler.dequeue({ allowedMessageClasses });
			if (admittedWork === undefined) {
				return;
			}
			const { completionToken, message } = admittedWork;
			const messageClass = message.messageClass;
			const work = message.payload;
			activeByClass[messageClass] += 1;
			activeWork.add(work);
			void (async (): Promise<void> => {
				let executionError: unknown;
				try {
					await work.execute();
				} catch (error) {
					executionError = error;
				} finally {
					scheduler.complete(completionToken);
					activeByClass[messageClass] -= 1;
					activeWork.delete(work);
					schedulePump();
				}
				if (work.settled || work.admissionGeneration !== admissionGeneration) {
					return;
				}
				work.settled = true;
				if (executionError === undefined) {
					work.resolve({ status: 'executed' });
					return;
				}
				work.reject(executionError);
			})();
		}
	};

	return {
		close: (reason) => {
			if (closedReason !== undefined) {
				return;
			}
			closedReason = reason;
			admissionGeneration += 1;
			for (const message of scheduler.cancelQueued()) {
				const work = message.payload;
				if (!work.settled) {
					work.settled = true;
					work.onCancel?.(reason);
					work.resolve({ reason, status: 'closed' });
				}
			}
			for (const work of activeWork) {
				if (!work.settled) {
					work.settled = true;
					work.onCancel?.(reason);
					work.resolve({ reason, status: 'closed' });
				}
			}
		},
		diagnostics: () => ({
			activeByClass: { ...activeByClass },
			scheduler: scheduler.diagnostics(),
		}),
		submit: (request) => {
			if (closedReason !== undefined) {
				const closed = { reason: closedReason, status: 'closed' } as const;
				return { admission: closed, completion: Promise.resolve(closed) };
			}
			let resolveCompletion!: (result: GatewayControlAdmissionExecutionResult) => void;
			let rejectCompletion!: (error: unknown) => void;
			const completion = new Promise<GatewayControlAdmissionExecutionResult>((resolve, reject) => {
				resolveCompletion = resolve;
				rejectCompletion = reject;
			});
			const work = {
				admissionGeneration,
				execute: request.execute,
				...(request.onCancel === undefined ? {} : { onCancel: request.onCancel }),
				payload: request.payload,
				reject: rejectCompletion,
				resolve: resolveCompletion,
				settled: false,
			} satisfies PendingGatewayControlAdmissionExecution<TPayload>;
			const result = scheduler.enqueue(executionMessage(request, work));
			switch (result.status) {
				case 'admitted':
					schedulePump();
					return { admission: { status: 'admitted' }, completion };
				case 'replaced':
					if (!result.replacedMessage.payload.settled) {
						result.replacedMessage.payload.settled = true;
						result.replacedMessage.payload.onCancel?.('replaced');
						result.replacedMessage.payload.resolve({ status: 'replaced' });
					}
					schedulePump();
					return { admission: { status: 'replaced' }, completion };
				case 'dropped':
				case 'fence':
				case 'refused':
				case 'shed':
					resolveCompletion(result);
					return { admission: result, completion };
			}
			throw new Error('unsupported gateway control admission result');
		},
	};
}
