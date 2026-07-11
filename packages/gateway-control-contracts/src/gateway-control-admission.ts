export const GATEWAY_CONTROL_ADMISSION_LIMITS = {
	authority: { maxBytes: 1_572_864, maxMessages: 96 },
	diagnostic: { maxBytes: 1_048_576, maxMessages: 64 },
	liveness: { maxBytes: 1_048_576, maxMessages: 64 },
	maxFrameBytes: 65_536,
	perPrincipalAuthority: { maxBytes: 131_072, maxMessages: 8 },
	safety: { maxBytes: 524_288, maxMessages: 32 },
} as const;

export const GATEWAY_CONTROL_PROCESS_ADMISSION_LIMITS = {
	maxActiveSessions: 32,
	maxNonSafetyBytes: 33_554_432,
	maxNonSafetyMessages: 2_048,
} as const;

export type GatewayControlAdmissionClass = 'authority' | 'diagnostic' | 'liveness' | 'safety';

export interface GatewayControlAdmissionMessage<TPayload> {
	readonly byteLength: number;
	readonly coalesceKey?: string;
	readonly id: string;
	readonly messageClass: GatewayControlAdmissionClass;
	readonly payload: TPayload;
	readonly stablePrincipal?: string;
}

export type GatewayControlAdmissionResult<TPayload = unknown> =
	| { readonly status: 'admitted' }
	| {
			readonly replacedMessage: GatewayControlAdmissionMessage<TPayload>;
			readonly status: 'replaced';
	  }
	| { readonly reason: 'diagnostic_capacity'; readonly status: 'dropped' }
	| { readonly reason: 'liveness_capacity'; readonly status: 'shed' }
	| { readonly reason: 'principal_capacity'; readonly status: 'refused' }
	| { readonly reason: 'global_capacity'; readonly status: 'dropped' | 'refused' | 'shed' }
	| {
			readonly reason:
				| 'authority_capacity'
				| 'frame_too_large'
				| 'invalid_message'
				| 'safety_capacity';
			readonly status: 'fence';
	  };

interface QueueAccounting {
	byteCount: number;
	messageCount: number;
}

interface AuthorityQueue<TPayload> extends QueueAccounting {
	messages: GatewayControlAdmissionMessage<TPayload>[];
}

function dequeueFirstCoalescedMessage<TPayload>(
	messages: Map<string, GatewayControlAdmissionMessage<TPayload>>,
): GatewayControlAdmissionMessage<TPayload> | undefined {
	const first = messages.entries().next().value;
	if (first === undefined) {
		return undefined;
	}
	messages.delete(first[0]);
	return first[1];
}

export interface GatewayControlAdmissionDiagnostics {
	readonly authorityBytes: number;
	readonly authorityMessages: number;
	readonly diagnosticBytes: number;
	readonly diagnosticMessages: number;
	readonly livenessBytes: number;
	readonly livenessMessages: number;
	readonly safetyBytes: number;
	readonly safetyMessages: number;
	readonly coalescedMessages: number;
	readonly droppedMessages: number;
	readonly fencedMessages: number;
	readonly refusedMessages: number;
	readonly shedMessages: number;
}

export interface GatewayControlAdmissionCompletionToken {
	readonly completionTokenId: symbol;
}

export interface GatewayControlAdmissionWork<TPayload> {
	readonly completionToken: GatewayControlAdmissionCompletionToken;
	readonly message: GatewayControlAdmissionMessage<TPayload>;
}

export interface GatewayControlAdmissionScheduler<TPayload> {
	cancelQueued(): readonly GatewayControlAdmissionMessage<TPayload>[];
	complete(completionToken: GatewayControlAdmissionCompletionToken): void;
	dequeue(options?: {
		readonly allowedMessageClasses?: readonly GatewayControlAdmissionClass[];
	}): GatewayControlAdmissionWork<TPayload> | undefined;
	diagnostics(): GatewayControlAdmissionDiagnostics;
	enqueue(
		message: GatewayControlAdmissionMessage<TPayload>,
	): GatewayControlAdmissionResult<TPayload>;
}

export interface GatewayControlProcessAdmissionMessage<
	TPayload,
> extends GatewayControlAdmissionMessage<TPayload> {
	readonly zoneId: string;
}

export interface GatewayControlProcessAdmissionWork<TPayload> {
	readonly completionToken: GatewayControlAdmissionCompletionToken;
	readonly message: GatewayControlProcessAdmissionMessage<TPayload>;
}

export interface GatewayControlProcessAdmission<TPayload> {
	complete(completionToken: GatewayControlAdmissionCompletionToken): void;
	dequeue(): GatewayControlProcessAdmissionWork<TPayload> | undefined;
	diagnostics(): {
		readonly activeSessions: number;
		readonly nonSafetyBytes: number;
		readonly nonSafetyMessages: number;
	};
	enqueue(
		message: GatewayControlProcessAdmissionMessage<TPayload>,
	): GatewayControlAdmissionResult<TPayload>;
	registerZone(zoneId: string): { readonly status: 'admitted' | 'capacity_refused' };
	unregisterZone(zoneId: string): void;
}

const serviceCycle: readonly GatewayControlAdmissionClass[] = [
	'safety',
	'safety',
	'safety',
	'safety',
	'safety',
	'safety',
	'safety',
	'safety',
	'authority',
	'authority',
	'authority',
	'authority',
	'liveness',
	'liveness',
	'diagnostic',
];

function canReserve(
	accounting: QueueAccounting,
	byteLength: number,
	limits: { readonly maxBytes: number; readonly maxMessages: number },
): boolean {
	return (
		accounting.byteCount + byteLength <= limits.maxBytes &&
		accounting.messageCount + 1 <= limits.maxMessages
	);
}

function release(accounting: QueueAccounting, byteLength: number): void {
	accounting.byteCount -= byteLength;
	accounting.messageCount -= 1;
}

function requirePositiveLimit(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer.`);
	}
}

function validateMessage<TPayload>(
	message: GatewayControlAdmissionMessage<TPayload>,
): GatewayControlAdmissionResult<TPayload> | undefined {
	if (
		message.id.length === 0 ||
		!Number.isSafeInteger(message.byteLength) ||
		message.byteLength <= 0
	) {
		return { reason: 'invalid_message', status: 'fence' };
	}
	if (message.byteLength > GATEWAY_CONTROL_ADMISSION_LIMITS.maxFrameBytes) {
		return { reason: 'frame_too_large', status: 'fence' };
	}
	if (
		message.messageClass === 'authority' &&
		(message.stablePrincipal === undefined || message.stablePrincipal.length === 0)
	) {
		return { reason: 'invalid_message', status: 'fence' };
	}
	if (
		(message.messageClass === 'diagnostic' || message.messageClass === 'liveness') &&
		(message.coalesceKey === undefined || message.coalesceKey.length === 0)
	) {
		return { reason: 'invalid_message', status: 'fence' };
	}
	return undefined;
}

function isGatewayControlProcessAdmissionMessage<TPayload>(
	message: GatewayControlAdmissionMessage<TPayload>,
): message is GatewayControlProcessAdmissionMessage<TPayload> {
	return 'zoneId' in message && typeof message.zoneId === 'string';
}

function gatewayControlProcessCoalescingKey<TPayload>(
	message: GatewayControlProcessAdmissionMessage<TPayload>,
): string | undefined {
	return message.messageClass === 'liveness' || message.messageClass === 'diagnostic'
		? `${message.messageClass}\u0000${message.coalesceKey ?? ''}`
		: undefined;
}

export function createGatewayControlAdmissionScheduler<
	TPayload,
>(): GatewayControlAdmissionScheduler<TPayload> {
	const safety: GatewayControlAdmissionMessage<TPayload>[] = [];
	const safetyAccounting: QueueAccounting = { byteCount: 0, messageCount: 0 };
	const authorityByPrincipal = new Map<string, AuthorityQueue<TPayload>>();
	const authorityPrincipalOrder: string[] = [];
	const authorityAccounting: QueueAccounting = { byteCount: 0, messageCount: 0 };
	const livenessByKey = new Map<string, GatewayControlAdmissionMessage<TPayload>>();
	const livenessAccounting: QueueAccounting = { byteCount: 0, messageCount: 0 };
	const diagnosticByKey = new Map<string, GatewayControlAdmissionMessage<TPayload>>();
	const diagnosticAccounting: QueueAccounting = { byteCount: 0, messageCount: 0 };
	const inFlightMessages = new Map<
		GatewayControlAdmissionCompletionToken,
		GatewayControlAdmissionMessage<TPayload>
	>();
	let serviceCursor = 0;
	let authorityPrincipalCursor = 0;
	let coalescedMessages = 0;
	let droppedMessages = 0;
	let fencedMessages = 0;
	let refusedMessages = 0;
	let shedMessages = 0;

	const dequeueAuthority = (): GatewayControlAdmissionMessage<TPayload> | undefined => {
		if (authorityPrincipalOrder.length === 0) {
			return undefined;
		}
		for (let offset = 0; offset < authorityPrincipalOrder.length; offset += 1) {
			const index = (authorityPrincipalCursor + offset) % authorityPrincipalOrder.length;
			const principal = authorityPrincipalOrder[index];
			if (principal === undefined) {
				continue;
			}
			const queue = authorityByPrincipal.get(principal);
			const message = queue?.messages.shift();
			if (queue === undefined || message === undefined) {
				continue;
			}
			authorityPrincipalCursor = (index + 1) % authorityPrincipalOrder.length;
			return message;
		}
		return undefined;
	};

	const dequeueClass = (
		messageClass: GatewayControlAdmissionClass,
	): GatewayControlAdmissionMessage<TPayload> | undefined => {
		switch (messageClass) {
			case 'safety': {
				const message = safety.shift();
				return message;
			}
			case 'authority':
				return dequeueAuthority();
			case 'liveness':
				return dequeueFirstCoalescedMessage(livenessByKey);
			case 'diagnostic':
				return dequeueFirstCoalescedMessage(diagnosticByKey);
		}
		throw new Error('unsupported gateway control admission class');
	};

	return {
		cancelQueued() {
			const cancelled: GatewayControlAdmissionMessage<TPayload>[] = [];
			for (const message of safety.splice(0)) {
				release(safetyAccounting, message.byteLength);
				cancelled.push(message);
			}
			for (const [principal, queue] of authorityByPrincipal) {
				for (const message of queue.messages.splice(0)) {
					release(queue, message.byteLength);
					release(authorityAccounting, message.byteLength);
					cancelled.push(message);
				}
				if (queue.messageCount === 0) {
					authorityByPrincipal.delete(principal);
				}
			}
			for (let index = authorityPrincipalOrder.length - 1; index >= 0; index -= 1) {
				if (!authorityByPrincipal.has(authorityPrincipalOrder[index] ?? '')) {
					authorityPrincipalOrder.splice(index, 1);
				}
			}
			authorityPrincipalCursor =
				authorityPrincipalOrder.length === 0
					? 0
					: Math.min(authorityPrincipalCursor, authorityPrincipalOrder.length - 1);
			for (const message of livenessByKey.values()) {
				release(livenessAccounting, message.byteLength);
				cancelled.push(message);
			}
			livenessByKey.clear();
			for (const message of diagnosticByKey.values()) {
				release(diagnosticAccounting, message.byteLength);
				cancelled.push(message);
			}
			diagnosticByKey.clear();
			return cancelled;
		},
		complete(completionToken) {
			const message = inFlightMessages.get(completionToken);
			if (message === undefined || !inFlightMessages.delete(completionToken)) {
				throw new Error('gateway control admission message is not in flight');
			}
			switch (message.messageClass) {
				case 'safety':
					release(safetyAccounting, message.byteLength);
					return;
				case 'authority': {
					const principal = message.stablePrincipal ?? '';
					const queue = authorityByPrincipal.get(principal);
					if (queue === undefined) {
						throw new Error('gateway control authority principal is not admitted');
					}
					release(queue, message.byteLength);
					release(authorityAccounting, message.byteLength);
					if (queue.messageCount === 0) {
						authorityByPrincipal.delete(principal);
						const index = authorityPrincipalOrder.indexOf(principal);
						if (index >= 0) {
							authorityPrincipalOrder.splice(index, 1);
							authorityPrincipalCursor =
								authorityPrincipalOrder.length === 0
									? 0
									: Math.min(authorityPrincipalCursor, authorityPrincipalOrder.length - 1);
						}
					}
					return;
				}
				case 'liveness':
					release(livenessAccounting, message.byteLength);
					return;
				case 'diagnostic':
					release(diagnosticAccounting, message.byteLength);
					return;
			}
		},
		enqueue(message) {
			const invalid = validateMessage(message);
			if (invalid !== undefined) {
				fencedMessages += 1;
				return invalid;
			}
			switch (message.messageClass) {
				case 'safety':
					if (
						!canReserve(
							safetyAccounting,
							message.byteLength,
							GATEWAY_CONTROL_ADMISSION_LIMITS.safety,
						)
					) {
						fencedMessages += 1;
						return { reason: 'safety_capacity', status: 'fence' };
					}
					safety.push(message);
					safetyAccounting.byteCount += message.byteLength;
					safetyAccounting.messageCount += 1;
					return { status: 'admitted' };
				case 'authority': {
					const principal = message.stablePrincipal ?? '';
					const queue = authorityByPrincipal.get(principal) ?? {
						byteCount: 0,
						messageCount: 0,
						messages: [],
					};
					if (
						!canReserve(
							queue,
							message.byteLength,
							GATEWAY_CONTROL_ADMISSION_LIMITS.perPrincipalAuthority,
						)
					) {
						refusedMessages += 1;
						return { reason: 'principal_capacity', status: 'refused' };
					}
					if (
						!canReserve(
							authorityAccounting,
							message.byteLength,
							GATEWAY_CONTROL_ADMISSION_LIMITS.authority,
						)
					) {
						fencedMessages += 1;
						return { reason: 'authority_capacity', status: 'fence' };
					}
					if (!authorityByPrincipal.has(principal)) {
						authorityByPrincipal.set(principal, queue);
						authorityPrincipalOrder.push(principal);
					}
					queue.messages.push(message);
					queue.byteCount += message.byteLength;
					queue.messageCount += 1;
					authorityAccounting.byteCount += message.byteLength;
					authorityAccounting.messageCount += 1;
					return { status: 'admitted' };
				}
				case 'liveness':
				case 'diagnostic': {
					const isLiveness = message.messageClass === 'liveness';
					const messages = isLiveness ? livenessByKey : diagnosticByKey;
					const accounting = isLiveness ? livenessAccounting : diagnosticAccounting;
					const limits = isLiveness
						? GATEWAY_CONTROL_ADMISSION_LIMITS.liveness
						: GATEWAY_CONTROL_ADMISSION_LIMITS.diagnostic;
					const key = message.coalesceKey ?? '';
					const prior = messages.get(key);
					const nextBytes = accounting.byteCount - (prior?.byteLength ?? 0) + message.byteLength;
					const nextMessages = accounting.messageCount + (prior === undefined ? 1 : 0);
					if (nextBytes > limits.maxBytes || nextMessages > limits.maxMessages) {
						if (isLiveness) {
							shedMessages += 1;
							return { reason: 'liveness_capacity', status: 'shed' };
						}
						droppedMessages += 1;
						return { reason: 'diagnostic_capacity', status: 'dropped' };
					}
					messages.set(key, message);
					accounting.byteCount = nextBytes;
					accounting.messageCount = nextMessages;
					if (prior !== undefined) {
						coalescedMessages += 1;
					}
					return prior === undefined
						? { status: 'admitted' }
						: { replacedMessage: prior, status: 'replaced' };
				}
			}
			throw new Error('unsupported gateway control admission class');
		},
		dequeue(options = {}) {
			for (let offset = 0; offset < serviceCycle.length; offset += 1) {
				const index = (serviceCursor + offset) % serviceCycle.length;
				const messageClass = serviceCycle[index];
				if (messageClass === undefined) {
					continue;
				}
				if (
					options.allowedMessageClasses !== undefined &&
					!options.allowedMessageClasses.includes(messageClass)
				) {
					continue;
				}
				const message = dequeueClass(messageClass);
				if (message !== undefined) {
					serviceCursor = (index + 1) % serviceCycle.length;
					const completionToken = Object.freeze({
						completionTokenId: Symbol('gateway-control-admission-completion'),
					}) satisfies GatewayControlAdmissionCompletionToken;
					inFlightMessages.set(completionToken, message);
					return { completionToken, message };
				}
			}
			return undefined;
		},
		diagnostics() {
			return {
				authorityBytes: authorityAccounting.byteCount,
				authorityMessages: authorityAccounting.messageCount,
				diagnosticBytes: diagnosticAccounting.byteCount,
				diagnosticMessages: diagnosticAccounting.messageCount,
				livenessBytes: livenessAccounting.byteCount,
				livenessMessages: livenessAccounting.messageCount,
				safetyBytes: safetyAccounting.byteCount,
				safetyMessages: safetyAccounting.messageCount,
				coalescedMessages,
				droppedMessages,
				fencedMessages,
				refusedMessages,
				shedMessages,
			};
		},
	};
}

export function createGatewayControlProcessAdmission<TPayload>(
	options: {
		readonly maxActiveSessions?: number;
		readonly maxNonSafetyBytes?: number;
		readonly maxNonSafetyMessages?: number;
	} = {},
): GatewayControlProcessAdmission<TPayload> {
	const maxActiveSessions =
		options.maxActiveSessions ?? GATEWAY_CONTROL_PROCESS_ADMISSION_LIMITS.maxActiveSessions;
	const maxNonSafetyBytes =
		options.maxNonSafetyBytes ?? GATEWAY_CONTROL_PROCESS_ADMISSION_LIMITS.maxNonSafetyBytes;
	const maxNonSafetyMessages =
		options.maxNonSafetyMessages ?? GATEWAY_CONTROL_PROCESS_ADMISSION_LIMITS.maxNonSafetyMessages;
	const schedulersByZone = new Map<string, GatewayControlAdmissionScheduler<TPayload>>();
	const queuedCoalescibleMessagesByZone = new Map<
		string,
		Map<string, GatewayControlProcessAdmissionMessage<TPayload>>
	>();
	const inFlightMessages = new Map<
		GatewayControlAdmissionCompletionToken,
		GatewayControlProcessAdmissionMessage<TPayload>
	>();
	const zoneOrder: string[] = [];
	let zoneCursor = 0;
	let nonSafetyBytes = 0;
	let nonSafetyMessages = 0;

	requirePositiveLimit('maxActiveSessions', maxActiveSessions);
	requirePositiveLimit('maxNonSafetyBytes', maxNonSafetyBytes);
	requirePositiveLimit('maxNonSafetyMessages', maxNonSafetyMessages);

	return {
		complete(completionToken) {
			const message = inFlightMessages.get(completionToken);
			if (message === undefined || !inFlightMessages.delete(completionToken)) {
				throw new Error('gateway control process admission message is not in flight');
			}
			const scheduler = schedulersByZone.get(message.zoneId);
			if (scheduler === undefined) {
				throw new Error('gateway control process admission zone is not registered');
			}
			scheduler.complete(completionToken);
			if (message.messageClass !== 'safety') {
				nonSafetyMessages -= 1;
				nonSafetyBytes -= message.byteLength;
			}
		},
		registerZone(zoneId) {
			if (zoneId.length === 0) {
				return { status: 'capacity_refused' };
			}
			if (schedulersByZone.has(zoneId)) {
				return { status: 'admitted' };
			}
			if (schedulersByZone.size >= maxActiveSessions) {
				return { status: 'capacity_refused' };
			}
			schedulersByZone.set(zoneId, createGatewayControlAdmissionScheduler<TPayload>());
			queuedCoalescibleMessagesByZone.set(zoneId, new Map());
			zoneOrder.push(zoneId);
			return { status: 'admitted' };
		},
		unregisterZone(zoneId) {
			const scheduler = schedulersByZone.get(zoneId);
			if (scheduler === undefined) {
				return;
			}
			for (;;) {
				const work = scheduler.dequeue();
				if (work === undefined) {
					break;
				}
				const { completionToken, message } = work;
				if (message.messageClass !== 'safety') {
					nonSafetyBytes -= message.byteLength;
					nonSafetyMessages -= 1;
				}
				scheduler.complete(completionToken);
			}
			for (const [completionToken, message] of inFlightMessages) {
				if (message.zoneId !== zoneId) {
					continue;
				}
				inFlightMessages.delete(completionToken);
				scheduler.complete(completionToken);
				if (message.messageClass !== 'safety') {
					nonSafetyBytes -= message.byteLength;
					nonSafetyMessages -= 1;
				}
			}
			schedulersByZone.delete(zoneId);
			queuedCoalescibleMessagesByZone.delete(zoneId);
			const index = zoneOrder.indexOf(zoneId);
			if (index >= 0) {
				zoneOrder.splice(index, 1);
				zoneCursor = zoneOrder.length === 0 ? 0 : Math.min(zoneCursor, zoneOrder.length - 1);
			}
		},
		enqueue(message) {
			const scheduler = schedulersByZone.get(message.zoneId);
			if (scheduler === undefined) {
				return { reason: 'global_capacity', status: 'refused' };
			}
			const coalescingKey = gatewayControlProcessCoalescingKey(message);
			const priorCoalescibleMessage =
				coalescingKey === undefined
					? undefined
					: queuedCoalescibleMessagesByZone.get(message.zoneId)?.get(coalescingKey);
			const nonSafetyMessageDelta = priorCoalescibleMessage === undefined ? 1 : 0;
			const nonSafetyByteDelta = message.byteLength - (priorCoalescibleMessage?.byteLength ?? 0);
			if (
				message.messageClass !== 'safety' &&
				(nonSafetyMessages + nonSafetyMessageDelta > maxNonSafetyMessages ||
					nonSafetyBytes + nonSafetyByteDelta > maxNonSafetyBytes)
			) {
				return message.messageClass === 'authority'
					? { reason: 'global_capacity', status: 'refused' }
					: message.messageClass === 'liveness'
						? { reason: 'global_capacity', status: 'shed' }
						: { reason: 'global_capacity', status: 'dropped' };
			}
			const before = scheduler.diagnostics();
			const result = scheduler.enqueue(message);
			if (
				message.messageClass !== 'safety' &&
				(result.status === 'admitted' || result.status === 'replaced')
			) {
				const after = scheduler.diagnostics();
				const beforeMessages =
					before.authorityMessages + before.livenessMessages + before.diagnosticMessages;
				const afterMessages =
					after.authorityMessages + after.livenessMessages + after.diagnosticMessages;
				const beforeBytes = before.authorityBytes + before.livenessBytes + before.diagnosticBytes;
				const afterBytes = after.authorityBytes + after.livenessBytes + after.diagnosticBytes;
				nonSafetyMessages += afterMessages - beforeMessages;
				nonSafetyBytes += afterBytes - beforeBytes;
				if (coalescingKey !== undefined) {
					queuedCoalescibleMessagesByZone.get(message.zoneId)?.set(coalescingKey, message);
				}
			}
			return result;
		},
		dequeue() {
			if (zoneOrder.length === 0) {
				return undefined;
			}
			for (let offset = 0; offset < zoneOrder.length; offset += 1) {
				const index = (zoneCursor + offset) % zoneOrder.length;
				const zoneId = zoneOrder[index];
				const scheduler = zoneId === undefined ? undefined : schedulersByZone.get(zoneId);
				const work = scheduler?.dequeue();
				if (zoneId === undefined || work === undefined) {
					continue;
				}
				const { completionToken, message } = work;
				if (!isGatewayControlProcessAdmissionMessage(message) || message.zoneId !== zoneId) {
					throw new Error('gateway control process admission message lost its zone identity');
				}
				const coalescingKey = gatewayControlProcessCoalescingKey(message);
				if (coalescingKey !== undefined) {
					const queuedMessages = queuedCoalescibleMessagesByZone.get(zoneId);
					if (queuedMessages?.get(coalescingKey) === message) {
						queuedMessages.delete(coalescingKey);
					}
				}
				zoneCursor = (index + 1) % zoneOrder.length;
				inFlightMessages.set(completionToken, message);
				return { completionToken, message };
			}
			return undefined;
		},
		diagnostics() {
			return { activeSessions: schedulersByZone.size, nonSafetyBytes, nonSafetyMessages };
		},
	};
}
