import { z } from 'zod';

import type { ManagementObservation } from '#auth/better-auth-provider/provider-configuration';
import { createSignInManagementBinding } from '#auth/better-auth-provider/sign-in-management-binding';
import { AgentClientManagement as ProductionAgentClientManagement } from '#auth/cloudflare-host/index';
import { signInWorkerConfiguration } from '#auth/cloudflare-host/worker-configuration';
import { callAuthProofBarrier } from '#auth/test-fixtures/auth-proof-barrier-client';

/** Only the proof bundle exports these RPC controls; public fetch has no route to them. */
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

	async armManagementHold(requestId: string): Promise<{ readonly armed: boolean }> {
		const response = await callAuthProofBarrier({
			bindings: this.env,
			channel: 'management-hold',
			operation: 'arm',
			key: requestId,
		});
		return z.object({ armed: z.boolean() }).parse(await response.json());
	}

	async enteredManagementHold(requestId: string): Promise<ManagementObservation> {
		const response = await callAuthProofBarrier({
			bindings: this.env,
			channel: 'management-hold',
			operation: 'entered',
			key: requestId,
		});
		return z
			.object({ point: z.literal('before-provider-owner-read'), requestId: z.string() })
			.parse(await response.json());
	}

	async managementHoldStatus(
		requestId: string,
	): Promise<{ readonly armed: boolean; readonly observed: boolean }> {
		const response = await callAuthProofBarrier({
			bindings: this.env,
			channel: 'management-hold',
			operation: 'status',
			key: requestId,
		});
		return z.object({ armed: z.boolean(), observed: z.boolean() }).parse(await response.json());
	}

	async releaseManagementHold(requestId: string): Promise<{ readonly released: boolean }> {
		const response = await callAuthProofBarrier({
			bindings: this.env,
			channel: 'management-hold',
			operation: 'release',
			key: requestId,
		});
		return z.object({ released: z.boolean() }).parse(await response.json());
	}
}
