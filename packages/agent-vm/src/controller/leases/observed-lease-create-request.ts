export interface ObservedControllerLeaseCreateRequest {
	readonly agentId: string;
	readonly idleTtlMs?: number | undefined;
	readonly profileId: string;
	readonly sessionKeyDigest?: string | undefined;
	readonly zoneId: string;
}
