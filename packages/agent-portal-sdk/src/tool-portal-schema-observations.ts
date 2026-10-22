import { createHash } from 'node:crypto';

import { z } from 'zod';

import * as artifactSurface from './artifact-surface/index.js';
import * as capabilitySurface from './capability-description-surface/index.js';
import * as primitiveSurface from './contract-primitives/index.js';
import * as sdkRoot from './index.js';
import { createPortableContractSchemaManifest } from './portable-contracts/index.js';
import * as callSurface from './portal-call-surface/index.js';

function fingerprint(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** The reviewed d25be046 oracle is immutable; changing a validator must change this observation. */
export function observeToolPortalSchemas(): Record<string, unknown> {
	const surfaces = { artifactSurface, callSurface, capabilitySurface, primitiveSurface, sdkRoot };
	const schemaBytes = Object.fromEntries(
		Object.entries(surfaces).map(([surfaceName, surface]) => [
			surfaceName,
			Object.fromEntries(
				Object.entries(surface).flatMap(([name, schema]) =>
					schema instanceof z.ZodType
						? [[name, fingerprint(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }))]]
						: [],
				),
			),
		]),
	);
	const call = { arguments: {}, id: 'call-1', namespace: 'example', name: 'write' };
	const parseCases: readonly { readonly schema: z.ZodType; readonly inputs: readonly unknown[] }[] =
		[
			{
				schema: callSurface.PortalCallRequestSchema,
				inputs: [
					{ calls: [call] },
					{ calls: [call, call] },
					{ calls: [{ ...call, id: '__proto__' }] },
					{ calls: Array.from({ length: 51 }, (_, index) => ({ ...call, id: String(index) })) },
					{ calls: [{ ...call, arguments: { text: 'x'.repeat(65_537) } }] },
					{
						calls: [
							{
								...call,
								arguments: Object.fromEntries(
									Array.from({ length: 1001 }, (_, index) => [String(index), null]),
								),
							},
						],
					},
				],
			},
			{
				schema: callSurface.PortalListRequestSchema,
				inputs: [{ requests: [{ id: 'list' }] }, { requests: [{ id: 'list', limit: 101 }] }],
			},
			{
				schema: callSurface.PortalSearchRequestSchema,
				inputs: [{ requests: [{ id: 'search' }] }, { requests: [{ id: 'search', limit: 51 }] }],
			},
			{
				schema: callSurface.PortalDescribeRequestSchema,
				inputs: [{ requests: [{ id: 'describe' }] }],
			},
			{
				schema: callSurface.PortalCallResultSchema,
				inputs: [
					{ items: [], ok: true },
					{ items: [], ok: false },
				],
			},
			{
				schema: primitiveSurface.NamespaceDiscoverySchema,
				inputs: [{ summary: '🦁'.repeat(500) }, { summary: '🦁'.repeat(501) }],
			},
			{
				schema: artifactSurface.PortalArtifactReadRequestSchema,
				inputs: [
					{
						maxBytes: 1,
						reference: {
							byteLength: 1,
							expiresAt: '2026-10-21T00:00:00.000Z',
							fingerprint: `sha256:${'a'.repeat(64)}`,
							id: 'artifact',
						},
					},
				],
			},
		];
	return {
		exports: Object.fromEntries(
			Object.entries(surfaces).map(([name, surface]) => [name, Object.keys(surface).toSorted()]),
		),
		manifestBytes: fingerprint(createPortableContractSchemaManifest()),
		parses: parseCases.map(({ schema, inputs }) =>
			inputs.map((input) => {
				const result = schema.safeParse(input);
				return result.success
					? { data: result.data, success: true }
					: { issues: result.error.issues, success: false };
			}),
		),
		schemaBytes,
	};
}
