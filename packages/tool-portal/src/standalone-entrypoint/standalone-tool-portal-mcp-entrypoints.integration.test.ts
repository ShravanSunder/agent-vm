import type { StandaloneToolPortalConfig } from '@agent-vm/config-contracts';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import {
	TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	type StandaloneToolPortalBearerCredentialSet,
} from './standalone-tool-portal-bearer-credentials.js';
import { startStandaloneToolPortalEntrypoints } from './standalone-tool-portal-mcp-entrypoints.js';
import type { StandaloneToolPortalProjectionService } from './standalone-tool-portal-mcp-projection.js';

const principalWithoutCredentialVersion = {
	agentId: 'agent-a',
	profileAssignmentRevision: 'profile-assignment:1',
	toolPortalProfileId: 'builder',
} as const;

const config = {
	agents: { 'agent-a': { profile: 'builder' } },
	authentication: {
		agents: {
			'agent-a': {
				approvalHmacKey: { name: 'APPROVAL_KEY', source: 'environment' },
				bearerKey: { name: 'BEARER_KEY', source: 'environment' },
				credentialVersion: 1,
			},
		},
	},
	drain: { timeoutMs: 100 },
	entrypoints: {
		http: {
			address: { host: '127.0.0.1', port: 0 },
			allowedHosts: ['127.0.0.1'],
			allowedOrigins: [],
			authentication: { kind: 'bearer' },
			enabled: true,
			route: '/tool-portal/http',
		},
		mcp: {
			address: { host: '127.0.0.1', port: 0 },
			allowedHosts: ['127.0.0.1'],
			allowedOrigins: [],
			authentication: { kind: 'bearer' },
			enabled: true,
			route: '/tool-portal/mcp',
			transport: 'streamable-http',
		},
		stdio: {
			authentication: { agentId: 'agent-a', kind: 'scoped-principal' },
			enabled: true,
		},
	},
	mode: 'standalone',
	profiles: {
		builder: {
			namespaces: {
				github: {
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: '*', deny: [] },
					},
					tools: { allow: '*', deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
} as const satisfies StandaloneToolPortalConfig;

const credentialSet = {
	audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	credentials: [
		{
			bearerToken: 'standalone-bearer-token',
			credentialVersion: 1,
			principal: principalWithoutCredentialVersion,
		},
	],
	serviceGeneration: 'standalone-service:1',
} satisfies StandaloneToolPortalBearerCredentialSet;

function createService(): StandaloneToolPortalProjectionService {
	return {
		call: vi.fn(async () => ({ items: [], ok: true })),
		describe: vi.fn(async () => ({ items: [], ok: true })),
		list: vi.fn(async () => ({ items: [], ok: true })),
		search: vi.fn(async () => ({ items: [], ok: true })),
	};
}

describe('standalone Tool Portal entrypoint group', () => {
	it('starts exactly configured HTTP, MCP, and stdio projections over one service', async () => {
		const [, serverTransport] = InMemoryTransport.createLinkedPair();
		const service = createService();
		const authenticatedEnvelope = {
			audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
			principal: { ...principalWithoutCredentialVersion, credentialVersion: 1 },
			serviceGeneration: 'standalone-service:1',
		} as const;
		const entrypoints = await startStandaloneToolPortalEntrypoints({
			artifactReader: { read: vi.fn(async () => Promise.reject(new Error('not expected'))) },
			bearerCredentialSet: credentialSet,
			config,
			service,
			stdioAuthenticatedEnvelope: authenticatedEnvelope,
			stdioTransport: serverTransport,
		});

		expect(entrypoints.service).toBe(service);
		expect(entrypoints.http?.service).toBe(service);
		expect(entrypoints.mcp?.service).toBe(service);
		expect(entrypoints.stdio?.service).toBe(service);
		await expect(entrypoints.retire()).resolves.toBeUndefined();
	});

	it('rejects missing resolved security material for an enabled entrypoint', async () => {
		await expect(
			startStandaloneToolPortalEntrypoints({
				artifactReader: { read: vi.fn(async () => Promise.reject(new Error('not expected'))) },
				config,
				service: createService(),
			}),
		).rejects.toThrow('require resolved bearer credentials');
	});

	it('starts only the explicitly configured stdio projection', async () => {
		const [, serverTransport] = InMemoryTransport.createLinkedPair();
		const service = createService();
		const authenticatedEnvelope = {
			audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
			principal: { ...principalWithoutCredentialVersion, credentialVersion: 1 },
			serviceGeneration: 'standalone-service:1',
		} as const;
		const entrypoints = await startStandaloneToolPortalEntrypoints({
			artifactReader: { read: vi.fn(async () => Promise.reject(new Error('not expected'))) },
			config: {
				...config,
				entrypoints: { stdio: config.entrypoints.stdio },
			},
			service,
			stdioAuthenticatedEnvelope: authenticatedEnvelope,
			stdioTransport: serverTransport,
		});

		expect(entrypoints.service).toBe(service);
		expect(entrypoints).not.toHaveProperty('http');
		expect(entrypoints).not.toHaveProperty('mcp');
		expect(entrypoints.stdio?.service).toBe(service);
		await expect(entrypoints.retire()).resolves.toBeUndefined();
	});

	it('rejects startup when no entrypoint is explicitly configured', async () => {
		await expect(
			startStandaloneToolPortalEntrypoints({
				artifactReader: { read: vi.fn(async () => Promise.reject(new Error('not expected'))) },
				config: { ...config, entrypoints: {} },
				service: createService(),
			}),
		).rejects.toThrow('must explicitly enable at least one entrypoint');
	});
});
