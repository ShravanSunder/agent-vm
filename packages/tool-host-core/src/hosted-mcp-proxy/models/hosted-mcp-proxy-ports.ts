import type { AgentTokenVerifier } from '@agent-collaboration/tool-access/contracts';
import type { ConsumeApprovalTokenId } from '@agent-collaboration/tool-engine/mcp-gateway';
import type { UpstreamMcpRuntimeOptions } from '@agent-collaboration/tool-engine/upstream-mcp-connectors';

import type { AnalyticsSink } from '#tool-host-core/call-analytics/models/call-analytics';
import type { OrganizationAdmission } from '#tool-host-core/caller-admission/models/caller-admission';
import type {
	OrganizationConfigurationSource,
	SecretSource,
} from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import type { ObservationLog } from '#tool-host-core/hosted-mcp-proxy/models/observation-log';
import type { Clock } from '#tool-host-core/organization-authority/models/authority-clock';
import type { HostedProxyLimits } from '#tool-host-core/request-limits/models/hosted-proxy-limits';

export interface OrganizationAuthorizationPort extends OrganizationAdmission {
	readonly consumeApprovalToken: ConsumeApprovalTokenId;
}
export interface HostedOrganizations {
	readonly forOrganization: (organizationId: string) => OrganizationAuthorizationPort;
}
export interface HostedMcpProxy {
	readonly handle: (request: Request) => Promise<Response>;
}

export interface HostedMcpProxyPorts {
	readonly verifier: AgentTokenVerifier;
	readonly organizations: HostedOrganizations;
	readonly configurations: OrganizationConfigurationSource;
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
