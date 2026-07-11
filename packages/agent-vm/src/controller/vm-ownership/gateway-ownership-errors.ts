export type GatewayOwnershipCoordinatorErrorCode =
	| 'gateway-already-current'
	| 'gateway-identity-mismatch'
	| 'gateway-not-admitting'
	| 'gateway-not-current'
	| 'owner-unsafe'
	| 'reservation-identity-mismatch'
	| 'startup-reconciliation-in-progress'
	| 'state-directory-mismatch';

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
