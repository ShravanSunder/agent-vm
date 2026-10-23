import type { ManagementObservation } from '#auth/better-auth-provider/provider-configuration';
import { createSignInManagementBinding } from '#auth/better-auth-provider/sign-in-management-binding';
import { AgentClientManagement as ProductionAgentClientManagement } from '#auth/cloudflare-host/index';
import { signInWorkerConfiguration } from '#auth/cloudflare-host/worker-configuration';
import { callAuthProofBarrier } from '#auth/test-fixtures/auth-proof-barrier-client';

/** The proof observer reports to Node; all control operations stay outside Worker RPC. */
export class AgentClientManagement extends ProductionAgentClientManagement {
	override async changeClient(
		props: Parameters<ProductionAgentClientManagement['changeClient']>[0],
	): ReturnType<ProductionAgentClientManagement['changeClient']> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env), {
			observeManagement: async (event: ManagementObservation): Promise<void> => {
				await callAuthProofBarrier({
					bindings: this.env,
					channel: 'management-hold',
					operation: 'arrive',
					key: event.requestId,
					event,
				});
			},
		}).changeClient(props);
	}
}
