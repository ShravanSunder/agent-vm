import type { ManagementObservation } from '#auth/better-auth-provider/provider-configuration';
import { createSignInManagementBinding } from '#auth/better-auth-provider/sign-in-management-binding';
import { AgentClientManagement as ProductionAgentClientManagement } from '#auth/cloudflare-host/index';
import { signInWorkerConfiguration } from '#auth/cloudflare-host/worker-configuration';
import { callAuthProofBarrier } from '#auth/test-fixtures/auth-proof-barrier-client';

/** The proof observer reports to Node; all control operations stay outside Worker RPC. */
export class AgentClientManagement extends ProductionAgentClientManagement {
	private observedBinding(): ReturnType<typeof createSignInManagementBinding> {
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
		});
	}
	override async registerAndLink(
		props: Parameters<ProductionAgentClientManagement['registerAndLink']>[0],
	): ReturnType<ProductionAgentClientManagement['registerAndLink']> {
		return this.observedBinding().registerAndLink(props);
	}
	override async link(
		props: Parameters<ProductionAgentClientManagement['link']>[0],
	): ReturnType<ProductionAgentClientManagement['link']> {
		return this.observedBinding().link(props);
	}
	override async unlink(
		props: Parameters<ProductionAgentClientManagement['unlink']>[0],
	): ReturnType<ProductionAgentClientManagement['unlink']> {
		return this.observedBinding().unlink(props);
	}
	override async disable(
		props: Parameters<ProductionAgentClientManagement['disable']>[0],
	): ReturnType<ProductionAgentClientManagement['disable']> {
		return this.observedBinding().disable(props);
	}
}
