import { describe, expect, it } from 'vitest';

import { parseToolPortalCliArguments, runToolPortalCliParser } from './tool-portal-cli-parser.js';

describe('Tool Portal Optique CLI parser', () => {
	it('shows top-level help on stdout without parsing a command', () => {
		const stdout: string[] = [];
		const stderr: string[] = [];

		const result = runToolPortalCliParser(['--help'], {
			stderr: { write: (text: string): boolean => (stderr.push(text), true) },
			stdout: { write: (text: string): boolean => (stdout.push(text), true) },
		});

		expect(result).toEqual({ exitCode: 0, kind: 'help' });
		expect(stdout.join('')).toContain('tool-portal');
		expect(stderr).toEqual([]);
	});

	it('parses the authenticated HTTP list invocation into a readonly operation value', () => {
		expect(
			parseToolPortalCliArguments([
				'list',
				'--input-json',
				'{"requests":[]}',
				'--transport',
				'http',
				'--endpoint',
				'https://example.test/mcp',
				'--authorization-env',
				'TOOL_PORTAL_AUTH',
			]),
		).toEqual({
			inputJson: '{"requests":[]}',
			operation: 'list',
			transport: {
				authorizationEnvironmentName: 'TOOL_PORTAL_AUTH',
				endpoint: 'https://example.test/mcp',
				kind: 'http',
			},
		});
	});

	it('parses call approval and scoped-stdio transport values', () => {
		expect(
			parseToolPortalCliArguments([
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

	it.each([
		['rejects duplicate options', ['list', '--input-json', '{}', '--input-json', '{}']],
		['rejects unknown options', ['list', '--input-json', '{}', '--unknown', 'value']],
		['rejects missing required options', ['list', '--input-json', '{}', '--transport', 'http']],
		[
			'rejects approval tokens for non-call operations',
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
			'rejects an invalid environment variable name',
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
			'rejects a relative scoped-stdio config path',
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
	] as const)('%s', (_description, argv) => {
		expect(() => parseToolPortalCliArguments(argv)).toThrow();
	});
});
