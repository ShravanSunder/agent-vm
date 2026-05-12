import { describe, expect, it, vi } from 'vitest';

import {
	splitResolvedGatewaySecrets,
	splitResolvedSecretsByInjection,
} from './split-resolved-gateway-secrets.js';

describe('splitResolvedSecretsByInjection', () => {
	it('returns only gateway-audience secrets for gateway splitting', () => {
		const result = splitResolvedSecretsByInjection(
			{
				DISCORD_BOT_TOKEN: {
					source: 'environment',
					envVar: 'DISCORD_BOT_TOKEN',
					audience: 'gateway',
					injection: 'env',
				},
				GITHUB_TOKEN: {
					source: 'environment',
					envVar: 'GITHUB_TOKEN',
					audience: 'both',
					injection: 'http-mediation',
					hosts: ['api.github.com'],
				},
				LINEAR_API_KEY: {
					source: 'environment',
					envVar: 'LINEAR_API_KEY',
					audience: 'tool-vm',
					injection: 'http-mediation',
					hosts: ['api.linear.app'],
				},
			},
			{
				DISCORD_BOT_TOKEN: 'discord-real-secret',
				GITHUB_TOKEN: 'github-real-secret',
				LINEAR_API_KEY: 'linear-real-secret',
			},
			{ audience: 'gateway', logPrefix: 'test-split' },
		);

		expect(result).toEqual({
			environmentSecrets: {
				DISCORD_BOT_TOKEN: 'discord-real-secret',
			},
			mediatedSecrets: {
				GITHUB_TOKEN: {
					hosts: ['api.github.com'],
					value: 'github-real-secret',
				},
			},
		});
	});

	it('returns only mediated Tool VM secrets for Tool VM splitting', () => {
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		try {
			const result = splitResolvedSecretsByInjection(
				{
					DISCORD_BOT_TOKEN: {
						source: 'environment',
						envVar: 'DISCORD_BOT_TOKEN',
						audience: 'gateway',
						injection: 'env',
					},
					GITHUB_TOKEN: {
						source: 'environment',
						envVar: 'GITHUB_TOKEN',
						audience: 'both',
						injection: 'http-mediation',
						hosts: ['api.github.com'],
					},
					LINEAR_API_KEY: {
						source: 'environment',
						envVar: 'LINEAR_API_KEY',
						audience: 'tool-vm',
						injection: 'http-mediation',
						hosts: ['api.linear.app'],
					},
				},
				{
					DISCORD_BOT_TOKEN: 'discord-real-secret',
					GITHUB_TOKEN: 'github-real-secret',
					LINEAR_API_KEY: 'linear-real-secret',
				},
				{ audience: 'tool-vm', logPrefix: 'test-split' },
			);

			expect(result).toEqual({
				environmentSecrets: {},
				mediatedSecrets: {
					GITHUB_TOKEN: {
						hosts: ['api.github.com'],
						value: 'github-real-secret',
					},
					LINEAR_API_KEY: {
						hosts: ['api.linear.app'],
						value: 'linear-real-secret',
					},
				},
			});
			expect(stderrSpy).not.toHaveBeenCalled();
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it('throws when resolved secrets are missing from config', () => {
		expect(() =>
			splitResolvedSecretsByInjection(
				{},
				{
					UNDECLARED_TOKEN: 'undeclared-real-secret',
				},
				{ audience: 'tool-vm', logPrefix: 'test-split' },
			),
		).toThrow("Secret 'UNDECLARED_TOKEN' was resolved but has no matching secret config");
	});

	it('throws on mediated secrets with empty hosts after schema bypass', () => {
		expect(() =>
			splitResolvedSecretsByInjection(
				{
					LINEAR_API_KEY: {
						source: 'environment',
						envVar: 'LINEAR_API_KEY',
						audience: 'tool-vm',
						injection: 'http-mediation',
						hosts: [],
					},
				},
				{
					LINEAR_API_KEY: 'linear-real-secret',
				},
				{ audience: 'tool-vm', logPrefix: 'test-split' },
			),
		).toThrow("Secret 'LINEAR_API_KEY' uses http-mediation but declares no hosts");
	});

	it('throws on env-injected non-gateway secrets after schema bypass', () => {
		expect(() =>
			splitResolvedSecretsByInjection(
				{
					LINEAR_API_KEY: {
						source: 'environment',
						envVar: 'LINEAR_API_KEY',
						audience: 'tool-vm',
						injection: 'env',
					} as never,
				},
				{
					LINEAR_API_KEY: 'linear-real-secret',
				},
				{ audience: 'tool-vm', logPrefix: 'test-split' },
			),
		).toThrow("Secret 'LINEAR_API_KEY' uses env injection with non-gateway audience 'tool-vm'");
	});

	it('keeps gateway env secrets out of Tool VM splitting', () => {
		const result = splitResolvedSecretsByInjection(
			{
				DISCORD_BOT_TOKEN: {
					source: 'environment',
					envVar: 'DISCORD_BOT_TOKEN',
					audience: 'gateway',
					injection: 'env',
				},
			},
			{},
			{ audience: 'tool-vm', logPrefix: 'test-split' },
		);

		expect(result).toEqual({
			environmentSecrets: {},
			mediatedSecrets: {},
		});
	});
});

describe('splitResolvedGatewaySecrets', () => {
	it('keeps gateway wrapper behavior scoped to gateway audience', () => {
		const result = splitResolvedGatewaySecrets(
			{
				id: 'sunfam',
				gateway: {
					type: 'openclaw',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: './openclaw.json',
					stateDir: './state',
					ssh: { secretEnv: 'explicit' },
					zoneFilesDir: './zone-files',
				},
				secrets: {
					PERPLEXITY_API_KEY: {
						source: '1password',
						ref: 'op://agent-vm/sunfam-perplexity/credential',
						injection: 'http-mediation',
						audience: 'gateway',
						hosts: ['api.perplexity.ai'],
					},
					READWISE_ACCESS_TOKEN: {
						source: '1password',
						ref: 'op://agent-vm/sunfam-shravan-readwise/credential',
						injection: 'http-mediation',
						audience: 'tool-vm',
						hosts: ['mcp2.readwise.io'],
					},
				},
				egressHosts: [{ host: 'api.perplexity.ai', audience: 'gateway' }],
				websocketBypass: [],
			},
			{
				PERPLEXITY_API_KEY: 'perplexity-real-secret',
				READWISE_ACCESS_TOKEN: 'readwise-real-secret',
			},
		);

		expect(result).toEqual({
			environmentSecrets: {},
			mediatedSecrets: {
				PERPLEXITY_API_KEY: {
					hosts: ['api.perplexity.ai'],
					value: 'perplexity-real-secret',
				},
			},
		});
	});
});
