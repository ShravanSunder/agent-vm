import type { AgentTokenVerifier } from '@agent-collaboration/tool-access/contracts';
import type { ConsumeApprovalTokenId } from '@agent-collaboration/tool-engine/mcp-gateway';
import type { UpstreamMcpRuntimeOptions } from '@agent-collaboration/tool-engine/upstream-mcp-connectors';

import type { AnalyticsSink } from '#tool-host-core/call-analytics/models/call-analytics';
import type { WorkspaceMembershipRead } from '#tool-host-core/caller-admission/models/caller-admission';
import type {
	WorkspaceConfigurationSource,
	SecretSource,
} from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import type { ObservationLog } from '#tool-host-core/hosted-mcp-proxy/models/observation-log';
import type { HostedProxyLimits } from '#tool-host-core/request-limits/models/hosted-proxy-limits';
import type { Clock } from '#tool-host-core/workspace-authority/models/authority-clock';

export interface WorkspaceAuthorizationPort extends WorkspaceMembershipRead {
	readonly consumeApprovalToken: ConsumeApprovalTokenId;
}
export interface HostedWorkspaces {
	readonly forWorkspace: (workspaceId: string) => WorkspaceAuthorizationPort;
}
export interface HostedMcpProxy {
	readonly handle: (request: Request) => Promise<Response>;
}

export interface HostedMcpProxyPorts {
	readonly verifier: AgentTokenVerifier;
	readonly sessionClientId: string;
	readonly toolPortalOrigin: string;
	readonly workspaces: HostedWorkspaces;
	readonly configurations: WorkspaceConfigurationSource;
	readonly secrets: SecretSource;
	readonly log: (event: ObservationLog) => void;
	readonly analytics: AnalyticsSink;
	readonly createClient?: UpstreamMcpRuntimeOptions['createClient'];
	readonly createUpstreamMcpTransport: NonNullable<
		UpstreamMcpRuntimeOptions['createUpstreamMcpTransport']
	>;
	readonly clock: Clock;
	readonly newId: () => string;
	readonly limits: HostedProxyLimits;
}
