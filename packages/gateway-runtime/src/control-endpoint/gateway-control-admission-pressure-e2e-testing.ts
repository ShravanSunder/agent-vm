import {
	GATEWAY_CONTROL_ADMISSION_EXECUTION_LIMITS,
	GATEWAY_CONTROL_ADMISSION_LIMITS,
	type GatewayControlAdmissionClass,
	type GatewayControlAdmissionExecutor,
	type GatewayControlAdmissionSubmissionResult,
	type GatewayControlRpcMessage,
} from '@agent-vm/gateway-control-contracts';

import type { GatewayControlAcceptedSession } from './gateway-control-endpoint-contracts.js';

export const AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV =
	'AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE';
export const AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_KEY_ENV =
	'AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_KEY';
export const GATEWAY_CONTROL_ADMISSION_PRESSURE_BATCH_LIMIT = 80;

type PressureDirection = 'egress' | 'ingress';
type PressureMessageClass = Extract<GatewayControlAdmissionClass, 'diagnostic' | 'liveness'>;

interface PressureExecutorDiagnostics {
	readonly activeByClass: Readonly<Record<GatewayControlAdmissionClass, number>>;
	readonly queuedByClass: Readonly<Record<GatewayControlAdmissionClass, number>>;
	readonly scheduler: {
		readonly authorityBytes: number;
		readonly authorityMessages: number;
		readonly coalescedMessages: number;
		readonly diagnosticBytes: number;
		readonly diagnosticMessages: number;
		readonly droppedMessages: number;
		readonly fencedMessages: number;
		readonly livenessBytes: number;
		readonly livenessMessages: number;
		readonly refusedMessages: number;
		readonly safetyBytes: number;
		readonly safetyMessages: number;
		readonly shedMessages: number;
	};
}

export interface GatewayControlAdmissionPressureSnapshot {
	readonly acceptedAttachmentGeneration: number;
	readonly capacities: {
		readonly execution: typeof GATEWAY_CONTROL_ADMISSION_EXECUTION_LIMITS;
		readonly queue: typeof GATEWAY_CONTROL_ADMISSION_LIMITS;
	};
	readonly egress: PressureExecutorDiagnostics;
	readonly highWater: Readonly<
		Record<PressureDirection, Readonly<Record<PressureMessageClass, number>>>
	>;
	readonly ingress: PressureExecutorDiagnostics;
}

export interface GatewayControlAdmissionPressureActuator {
	hold(options: {
		readonly attachmentGeneration: number;
		readonly direction: PressureDirection;
		readonly messageClass: PressureMessageClass;
	}): Promise<{ readonly holdId: string }>;
	release(options: {
		readonly attachmentGeneration: number;
		readonly holdId: string;
	}): Promise<void>;
	snapshot(attachmentGeneration: number): GatewayControlAdmissionPressureSnapshot;
	submitBatch(options: {
		readonly attachmentGeneration: number;
		readonly batchSize: number;
		readonly byteLength: number;
		readonly coalesceKeyPrefix: string;
		readonly direction: PressureDirection;
		readonly messageClass: PressureMessageClass;
	}): Promise<{
		readonly admissions: readonly GatewayControlAdmissionSubmissionResult[];
		readonly snapshot: GatewayControlAdmissionPressureSnapshot;
	}>;
}

interface HeldPressureWork {
	readonly attachmentGeneration: number;
	readonly direction: PressureDirection;
	readonly messageClass: PressureMessageClass;
	readonly release: () => void;
}

let registeredActuator: GatewayControlAdmissionPressureActuator | undefined;

function executorDiagnostics(
	executor: GatewayControlAdmissionExecutor<GatewayControlRpcMessage>,
): PressureExecutorDiagnostics {
	const diagnostics = executor.diagnostics();
	return {
		...diagnostics,
		queuedByClass: {
			authority: diagnostics.scheduler.authorityMessages - diagnostics.activeByClass.authority,
			diagnostic: diagnostics.scheduler.diagnosticMessages - diagnostics.activeByClass.diagnostic,
			liveness: diagnostics.scheduler.livenessMessages - diagnostics.activeByClass.liveness,
			safety: diagnostics.scheduler.safetyMessages - diagnostics.activeByClass.safety,
		},
	};
}

export function getGatewayControlAdmissionPressureE2eActuator():
	| GatewayControlAdmissionPressureActuator
	| undefined {
	return registeredActuator;
}

export function registerGatewayControlAdmissionPressureE2eActuator(
	actuator: GatewayControlAdmissionPressureActuator,
): () => void {
	if (process.env[AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV] !== '1') {
		return () => undefined;
	}
	registeredActuator = actuator;
	return () => {
		if (registeredActuator === actuator) registeredActuator = undefined;
	};
}

export function createGatewayControlAdmissionPressureE2eActuator(options: {
	readonly getAcceptedSession: () => GatewayControlAcceptedSession | undefined;
	readonly getEgress: () => GatewayControlAdmissionExecutor<GatewayControlRpcMessage>;
	readonly getIngress: () => GatewayControlAdmissionExecutor<GatewayControlRpcMessage>;
}): GatewayControlAdmissionPressureActuator {
	const heldWorkById = new Map<string, HeldPressureWork>();
	const highWater: Record<PressureDirection, Record<PressureMessageClass, number>> = {
		egress: { diagnostic: 0, liveness: 0 },
		ingress: { diagnostic: 0, liveness: 0 },
	};
	let nextWorkId = 1;

	const assertCurrentGeneration = (attachmentGeneration: number): void => {
		const acceptedSession = options.getAcceptedSession();
		if (
			acceptedSession === undefined ||
			acceptedSession.attachmentGeneration !== attachmentGeneration
		) {
			throw new Error('gateway control admission pressure actuator generation is stale');
		}
	};
	const executorFor = (
		direction: PressureDirection,
	): GatewayControlAdmissionExecutor<GatewayControlRpcMessage> =>
		direction === 'ingress' ? options.getIngress() : options.getEgress();
	const updateHighWater = (direction: PressureDirection): void => {
		const diagnostics = executorFor(direction).diagnostics();
		for (const messageClass of ['diagnostic', 'liveness'] as const) {
			highWater[direction][messageClass] = Math.max(
				highWater[direction][messageClass],
				diagnostics.scheduler[`${messageClass}Messages`],
			);
		}
	};
	const snapshot = (attachmentGeneration: number): GatewayControlAdmissionPressureSnapshot => {
		assertCurrentGeneration(attachmentGeneration);
		updateHighWater('ingress');
		updateHighWater('egress');
		return {
			acceptedAttachmentGeneration: attachmentGeneration,
			capacities: {
				execution: GATEWAY_CONTROL_ADMISSION_EXECUTION_LIMITS,
				queue: GATEWAY_CONTROL_ADMISSION_LIMITS,
			},
			egress: executorDiagnostics(options.getEgress()),
			highWater: {
				egress: { ...highWater.egress },
				ingress: { ...highWater.ingress },
			},
			ingress: executorDiagnostics(options.getIngress()),
		};
	};

	return {
		hold: async ({ attachmentGeneration, direction, messageClass }) => {
			assertCurrentGeneration(attachmentGeneration);
			const holdId = `e2e-admission-hold-${String(nextWorkId++)}`;
			let release!: () => void;
			let reportStarted!: () => void;
			const started = new Promise<void>((resolve) => {
				reportStarted = resolve;
			});
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const submission = executorFor(direction).submit({
				byteLength: 1,
				coalesceKey: holdId,
				execute: async () => {
					reportStarted();
					await held;
				},
				id: holdId,
				messageClass,
				payload: pressurePayload(),
			});
			if (submission.admission.status !== 'admitted') {
				throw new Error(
					`gateway control admission pressure hold was ${submission.admission.status}`,
				);
			}
			heldWorkById.set(holdId, {
				attachmentGeneration,
				direction,
				messageClass,
				release,
			});
			await started;
			assertCurrentGeneration(attachmentGeneration);
			updateHighWater(direction);
			return { holdId };
		},
		release: async ({ attachmentGeneration, holdId }) => {
			assertCurrentGeneration(attachmentGeneration);
			const heldWork = heldWorkById.get(holdId);
			if (heldWork === undefined || heldWork.attachmentGeneration !== attachmentGeneration) {
				throw new Error('gateway control admission pressure hold is absent or stale');
			}
			heldWorkById.delete(holdId);
			heldWork.release();
			const waitForDrain = async (drainAttempt: number): Promise<void> => {
				await new Promise<void>((resolve) => setImmediate(resolve));
				assertCurrentGeneration(attachmentGeneration);
				const diagnostics = executorFor(heldWork.direction).diagnostics();
				if (
					diagnostics.activeByClass[heldWork.messageClass] === 0 &&
					diagnostics.scheduler[`${heldWork.messageClass}Messages`] === 0
				) {
					return;
				}
				if (drainAttempt >= 255) {
					throw new Error('gateway control admission pressure did not drain after release');
				}
				await waitForDrain(drainAttempt + 1);
			};
			await waitForDrain(0);
		},
		snapshot,
		submitBatch: async ({
			attachmentGeneration,
			batchSize,
			byteLength,
			coalesceKeyPrefix,
			direction,
			messageClass,
		}) => {
			assertCurrentGeneration(attachmentGeneration);
			if (
				!Number.isSafeInteger(batchSize) ||
				batchSize <= 0 ||
				batchSize > GATEWAY_CONTROL_ADMISSION_PRESSURE_BATCH_LIMIT
			) {
				throw new RangeError(
					`gateway control admission pressure batch size must be between 1 and ${String(GATEWAY_CONTROL_ADMISSION_PRESSURE_BATCH_LIMIT)}`,
				);
			}
			if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
				throw new RangeError('gateway control admission pressure byte length must be positive');
			}
			if (coalesceKeyPrefix.length === 0) {
				throw new Error('gateway control admission pressure coalesce key prefix is required');
			}
			const executor = executorFor(direction);
			const admissions = Array.from(
				{ length: batchSize },
				(_unused, batchIndex) =>
					executor.submit({
						byteLength,
						coalesceKey: `${coalesceKeyPrefix}-${String(batchIndex)}`,
						execute: async () => undefined,
						id: `e2e-admission-batch-${String(nextWorkId++)}`,
						messageClass,
						payload: pressurePayload(),
					}).admission,
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assertCurrentGeneration(attachmentGeneration);
			updateHighWater(direction);
			return { admissions, snapshot: snapshot(attachmentGeneration) };
		},
	};
}

function pressurePayload(): GatewayControlRpcMessage {
	return {
		kind: 'event',
		operation: 'runtime_status',
		payload: {
			findings: [],
			observedAtMs: 0,
			statusKind: 'gateway-runtime-e2e-pressure',
		},
	};
}
