import {
	deriveZoneHealthSnapshot,
	healthEventBucketKey,
	type AgentVmHealthEvent,
	type ZoneHealthSnapshot,
} from '@agent-vm/gateway-interface';

export interface HealthEventStoreOptions {
	readonly eventHistoryLimit: number;
	readonly staleAfterMs: number;
}

export interface DeriveHealthSnapshotOptions {
	readonly nowMs: number;
	readonly zoneId: string;
}

export class HealthEventStore {
	readonly #eventHistoryLimit: number;
	readonly #latestByBucket = new Map<string, AgentVmHealthEvent>();
	readonly #history: AgentVmHealthEvent[] = [];
	readonly #staleAfterMs: number;

	constructor(options: HealthEventStoreOptions) {
		this.#eventHistoryLimit = options.eventHistoryLimit;
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
	}

	listHistory(): readonly AgentVmHealthEvent[] {
		return [...this.#history];
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
}
