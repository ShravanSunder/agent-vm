export type GatewayHealthCheck =
	| { readonly type: 'http'; readonly port: number; readonly path: string }
	| { readonly type: 'command'; readonly command: string };
