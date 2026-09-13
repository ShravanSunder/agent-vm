import { createHash } from 'node:crypto';

import {
	ArtifactReferenceSchema,
	PortalArtifactReadResultSchema,
	type ArtifactReference,
	type PortalArtifactReadResult,
} from '@agent-vm/agent-portal-sdk';

import { GatewayRuntimeArtifactReadCallerSchema } from './artifact-read-authority.js';
import type {
	GatewayRuntimeArtifactReadCaller,
	GatewayRuntimeArtifactReader,
} from './artifact-store.js';

type ArtifactDeliveryErrorCode =
	| 'cancelled'
	| 'integrity'
	| 'invalid-reference'
	| 'size-limit'
	| 'unavailable';

export class GatewayRuntimeArtifactDeliveryError extends Error {
	readonly code: ArtifactDeliveryErrorCode;

	constructor(code: ArtifactDeliveryErrorCode) {
		super(`Artifact delivery failed (${code}).`);
		this.name = 'GatewayRuntimeArtifactDeliveryError';
		this.code = code;
	}
}

export interface ReadVerifiedGatewayArtifactProps {
	readonly caller: GatewayRuntimeArtifactReadCaller;
	readonly chunkBytes?: number;
	readonly maximumBytes: number;
	readonly reader: GatewayRuntimeArtifactReader;
	readonly reference: ArtifactReference;
	readonly signal: AbortSignal;
}

function checkCancellation(signal: AbortSignal): void {
	if (signal.aborted) throw new GatewayRuntimeArtifactDeliveryError('cancelled');
}

function referencesMatch(left: ArtifactReference, right: ArtifactReference): boolean {
	return (
		left.id === right.id &&
		left.byteLength === right.byteLength &&
		left.expiresAt === right.expiresAt &&
		left.fingerprint === right.fingerprint &&
		left.mediaType === right.mediaType
	);
}

async function awaitArtifactRead(
	read: () => Promise<PortalArtifactReadResult>,
	signal: AbortSignal,
): Promise<PortalArtifactReadResult> {
	checkCancellation(signal);
	return await new Promise<PortalArtifactReadResult>((resolve, reject) => {
		const abort = (): void => {
			signal.removeEventListener('abort', abort);
			reject(new GatewayRuntimeArtifactDeliveryError('cancelled'));
		};
		signal.addEventListener('abort', abort, { once: true });
		void Promise.resolve()
			.then(async (): Promise<PortalArtifactReadResult> => {
				checkCancellation(signal);
				return await read();
			})
			.then(
				(result): void => {
					signal.removeEventListener('abort', abort);
					if (signal.aborted) abort();
					else resolve(result);
				},
				(): void => {
					signal.removeEventListener('abort', abort);
					if (signal.aborted) abort();
					else reject(new GatewayRuntimeArtifactDeliveryError('unavailable'));
				},
			);
	});
}

/** Return complete verified bytes; never expose partially read content to a publisher. */
export async function readVerifiedGatewayArtifact(
	props: ReadVerifiedGatewayArtifactProps,
): Promise<Uint8Array> {
	checkCancellation(props.signal);
	const chunkBytes = props.chunkBytes ?? 16 * 1_024;
	if (
		!Number.isSafeInteger(props.maximumBytes) ||
		props.maximumBytes <= 0 ||
		props.maximumBytes > 16 * 1_024 * 1_024 ||
		!Number.isSafeInteger(chunkBytes) ||
		chunkBytes <= 0 ||
		chunkBytes > 64 * 1_024
	) {
		throw new GatewayRuntimeArtifactDeliveryError('size-limit');
	}
	const parsedReference = ArtifactReferenceSchema.safeParse(props.reference);
	if (!parsedReference.success) throw new GatewayRuntimeArtifactDeliveryError('invalid-reference');
	const reference = parsedReference.data;
	if (reference.byteLength > props.maximumBytes)
		throw new GatewayRuntimeArtifactDeliveryError('size-limit');
	const parsedCaller = GatewayRuntimeArtifactReadCallerSchema.safeParse(props.caller);
	if (!parsedCaller.success) throw new GatewayRuntimeArtifactDeliveryError('unavailable');
	const caller = parsedCaller.data;
	const bytes = new Uint8Array(reference.byteLength);
	const hash = createHash('sha256');

	const readRange = async (offsetBytes: number, maxBytes: number): Promise<Uint8Array> => {
		const result = await awaitArtifactRead(
			async () =>
				await props.reader.read({ caller, request: { maxBytes, offsetBytes, reference } }),
			props.signal,
		);
		checkCancellation(props.signal);
		const parsed = PortalArtifactReadResultSchema.safeParse(result);
		if (!parsed.success) throw new GatewayRuntimeArtifactDeliveryError('integrity');
		const response = parsed.data;
		const expectedBytes = Math.min(maxBytes, reference.byteLength - offsetBytes);
		if (
			!referencesMatch(reference, response.reference) ||
			response.offsetBytes !== offsetBytes ||
			response.contentBase64.length > Math.ceil(expectedBytes / 3) * 4
		) {
			throw new GatewayRuntimeArtifactDeliveryError('integrity');
		}
		const chunk = Buffer.from(response.contentBase64, 'base64');
		if (
			chunk.byteLength !== expectedBytes ||
			chunk.toString('base64') !== response.contentBase64 ||
			response.truncated !== offsetBytes + chunk.byteLength < reference.byteLength
		) {
			throw new GatewayRuntimeArtifactDeliveryError('integrity');
		}
		return chunk;
	};

	for (let offset = 0; offset < reference.byteLength; offset += chunkBytes) {
		// Ordered range reads bound transient allocation and re-enter artifact authority.
		// oxlint-disable-next-line no-await-in-loop
		const chunk = await readRange(offset, Math.min(chunkBytes, reference.byteLength - offset));
		bytes.set(chunk, offset);
		hash.update(chunk);
	}
	if (`sha256:${hash.digest('hex')}` !== reference.fingerprint) {
		throw new GatewayRuntimeArtifactDeliveryError('integrity');
	}
	// Also authenticates empty files and fences authority changes during the last content read.
	await readRange(reference.byteLength, 1);
	checkCancellation(props.signal);
	return bytes;
}
