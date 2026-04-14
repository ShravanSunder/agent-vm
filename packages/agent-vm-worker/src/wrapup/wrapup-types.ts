import { z } from 'zod';

export const wrapupActionResultSchema = z.object({
	key: z.string(),
	type: z.string(),
	artifact: z.string().optional(),
	success: z.boolean(),
});

export interface WrapupActionResult {
	readonly key: string;
	readonly type: string;
	readonly artifact?: string;
	readonly success: boolean;
}

export interface WrapupActionConfig {
	readonly key: string;
	readonly type: string;
	readonly required: boolean;
}

export function findMissingRequiredActions(
	configuredActions: readonly WrapupActionConfig[],
	executedResults: readonly WrapupActionResult[],
): readonly string[] {
	const successfulKeys = new Set(
		executedResults.filter((result) => result.success).map((result) => result.key),
	);

	return configuredActions
		.filter((action) => action.required)
		.filter((action) => !successfulKeys.has(action.key))
		.map((action) => action.type);
}
