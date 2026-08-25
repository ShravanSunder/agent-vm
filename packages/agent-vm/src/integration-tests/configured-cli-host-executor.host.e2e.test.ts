import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ControllerExecutionOperation } from '@agent-vm/config-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeConfiguredCliOnControllerHost } from '../controller/runner/configured-cli-host-executor.js';

const fixtureProgram = String.raw`
import json
import os
import sys
print(json.dumps({
    "argv": sys.argv[1:],
    "cwd": os.getcwd(),
    "inheritedValue": os.environ.get("AGENT_VM_HOST_E2E_ALLOWED"),
    "forbiddenValue": os.environ.get("AGENT_VM_HOST_E2E_FORBIDDEN"),
    "stdin": sys.stdin.read(),
}), end="")
`;

let testRoot: string;

beforeEach(async () => {
	testRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-configured-cli-host-'));
});

afterEach(async () => {
	delete process.env.AGENT_VM_HOST_E2E_ALLOWED;
	delete process.env.AGENT_VM_HOST_E2E_FORBIDDEN;
	await rm(testRoot, { force: true, recursive: true });
});

describe('configured CLI controller-host production executor', () => {
	it('preserves argv, stdin, cwd, and allowlisted environment without invoking a shell', async () => {
		process.env.AGENT_VM_HOST_E2E_ALLOWED = 'allowed-value';
		process.env.AGENT_VM_HOST_E2E_FORBIDDEN = 'must-not-leak';
		const shellSentinelPath = path.join(testRoot, 'shell-sentinel');
		const shellLikeToken = `; touch ${shellSentinelPath}`;
		const operation = {
			calls: { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' },
			commands: [{ flagRules: [], path: ['inspect'] }],
			deniedPatterns: [],
			executablePath: '/usr/bin/python3',
			executionTarget: {
				cwd: testRoot,
				environment: { kind: 'inherit_allowlist', names: ['AGENT_VM_HOST_E2E_ALLOWED'] },
				kind: 'controller_host',
			},
			kind: 'configured_cli',
			mandatoryArgvPrefix: ['-c', fixtureProgram],
			output: {
				modelVisibleStderr: 'none',
				overflow: 'fail',
				stderrMaxBytes: 4096,
				stdoutMaxBytes: 4096,
			},
			safeHelp: 'Execute the permanent host transcript fixture.',
			stdin: { deniedPatterns: [], kind: 'bounded_text', maxBytes: 1024 },
			timeout: { kind: 'quick' },
		} as const satisfies Extract<ControllerExecutionOperation, { kind: 'configured_cli' }>;
		const authorization = {
			evaluation: {
				authorityKind: 'without_approval',
				bindingRevision: 'binding:host-e2e',
				disposition: 'without_approval',
				fingerprint: `sha256:${'a'.repeat(64)}`,
				operationId: '11111111-1111-4111-8111-111111111111',
				operationName: 'inspect',
				targetKind: 'controller_host',
			},
			operation,
		} as const;

		const result = await executeConfiguredCliOnControllerHost({
			authorization,
			input: {
				argv: ['inspect', 'literal argument', shellLikeToken],
				reason: 'host e2e transcript',
				stdin: 'fixture stdin',
			},
			operation,
			reloadAuthorization: async () => authorization,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderrTruncated).toBe(false);
		expect(result.stdoutTruncated).toBe(false);
		expect(JSON.parse(result.stdout)).toEqual({
			argv: ['inspect', 'literal argument', shellLikeToken],
			cwd: await realpath(testRoot),
			forbiddenValue: null,
			inheritedValue: 'allowed-value',
			stdin: 'fixture stdin',
		});
		await expect(access(shellSentinelPath)).rejects.toThrow();
	});
});
