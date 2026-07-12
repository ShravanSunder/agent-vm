import { describe, expect, it } from 'vitest';

import {
	ControllerDispatchIntentSchema,
	ControllerHostActionRequestSchema,
	ManagedVmArtifactReadRequestSchema,
	ManagedVmExecRequestSchema,
} from './index.js';

const validTrustedScope = {
	agentId: 'agent-a',
	profileId: 'code-builder',
};

const validDispatchIntent = {
	auditCorrelationId: 'audit-1',
	canonicalArguments: { title: 'Fix deploy' },
	capability: { name: 'create_issue', namespace: 'github' },
	trustedScope: validTrustedScope,
};

describe('controller execution contracts', () => {
	it('rejects adapter-supplied execution authority in dispatch intent', () => {
		for (const forbiddenField of [
			'executablePath',
			'argv',
			'cwd',
			'env',
			'credentialMaterial',
			'credentialMountPath',
			'hostPath',
			'vmProfile',
			'egress',
			'shellCommand',
			'pty',
		]) {
			expect(
				ControllerDispatchIntentSchema.safeParse({
					...validDispatchIntent,
					[forbiddenField]: forbiddenField,
				}).success,
			).toBe(false);
		}
	});

	it('rejects legacy toolName capability references in dispatch intent', () => {
		expect(
			ControllerDispatchIntentSchema.safeParse({
				...validDispatchIntent,
				capability: { namespace: 'github', toolName: 'create_issue' },
			}).success,
		).toBe(false);
	});

	it('requires strict ManagedVm exec requests with no shell or PTY', () => {
		expect(
			ManagedVmExecRequestSchema.parse({
				abortSignalId: 'abort-1',
				argv: ['issue', 'list'],
				cwd: { kind: 'workspace_root' },
				env: {},
				executablePath: '/usr/local/bin/gh',
				pty: false,
				shellMode: 'none',
				stderr: 'stream',
				stderrMaxBytes: 1024,
				stdout: 'stream',
				stdoutMaxBytes: 2048,
				timeoutMs: 1_000,
			}),
		).toMatchObject({ executablePath: '/usr/local/bin/gh', shellMode: 'none' });

		expect(
			ManagedVmExecRequestSchema.safeParse({
				argv: [],
				command: 'gh issue list',
				cwd: { kind: 'workspace_root' },
				env: {},
				executablePath: '/usr/local/bin/gh',
				pty: false,
				shellMode: 'none',
				stderr: 'stream',
				stderrMaxBytes: 1024,
				stdout: 'stream',
				stdoutMaxBytes: 2048,
				timeoutMs: 1_000,
			}).success,
		).toBe(false);

		expect(
			ManagedVmExecRequestSchema.safeParse({
				argv: [],
				cwd: { kind: 'workspace_root' },
				env: {},
				executablePath: '/usr/local/bin/gh',
				pty: true,
				shellMode: 'shell',
				stderr: 'stream',
				stderrMaxBytes: 1024,
				stdout: 'stream',
				stdoutMaxBytes: 2048,
				timeoutMs: 1_000,
			}).success,
		).toBe(false);

		for (const invalidRequest of [
			{ argv: Array.from({ length: 101 }, () => 'arg') },
			{ stdin: 'x'.repeat(1024 * 1024 + 1) },
			{ stdoutMaxBytes: 16 * 1024 * 1024 + 1 },
			{ stderrMaxBytes: 16 * 1024 * 1024 + 1 },
			{ timeoutMs: 8 * 60 * 60 * 1000 + 1 },
		]) {
			expect(
				ManagedVmExecRequestSchema.safeParse({
					argv: ['issue', 'list'],
					cwd: { kind: 'workspace_root' },
					env: {},
					executablePath: '/usr/local/bin/gh',
					pty: false,
					shellMode: 'none',
					stderr: 'stream',
					stderrMaxBytes: 1024,
					stdout: 'stream',
					stdoutMaxBytes: 2048,
					timeoutMs: 1_000,
					...invalidRequest,
				}).success,
			).toBe(false);
		}
	});

	it('caps ManagedVm artifact reads at the contract boundary', () => {
		expect(
			ManagedVmArtifactReadRequestSchema.parse({
				artifactId: 'artifact-1',
				maxBytes: 1024,
				noFollow: true,
			}),
		).toMatchObject({ artifactId: 'artifact-1' });

		expect(
			ManagedVmArtifactReadRequestSchema.safeParse({
				artifactId: 'artifact-1',
				maxBytes: 16 * 1024 * 1024 + 1,
				noFollow: true,
			}).success,
		).toBe(false);
	});

	it('does not allow host actions to become generic subprocess requests', () => {
		expect(
			ControllerHostActionRequestSchema.parse({
				canonicalArguments: { branch: 'feature-a' },
				dispatch: validDispatchIntent,
				hostActionName: 'git.push_branch',
			}),
		).toMatchObject({ hostActionName: 'git.push_branch' });

		expect(
			ControllerHostActionRequestSchema.safeParse({
				canonicalArguments: { branch: 'feature-a' },
				command: 'git push',
				dispatch: validDispatchIntent,
				hostActionName: 'git.push_branch',
			}).success,
		).toBe(false);
	});
});
