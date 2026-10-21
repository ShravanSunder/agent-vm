/** Encoding matches the existing Node token wire format. */
export function encodeTokenBytes(value: Uint8Array): string {
	return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(''))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}

export function decodeTokenBytes(value: string): Uint8Array<ArrayBuffer> {
	// Node's base64url decoder also accepts standard base64 and padding.
	return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) =>
		character.charCodeAt(0),
	);
}

export async function tokenHmacKey(key: Uint8Array): Promise<CryptoKey> {
	return globalThis.crypto.subtle.importKey(
		'raw',
		new Uint8Array(key),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);
}

export async function signTokenBytes(key: Uint8Array, input: string): Promise<string> {
	const signature = await globalThis.crypto.subtle.sign(
		'HMAC',
		await tokenHmacKey(key),
		new TextEncoder().encode(input),
	);
	return encodeTokenBytes(new Uint8Array(signature));
}

export async function verifyTokenBytes(props: {
	readonly key: Uint8Array;
	readonly input: string;
	readonly signature: Uint8Array;
}): Promise<boolean> {
	return globalThis.crypto.subtle.verify(
		'HMAC',
		await tokenHmacKey(props.key),
		new Uint8Array(props.signature),
		new TextEncoder().encode(props.input),
	);
}
