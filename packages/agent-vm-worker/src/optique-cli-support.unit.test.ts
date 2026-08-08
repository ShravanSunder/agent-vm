import { object } from '@optique/core/constructs';
import { option } from '@optique/core/primitives';
import { zod } from '@optique/zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	createWorkerPortValueParser,
	runOptiqueCliParser,
	type OptiqueCliIo,
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

function createCliIo(output: CapturedCliOutput): OptiqueCliIo {
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
	port: option('-p', '--port', createWorkerPortValueParser()),
});

describe('agent-vm-worker Optique CLI support', () => {
	it('reports help through injected stdout without terminating the host process', () => {
		const output = createCapturedCliOutput();

		const result = runOptiqueCliParser({
			argv: ['--help'],
			io: createCliIo(output),
			parser,
			programName: 'agent-vm-worker',
		});

		expect(result).toEqual({ kind: 'help', exitCode: 0 });
		expect(output.stdout.join('')).toContain('--port PORT');
		expect(output.stdout.join('')).toContain('--mode MODE');
		expect(output.stderr).toEqual([]);
	});

	it('reports invalid enum and port values through injected stderr', () => {
		const output = createCapturedCliOutput();

		const result = runOptiqueCliParser({
			argv: ['--mode', 'turbo', '--port', 'not-a-port'],
			io: createCliIo(output),
			parser,
			programName: 'agent-vm-worker',
		});

		expect(result).toEqual({ kind: 'parse-error', exitCode: 1 });
		expect(output.stdout).toEqual([]);
		expect(output.stderr.join('')).toContain('Error:');
		expect(output.stderr.join('')).toContain('--mode');
	});

	it('accepts the short help option through injected stdout', () => {
		const output = createCapturedCliOutput();

		const result = runOptiqueCliParser({
			argv: ['-h'],
			io: createCliIo(output),
			parser,
			programName: 'agent-vm-worker',
		});

		expect(result).toEqual({ kind: 'help', exitCode: 0 });
		expect(output.stdout.join('')).toContain('--port PORT');
		expect(output.stderr).toEqual([]);
	});

	it('coerces a worker port through the named repeated value parser', () => {
		const output = createCapturedCliOutput();

		const result = runOptiqueCliParser({
			argv: ['--mode', 'fast', '-p', '19123'],
			io: createCliIo(output),
			parser,
			programName: 'agent-vm-worker',
		});

		expect(result).toEqual({
			kind: 'parsed',
			value: { mode: 'fast', port: 19_123 },
		});
		expect(output.stdout).toEqual([]);
		expect(output.stderr).toEqual([]);
	});
});
