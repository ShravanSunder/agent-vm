import { createLeaseClient } from '../controller-lease-client.js';
import type { CreateBackendDependencies } from './sandbox-backend-contract.js';

export function createGondolinSandboxBackendManager(
	options: {
		readonly controllerUrl: string;
		readonly zoneId: string;
	},
	dependencies: CreateBackendDependencies,
): {
	describeRuntime: (params: {
		readonly entry: { readonly containerName: string };
	}) => Promise<{ readonly configLabelMatch: boolean; readonly running: boolean }>;
	removeRuntime: (params: { readonly entry: { readonly containerName: string } }) => Promise<void>;
} {
	return {
		describeRuntime: async (params) => {
			const leaseClient =
				dependencies.createLeaseClient?.({
					controllerUrl: options.controllerUrl,
				}) ?? createLeaseClient({ controllerUrl: options.controllerUrl });
			try {
				const leaseStatus = await leaseClient.getLeaseStatus(params.entry.containerName);
				return { configLabelMatch: true, running: leaseStatus !== null };
			} catch {
				return { configLabelMatch: false, running: false };
			}
		},
		removeRuntime: async (params) => {
			const leaseClient =
				dependencies.createLeaseClient?.({
					controllerUrl: options.controllerUrl,
				}) ?? createLeaseClient({ controllerUrl: options.controllerUrl });
			await leaseClient.releaseLease(params.entry.containerName);
		},
	};
}
