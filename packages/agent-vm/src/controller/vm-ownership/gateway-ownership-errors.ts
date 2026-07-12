export type GatewayOwnershipCoordinatorErrorCode =
	| 'agent-already-admitted'
	| 'child-identity-mismatch'
	| 'child-not-current'
	| 'child-vm-already-attached'
	| 'child-vm-not-attached'
	| 'gateway-already-current'
	| 'gateway-already-attached'
	| 'gateway-identity-mismatch'
	| 'gateway-not-admitting'
	| 'gateway-not-attached'
	| 'gateway-not-current'
	| 'gateway-not-sealed'
	| 'owner-unsafe'
	| 'leaf-already-admitted';

export class GatewayOwnershipCoordinatorError extends Error {
	public constructor(
		public readonly code: GatewayOwnershipCoordinatorErrorCode,
		options: { readonly cause?: unknown } = {},
	) {
		super(`Gateway ownership coordinator refused operation: ${code}`, options);
		this.name = 'GatewayOwnershipCoordinatorError';
	}
}

export function containsGatewayOwnershipCoordinatorErrorCode(
	error: unknown,
	expectedCode: GatewayOwnershipCoordinatorErrorCode,
): boolean {
	const pendingErrors: unknown[] = [error];
	const visitedErrors = new Set<unknown>();
	while (pendingErrors.length > 0) {
		const currentError = pendingErrors.pop();
		if (visitedErrors.has(currentError)) {
			continue;
		}
		visitedErrors.add(currentError);
		if (
			currentError instanceof GatewayOwnershipCoordinatorError &&
			currentError.code === expectedCode
		) {
			return true;
		}
		if (currentError instanceof AggregateError) {
			pendingErrors.push(...currentError.errors);
		}
		if (currentError instanceof Error && currentError.cause !== undefined) {
			pendingErrors.push(currentError.cause);
		}
	}
	return false;
}
