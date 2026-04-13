export interface WrapupActionResult {
	readonly type: string;
	readonly artifact?: string;
	readonly success: boolean;
}

export interface WrapupActionConfig {
	readonly type: string;
	readonly required: boolean;
}

export function findMissingRequiredActions(
	configuredActions: readonly WrapupActionConfig[],
	executedResults: readonly WrapupActionResult[],
): readonly string[] {
	const requiredTypes = configuredActions
		.filter((action) => action.required)
		.map((action) => action.type);
	const successfulTypes = new Set(
		executedResults.filter((result) => result.success).map((result) => result.type),
	);

	return requiredTypes.filter((type) => !successfulTypes.has(type));
}
