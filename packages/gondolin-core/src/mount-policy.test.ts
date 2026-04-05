import { describe, expect, test } from 'vitest';

import {
	resolveGuestMountPath,
	validateRuntimeMountPolicy,
	validateWritableMount,
} from './mount-policy.js';

describe('mount-policy', () => {
	test('resolveGuestMountPath keeps absolute paths and resolves relative paths from the workspace root', () => {
		expect(resolveGuestMountPath('/state', '/workspace/project')).toBe('/state');
		expect(resolveGuestMountPath('./state', '/workspace/project')).toBe('/workspace/project/state');
		expect(resolveGuestMountPath('logs', '/workspace/project')).toBe('/workspace/project/logs');
	});

	test('validateWritableMount rejects guest paths outside the allowlist', () => {
		expect(() =>
			validateWritableMount(
				'/etc',
				{
					allowAuthWrite: false,
					writableAllowedGuestPrefixes: ['/workspace'],
				},
				{ workDir: '/workspace/project' },
			),
		).toThrow(/outside writable allowlist/);
	});

	test('validateWritableMount blocks auth directories unless auth writes are enabled', () => {
		expect(() =>
			validateWritableMount(
				'/home/agent/.claude/session',
				{
					allowAuthWrite: false,
					writableAllowedGuestPrefixes: ['/home/agent/.claude', '/workspace'],
				},
				{ workDir: '/workspace/project' },
			),
		).toThrow(/auth mount path/);
	});

	test('validateRuntimeMountPolicy blocks writable host mounts that overlap protected auth directories', () => {
		expect(() =>
			validateRuntimeMountPolicy(
				{
					extraMounts: {
						'/workspace/config': '/Users/example/.claude',
					},
					mountControls: {
						allowAuthWrite: false,
						writableAllowedGuestPrefixes: ['/workspace'],
					},
				},
				{
					workDir: '/workspace/project',
					hostHome: '/Users/example',
				},
			),
		).toThrow(/auth host directory/);
	});
});
