import {
	createGatewayControlProcessAdmission,
	type GatewayControlAdmissionExecutionRequest,
	type GatewayControlAdmissionExecutionResult,
	type GatewayControlAdmissionCompletionToken,
	type GatewayControlAdmissionExecutor,
	type GatewayControlAdmissionSubmission,
	type GatewayControlProcessAdmissionWork,
} from '@agent-vm/gateway-control-contracts';

export interface GatewayControlProcessSessionRegistration {
	readonly attachmentGeneration: number;
	readonly controllerEpoch: string;
	readonly gatewayEpoch: string;
	readonly processEpoch: string;
	readonly registrationId: symbol;
	readonly zoneId: string;
}

export type GatewayControlProcessSessionRegistrationResult =
	| {
			readonly registration: GatewayControlProcessSessionRegistration;
			readonly status: 'admitted';
	  }
	| {
			readonly reason: 'gateway_epoch_conflict' | 'session_capacity' | 'stale_attachment';
			readonly status: 'capacity_refused';
	  };

export interface GatewayControlProcessAdmissionCoordinator {
	diagnostics(): {
		readonly activeSessions: number;
		readonly nonSafetyBytes: number;
		readonly nonSafetyMessages: number;
	};
	registerSession(
		identity: {
			readonly attachmentGeneration: number;
			readonly controllerEpoch: string;
			readonly gatewayEpoch: string;
			readonly processEpoch: string;
			readonly zoneId: string;
		},
		options?: { readonly onSuperseded?: (reason: string) => void },
	): GatewayControlProcessSessionRegistrationResult;
	submit(options: {
		readonly localExecutor: GatewayControlAdmissionExecutor<unknown>;
		readonly registration: GatewayControlProcessSessionRegistration;
		readonly request: GatewayControlAdmissionExecutionRequest<unknown>;
	}): GatewayControlAdmissionSubmission;
	unregisterSession(registration: GatewayControlProcessSessionRegistration, reason: string): void;
}

interface RegisteredGatewayControlProcessSession {
	readonly onSuperseded?: (reason: string) => void;
	readonly registration: GatewayControlProcessSessionRegistration;
	readonly work: Set<PendingGatewayControlProcessWork>;
}

interface PendingGatewayControlProcessWork {
	processCompletionActive: boolean;
	readonly localExecutor: GatewayControlAdmissionExecutor<unknown>;
	readonly registration: GatewayControlProcessSessionRegistration;
	readonly request: GatewayControlAdmissionExecutionRequest<unknown>;
	readonly reject: (error: unknown) => void;
	readonly resolve: (result: GatewayControlAdmissionExecutionResult) => void;
	settled: boolean;
}

function closedSubmission(reason: string): GatewayControlAdmissionSubmission {
	const result = { reason, status: 'closed' } as const;
	return { admission: result, completion: Promise.resolve(result) };
}

export function createGatewayControlProcessAdmissionCoordinator(
	options: {
		readonly maxActiveSessions?: number;
		readonly maxNonSafetyBytes?: number;
		readonly maxNonSafetyMessages?: number;
		readonly scheduleImmediate?: (callback: () => void) => void;
	} = {},
): GatewayControlProcessAdmissionCoordinator {
	const processAdmission = createGatewayControlProcessAdmission<PendingGatewayControlProcessWork>({
		...(options.maxActiveSessions === undefined
			? {}
			: { maxActiveSessions: options.maxActiveSessions }),
		...(options.maxNonSafetyBytes === undefined
			? {}
			: { maxNonSafetyBytes: options.maxNonSafetyBytes }),
		...(options.maxNonSafetyMessages === undefined
			? {}
			: { maxNonSafetyMessages: options.maxNonSafetyMessages }),
	});
	const scheduleImmediate =
		options.scheduleImmediate ?? ((callback: () => void) => setImmediate(callback));
	const sessionsByZone = new Map<string, RegisteredGatewayControlProcessSession>();
	let pumpScheduled = false;

	const currentSessionFor = (
		registration: GatewayControlProcessSessionRegistration,
	): RegisteredGatewayControlProcessSession | undefined => {
		const session = sessionsByZone.get(registration.zoneId);
		return session?.registration === registration ? session : undefined;
	};

	const settleWork = (
		work: PendingGatewayControlProcessWork,
		result: GatewayControlAdmissionExecutionResult,
	): void => {
		if (work.settled) {
			return;
		}
		work.settled = true;
		currentSessionFor(work.registration)?.work.delete(work);
		work.resolve(result);
	};

	const rejectWork = (work: PendingGatewayControlProcessWork, error: unknown): void => {
		if (work.settled) {
			return;
		}
		work.settled = true;
		currentSessionFor(work.registration)?.work.delete(work);
		work.reject(error);
	};

	const completeProcessToken = (
		work: PendingGatewayControlProcessWork,
		token: GatewayControlAdmissionCompletionToken,
	): void => {
		if (!work.processCompletionActive) {
			return;
		}
		work.processCompletionActive = false;
		processAdmission.complete(token);
	};

	const executeProcessWork = (
		processWork: GatewayControlProcessAdmissionWork<PendingGatewayControlProcessWork>,
	): void => {
		const work = processWork.message.payload;
		if (work.settled || currentSessionFor(work.registration) === undefined) {
			processAdmission.complete(processWork.completionToken);
			return;
		}
		work.processCompletionActive = true;
		let localSubmission: GatewayControlAdmissionSubmission;
		try {
			localSubmission = work.localExecutor.submit(work.request);
		} catch (error) {
			completeProcessToken(work, processWork.completionToken);
			rejectWork(work, error);
			return;
		}
		void localSubmission.completion.then(
			(result) => {
				completeProcessToken(work, processWork.completionToken);
				settleWork(work, result);
				schedulePump();
			},
			(error: unknown) => {
				completeProcessToken(work, processWork.completionToken);
				rejectWork(work, error);
				schedulePump();
			},
		);
	};

	const pump = (): void => {
		for (;;) {
			const work = processAdmission.dequeue();
			if (work === undefined) {
				return;
			}
			executeProcessWork(work);
		}
	};

	function schedulePump(): void {
		if (pumpScheduled) {
			return;
		}
		pumpScheduled = true;
		scheduleImmediate(() => {
			pumpScheduled = false;
			pump();
		});
	}

	const closeSession = (session: RegisteredGatewayControlProcessSession, reason: string): void => {
		if (currentSessionFor(session.registration) !== session) {
			return;
		}
		for (const work of session.work) {
			work.processCompletionActive = false;
			work.request.onCancel?.(reason);
			settleWork(work, { reason, status: 'closed' });
		}
		processAdmission.unregisterZone(session.registration.zoneId);
		sessionsByZone.delete(session.registration.zoneId);
	};

	return {
		diagnostics: () => processAdmission.diagnostics(),
		registerSession: (identity, registrationOptions) => {
			const zoneId = identity.zoneId;
			const existing = sessionsByZone.get(zoneId);
			if (existing !== undefined) {
				if (
					existing.registration.controllerEpoch !== identity.controllerEpoch ||
					existing.registration.gatewayEpoch !== identity.gatewayEpoch
				) {
					return { reason: 'gateway_epoch_conflict', status: 'capacity_refused' };
				}
				if (identity.attachmentGeneration <= existing.registration.attachmentGeneration) {
					return { reason: 'stale_attachment', status: 'capacity_refused' };
				}
				const reason = 'gateway control process session superseded';
				closeSession(existing, reason);
				existing.onSuperseded?.(reason);
			}
			const admission = processAdmission.registerZone(zoneId);
			if (admission.status !== 'admitted') {
				return { reason: 'session_capacity', status: 'capacity_refused' };
			}
			const registration = {
				attachmentGeneration: identity.attachmentGeneration,
				controllerEpoch: identity.controllerEpoch,
				gatewayEpoch: identity.gatewayEpoch,
				processEpoch: identity.processEpoch,
				registrationId: Symbol(`gateway-control-process-session:${zoneId}`),
				zoneId,
			} satisfies GatewayControlProcessSessionRegistration;
			sessionsByZone.set(zoneId, {
				...(registrationOptions?.onSuperseded === undefined
					? {}
					: { onSuperseded: registrationOptions.onSuperseded }),
				registration,
				work: new Set(),
			});
			return { registration, status: 'admitted' };
		},
		submit: ({ localExecutor, registration, request }) => {
			const session = currentSessionFor(registration);
			if (session === undefined) {
				return closedSubmission('gateway control process session is not current');
			}
			let resolveCompletion!: (result: GatewayControlAdmissionExecutionResult) => void;
			let rejectCompletion!: (error: unknown) => void;
			const completion = new Promise<GatewayControlAdmissionExecutionResult>((resolve, reject) => {
				resolveCompletion = resolve;
				rejectCompletion = reject;
			});
			const work = {
				localExecutor,
				processCompletionActive: false,
				registration,
				reject: rejectCompletion,
				request,
				resolve: resolveCompletion,
				settled: false,
			} satisfies PendingGatewayControlProcessWork;
			const admission = processAdmission.enqueue({
				byteLength: request.byteLength,
				...(request.coalesceKey === undefined ? {} : { coalesceKey: request.coalesceKey }),
				id: request.id,
				messageClass: request.messageClass,
				payload: work,
				...(request.stablePrincipal === undefined
					? {}
					: { stablePrincipal: request.stablePrincipal }),
				zoneId: registration.zoneId,
			});
			switch (admission.status) {
				case 'admitted':
					session.work.add(work);
					schedulePump();
					return { admission: { status: 'admitted' }, completion };
				case 'replaced':
					admission.replacedMessage.payload.request.onCancel?.('replaced');
					settleWork(admission.replacedMessage.payload, { status: 'replaced' });
					session.work.add(work);
					schedulePump();
					return { admission: { status: 'replaced' }, completion };
				case 'dropped':
				case 'fence':
				case 'refused':
				case 'shed':
					resolveCompletion(admission);
					return { admission, completion };
			}
			throw new Error('unsupported gateway process admission result');
		},
		unregisterSession: (registration, reason) => {
			const session = currentSessionFor(registration);
			if (session !== undefined) {
				closeSession(session, reason);
			}
		},
	};
}
