export interface Clock {
	readonly nowMs: () => number;
	readonly nowIso: () => string;
}
