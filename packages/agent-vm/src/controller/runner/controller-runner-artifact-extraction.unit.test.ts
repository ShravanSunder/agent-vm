import { describe, expect, expectTypeOf, it } from 'vitest';

import {
	createFixedControllerRunnerArtifactExtraction,
	type ControllerRunnerArtifactExtractionRequest,
} from './controller-runner-artifact-extraction.js';

const controllerPolicy = {
	allowedArtifactIds: ['result-json', 'coverage-tar'],
	maxBytes: 4096,
	readTimeoutMs: 5000,
	runnerScratchRoot: '/run/agent-vm/runner-artifacts',
	stockReaderExecutablePath: '/usr/local/libexec/agent-vm-read-artifact',
} as const;

describe('fixed controller runner artifact extraction', () => {
	it('builds fixed direct argv and bounded output policy from controller authority', () => {
		const extraction = createFixedControllerRunnerArtifactExtraction({
			controllerPolicy,
			request: { artifactId: 'result-json' },
		});

		expect(extraction).toEqual({
			argv: [
				'/usr/local/libexec/agent-vm-read-artifact',
				'--root',
				'/run/agent-vm/runner-artifacts',
				'--artifact-id',
				'result-json',
			],
			artifactId: 'result-json',
			maxBytes: 4096,
			output: {
				stderr: { kind: 'discard' },
				stdout: { kind: 'pipe' },
				windowBytes: 4096,
			},
			readTimeoutMs: 5000,
		});
	});

	it.each([
		['executable', { artifactId: 'result-json', executablePath: '/bin/sh' }],
		['root', { artifactId: 'result-json', runnerScratchRoot: '/' }],
		['path', { artifactId: 'result-json', path: '../../etc/shadow' }],
		['command', { artifactId: 'result-json', command: 'cat /etc/shadow' }],
		['argv', { artifactId: 'result-json', argv: ['/bin/sh', '-c', 'id'] }],
		['byte bound', { artifactId: 'result-json', maxBytes: Number.MAX_SAFE_INTEGER }],
		['read deadline', { artifactId: 'result-json', readTimeoutMs: Number.MAX_SAFE_INTEGER }],
		[
			'output mode',
			{
				artifactId: 'result-json',
				output: { stderr: { kind: 'pipe' }, stdout: { kind: 'pipe' }, windowBytes: 1 },
			},
		],
	] as const)('rejects a public %s override', (_label, request) => {
		expect(() =>
			createFixedControllerRunnerArtifactExtraction({ controllerPolicy, request }),
		).toThrow(/strict validation/u);
	});

	it.each(['../../etc/shadow', '/absolute', 'unlisted', 'result json', ''])(
		'rejects the untrusted or unauthorized artifact id %j',
		(artifactId) => {
			expect(() =>
				createFixedControllerRunnerArtifactExtraction({
					controllerPolicy,
					request: { artifactId },
				}),
			).toThrow(/artifact/u);
		},
	);

	it.each([
		['zero byte bound', { ...controllerPolicy, maxBytes: 0 }],
		['fractional byte bound', { ...controllerPolicy, maxBytes: 1.5 }],
		['infinite byte bound', { ...controllerPolicy, maxBytes: Number.POSITIVE_INFINITY }],
		['zero deadline', { ...controllerPolicy, readTimeoutMs: 0 }],
		['fractional deadline', { ...controllerPolicy, readTimeoutMs: 1.5 }],
		['relative scratch root', { ...controllerPolicy, runnerScratchRoot: 'runner-artifacts' }],
		['root scratch directory', { ...controllerPolicy, runnerScratchRoot: '/' }],
		[
			'non-normalized scratch root',
			{ ...controllerPolicy, runnerScratchRoot: '/run/agent-vm/../runner-artifacts' },
		],
		[
			'relative stock reader',
			{ ...controllerPolicy, stockReaderExecutablePath: 'agent-vm-read-artifact' },
		],
		['root stock reader', { ...controllerPolicy, stockReaderExecutablePath: '/' }],
	] as const)('rejects invalid controller policy: %s', (_label, invalidPolicy) => {
		expect(() =>
			createFixedControllerRunnerArtifactExtraction({
				controllerPolicy: invalidPolicy,
				request: { artifactId: 'result-json' },
			}),
		).toThrow();
	});

	it('exposes no executable, root, path, command, or argv selector in the request contract', () => {
		expectTypeOf<ControllerRunnerArtifactExtractionRequest>().toHaveProperty('artifactId');
		expectTypeOf<ControllerRunnerArtifactExtractionRequest>().not.toHaveProperty('executablePath');
		expectTypeOf<ControllerRunnerArtifactExtractionRequest>().not.toHaveProperty(
			'runnerScratchRoot',
		);
		expectTypeOf<ControllerRunnerArtifactExtractionRequest>().not.toHaveProperty('path');
		expectTypeOf<ControllerRunnerArtifactExtractionRequest>().not.toHaveProperty('command');
		expectTypeOf<ControllerRunnerArtifactExtractionRequest>().not.toHaveProperty('argv');
		expectTypeOf<ControllerRunnerArtifactExtractionRequest>().not.toHaveProperty('maxBytes');
		expectTypeOf<ControllerRunnerArtifactExtractionRequest>().not.toHaveProperty('readTimeoutMs');
		expectTypeOf<ControllerRunnerArtifactExtractionRequest>().not.toHaveProperty('output');
	});
});
