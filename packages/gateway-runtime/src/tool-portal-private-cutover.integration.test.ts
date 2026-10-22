import { readFile, rm } from 'node:fs/promises';

import { startFakeUpstreamMcpServer } from '@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server';
import {
	PortalCallRequestSchema,
	PortalCatalogOfferResultSchema,
	PortalCatalogPrepareResultSchema,
	PortalCatalogReadResultSchema,
	PortalCatalogReleaseResultSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
} from '@agent-vm/agent-portal-sdk';
import { GatewayRuntimeClient } from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import {
	attachmentForConfig,
	createCutoverServiceConfig,
	cutoverPortalRequests,
	cutoverTrustedContext,
} from '@agent-vm/gateway-runtime/managed-tool-engine/test-fixtures/production-private-cutover-test-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { startGatewayRuntimeProductionService } from '#gateway-runtime/production/gateway-runtime-production-service';
describe('S4a pinned private connection comparison', () => {
	it('matches08f9e426 through default production UDS, real provider, artifacts and catalog retirement', async () => {
		// Arrange: only the external server is controlled. Production composition, UDS,
		// authority, rules, dispatcher, connector and compiler are the actual path.
		const upstream = await startFakeUpstreamMcpServer();
		const config = await createCutoverServiceConfig({
			includeMcpProvider: true,
			mcpOnly: true,
			mcpConfig: {
				schemaVersion: 1,
				providers: {
					fixture: {
						kind: 'mcp',
						namespace: 'github',
						discovery: {},
						secretPolicies: {},
						transport: {
							kind: 'streamable-http',
							url: upstream.url,
							headers: {},
							requiredEgressHosts: [],
						},
					},
				},
			},
		});
		const service = await startGatewayRuntimeProductionService({
			config,
			dependencies: { now: () => Date.parse('2026-07-13T12:00:00.000Z') },
		});
		const client = new GatewayRuntimeClient({
			attachment: attachmentForConfig(config),
			socketPath: service.udsServer.readiness.socketPath,
			startupRetryPolicy: { maxAttempts: 1 },
		});
		const context = cutoverTrustedContext(config);
		const options = { trustedContext: context };
		const untrustedOracle: unknown = JSON.parse(
			await readFile(
				new URL(
					'./managed-tool-engine/test-fixtures/private-cutover-08f9e426.json',
					import.meta.url,
				),
				'utf8',
			),
		);
		const oracle = z
			.object({ revision: z.literal('08f9e426'), outputs: z.record(z.string(), z.unknown()) })
			.parse(untrustedOracle).outputs;
		try {
			await client.connect();
			expect(service.readiness.uds.attachment.status).toBe('attached');
			expect(
				await client.portal.list(
					PortalListRequestSchema.parse(cutoverPortalRequests.list),
					options,
				),
			).toEqual(oracle.list);
			expect(
				await client.portal.search(
					PortalSearchRequestSchema.parse(cutoverPortalRequests.search),
					options,
				),
			).toEqual(oracle.search);
			expect(
				await client.portal.describe(
					PortalDescribeRequestSchema.parse(cutoverPortalRequests.describe),
					options,
				),
			).toEqual(oracle.describe);
			expect(
				await client.portal.call(
					PortalCallRequestSchema.parse(cutoverPortalRequests.call),
					options,
				),
			).toEqual(oracle.call);
			expect(upstream.calls).toHaveLength(1);
			expect(upstream.calls[0]?.name).toBe('read_thing');
			await expect(
				client.portal.call(PortalCallRequestSchema.parse(cutoverPortalRequests.call), {
					trustedContext: {
						...context,
						principal: { ...context.principal, profileAssignmentRevision: 'stale-assignment' },
					},
				}),
			).rejects.toThrow();
			expect(upstream.calls).toHaveLength(1);
			const hidden = {
				requests: [{ id: 'hidden', tools: [{ namespace: 'github', name: 'write_thing' }] }],
			};
			expect(
				JSON.stringify(
					await client.portal.describe(PortalDescribeRequestSchema.parse(hidden), options),
				),
			).not.toContain('write_thing');
			expect(
				JSON.stringify(
					await client.portal.search(
						{
							requests: [
								{ id: 'hidden-search', query: 'write_thing', limit: 20, schemaDetail: 'full' },
							],
						},
						options,
					),
				),
			).not.toContain('write_thing');
			expect(upstream.calls).toHaveLength(1);
			const authorization = {
				...context.principal,
				capability: { namespace: 'github', name: 'read_thing' },
				operationId: 'fixed-artifact-operation',
				executionFingerprint: 'fixed-artifact-fingerprint',
				owningGeneration: config.semanticSnapshot.activeRevision,
				surfaceClass: 'protected_uds' as const,
			};
			service.composition.registerArtifactAuthority(authorization);
			const writer = await service.composition.artifactStore.beginWrite({
				authorization,
				lifetimeMs: 60000,
				maximumBytes: 11,
				mediaType: 'text/plain',
			});
			await writer.write(Buffer.from('hello-world'));
			const reference = await writer.commit();
			const artifactRead = await client.artifacts.read(
				{ reference, offsetBytes: 6, maxBytes: 5 },
				options,
			);
			expect(Buffer.from(artifactRead.contentBase64, 'base64').toString('utf8')).toBe('world');
			expect(artifactRead).toMatchObject({
				reference,
				offsetBytes: 6,
				mediaType: 'text/plain',
				truncated: false,
			});
			service.composition.retireArtifactAuthority({
				kind: 'operation',
				operationId: authorization.operationId,
			});
			await expect(
				client.artifacts.read({ reference, offsetBytes: 0, maxBytes: 5 }, options),
			).rejects.toThrow();
			// Catalog data goes over the production private socket in bounded pages.
			const invokeCatalog = async (method: string, publicRequest: unknown): Promise<unknown> =>
				await client.request(method, { publicRequest, trustedContext: context });
			const prepared = PortalCatalogPrepareResultSchema.parse(
				await invokeCatalog('portal.catalog.prepare', {}),
			);
			expect(prepared).toEqual(oracle.catalogPrepare);
			if (prepared.kind !== 'complete')
				throw new Error(`Catalog did not prepare: ${JSON.stringify(prepared)}`);
			const offer = PortalCatalogOfferResultSchema.parse(
				await invokeCatalog('portal.catalog.offer', {
					definitionFingerprint: prepared.manifest.definitionFingerprint,
				}),
			);
			if (offer.kind !== 'offered') throw new Error('Catalog did not offer');
			const pageLength = Math.ceil(prepared.manifest.bundleByteLength / 3);
			const sourceChunks = await Promise.all(
				Array.from({ length: 3 }, async (_unused, index) => {
					const page = PortalCatalogReadResultSchema.parse(
						await invokeCatalog('portal.catalog.read', {
							definitionFingerprint: prepared.manifest.definitionFingerprint,
							offerId: offer.offerId,
							offset: index * pageLength,
							length: pageLength,
						}),
					);
					if (page.kind !== 'content') throw new Error('Catalog page refused');
					expect(page.eof).toBe(index === 2);
					return Buffer.from(page.contentBase64, 'base64');
				}),
			);
			expect(Buffer.concat(sourceChunks).toString('base64')).toBe(oracle.catalogContentBase64);
			const source = Buffer.concat(sourceChunks).toString('utf8');
			expect(source).toContain('read_thing');
			expect(source).not.toContain('write_thing');
			expect(
				PortalCatalogReleaseResultSchema.parse(
					await invokeCatalog('portal.catalog.release', {
						definitionFingerprint: prepared.manifest.definitionFingerprint,
						offerId: offer.offerId,
					}),
				),
			).toEqual({ kind: 'released' });
			expect(
				await invokeCatalog('portal.catalog.read', {
					definitionFingerprint: prepared.manifest.definitionFingerprint,
					offerId: offer.offerId,
					offset: 0,
					length: 128,
				}),
			).toEqual({ kind: 'unavailable', reason: 'catalog-source-unavailable' });
			expect(service.composition.preparedCatalogSourceCache.inspect().entries).toBe(1);
			await client.disconnect();
			await service.retire({ drainTimeoutMs: 100 });
			expect(service.composition.preparedCatalogSourceCache.inspect()).toMatchObject({
				retired: true,
				entries: 0,
				offers: 0,
			});
		} finally {
			await client.disconnect();
			await service.retire({ drainTimeoutMs: 100 });
			await upstream.close();
			await rm(config.runtimeRoot, { force: true, recursive: true });
		}
	});
});

describe('managed provider credential boundary', () => {
	it('redacts the real provider success, error, descriptions, helper, catalog and captured logs', async () => {
		const credential = 'S4A_PRIVATE_PROVIDER_CREDENTIAL_CANARY_5b0d6c88';
		const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const upstream = await startFakeUpstreamMcpServer({
			descriptionByToolName: { read_thing: `Mock record ${credential}` },
			toolResultByToolName: {
				read_thing: {
					content: [{ type: 'text', text: credential }],
					structuredContent: { providerValue: credential },
				},
			},
			toolErrorMessageByToolName: { write_thing: credential },
		});
		const config = await createCutoverServiceConfig({
			includeMcpProvider: true,
			mcpOnly: true,
			mcpAllowedTools: ['read_thing', 'write_thing'],
			mcpConfig: {
				schemaVersion: 1,
				providers: {
					fixture: {
						kind: 'mcp',
						namespace: 'github',
						discovery: {},
						secretPolicies: {},
						transport: {
							kind: 'streamable-http',
							url: upstream.url,
							headers: { authorization: { source: 'environment', name: 'S4A_TEST_CREDENTIAL' } },
							requiredEgressHosts: [],
						},
					},
				},
			},
		});
		const service = await startGatewayRuntimeProductionService({
			config,
			dependencies: { resolveMcpSecret: async () => credential },
		});
		const client = new GatewayRuntimeClient({
			attachment: attachmentForConfig(config),
			socketPath: service.udsServer.readiness.socketPath,
			startupRetryPolicy: { maxAttempts: 1 },
		});
		const context = cutoverTrustedContext(config);
		const options = { trustedContext: context };
		try {
			await client.connect();
			const listed = await client.portal.list(
				PortalListRequestSchema.parse(cutoverPortalRequests.list),
				options,
			);
			const searched = await client.portal.search(
				PortalSearchRequestSchema.parse(cutoverPortalRequests.search),
				options,
			);
			const described = await client.portal.describe(
				PortalDescribeRequestSchema.parse(cutoverPortalRequests.describe),
				options,
			);
			const success = await client.portal.call(
				{
					calls: [
						{
							id: 'success',
							namespace: 'github',
							name: 'read_thing',
							arguments: { title: 'safe argument' },
						},
					],
				},
				options,
			);
			const failed = await client.portal.call(
				{
					calls: [
						{
							id: 'failure',
							namespace: 'github',
							name: 'write_thing',
							arguments: { title: 'safe argument' },
						},
					],
				},
				options,
			);
			expect(upstream.authorizationHeaders).toContain(credential);
			expect(JSON.stringify(upstream.listedTools)).toContain(credential);
			expect(JSON.stringify(upstream.toolResults)).toContain(credential);
			expect(success.items[0]?.status).toBe('ok');
			expect(failed.items[0]?.status).toBe('error');
			expect(upstream.calls).toHaveLength(1);
			expect(
				upstream.requests
					.flatMap((request) => request.jsonRpcMethods)
					.filter((method) => method === 'tools/call'),
			).toHaveLength(2);
			const prepared = PortalCatalogPrepareResultSchema.parse(
				await client.request('portal.catalog.prepare', {
					publicRequest: {},
					trustedContext: context,
				}),
			);
			if (prepared.kind !== 'complete') throw new Error('Canary catalog did not prepare');
			const offered = PortalCatalogOfferResultSchema.parse(
				await client.request('portal.catalog.offer', {
					publicRequest: { definitionFingerprint: prepared.manifest.definitionFingerprint },
					trustedContext: context,
				}),
			);
			if (offered.kind !== 'offered') throw new Error('Canary catalog did not offer');
			const page = PortalCatalogReadResultSchema.parse(
				await client.request('portal.catalog.read', {
					publicRequest: {
						definitionFingerprint: prepared.manifest.definitionFingerprint,
						offerId: offered.offerId,
						offset: 0,
						length: 65536,
					},
					trustedContext: context,
				}),
			);
			if (page.kind !== 'content') throw new Error('Canary source unavailable');
			expect(page.eof).toBe(true);
			const callerVisible =
				JSON.stringify({
					listed,
					searched,
					described,
					success,
					failed,
					prepared,
					logs: [...errors.mock.calls, ...warnings.mock.calls, ...logs.mock.calls],
				}) + Buffer.from(page.contentBase64, 'base64').toString('utf8');
			expect(callerVisible).not.toContain(credential);
		} finally {
			await client.disconnect();
			await service.retire({ drainTimeoutMs: 100 });
			await upstream.close();
			await rm(config.runtimeRoot, { force: true, recursive: true });
			errors.mockRestore();
			warnings.mockRestore();
			logs.mockRestore();
		}
	});
});
