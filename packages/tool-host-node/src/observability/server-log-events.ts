export type PortalServerLogEvent =
	| {
			readonly event: 'server_error';
			readonly reason?: 'operation-store-capacity' | 'operation-store-storage-failed';
			readonly level: 'error';
			readonly message: string;
			readonly stack?: string;
	  }
	| {
			readonly agentId: string;
			readonly clientAddress: string;
			readonly decision: 'allow' | 'deny';
			readonly event: 'mcp_proxy_auth';
			readonly level: 'info' | 'warn';
			readonly reason?: string | undefined;
			readonly timeMs: number;
	  }
	| {
			readonly agentId: string;
			readonly clientAddress: string;
			readonly event: 'mcp_proxy_auth_audit_error';
			readonly level: 'warn';
			readonly message: string;
			readonly timeMs: number;
	  }
	| {
			readonly agentId: string;
			readonly decision: 'allow' | 'deny';
			readonly event: 'mcp_portal_approval';
			readonly level: 'info' | 'warn';
			readonly reason?: string | undefined;
			readonly timeMs: number;
			readonly verifierReason?: string;
	  }
	| {
			readonly agentId: string;
			readonly event: 'mcp_portal_approval_audit_error';
			readonly level: 'warn';
			readonly message: string;
			readonly timeMs: number;
	  }
	| {
			readonly agentScopeId: string;
			readonly event: 'upstream_close_error';
			readonly level: 'warn';
			readonly message: string;
			readonly namespace?: string;
	  };

export interface PortalServerLogger {
	readonly log: (event: PortalServerLogEvent) => void;
}
