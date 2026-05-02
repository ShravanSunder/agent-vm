import { describe, expect, test } from 'vitest';

import {
	resolveGuestMountPath,
	validateRuntimeMountPolicy,
	validateWritableMount,
} from './mount-policy.js';

describe('mount-policy', () => {
	test('resolveGuestMountPath keeps absolute paths and resolves relative paths from the working directory', () => {
		expect(resolveGuestMountPath('/state', '/work/project')).toBe('/state');
		expect(resolveGuestMountPath('./state', '/work/project')).toBe('/work/project/state');
		expect(resolveGuestMountPath('logs', '/work/project')).toBe('/work/project/logs');
	});

	test('validateWritableMount rejects guest paths outside the allowlist', () => {
		expect(() =>
			validateWritableMount(
				'/etc',
				{
					allowAuthWrite: false,
					writableAllowedGuestPrefixes: ['/work'],
				},
				{ workDir: '/work/project' },
			),
		).toThrow(/outside writable allowlist/);
	});

	test('validateWritableMount blocks auth directories unless auth writes are enabled', () => {
		expect(() =>
			validateWritableMount(
				'/home/agent/.claude/session',
				{
					allowAuthWrite: false,
					writableAllowedGuestPrefixes: ['/home/agent/.claude', '/work'],
				},
				{ workDir: '/work/project' },
			),
		).toThrow(/auth mount path/);
	});

	test('validateRuntimeMountPolicy blocks writable host mounts that overlap protected auth directories', async () => {
		await expect(
			validateRuntimeMountPolicy(
				{
					extraMounts: {
						'/work/config': '/Users/example/.claude',
					},
					mountControls: {
						allowAuthWrite: false,
						writableAllowedGuestPrefixes: ['/work'],
					},
				},
				{
					workDir: '/work/project',
					hostHome: '/Users/example',
				},
			),
		).rejects.toThrow(/auth host directory/);
	});
});
