import { readFile } from 'node:fs/promises';

import { formatMessage } from '@optique/core/message';
import { parseSync } from '@optique/core/parser';
import { option } from '@optique/core/primitives';
import { zod } from '@optique/zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { projectZodScalarPresence, toolPortalRootParser } from './tool-portal-cli-parser.js';

function parseToolPortalArguments(arguments_: readonly string[]): unknown {
	const result = parseSync(toolPortalRootParser, arguments_);
	if (!result.success) throw new Error(formatMessage(result.error));
	return result.value;
}

describe('Tool Portal Optique CLI parser', () => {
	it('keeps parser construction free of transport and operation effects', async () => {
		const parserSource = await readFile(
			new URL('./tool-portal-cli-parser.ts', import.meta.url),
			'utf8',
		);

		expect(parserSource).not.toMatch(/ToolPortalMcpClient|createNodeToolPortalMcpTransport/u);
		expect(parserSource).not.toMatch(/node:fs|process\.|runToolPortalOperation/u);
	});

	it.each(['artifact-read', 'describe', 'list', 'search'] as const)(
		'parses the %s HTTP command with its exact conditional options',
		(operation) => {
			expect(
				parseToolPortalArguments([
					operation,
					'--input-json',
					'{}',
					'--transport',
					'http',
					'--endpoint',
					'https://example.test/mcp',
					'--authorization-env',
					'TOOL_PORTAL_AUTH',
				]),
			).toEqual({
				inputJson: '{}',
				operation,
				transport: {
					authorizationEnvironmentName: 'TOOL_PORTAL_AUTH',
					endpoint: 'https://example.test/mcp',
					kind: 'http',
				},
			});
		},
	);

	it('parses call with its optional approval token and scoped-stdio branch', () => {
		expect(
			parseToolPortalArguments([
				'call',
				'--input-json',
				'{"calls":[]}',
				'--transport',
				'scoped-stdio',
				'--stdio-config',
				'/tmp/tool-portal.json',
				'--approval-token-env',
				'TOOL_PORTAL_APPROVAL',
			]),
		).toEqual({
			approvalTokenEnvironmentName: 'TOOL_PORTAL_APPROVAL',
			inputJson: '{"calls":[]}',
			operation: 'call',
			transport: {
				kind: 'scoped-stdio',
				scopedStdioConfigPath: '/tmp/tool-portal.json',
			},
		});
	});

	it('parses HTTP branch options before the transport selector', () => {
		expect(
			parseToolPortalArguments([
				'list',
				'--input-json',
				'{}',
				'--endpoint',
				'https://example.test/mcp',
				'--authorization-env',
				'TOOL_PORTAL_AUTH',
				'--transport',
				'http',
			]),
		).toEqual({
			inputJson: '{}',
			operation: 'list',
			transport: {
				authorizationEnvironmentName: 'TOOL_PORTAL_AUTH',
				endpoint: 'https://example.test/mcp',
				kind: 'http',
			},
		});
	});

	it('parses scoped-stdio branch options before the transport selector', () => {
		expect(
			parseToolPortalArguments([
				'search',
				'--input-json',
				'{"query":"status"}',
				'--stdio-config',
				'/tmp/tool-portal.json',
				'--transport',
				'scoped-stdio',
			]),
		).toEqual({
			inputJson: '{"query":"status"}',
			operation: 'search',
			transport: {
				kind: 'scoped-stdio',
				scopedStdioConfigPath: '/tmp/tool-portal.json',
			},
		});
	});

	it('leaves the call approval token absent when the option is absent', () => {
		expect(
			parseToolPortalArguments([
				'call',
				'--input-json',
				'{}',
				'--transport',
				'scoped-stdio',
				'--stdio-config',
				'/tmp/tool-portal.json',
			]),
		).toEqual({
			approvalTokenEnvironmentName: undefined,
			inputJson: '{}',
			operation: 'call',
			transport: {
				kind: 'scoped-stdio',
				scopedStdioConfigPath: '/tmp/tool-portal.json',
			},
		});
	});

	it.each([
		['duplicate option', ['list', '--input-json', '{}', '--input-json', '{}']],
		['unknown option', ['list', '--input-json', '{}', '--unknown', 'value']],
		[
			'missing HTTP authorization environment option',
			[
				'list',
				'--input-json',
				'{}',
				'--transport',
				'http',
				'--endpoint',
				'https://example.test/mcp',
			],
		],
		['missing HTTP endpoint', ['list', '--input-json', '{}', '--transport', 'http']],
		[
			'missing scoped stdio configuration option',
			['list', '--input-json', '{}', '--transport', 'scoped-stdio'],
		],
		[
			'HTTP-only option on scoped stdio',
			[
				'list',
				'--input-json',
				'{}',
				'--transport',
				'scoped-stdio',
				'--stdio-config',
				'/tmp/tool-portal.json',
				'--endpoint',
				'https://example.test/mcp',
			],
		],
		[
			'approval token on a non-call operation',
			[
				'list',
				'--input-json',
				'{}',
				'--transport',
				'http',
				'--endpoint',
				'https://example.test/mcp',
				'--authorization-env',
				'TOOL_PORTAL_AUTH',
				'--approval-token-env',
				'TOOL_PORTAL_APPROVAL',
			],
		],
		[
			'unsafe HTTP endpoint',
			[
				'list',
				'--input-json',
				'{}',
				'--transport',
				'http',
				'--endpoint',
				'https://user:secret@example.test/mcp',
				'--authorization-env',
				'TOOL_PORTAL_AUTH',
			],
		],
		[
			'invalid environment variable name',
			[
				'call',
				'--input-json',
				'{}',
				'--transport',
				'http',
				'--endpoint',
				'https://example.test/mcp',
				'--authorization-env',
				'not-valid',
			],
		],
		[
			'relative scoped-stdio path',
			[
				'list',
				'--input-json',
				'{}',
				'--transport',
				'scoped-stdio',
				'--stdio-config',
				'config/tool-portal.json',
			],
		],
	] as const)('rejects a %s', (_description, arguments_) => {
		expect(() => parseToolPortalArguments(arguments_)).toThrow();
	});

	it('projects a simply optional Zod schema onto Optique absence', () => {
		const optionalEnvironmentNameSchema = z.string().min(1).optional();
		const parser = projectZodScalarPresence({
			parser: option(
				'--environment',
				zod(optionalEnvironmentNameSchema, { placeholder: undefined }),
			),
			schema: optionalEnvironmentNameSchema,
		});

		expect(parseSync(parser, [])).toMatchObject({ success: true, value: undefined });
	});

	it.each([z.string().default('fallback').optional(), z.string().optional().default('fallback')])(
		'rejects mixed optional/default wrapper order',
		(schema) => {
			expect(() =>
				projectZodScalarPresence({
					parser: option('--value', zod(schema, { placeholder: undefined })),
					schema,
				}),
			).toThrow('must not mix ZodOptional and ZodDefault');
		},
	);

	it.each([
		z.string().prefault('fallback'),
		z.string().catch('fallback'),
		z.string().default('fallback').pipe(z.string()),
	])('rejects unsupported schemas that accept undefined', (schema) => {
		const parser = option('--value', zod(schema, { placeholder: 'fallback' }));

		expect(() => projectZodScalarPresence({ parser, schema })).toThrow(
			/accepting undefined must use ZodOptional or ZodDefault/u,
		);
	});
});
