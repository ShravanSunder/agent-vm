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
	cancelOperation(options: {
		readonly activeOperationId: string;
		readonly attachmentGeneration: number;
		readonly connectionId: string;
		readonly registration: GatewayControlProcessSessionRegistration;
		readonly sessionId: string;
		readonly stablePrincipal: string;
	}):
		| { readonly status: 'cancelled' | 'already_cancelled' }
		| { readonly status: 'not_found' | 'not_owned' };
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
	readonly cancellationController?: AbortController;
	localSubmissionStarted: boolean;
	processCompletionActive: boolean;
	readonly localExecutor: GatewayControlAdmissionExecutor<unknown>;
	readonly ownerSession: RegisteredGatewayControlProcessSession;
	readonly registration: GatewayControlProcessSessionRegistration;
	readonly request: GatewayControlAdmissionExecutionRequest<unknown>;
	readonly reject: (error: unknown) => void;
	readonly resolveCleanup: () => void;
	readonly resolve: (result: GatewayControlAdmissionExecutionResult) => void;
	settled: boolean;
}

function closedSubmission(reason: string): GatewayControlAdmissionSubmission {
	const result = { reason, status: 'closed' } as const;
	return { admission: result, cleanup: Promise.resolve(), completion: Promise.resolve(result) };
}

function settleProcessWork(
	work: PendingGatewayControlProcessWork,
	result: GatewayControlAdmissionExecutionResult,
): void {
	if (work.settled) return;
	work.settled = true;
	work.resolve(result);
}

function rejectProcessWork(work: PendingGatewayControlProcessWork, error: unknown): void {
	if (work.settled) return;
	work.settled = true;
	work.reject(error);
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
	const retiredSessionsByZone = new Map<string, Set<RegisteredGatewayControlProcessSession>>();
	let pumpScheduled = false;

	const currentSessionFor = (
		registration: GatewayControlProcessSessionRegistration,
	): RegisteredGatewayControlProcessSession | undefined => {
		const session = sessionsByZone.get(registration.zoneId);
		return session?.registration === registration ? session : undefined;
	};

	const releaseWork = (work: PendingGatewayControlProcessWork): void => {
		work.ownerSession.work.delete(work);
		work.resolveCleanup();
		if (work.ownerSession.work.size === 0) {
			const retiredSessions = retiredSessionsByZone.get(work.registration.zoneId);
			retiredSessions?.delete(work.ownerSession);
			if (retiredSessions?.size === 0) retiredSessionsByZone.delete(work.registration.zoneId);
		}
		if (
			!sessionsByZone.has(work.registration.zoneId) &&
			!retiredSessionsByZone.has(work.registration.zoneId)
		) {
			processAdmission.unregisterZone(work.registration.zoneId);
		}
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
			releaseWork(work);
			return;
		}
		work.processCompletionActive = true;
		work.localSubmissionStarted = true;
		let localSubmission: GatewayControlAdmissionSubmission;
		try {
			localSubmission = work.localExecutor.submit({
				...work.request,
				execute: async () =>
					await work.request.execute(
						work.cancellationController === undefined
							? {}
							: { cancellationSignal: work.cancellationController.signal },
					),
			});
		} catch (error) {
			completeProcessToken(work, processWork.completionToken);
			rejectProcessWork(work, error);
			releaseWork(work);
			return;
		}
		void localSubmission.completion.then(
			(result) => {
				settleProcessWork(work, result);
				if (work.request.retainProcessAdmissionUntilCleanup !== true) {
					completeProcessToken(work, processWork.completionToken);
					releaseWork(work);
					schedulePump();
				}
			},
			(error: unknown) => {
				rejectProcessWork(work, error);
				if (work.request.retainProcessAdmissionUntilCleanup !== true) {
					completeProcessToken(work, processWork.completionToken);
					releaseWork(work);
					schedulePump();
				}
			},
		);
		void localSubmission.cleanup.then(
			() => {
				if (work.request.retainProcessAdmissionUntilCleanup !== true) return;
				completeProcessToken(work, processWork.completionToken);
				releaseWork(work);
				schedulePump();
			},
			(error: unknown) => {
				if (work.request.retainProcessAdmissionUntilCleanup !== true) return;
				completeProcessToken(work, processWork.completionToken);
				rejectProcessWork(work, error);
				releaseWork(work);
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
		sessionsByZone.delete(session.registration.zoneId);
		for (const work of session.work) {
			work.cancellationController?.abort(new Error(reason));
			work.request.onCancel?.(reason);
			settleProcessWork(work, { reason, status: 'closed' });
		}
		if (session.work.size === 0) {
			if (!retiredSessionsByZone.has(session.registration.zoneId)) {
				processAdmission.unregisterZone(session.registration.zoneId);
			}
		} else {
			const retiredSessions = retiredSessionsByZone.get(session.registration.zoneId) ?? new Set();
			retiredSessions.add(session);
			retiredSessionsByZone.set(session.registration.zoneId, retiredSessions);
		}
	};

	return {
		cancelOperation: (cancellation) => {
			const session = currentSessionFor(cancellation.registration);
			if (session === undefined) return { status: 'not_found' };
			const matchingId = [...session.work].find(
				(work) =>
					work.request.cancellableOperation?.activeOperationId === cancellation.activeOperationId,
			);
			if (matchingId === undefined) return { status: 'not_found' };
			const owner = matchingId.request.cancellableOperation;
			if (
				owner === undefined ||
				owner.attachmentGeneration !== cancellation.attachmentGeneration ||
				owner.connectionId !== cancellation.connectionId ||
				owner.sessionId !== cancellation.sessionId ||
				owner.stablePrincipal !== cancellation.stablePrincipal
			) {
				return { status: 'not_owned' };
			}
			if (matchingId.cancellationController?.signal.aborted === true) {
				return { status: 'already_cancelled' };
			}
			if (matchingId.settled) return { status: 'not_found' };
			matchingId.cancellationController?.abort(
				new Error('configured CLI operation cancelled by its authenticated Gateway caller'),
			);
			if (!matchingId.localSubmissionStarted) {
				settleProcessWork(matchingId, {
					reason: 'configured CLI operation cancelled before execution',
					status: 'closed',
				});
				schedulePump();
			}
			return { status: 'cancelled' };
		},
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
			let resolveCleanup!: () => void;
			const cleanup = new Promise<void>((resolve) => {
				resolveCleanup = resolve;
			});
			const completion = new Promise<GatewayControlAdmissionExecutionResult>((resolve, reject) => {
				resolveCompletion = resolve;
				rejectCompletion = reject;
			});
			const work = {
				...(request.cancellableOperation === undefined
					? {}
					: { cancellationController: new AbortController() }),
				localExecutor,
				localSubmissionStarted: false,
				ownerSession: session,
				processCompletionActive: false,
				registration,
				reject: rejectCompletion,
				request,
				resolveCleanup,
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
					return { admission: { status: 'admitted' }, cleanup, completion };
				case 'replaced':
					admission.replacedMessage.payload.request.onCancel?.('replaced');
					settleProcessWork(admission.replacedMessage.payload, { status: 'replaced' });
					releaseWork(admission.replacedMessage.payload);
					session.work.add(work);
					schedulePump();
					return { admission: { status: 'replaced' }, cleanup, completion };
				case 'dropped':
				case 'fence':
				case 'refused':
				case 'shed':
					resolveCleanup();
					resolveCompletion(admission);
					return { admission, cleanup, completion };
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
