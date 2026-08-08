import { object } from '@optique/core/constructs';
import { option } from '@optique/core/primitives';
import { zod } from '@optique/zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { CliIo } from './agent-vm-cli-support.js';
import {
	createConfigPathValueParser,
	createZoneIdValueParser,
	runOptiqueCliParser,
} from './optique-cli-support.js';

interface CapturedCliOutput {
	readonly stdout: string[];
	readonly stderr: string[];
}

function createCapturedCliOutput(): CapturedCliOutput {
	return {
		stderr: [],
		stdout: [],
	};
}

function createCliIo(output: CapturedCliOutput): CliIo {
	return {
		stderr: {
			write: (chunk: string | Uint8Array): boolean => {
				output.stderr.push(String(chunk));
				return true;
			},
		},
		stdout: {
			write: (chunk: string | Uint8Array): boolean => {
				output.stdout.push(String(chunk));
				return true;
			},
		},
	};
}

const parser = object({
	mode: option(
		'--mode',
		zod(z.enum(['safe', 'fast']), {
			metavar: 'MODE',
			placeholder: 'safe',
		}),
	),
	port: option(
		'--port',
		zod(z.coerce.number().int().min(1).max(65_535), {
			metavar: 'PORT',
			placeholder: 18789,
		}),
	),
});

describe('agent-vm Optique CLI support', () => {
	it('reports help through injected stdout without terminating the host process', () => {
		const output = createCapturedCliOutput();

		const result = runOptiqueCliParser({
			argv: ['--help'],
			io: createCliIo(output),
			parser,
			programName: 'agent-vm',
			version: '9.8.7',
		});

		expect(result).toEqual({ kind: 'help', exitCode: 0 });
		expect(output.stdout.join('')).toContain('--mode MODE');
		expect(output.stdout.join('')).toContain('--port PORT');
		expect(output.stderr).toEqual([]);
	});

	it('reports version through injected stdout without dispatching a parsed value', () => {
		const output = createCapturedCliOutput();

		const result = runOptiqueCliParser({
			argv: ['--version'],
			io: createCliIo(output),
			parser,
			programName: 'agent-vm',
			version: '9.8.7',
		});

		expect(result).toEqual({ kind: 'version', exitCode: 0 });
		expect(output.stdout.join('')).toBe('9.8.7\n');
		expect(output.stderr).toEqual([]);
	});

	it('accepts the short help option through injected stdout', () => {
		const output = createCapturedCliOutput();

		const result = runOptiqueCliParser({
			argv: ['-h'],
			io: createCliIo(output),
			parser,
			programName: 'agent-vm',
			version: '9.8.7',
		});

		expect(result).toEqual({ kind: 'help', exitCode: 0 });
		expect(output.stdout.join('')).toContain('--mode MODE');
		expect(output.stderr).toEqual([]);
	});

	it('reports malformed values through injected stderr without terminating the host process', () => {
		const output = createCapturedCliOutput();

		const result = runOptiqueCliParser({
			argv: ['--mode', 'turbo', '--port', 'not-a-port'],
			io: createCliIo(output),
			parser,
			programName: 'agent-vm',
			version: '9.8.7',
		});

		expect(result).toEqual({ kind: 'parse-error', exitCode: 1 });
		expect(output.stdout).toEqual([]);
		expect(output.stderr.join('')).toContain('Error:');
		expect(output.stderr.join('')).toContain('--mode');
	});

	it('coerces numeric Zod values and preserves enum output values', () => {
		const output = createCapturedCliOutput();

		const result = runOptiqueCliParser({
			argv: ['--mode', 'fast', '--port', '19123'],
			io: createCliIo(output),
			parser,
			programName: 'agent-vm',
			version: '9.8.7',
		});

		expect(result).toEqual({
			kind: 'parsed',
			value: { mode: 'fast', port: 19_123 },
		});
		expect(output.stdout).toEqual([]);
		expect(output.stderr).toEqual([]);
	});

	it('rejects a reserved zone id through the authoritative zone schema', () => {
		const output = createCapturedCliOutput();
		const zoneParser = object({
			config: option('--config', createConfigPathValueParser()),
			zone: option('--zone', createZoneIdValueParser()),
		});

		const result = runOptiqueCliParser({
			argv: ['--config', 'config/system.json', '--zone', 'cache'],
			io: createCliIo(output),
			parser: zoneParser,
			programName: 'agent-vm',
			version: '9.8.7',
		});

		expect(result).toEqual({ kind: 'parse-error', exitCode: 1 });
		expect(output.stderr.join('')).toContain('zone id is reserved for global storage');
	});
});
