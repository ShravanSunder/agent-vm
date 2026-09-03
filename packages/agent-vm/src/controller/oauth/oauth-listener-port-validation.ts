export interface OAuthListenerPortSystemConfig {
	readonly host: {
		readonly controllerPort: number;
		readonly observability?:
			| { readonly enabled: false }
			| { readonly enabled: true; readonly ports: Readonly<Record<string, number>> }
			| undefined;
	};
	readonly tcpPool: { readonly basePort: number; readonly size: number };
	readonly zones: readonly {
		readonly gateway: { readonly port: number };
	}[];
}

export function assertOAuthListenerPortAvailable(props: {
	readonly oauthPort: number;
	readonly systemConfig: OAuthListenerPortSystemConfig;
}): void {
	const observabilityPorts =
		props.systemConfig.host.observability?.enabled === true
			? Object.values(props.systemConfig.host.observability.ports)
			: [];
	const collidesWithReservedPort = [
		props.systemConfig.host.controllerPort,
		...props.systemConfig.zones.map((zone) => zone.gateway.port),
		...observabilityPorts,
	].includes(props.oauthPort);
	const collidesWithManagedRuntimePool =
		props.oauthPort >= props.systemConfig.tcpPool.basePort &&
		props.oauthPort < props.systemConfig.tcpPool.basePort + props.systemConfig.tcpPool.size;
	if (collidesWithReservedPort || collidesWithManagedRuntimePool) {
		throw new Error(
			`OAuth listener port ${String(props.oauthPort)} collides with another host port.`,
		);
	}
}
