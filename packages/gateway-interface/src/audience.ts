export const vmAudienceValues = ['gateway', 'tool-vm', 'both'] as const;

export type VmAudience = (typeof vmAudienceValues)[number];
export type RuntimeVmAudience = Exclude<VmAudience, 'both'>;

export interface EgressHostConfig {
	readonly host: string;
	readonly audience: VmAudience;
}

export const controllerVmHost = 'controller.vm.host';

export function targetsAudience(
	configAudience: VmAudience,
	runtimeAudience: RuntimeVmAudience,
): boolean {
	return configAudience === runtimeAudience || configAudience === 'both';
}

export function egressHostsForAudience(
	egressHosts: readonly EgressHostConfig[],
	runtimeAudience: RuntimeVmAudience,
): readonly string[] {
	return egressHosts
		.filter((egressHost) => targetsAudience(egressHost.audience, runtimeAudience))
		.map((egressHost) => egressHost.host);
}

export function gatewayVmAllowedHosts(egressHosts: readonly EgressHostConfig[]): readonly string[] {
	return Array.from(new Set([controllerVmHost, ...egressHostsForAudience(egressHosts, 'gateway')]));
}
