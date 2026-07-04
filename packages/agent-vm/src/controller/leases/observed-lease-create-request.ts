export interface ObservedControllerLeaseCreateRequest {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly idleTtlMs?: number | undefined;
	readonly profileId: string;
	readonly sessionKeyDigest?: string | undefined;
	readonly workMountDir: string;
	readonly zoneId: string;
}
