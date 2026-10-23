export interface AgentAuditChange {
	readonly requestId: string;
	readonly actorUserId: string;
	readonly clientId: string;
	readonly change: 'registered' | 'retired' | 'rotated';
}
