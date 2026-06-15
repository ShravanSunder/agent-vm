import {
	deriveZoneHealthSnapshot,
	healthEventBucketKey,
	type AgentVmHealthEvent,
	type ZoneHealthSnapshot,
} from '@agent-vm/gateway-interface';

export interface HealthEventStoreOptions {
	readonly durableEventLog?:
		| { readonly append: (event: AgentVmHealthEvent) => Promise<void> }
		| undefined;
	readonly eventHistoryLimit: number;
	readonly healthEventSinks?: readonly HealthEventSink[] | undefined;
	readonly latestBucketLimit?: number | undefined;
	readonly staleAfterMs: number;
}

export interface HealthEventSink {
	readonly record: (event: AgentVmHealthEvent) => Promise<void> | void;
}

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
	readonly #healthEventSinks: readonly HealthEventSink[];
	#durableWriteQueue: Promise<void> = Promise.resolve();
	#healthEventSinkQueue: Promise<void> = Promise.resolve();
	readonly #staleAfterMs: number;

	constructor(options: HealthEventStoreOptions) {
		this.#durableEventLog = options.durableEventLog;
		this.#eventHistoryLimit = options.eventHistoryLimit;
		this.#healthEventSinks = options.healthEventSinks ?? [];
		this.#latestBucketLimit = options.latestBucketLimit ?? 1_000;
		this.#staleAfterMs = options.staleAfterMs;
	}

	record(event: AgentVmHealthEvent): void {
		this.#history.push(event);
		while (this.#history.length > this.#eventHistoryLimit) {
			this.#history.shift();
		}

		const key = healthEventBucketKey(event);
		const previous = this.#latestByBucket.get(key);
		if (!previous || previous.observedAtMs <= event.observedAtMs) {
			this.#latestByBucket.set(key, event);
		}
		this.#evictOldestLatestBuckets();
		this.#queueDurableWrite(event);
		this.#queueHealthEventSinks(event);
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
		await this.#durableWriteQueue;
	}

	async flushHealthEventSinks(): Promise<void> {
		await this.#healthEventSinkQueue;
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
		this.#durableWriteQueue = this.#durableWriteQueue
			.then(async () => {
				await this.#durableEventLog?.append(event);
			})
			.catch(() => {
				// Durable logs are evidence. In-memory health remains the serving path.
			});
	}

	#queueHealthEventSinks(event: AgentVmHealthEvent): void {
		if (this.#healthEventSinks.length === 0) {
			return;
		}
		this.#healthEventSinkQueue = this.#healthEventSinkQueue
			.then(async () => {
				await Promise.all(
					this.#healthEventSinks.map(async (sink) => {
						try {
							await sink.record(event);
						} catch {
							// Telemetry is operator evidence. Health state remains the serving path.
						}
					}),
				);
			})
			.catch(() => {
				// Keep future telemetry events flowing after an unexpected sink failure.
			});
	}
}
