import { describe, expect, it } from 'vitest';

import {
	runGatewayRuntimeCliParser,
	type GatewayRuntimeCliParseResult,
} from './gateway-runtime-cli-parser.js';

interface CapturedCliIo {
	readonly stderr: { value: string };
	readonly stdout: { value: string };
}

function createCapturedCliIo(): CapturedCliIo {
	return {
		stderr: { value: '' },
		stdout: { value: '' },
	};
}

function runParser(argv: readonly string[], io: CapturedCliIo): GatewayRuntimeCliParseResult {
	return runGatewayRuntimeCliParser(argv, {
		stderr: {
			write: (text: string): boolean => {
				io.stderr.value += text;
				return true;
			},
		},
		stdout: {
			write: (text: string): boolean => {
				io.stdout.value += text;
				return true;
			},
		},
	});
}

describe('Gateway Runtime CLI parser', () => {
	it('parses the required absolute config option into a discriminated command', () => {
		const io = createCapturedCliIo();

		expect(runParser(['--config', '/tmp/gateway-runtime.json'], io)).toEqual({
			kind: 'parsed',
			value: {
				command: 'start',
				options: { config: '/tmp/gateway-runtime.json' },
			},
		});
		expect(io).toEqual({ stderr: { value: '' }, stdout: { value: '' } });
	});

	it('uses Optique standard attached long-option values', () => {
		const io = createCapturedCliIo();

		expect(runParser(['--config=/tmp/gateway-runtime.json'], io)).toEqual({
			kind: 'parsed',
			value: {
				command: 'start',
				options: { config: '/tmp/gateway-runtime.json' },
			},
		});
		expect(io).toEqual({ stderr: { value: '' }, stdout: { value: '' } });
	});

	it.each([
		['missing --config', []],
		['relative config path', ['--config', 'relative.json']],
		['NUL-bearing config path', ['--config', '/tmp/invalid\u0000.json']],
		['unknown option', ['--unknown', '/tmp/gateway-runtime.json']],
	] as const)('rejects %s without producing a parsed command', (_name, argv) => {
		const io = createCapturedCliIo();

		const result = runParser(argv, io);

		expect(result).toMatchObject({ kind: 'parse-error' });
		expect(io.stdout.value).toBe('');
		expect(io.stderr.value).toMatch(/error|config|absolute|NUL|unknown/iu);
	});

	it('writes help to stdout and reports success without parsing a command', () => {
		const io = createCapturedCliIo();

		const result = runParser(['--help'], io);

		expect(result).toEqual({ kind: 'help', exitCode: 0 });
		expect(io.stdout.value).toContain('--config');
		expect(io.stderr.value).toBe('');
	});
});
