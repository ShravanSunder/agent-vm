export type GatewayOwnershipEvidence =
	| {
			readonly kind: 'missing-record-port-owned';
			readonly ownerCommand: string;
			readonly ownerPid: number;
			readonly port: number;
	  }
	| {
			readonly kind: 'record-parse-error';
			readonly message: string;
			readonly path: string;
	  }
	| {
			readonly actualScope: string;
			readonly expectedScope: string;
			readonly kind: 'record-scope-mismatch';
	  }
	| {
			readonly expectedPid: number;
			readonly kind: 'port-owner-mismatch';
			readonly ownerPid: number;
			readonly port: number;
	  }
	| {
			readonly kind: 'unmanaged-port-owner';
			readonly ownerCommand: string;
			readonly ownerPid: number;
			readonly port: number;
	  };

export interface GatewayOwnershipUnsafeErrorOptions {
	readonly cause?: unknown;
	readonly evidence: GatewayOwnershipEvidence;
	readonly message: string;
}

export class GatewayOwnershipUnsafeError extends Error {
	readonly code = 'GATEWAY_OWNERSHIP_UNSAFE';
	readonly evidence: GatewayOwnershipEvidence;

	constructor(options: GatewayOwnershipUnsafeErrorOptions) {
		super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'GatewayOwnershipUnsafeError';
		this.evidence = options.evidence;
	}
}
