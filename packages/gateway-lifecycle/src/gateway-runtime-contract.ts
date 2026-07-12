export const gatewayTypeValues = ['openclaw', 'worker'] as const;

export type GatewayType = (typeof gatewayTypeValues)[number];

export function buildGatewaySessionLabel(projectNamespace: string, zoneId: string): string {
	return `${projectNamespace}:${zoneId}:gateway`;
}

export function buildToolSessionLabel(
	projectNamespace: string,
	zoneId: string,
	tcpSlot: number,
): string {
	return `${projectNamespace}:${zoneId}:tool:${tcpSlot}`;
}
