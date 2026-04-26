import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { resolveConfigPath } from './path-resolver.js';

describe('resolveConfigPath', () => {
	const configDir = '/repo/config';
	const homeDir = '/home/user';

	test('returns homeDir for the bare tilde', () => {
		expect(resolveConfigPath('~', configDir, homeDir)).toBe(homeDir);
	});

	test('expands ~/ to homeDir/...', () => {
		expect(resolveConfigPath('~/.agent-vm/state/shravan', configDir, homeDir)).toBe(
			path.join(homeDir, '.agent-vm/state/shravan'),
		);
	});

	test('passes absolute paths through unchanged', () => {
		expect(resolveConfigPath('/var/agent-vm/state', configDir, homeDir)).toBe(
			'/var/agent-vm/state',
		);
	});

	test('resolves relative paths against configDir', () => {
		expect(resolveConfigPath('../state/shravan', configDir, homeDir)).toBe(
			path.resolve(configDir, '../state/shravan'),
		);
	});

	test('does not expand a tilde mid-string (~user is not supported)', () => {
		// expandTilde + isAbsolute path: not absolute, so it resolves
		// against configDir. Captures the contract that we only handle
		// `~` and `~/...`, never `~user/...`.
		expect(resolveConfigPath('~user/x', configDir, homeDir)).toBe(
			path.resolve(configDir, '~user/x'),
		);
	});

	test('defaults homeDir to os.homedir() when not provided', () => {
		// Smoke check that the default parameter is wired.
		const result = resolveConfigPath('~/x', configDir);
		expect(result.endsWith(`${path.sep}x`)).toBe(true);
		expect(path.isAbsolute(result)).toBe(true);
	});
});
