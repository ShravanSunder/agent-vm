import { Buffer } from 'node:buffer';

import {
	deriveZoneHealthSnapshot,
	healthEventBucketKey,
	type AgentVmHealthEvent,
	type ZoneHealthSnapshot,
} from '@agent-vm/gateway-lifecycle';

export interface HealthEventStoreOptions {
	readonly durableEventLog?:
		| { readonly append: (event: AgentVmHealthEvent) => Promise<void> }
		| undefined;
	readonly eventHistoryLimit: number;
	readonly evidenceQueueLimits?: Partial<HealthEventEvidenceQueueLimits> | undefined;
	readonly healthEventSinks?: readonly HealthEventSink[] | undefined;
	readonly latestBucketLimit?: number | undefined;
	readonly staleAfterMs: number;
}

export interface HealthEventSink {
	readonly record: (event: AgentVmHealthEvent) => Promise<void> | void;
}

export interface HealthEventEvidenceQueueLimits {
	readonly flushTimeoutMs: number;
	readonly livenessAggregationWindowMs: number;
	readonly maxOutstandingOperations: number;
	readonly maxPendingBytes: number;
	readonly maxPendingRecords: number;
	readonly operationTimeoutMs: number;
}

export interface HealthEventEvidenceQueueDiagnostics extends HealthEventEvidenceQueueLimits {
	readonly activeOperations: number;
	readonly coalescedRecords: number;
	readonly droppedBytes: number;
	readonly droppedRecords: number;
	readonly failedOperations: number;
	readonly flushTimeouts: number;
	readonly highWaterPendingBytes: number;
	readonly highWaterPendingRecords: number;
	readonly operationTimeouts: number;
	readonly outstandingBytes: number;
	readonly pendingBytes: number;
	readonly pendingRecords: number;
}

export interface HealthEventEvidenceDiagnostics {
	readonly durableLog: HealthEventEvidenceQueueDiagnostics;
	readonly healthEventSinks: HealthEventEvidenceQueueDiagnostics;
}

export const defaultHealthEventEvidenceQueueLimits = {
	flushTimeoutMs: 2_000,
	livenessAggregationWindowMs: 10_000,
	maxOutstandingOperations: 2,
	maxPendingBytes: 512 * 1_024,
	maxPendingRecords: 256,
	operationTimeoutMs: 1_000,
} as const satisfies HealthEventEvidenceQueueLimits;

export interface DeriveHealthSnapshotOptions {
	readonly nowMs: number;
	readonly zoneId: string;
}

export class HealthEventStore {
	readonly #eventHistoryLimit: number;
	readonly #latestBucketLimit: number;
	readonly #latestByBucket = new Map<string, AgentVmHealthEvent>();
	readonly #history: AgentVmHealthEvent[] = [];
	readonly #durableEventLog: HealthEventStoreOptions['durableEventLog'];
	readonly #durableWriteQueue: BoundedHealthEventEvidenceQueue;
	readonly #healthEventSinks: readonly HealthEventSink[];
	readonly #healthEventSinkQueue: BoundedHealthEventEvidenceQueue;
	readonly #staleAfterMs: number;

	constructor(options: HealthEventStoreOptions) {
		this.#durableEventLog = options.durableEventLog;
		this.#eventHistoryLimit = options.eventHistoryLimit;
		this.#healthEventSinks = options.healthEventSinks ?? [];
		this.#latestBucketLimit = options.latestBucketLimit ?? 1_000;
		this.#staleAfterMs = options.staleAfterMs;
		const evidenceQueueLimits = resolveEvidenceQueueLimits(options.evidenceQueueLimits);
		this.#durableWriteQueue = new BoundedHealthEventEvidenceQueue({
			deliver: async (event) => {
				await this.#durableEventLog?.append(event);
			},
			limits: evidenceQueueLimits,
		});
		this.#healthEventSinkQueue = new BoundedHealthEventEvidenceQueue({
			deliver: async (event) => {
				const results = await Promise.allSettled(
					this.#healthEventSinks.map(async (sink) => await sink.record(event)),
				);
				if (results.some((result) => result.status === 'rejected')) {
					throw new Error('One or more health event evidence sinks rejected a record.');
				}
			},
			limits: evidenceQueueLimits,
		});
	}

	record(event: AgentVmHealthEvent): void {
		this.#recordLiveState(event);
		this.#queueDurableWrite(event);
		this.#queueHealthEventSinks(event);
	}

	recordLiveOnly(event: AgentVmHealthEvent): void {
		this.#recordLiveState(event);
		this.#queueHealthEventSinks(event);
	}

	recordEvidenceOnly(event: AgentVmHealthEvent): void {
		this.#queueDurableWrite(event);
	}

	#recordLiveState(event: AgentVmHealthEvent): void {
		this.#history.push(event);
		while (this.#history.length > this.#eventHistoryLimit) {
			this.#history.shift();
		}

		if (event.kind !== 'caller-context-rejection') {
			const key = healthEventBucketKey(event);
			const previous = this.#latestByBucket.get(key);
			if (!previous || previous.observedAtMs <= event.observedAtMs) {
				this.#latestByBucket.set(key, event);
			}
			this.#evictOldestLatestBuckets();
		}
	}

	#evictOldestLatestBuckets(): void {
		if (this.#latestByBucket.size <= this.#latestBucketLimit) {
			return;
		}
		const evictCount = this.#latestByBucket.size - this.#latestBucketLimit;
		const keysToEvict = [...this.#latestByBucket.entries()]
			.toSorted((first, second) => first[1].observedAtMs - second[1].observedAtMs)
			.slice(0, evictCount)
			.map(([key]) => key);
		for (const key of keysToEvict) {
			this.#latestByBucket.delete(key);
		}
	}

	listHistory(): readonly AgentVmHealthEvent[] {
		return [...this.#history];
	}

	async flushDurableWrites(): Promise<void> {
		await this.#durableWriteQueue.flush();
	}

	async flushHealthEventSinks(): Promise<void> {
		await this.#healthEventSinkQueue.flush();
	}

	getEvidenceQueueDiagnostics(): HealthEventEvidenceDiagnostics {
		return {
			durableLog: this.#durableWriteQueue.getDiagnostics(),
			healthEventSinks: this.#healthEventSinkQueue.getDiagnostics(),
		};
	}

	listLatestEventsForZone(zoneId: string): readonly AgentVmHealthEvent[] {
		return [...this.#latestByBucket.values()]
			.filter((event) => event.zoneId === zoneId)
			.toSorted((first, second) => second.observedAtMs - first.observedAtMs);
	}

	deriveSnapshot(options: DeriveHealthSnapshotOptions): ZoneHealthSnapshot {
		return deriveZoneHealthSnapshot(this.listLatestEventsForZone(options.zoneId), {
			nowMs: options.nowMs,
			staleAfterMs: this.#staleAfterMs,
			zoneId: options.zoneId,
		});
	}

	#queueDurableWrite(event: AgentVmHealthEvent): void {
		if (!this.#durableEventLog) {
			return;
		}
		this.#durableWriteQueue.enqueue(event);
	}

	#queueHealthEventSinks(event: AgentVmHealthEvent): void {
		if (this.#healthEventSinks.length === 0) {
			return;
		}
		this.#healthEventSinkQueue.enqueue(event);
	}
}

interface PendingEvidenceRecord {
	readonly byteSize: number;
	readonly coalescingKey?: string | undefined;
	readonly coalescingMode?: EvidenceCoalescingMode | undefined;
	readonly event: AgentVmHealthEvent;
	readonly notBeforeMs: number;
}

interface OutstandingEvidenceDelivery {
	readonly byteSize: number;
	readonly coalescingKey?: string | undefined;
	readonly coalescingMode?: EvidenceCoalescingMode | undefined;
}

type EvidenceCoalescingMode =
	| 'reconnect-window-close'
	| 'reconnect-window-opening'
	| 'reconnect-window-update'
	| 'routine';

interface BoundedHealthEventEvidenceQueueOptions {
	readonly deliver: (event: AgentVmHealthEvent) => Promise<void>;
	readonly limits: HealthEventEvidenceQueueLimits;
}

class BoundedHealthEventEvidenceQueue {
	readonly #deliver: BoundedHealthEventEvidenceQueueOptions['deliver'];
	readonly #limits: HealthEventEvidenceQueueLimits;
	readonly #pending: PendingEvidenceRecord[] = [];
	readonly #idleWaiters = new Set<() => void>();
	readonly #livenessWindowStartedAtByBucket = new Map<string, number>();
	#activeDelivery: Promise<void> | undefined;
	readonly #outstandingDeliveries = new Map<symbol, OutstandingEvidenceDelivery>();
	#coalescedRecords = 0;
	#drainScheduled = false;
	#drainTimer: ReturnType<typeof setTimeout> | undefined;
	#droppedBytes = 0;
	#droppedRecords = 0;
	#failedOperations = 0;
	#flushTimeouts = 0;
	#flushRequests = 0;
	#highWaterPendingBytes = 0;
	#highWaterPendingRecords = 0;
	#operationTimeouts = 0;
	#pendingBytes = 0;

	constructor(options: BoundedHealthEventEvidenceQueueOptions) {
		this.#deliver = options.deliver;
		this.#limits = options.limits;
	}

	enqueue(event: AgentVmHealthEvent): void {
		let byteSize: number;
		try {
			byteSize = Buffer.byteLength(JSON.stringify(event), 'utf8');
		} catch {
			this.#recordDrop(0);
			return;
		}
		if (byteSize > this.#limits.maxPendingBytes) {
			this.#recordDrop(byteSize);
			return;
		}

		const reconnectWindowKey = reconnectEvidenceWindowKey(event);
		const coalescingMode = reconnectEvidenceCoalescingMode(event);
		const coalescingKey = reconnectWindowKey ?? evidenceCoalescingKey(event);
		const livenessWindowStartedAtMs =
			coalescingKey === undefined || reconnectWindowKey !== undefined
				? undefined
				: this.#livenessWindowStartedAtByBucket.get(coalescingKey);
		let notBeforeMs =
			coalescingMode === 'reconnect-window-update'
				? Number.POSITIVE_INFINITY
				: livenessWindowStartedAtMs === undefined
					? 0
					: livenessWindowStartedAtMs + this.#limits.livenessAggregationWindowMs;
		if (coalescingKey !== undefined && coalescingMode !== 'reconnect-window-opening') {
			const existingIndex = this.#pending.findIndex(
				(pending) =>
					pending.coalescingKey === coalescingKey &&
					(coalescingMode === 'routine'
						? pending.coalescingMode === 'routine'
						: pending.coalescingMode === 'reconnect-window-update'),
			);
			if (existingIndex >= 0) {
				const [replaced] = this.#pending.splice(existingIndex, 1);
				if (replaced !== undefined) {
					this.#pendingBytes -= replaced.byteSize;
					this.#coalescedRecords += 1;
					if (coalescingMode !== 'reconnect-window-close') {
						notBeforeMs = replaced.notBeforeMs;
					}
				}
			}
		}

		while (
			this.#pending.length >= this.#limits.maxPendingRecords ||
			this.#pendingBytes + byteSize > this.#limits.maxPendingBytes
		) {
			const callerContextDiagnosticIndex = this.#pending.findIndex(
				(pending) => pending.event.kind === 'caller-context-rejection',
			);
			if (event.kind === 'caller-context-rejection' && callerContextDiagnosticIndex < 0) {
				this.#recordDrop(byteSize);
				return;
			}
			const coalescibleOrdinaryEvidenceIndex = this.#pending.findIndex(
				(pending) =>
					!isReconnectWindowBoundary(pending.coalescingMode) && pending.coalescingKey !== undefined,
			);
			const ordinaryEvidenceIndex = this.#pending.findIndex(
				(pending) => !isReconnectWindowBoundary(pending.coalescingMode),
			);
			const evictionIndex =
				callerContextDiagnosticIndex >= 0
					? callerContextDiagnosticIndex
					: coalescibleOrdinaryEvidenceIndex >= 0
						? coalescibleOrdinaryEvidenceIndex
						: ordinaryEvidenceIndex;
			if (evictionIndex < 0) {
				this.#recordDrop(byteSize);
				return;
			}
			const [evicted] = this.#pending.splice(evictionIndex, 1);
			if (evicted === undefined) {
				this.#recordDrop(byteSize);
				return;
			}
			this.#pendingBytes -= evicted.byteSize;
			this.#recordDrop(evicted.byteSize);
		}

		this.#pending.push({ byteSize, coalescingKey, coalescingMode, event, notBeforeMs });
		this.#pendingBytes += byteSize;
		this.#highWaterPendingBytes = Math.max(this.#highWaterPendingBytes, this.#pendingBytes);
		this.#highWaterPendingRecords = Math.max(this.#highWaterPendingRecords, this.#pending.length);
		this.#scheduleDrain();
	}

	async flush(): Promise<void> {
		if (this.#isIdle()) {
			return;
		}
		this.#flushRequests += 1;
		this.#scheduleDrain();

		let resolveIdle: (() => void) | undefined;
		const idle = new Promise<'idle'>((resolve) => {
			resolveIdle = () => resolve('idle');
			this.#idleWaiters.add(resolveIdle);
		});
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<'timeout'>((resolve) => {
			timeout = setTimeout(() => resolve('timeout'), this.#limits.flushTimeoutMs);
			timeout.unref?.();
		});

		try {
			const outcome = await Promise.race([idle, deadline]);
			if (outcome === 'timeout') {
				this.#flushTimeouts += 1;
			}
		} finally {
			this.#flushRequests -= 1;
			if (resolveIdle !== undefined) {
				this.#idleWaiters.delete(resolveIdle);
			}
			if (timeout !== undefined) {
				clearTimeout(timeout);
			}
		}
	}

	getDiagnostics(): HealthEventEvidenceQueueDiagnostics {
		return {
			...this.#limits,
			activeOperations: this.#outstandingDeliveries.size,
			coalescedRecords: this.#coalescedRecords,
			droppedBytes: this.#droppedBytes,
			droppedRecords: this.#droppedRecords,
			failedOperations: this.#failedOperations,
			flushTimeouts: this.#flushTimeouts,
			highWaterPendingBytes: this.#highWaterPendingBytes,
			highWaterPendingRecords: this.#highWaterPendingRecords,
			operationTimeouts: this.#operationTimeouts,
			outstandingBytes: [...this.#outstandingDeliveries.values()].reduce(
				(total, delivery) => total + delivery.byteSize,
				0,
			),
			pendingBytes: this.#pendingBytes,
			pendingRecords: this.#pending.length,
		};
	}

	#scheduleDrain(): void {
		if (
			this.#activeDelivery !== undefined ||
			this.#drainScheduled ||
			this.#pending.length === 0 ||
			this.#outstandingDeliveries.size >= this.#limits.maxOutstandingOperations
		) {
			return;
		}
		if (this.#drainTimer !== undefined) {
			clearTimeout(this.#drainTimer);
			this.#drainTimer = undefined;
		}
		this.#drainScheduled = true;
		void Promise.resolve().then(() => {
			this.#drainScheduled = false;
			this.#startNextDelivery();
		});
	}

	#startNextDelivery(): void {
		if (
			this.#activeDelivery !== undefined ||
			this.#outstandingDeliveries.size >= this.#limits.maxOutstandingOperations
		) {
			return;
		}
		const nextIndex = this.#selectNextDeliveryIndex();
		if (nextIndex < 0) {
			this.#scheduleAggregationDeadline();
			return;
		}
		const [next] = this.#pending.splice(nextIndex, 1);
		if (next === undefined) {
			this.#notifyIdle();
			return;
		}
		this.#pendingBytes -= next.byteSize;
		if (next.coalescingKey !== undefined && next.coalescingMode === 'routine') {
			this.#recordLivenessWindowStart(next.coalescingKey);
		}

		const deliveryIdentity = Symbol('health-event-evidence-delivery');
		this.#outstandingDeliveries.set(deliveryIdentity, {
			byteSize: next.byteSize,
			coalescingKey: next.coalescingKey,
			coalescingMode: next.coalescingMode,
		});
		let resolveOperationTimeout: (() => void) | undefined;
		const operationTimeout = setTimeout(() => {
			resolveOperationTimeout?.();
		}, this.#limits.operationTimeoutMs);
		operationTimeout.unref?.();
		const operationDeadline = new Promise<'timeout'>((resolve) => {
			resolveOperationTimeout = () => resolve('timeout');
		});
		const underlyingDelivery = Promise.resolve().then(async () => await this.#deliver(next.event));
		const deliveryOutcome = underlyingDelivery.then(
			() => 'settled' as const,
			() => {
				this.#failedOperations += 1;
				return 'failed' as const;
			},
		);
		void deliveryOutcome.finally(() => {
			this.#outstandingDeliveries.delete(deliveryIdentity);
			this.#scheduleDrain();
			this.#notifyIdle();
		});
		const ownedDelivery = Promise.race([deliveryOutcome, operationDeadline]).then((outcome) => {
			clearTimeout(operationTimeout);
			if (outcome === 'timeout') {
				this.#operationTimeouts += 1;
			}
		});
		this.#activeDelivery = ownedDelivery;
		void ownedDelivery.finally(() => {
			if (this.#activeDelivery === ownedDelivery) {
				this.#activeDelivery = undefined;
			}
			this.#scheduleDrain();
			this.#notifyIdle();
		});
	}

	#selectNextDeliveryIndex(): number {
		if (this.#flushRequests > 0) {
			return this.#pending.findIndex(
				(record) =>
					record.coalescingMode !== 'reconnect-window-update' &&
					!this.#hasOutstandingReconnectWindowDelivery(record),
			);
		}
		const nowMs = Date.now();
		return this.#pending.findIndex(
			(record) =>
				!this.#hasOutstandingReconnectWindowDelivery(record) &&
				(record.coalescingKey === undefined || record.notBeforeMs <= nowMs),
		);
	}

	#hasOutstandingReconnectWindowDelivery(record: PendingEvidenceRecord): boolean {
		if (record.coalescingKey === undefined || !isReconnectWindowEvidence(record.coalescingMode)) {
			return false;
		}
		return [...this.#outstandingDeliveries.values()].some(
			(delivery) =>
				delivery.coalescingKey === record.coalescingKey &&
				isReconnectWindowEvidence(delivery.coalescingMode),
		);
	}

	#scheduleAggregationDeadline(): void {
		const nextDeadlineMs = Math.min(
			...this.#pending.map((record) => record.notBeforeMs).filter((deadline) => deadline > 0),
		);
		if (!Number.isFinite(nextDeadlineMs)) {
			return;
		}
		const delayMs = Math.max(0, nextDeadlineMs - Date.now());
		this.#drainTimer = setTimeout(() => {
			this.#drainTimer = undefined;
			this.#scheduleDrain();
		}, delayMs);
		this.#drainTimer.unref?.();
	}

	#isIdle(): boolean {
		return (
			this.#activeDelivery === undefined &&
			!this.#drainScheduled &&
			this.#drainTimer === undefined &&
			this.#outstandingDeliveries.size === 0 &&
			this.#pending.length === 0
		);
	}

	#notifyIdle(): void {
		if (!this.#isIdle()) {
			return;
		}
		for (const resolve of this.#idleWaiters) {
			resolve();
		}
		this.#idleWaiters.clear();
	}

	#recordDrop(byteSize: number): void {
		this.#droppedBytes += byteSize;
		this.#droppedRecords += 1;
	}

	#recordLivenessWindowStart(coalescingKey: string): void {
		this.#livenessWindowStartedAtByBucket.delete(coalescingKey);
		this.#livenessWindowStartedAtByBucket.set(coalescingKey, Date.now());
		while (this.#livenessWindowStartedAtByBucket.size > this.#limits.maxPendingRecords) {
			const oldestKey = this.#livenessWindowStartedAtByBucket.keys().next().value;
			if (oldestKey === undefined) {
				return;
			}
			this.#livenessWindowStartedAtByBucket.delete(oldestKey);
		}
	}
}

function isReconnectWindowBoundary(mode: EvidenceCoalescingMode | undefined): boolean {
	return mode === 'reconnect-window-opening' || mode === 'reconnect-window-close';
}

function isReconnectWindowEvidence(mode: EvidenceCoalescingMode | undefined): boolean {
	return isReconnectWindowBoundary(mode) || mode === 'reconnect-window-update';
}

function evidenceCoalescingKey(event: AgentVmHealthEvent): string | undefined {
	if (event.kind === 'caller-context-rejection') {
		return healthEventBucketKey(event);
	}
	if (event.result !== 'ok') {
		return undefined;
	}
	if (event.kind === 'gateway-control-session' && event.operation !== 'control-session-heartbeat') {
		return undefined;
	}
	if (
		event.kind === 'controller-request' ||
		event.kind === 'gateway-recovery' ||
		event.kind === 'tool-vm-ssh'
	) {
		return undefined;
	}
	return healthEventBucketKey(event);
}

function reconnectEvidenceWindowKey(event: AgentVmHealthEvent): string | undefined {
	if (event.kind !== 'gateway-control-session' || event.reconnectPhase === undefined) {
		return undefined;
	}
	return `${event.zoneId}:${event.kind}:reconnect:${event.peerId}:${event.bootId}`;
}

function reconnectEvidenceCoalescingMode(
	event: AgentVmHealthEvent,
): EvidenceCoalescingMode | undefined {
	if (event.kind !== 'gateway-control-session' || event.reconnectPhase === undefined) {
		return evidenceCoalescingKey(event) === undefined ? undefined : 'routine';
	}
	if (event.windowState === 'closed') {
		return 'reconnect-window-close';
	}
	return event.reconnectPhase === 'attachment-lost'
		? 'reconnect-window-opening'
		: 'reconnect-window-update';
}

function resolveEvidenceQueueLimits(
	overrides: Partial<HealthEventEvidenceQueueLimits> | undefined,
): HealthEventEvidenceQueueLimits {
	const limits = { ...defaultHealthEventEvidenceQueueLimits, ...overrides };
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new Error(`Health event evidence queue ${name} must be a positive safe integer.`);
		}
	}
	return limits;
}
