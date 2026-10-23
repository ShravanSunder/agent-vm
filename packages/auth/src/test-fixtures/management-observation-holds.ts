import type { ManagementObservation } from '#auth/better-auth-provider/provider-configuration';
import { createSignInManagementBinding } from '#auth/better-auth-provider/sign-in-management-binding';
import { AgentClientManagement as ProductionAgentClientManagement } from '#auth/cloudflare-host/index';
import { signInWorkerConfiguration } from '#auth/cloudflare-host/worker-configuration';

interface ManagementHold {
	readonly entered: PromiseWithResolvers<ManagementObservation>;
	readonly release: PromiseWithResolvers<void>;
	observed: boolean;
}
const managementHolds = new Map<string, ManagementHold>();

async function observeManagement(event: ManagementObservation): Promise<void> {
	const hold = managementHolds.get(event.requestId);
	if (hold === undefined) return;
	hold.observed = true;
	hold.entered.resolve(event);
	await hold.release.promise;
}

/** Only the proof bundle exports these RPC controls; public fetch has no route to them. */
export class AgentClientManagement extends ProductionAgentClientManagement {
	override async changeClient(
		props: Parameters<ProductionAgentClientManagement['changeClient']>[0],
	): ReturnType<ProductionAgentClientManagement['changeClient']> {
		return createSignInManagementBinding(signInWorkerConfiguration(this.env), {
			observeManagement,
		}).changeClient(props);
	}

	async armManagementHold(requestId: string): Promise<{ readonly armed: boolean }> {
		if (managementHolds.has(requestId)) throw new Error('Management hold already armed');
		managementHolds.set(requestId, {
			entered: Promise.withResolvers<ManagementObservation>(),
			release: Promise.withResolvers<void>(),
			observed: false,
		});
		return { armed: true };
	}

	async enteredManagementHold(requestId: string): Promise<ManagementObservation> {
		const hold = managementHolds.get(requestId);
		if (hold === undefined) throw new Error('Management hold not armed');
		return hold.entered.promise;
	}

	async managementHoldStatus(
		requestId: string,
	): Promise<{ readonly armed: boolean; readonly observed: boolean }> {
		const hold = managementHolds.get(requestId);
		return { armed: hold !== undefined, observed: hold?.observed ?? false };
	}

	async releaseManagementHold(requestId: string): Promise<{ readonly released: boolean }> {
		const hold = managementHolds.get(requestId);
		if (hold === undefined) throw new Error('Management hold not armed');
		hold.release.resolve();
		managementHolds.delete(requestId);
		return { released: true };
	}
}
