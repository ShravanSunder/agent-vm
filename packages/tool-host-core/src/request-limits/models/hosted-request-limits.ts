import type {
	DispatchInvocation,
	ResourceResult,
} from '@agent-collaboration/tool-engine/capability-dispatch';
import type { PortalBatchResult } from '@agent-collaboration/tool-engine/mcp-gateway';

export interface HostedRequestLimits {
	readonly begin: (input: unknown, id: string | number) => PortalBatchResult | undefined;
	readonly callHasStarted: (itemId: string) => boolean;
	readonly invoke: (
		invocation: DispatchInvocation,
		call: () => Promise<ResourceResult>,
	) => Promise<ResourceResult>;
}
