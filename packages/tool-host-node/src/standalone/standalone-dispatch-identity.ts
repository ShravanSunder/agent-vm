import { createHash } from 'node:crypto';

import type { PortalCallRequest } from '@agent-collaboration/tool-access/contracts';

export interface StandaloneSemanticRevisions {
	readonly activeRevision: string;
	readonly bindingRevision: string;
	readonly catalogRevision: string;
	readonly profilePolicyRevision: string;
	readonly providerRevision: string;
	readonly schemaRevision: string;
}

export function canonicalStandaloneAuthorityJson(value: unknown): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string')
		return JSON.stringify(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value))
			throw new TypeError('Tool Portal authority values must be finite.');
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalStandaloneAuthorityJson).join(',')}]`;
	if (typeof value === 'object')
		return `{${Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalStandaloneAuthorityJson(entry)}`)
			.join(',')}}`;
	throw new TypeError('Tool Portal authority values must be JSON-compatible.');
}

export function deriveStandaloneOperationId(props: {
	readonly callId: string;
	readonly semanticRevision: string;
	readonly stablePrincipal: string;
	readonly surfaceClass: string;
}): string {
	const digest = createHash('sha256')
		.update(
			[
				'tool-portal-operation-v1',
				props.semanticRevision,
				props.surfaceClass,
				props.stablePrincipal,
				props.callId,
			].join('\u0000'),
			'utf8',
		)
		.digest('hex')
		.slice(0, 32)
		.split('');
	digest[12] = '5';
	digest[16] = ((Number.parseInt(digest[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
	const hexadecimal = digest.join('');
	return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
}

export function deriveStandaloneDirectFingerprint(props: {
	readonly call: PortalCallRequest['calls'][number];
	readonly principal: unknown;
	readonly semanticSnapshot: StandaloneSemanticRevisions;
	readonly surfaceClass: string;
}): `sha256:${string}` {
	const fingerprintInput = {
		backendKind: 'mcp_provider',
		capability: { name: props.call.name, namespace: props.call.namespace },
		canonicalArguments: props.call.arguments,
		currentGeneration: props.semanticSnapshot.activeRevision,
		principal: props.principal,
		semanticRevisions: {
			activeRevision: props.semanticSnapshot.activeRevision,
			bindingRevision: props.semanticSnapshot.bindingRevision,
			catalogRevision: props.semanticSnapshot.catalogRevision,
			profilePolicyRevision: props.semanticSnapshot.profilePolicyRevision,
			providerRevision: props.semanticSnapshot.providerRevision,
			schemaRevision: props.semanticSnapshot.schemaRevision,
		},
		surfaceClass: props.surfaceClass,
		version: 'tool-portal-direct-dispatch-v1',
	};
	return `sha256:${createHash('sha256').update(canonicalStandaloneAuthorityJson(fingerprintInput), 'utf8').digest('hex')}`;
}
