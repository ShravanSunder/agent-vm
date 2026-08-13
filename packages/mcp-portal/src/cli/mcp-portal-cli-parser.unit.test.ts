import { readFile } from 'node:fs/promises';

import { parseSync } from '@optique/core/parser';
import { constant, option } from '@optique/core/primitives';
import { zod } from '@optique/zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	mcpPortalRootParser,
	projectZodRepeatedOption,
	projectZodScalarPresence,
} from './mcp-portal-cli-parser.js';

function parseArguments(argumentsToParse: readonly string[]): unknown {
	const result = parseSync(mcpPortalRootParser, argumentsToParse);
	if (!result.success) {
		throw new Error('Expected MCP Portal arguments to parse successfully.');
	}
	return result.value;
}

describe('MCP Portal Optique parser', () => {
	it('keeps parser construction free of runtime operation effects', async () => {
		const parserSource = await readFile(
			new URL('./mcp-portal-cli-parser.ts', import.meta.url),
			'utf8',
		);

		expect(parserSource).not.toMatch(/node:(?:child_process|fs|http|net)/u);
		expect(parserSource).not.toMatch(/process\.|run[A-Z]\w*Operation|createNode\w*Transport/u);
	});

	it.each([
		{
			args: ['validate', 'catalog.json'],
			expected: { catalogPath: 'catalog.json', command: 'validate' },
		},
		{
			args: ['generate-helper', 'catalog.json', '--out', 'generated'],
			expected: {
				catalogPath: 'catalog.json',
				command: 'generate-helper',
				outputDirectory: 'generated',
			},
		},
		{
			args: ['call', '--config-dir', '/config', '--agent', 'agent', '--input', 'request.json'],
			expected: {
				agentId: 'agent',
				command: 'call',
				configDir: '/config',
				inputPath: 'request.json',
				toolName: 'mcp_portal_call',
			},
		},
		{
			args: [
				'mcp-proxy',
				'print-client-config',
				'--config-dir',
				'/config',
				'--agent',
				'agent',
				'--master-key-fingerprint',
				'opaque-current-value',
			],
			expected: {
				agentId: 'agent',
				command: 'mcp-proxy.print-client-config',
				configDir: '/config',
				expectedFingerprint: 'opaque-current-value',
				proxyUrl: undefined,
			},
		},
		{
			args: ['mcp-proxy', 'write-credential'],
			expected: { command: 'mcp-proxy.write-credential' },
		},
	] as const)('parses $expected.command through the shared root', ({ args, expected }) => {
		expect(parseArguments(args)).toEqual(expected);
	});

	it('preserves absent, repeated, and bounded serve values', () => {
		expect(parseArguments(['mcp-proxy', 'serve', '--config-dir', '/config'])).toEqual({
			agentOverrides: [],
			command: 'mcp-proxy.serve',
			configDir: '/config',
			port: undefined,
		});
		expect(
			parseArguments([
				'mcp-proxy',
				'serve',
				'--config-dir',
				'/config',
				'--port',
				'0',
				'--agent',
				'shravan=builder',
				'--agent',
				'other=reviewer',
			]),
		).toEqual({
			agentOverrides: ['shravan=builder', 'other=reviewer'],
			command: 'mcp-proxy.serve',
			configDir: '/config',
			port: 0,
		});
		expect(
			parseArguments(['mcp-proxy', 'serve', '--config-dir', '/config', '--port', '65535']),
		).toMatchObject({ port: 65_535 });
	});

	it.each([
		{ args: ['serve'] },
		{ args: ['write-credential'] },
		{ args: ['mcp-proxy', 'write-credential', '--config-dir', '/ignored'] },
		{ args: ['mcp-proxy', 'serve', '--config-dir', '/config', '--port', ''] },
		{ args: ['mcp-proxy', 'serve', '--config-dir', '/config', '--port', '   '] },
		{ args: ['mcp-proxy', 'serve', '--config-dir', '/config', '--port', '65536'] },
		{ args: ['mcp-proxy', 'serve', '--config-dir', '/config', '--port', '1.5'] },
		{ args: ['mcp-proxy', 'serve', '--config-dir', '/config', '--agent', 'missing-profile'] },
	] as const)('rejects unsupported or invalid grammar: $args', ({ args }) => {
		expect(parseSync(mcpPortalRootParser, args).success).toBe(false);
	});

	it('rejects both mixed scalar absence-wrapper orders', () => {
		expect(() =>
			projectZodScalarPresence(z.string().default('value').optional(), constant('value')),
		).toThrow(/mixes ZodOptional and ZodDefault/u);
		expect(() =>
			projectZodScalarPresence(z.string().optional().default('value'), constant('value')),
		).toThrow(/mixes ZodOptional and ZodDefault/u);
	});

	it('lets the repeated array schema own the empty default', () => {
		const repeatedSchema = z.array(z.string().min(1)).default([]);
		const parser = projectZodRepeatedOption(
			repeatedSchema,
			option('--agent', zod(repeatedSchema.unwrap().element, { placeholder: 'agent=profile' })),
		);
		const result = parseSync(parser, []);

		expect(result).toMatchObject({ success: true, value: [] });
	});
});
