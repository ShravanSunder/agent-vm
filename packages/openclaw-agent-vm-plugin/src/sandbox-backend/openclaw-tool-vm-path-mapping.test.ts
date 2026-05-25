import { describe, expect, it } from 'vitest';

import {
	OpenClawToolVmPathIntentError,
	assertOpenClawToolVmPathIntent,
	resolveOpenClawToolVmPathIntent,
} from './openclaw-tool-vm-path-mapping.js';

describe('resolveOpenClawToolVmPathIntent', () => {
	it.each([
		{
			effectiveGuestCwd: '/workspace',
			hostEquivalentPath: '/zone/agents/beta',
			inputPath: '/zone/agents/beta',
			kind: 'host-workspace-root',
			leaseWorkMountDir: '/zone/agents/beta',
		},
		{
			effectiveGuestCwd: '/workspace/app',
			hostEquivalentPath: '/zone/agents/beta/app',
			inputPath: '/zone/agents/beta/app',
			kind: 'host-workspace-subpath',
			leaseWorkMountDir: '/zone/agents/beta',
		},
		{
			effectiveGuestCwd: '/workspace',
			hostEquivalentPath: '/zone/agents/beta',
			inputPath: '/workspace',
			kind: 'workspace-root',
			leaseWorkMountDir: '/zone/agents/beta',
		},
		{
			effectiveGuestCwd: '/workspace/app',
			hostEquivalentPath: '/zone/agents/beta/app',
			inputPath: '/workspace/app',
			kind: 'workspace-subpath',
			leaseWorkMountDir: '/zone/agents/beta',
		},
		{
			effectiveGuestCwd: '/work',
			inputPath: '/work',
			kind: 'scratch-root',
			leaseWorkMountDir: '/zone/agents/beta',
		},
		{
			effectiveGuestCwd: '/work/tmp',
			inputPath: '/work/tmp',
			kind: 'scratch-subpath',
			leaseWorkMountDir: '/zone/agents/beta',
		},
		{
			effectiveGuestCwd: '/workspace',
			hostEquivalentPath: '/home/openclaw/.openclaw/state/sandboxes/work',
			inputPath: '/home/openclaw/.openclaw/state/sandboxes/work',
			kind: 'openclaw-sandbox-path',
			leaseWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/work',
		},
		{
			effectiveGuestCwd: '/workspace/app',
			hostEquivalentPath: '/home/openclaw/.openclaw/state/sandboxes/work/app',
			inputPath: '/home/openclaw/.openclaw/state/sandboxes/work/app',
			kind: 'openclaw-sandbox-path',
			leaseWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/work',
		},
	])('projects $inputPath', ({ inputPath, ...expectedResolution }) => {
		expect(
			resolveOpenClawToolVmPathIntent({
				agentWorkspaceDir: '/zone/agents/beta',
				inputPath,
			}),
		).toEqual({
			ok: true,
			value: expectedResolution,
		});
	});

	it('rejects cross-agent host paths with guidance', () => {
		const result = resolveOpenClawToolVmPathIntent({
			agentWorkspaceDir: '/zone/agents/beta',
			inputPath: '/zone/agents/alpha/app',
		});

		expect(result).toMatchObject({
			error: {
				code: 'unknown-runtime-path',
				inputPath: '/zone/agents/alpha/app',
				retryGuidance:
					'Use one of the allowed path forms for openclaw-tool-vm executionCwd: /workspace[/subpath], /zone/agents/beta[/subpath], /work[/subpath], /home/openclaw/.openclaw/state/sandboxes/<child>.',
			},
			ok: false,
		});
	});

	it('rejects relative paths', () => {
		const result = resolveOpenClawToolVmPathIntent({
			agentWorkspaceDir: '/zone/agents/beta',
			inputPath: 'relative/path',
		});

		expect(result).toMatchObject({
			error: {
				code: 'path-not-absolute',
			},
			ok: false,
		});
	});

	it.each(['', '/', 'relative/workspace'])(
		'rejects invalid agent workspace root %s before translating input paths',
		(agentWorkspaceDir) => {
			const result = resolveOpenClawToolVmPathIntent({
				agentWorkspaceDir,
				inputPath: '/zone/agents/beta/app',
			});

			expect(result).toMatchObject({
				error: {
					code: 'invalid-runtime-root',
				},
				ok: false,
			});
		},
	);

	it('throws a structured error when asserting invalid path intent', () => {
		expect(() =>
			assertOpenClawToolVmPathIntent({
				agentWorkspaceDir: '/zone/agents/beta',
				inputPath: '/zone/agents/alpha/app',
			}),
		).toThrow(OpenClawToolVmPathIntentError);

		try {
			assertOpenClawToolVmPathIntent({
				agentWorkspaceDir: '/zone/agents/beta',
				inputPath: '/zone/agents/alpha/app',
			});
		} catch (error) {
			expect(error).toBeInstanceOf(OpenClawToolVmPathIntentError);
			if (!(error instanceof OpenClawToolVmPathIntentError)) {
				throw error;
			}
			expect(error.details).toMatchObject({
				code: 'unknown-runtime-path',
				mappingId: 'openclaw-tool-vm',
				purpose: 'executionCwd',
			});
		}
	});
});
