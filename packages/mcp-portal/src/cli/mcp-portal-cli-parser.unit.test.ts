import { describe, expect, it } from 'vitest';

import {
	mcpPortalCliParser,
	parsePortalServerCliArgs,
	runMcpPortalCliParser,
} from './mcp-portal-cli-parser.js';

function createIo(): {
	readonly stderr: string[];
	readonly stdout: string[];
	readonly io: {
		readonly stderr: { readonly write: (text: string) => boolean };
		readonly stdout: { readonly write: (text: string) => boolean };
	};
} {
	const stderr: string[] = [];
	const stdout: string[] = [];
	return {
		stderr,
		stdout,
		io: {
			stderr: { write: (text) => (stderr.push(text), true) },
			stdout: { write: (text) => (stdout.push(text), true) },
		},
	};
}

describe('mcp-portal Optique parser', () => {
	it('returns a discriminated generate-helper command with typed positional and option values', () => {
		const output = createIo();

		expect(
			runMcpPortalCliParser(['generate-helper', 'catalog.json', '--out', 'generated'], output.io),
		).toEqual({
			kind: 'parsed',
			value: {
				command: 'generate-helper',
				options: { catalogPath: 'catalog.json', outputDirectory: 'generated' },
			},
		});
		expect(output.stderr).toEqual([]);
		expect(output.stdout).toEqual([]);
	});

	it('coerces serve ports and preserves repeated profile overrides', () => {
		expect(
			parsePortalServerCliArgs([
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
			configDir: '/config',
			port: 0,
		});
	});

	it('reports help on stdout and malformed Zod values on stderr without terminating the host', () => {
		const helpOutput = createIo();
		const helpResult = runMcpPortalCliParser(['mcp-proxy', 'serve', '--help'], helpOutput.io);
		expect(helpResult).toEqual({ kind: 'help', exitCode: 0 });
		expect(helpOutput.stdout.join('')).toContain('mcp-proxy serve');
		expect(helpOutput.stderr).toEqual([]);

		const invalidOutput = createIo();
		const invalidResult = runMcpPortalCliParser(
			['mcp-proxy', 'serve', '--config-dir', '/config', '--port', 'nope'],
			invalidOutput.io,
		);
		expect(invalidResult.kind).toBe('parse-error');
		expect(invalidOutput.stderr.join('')).toMatch(/port|number|invalid/u);
		expect(invalidOutput.stdout).toEqual([]);

		const invalidToolOutput = createIo();
		const invalidToolResult = runMcpPortalCliParser(
			[
				'call',
				'--config-dir',
				'/config',
				'--agent',
				'agent',
				'--input',
				'request.json',
				'--tool',
				'not-a-portal-tool',
			],
			invalidToolOutput.io,
		);
		expect(invalidToolResult.kind).toBe('parse-error');
		expect(invalidToolOutput.stderr.join('')).toMatch(/tool|invalid|expected/u);
	});

	it('keeps the parser tree synchronous and constructible without running operations', () => {
		expect(mcpPortalCliParser).toBeDefined();
	});
});
