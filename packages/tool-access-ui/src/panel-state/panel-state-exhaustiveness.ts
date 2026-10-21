export function assertNever(value: never): never {
	throw new Error(`Unexpected panel variant: ${String(value)}`);
}
