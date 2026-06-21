import { expect } from 'vitest';

export interface PortalContractParser<TValue> {
	readonly safeParse: (value: unknown) => PortalContractParseResult<TValue>;
}

export type PortalContractParseResult<TValue> =
	| {
			readonly data: TValue;
			readonly success: true;
	  }
	| {
			readonly error: unknown;
			readonly success: false;
	  };

const hiddenControlFieldNames = new Set([
	'approvalToken',
	'backendKind',
	'executionFingerprint',
	'portalApprovalToken',
	'transport',
	'upstream',
]);

export function assertPortalResultMatchesContract<TValue>(
	schema: PortalContractParser<TValue>,
	value: unknown,
): TValue {
	const parseResult = schema.safeParse(value);
	expect(parseResult.success).toBe(true);
	if (!parseResult.success) {
		throw parseResult.error;
	}
	return parseResult.data;
}

export function assertPortalResultHasNoHiddenControlFields(value: unknown): void {
	expect(collectHiddenControlFieldPaths(value)).toEqual([]);
}

function collectHiddenControlFieldPaths(value: unknown): readonly string[] {
	const paths: string[] = [];
	collectHiddenControlFieldPathsInto(value, '$', paths);
	return paths.toSorted();
}

function collectHiddenControlFieldPathsInto(value: unknown, path: string, paths: string[]): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			collectHiddenControlFieldPathsInto(item, `${path}[${index}]`, paths);
		});
		return;
	}
	if (typeof value !== 'object' || value === null) {
		return;
	}
	for (const [key, childValue] of Object.entries(value)) {
		const childPath = `${path}.${key}`;
		if (hiddenControlFieldNames.has(key)) {
			paths.push(childPath);
		}
		collectHiddenControlFieldPathsInto(childValue, childPath, paths);
	}
}
