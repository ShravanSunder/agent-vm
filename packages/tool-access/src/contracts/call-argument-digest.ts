// Legacy call-argument bytes are distinct from the dispatch-intent contract.
export interface ApprovalTokenCallDigest {
	readonly argumentsHash: string;
	readonly namespace: string;
	readonly toolName: string;
}
export function canonicalCallArguments(value: unknown): string | undefined {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value ?? null);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalCallArguments).join(',')}]`;
	}
	const entries = Object.entries(value)
		.filter((entry) => entry[1] !== undefined)
		.toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
		.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalCallArguments(entryValue)}`);
	return `{${entries.join(',')}}`;
}

export async function hashCallArguments(args: unknown): Promise<string> {
	const serializedArguments = canonicalCallArguments(args);
	// Node's former hash rejected undefined input; TextEncoder would hash an empty string.
	if (serializedArguments === undefined)
		throw new TypeError('Call arguments are not serializable.');
	const digest = await globalThis.crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(serializedArguments),
	);
	return btoa(Array.from(new Uint8Array(digest), (byte) => String.fromCharCode(byte)).join(''))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}
