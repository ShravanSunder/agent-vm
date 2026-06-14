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
	readonly latestBucketLimit?: number | undefined;
	readonly now?: (() => number) | undefined;
	readonly staleAfterMs: number;
}

export interface DeriveHealthSnapshotOptions {
	readonly nowMs: number;
	readonly zoneId: string;
}

const durableWriteWarningIntervalMs = 60_000;

function formatDurableWriteError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class HealthEventStore {
	readonly #eventHistoryLimit: number;
	readonly #latestBucketLimit: number;
	readonly #latestByBucket = new Map<string, AgentVmHealthEvent>();
	readonly #history: AgentVmHealthEvent[] = [];
	readonly #durableEventLog: HealthEventStoreOptions['durableEventLog'];
	readonly #now: () => number;
	#durableWriteQueue: Promise<void> = Promise.resolve();
	#lastDurableWriteWarningAtMs: number | undefined;
	readonly #staleAfterMs: number;

	constructor(options: HealthEventStoreOptions) {
		this.#durableEventLog = options.durableEventLog;
		this.#eventHistoryLimit = options.eventHistoryLimit;
		this.#latestBucketLimit = options.latestBucketLimit ?? 1_000;
		this.#now = options.now ?? Date.now;
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
				this.#lastDurableWriteWarningAtMs = undefined;
			})
			.catch((error: unknown) => {
				// Durable logs are evidence. In-memory health remains the serving path.
				this.#warnDurableWriteFailed(error);
			});
	}

	#warnDurableWriteFailed(error: unknown): void {
		const nowMs = this.#now();
		if (
			this.#lastDurableWriteWarningAtMs !== undefined &&
			nowMs - this.#lastDurableWriteWarningAtMs < durableWriteWarningIntervalMs
		) {
			return;
		}
		this.#lastDurableWriteWarningAtMs = nowMs;
		process.stderr.write(
			`[health-event-store] durable health event log append failed: ${formatDurableWriteError(error)}\n`,
		);
	}
}
