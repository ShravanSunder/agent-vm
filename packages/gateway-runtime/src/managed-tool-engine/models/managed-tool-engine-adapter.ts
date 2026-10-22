import type { createAccessAssessor } from '@agent-collaboration/tool-access/authorization';
import type { AccountFact } from '@agent-collaboration/tool-access/contracts';
import type {
	ApprovalPort,
	BackendKind,
	DispatchRequest,
	OperationPort,
	ToolBackend,
	createCapabilityDispatcher,
} from '@agent-collaboration/tool-engine/capability-dispatch';
import type { PortalCallRequest, PortalCallResult } from '@agent-vm/agent-portal-sdk';
import type { ManagedEngineInvocationContext } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-access/models/managed-invocation-context.js';
import type { ManagedGoogleReadyPreflight } from '@agent-vm/oauth-broker-contracts';

export interface ManagedToolEngineAdapter {
	readonly backends: ReadonlyMap<BackendKind, ToolBackend<BackendKind>>;
	readonly operations: OperationPort;
	readonly approvals: ApprovalPort;
	readonly assessAccess: ReturnType<typeof createAccessAssessor>;
	readonly dispatcher: ReturnType<typeof createCapabilityDispatcher>;
	readonly register: (props: {
		readonly context: ManagedEngineInvocationContext;
		readonly call: PortalCallRequest['calls'][number];
		readonly accounts?: readonly AccountFact[];
		readonly managedGoogle?: ManagedGoogleReadyPreflight;
	}) => Promise<string>;
	readonly release: (reference: string) => void;
	readonly request: (reference: string) => DispatchRequest;
	readonly call: (
		request: PortalCallRequest,
		context: ManagedEngineInvocationContext,
		prepared?: {
			readonly accounts: readonly AccountFact[];
			readonly managedGoogle?: ManagedGoogleReadyPreflight;
		},
	) => Promise<PortalCallResult>;
}
