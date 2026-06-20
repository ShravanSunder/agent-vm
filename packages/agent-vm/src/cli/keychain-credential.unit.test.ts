import { describe, expect, it, vi } from 'vitest';

import {
	getKeychainTokenSource,
	hasServiceAccountToken,
	storeServiceAccountToken,
} from './keychain-credential.js';

describe('Keychain service account credentials', () => {
	it('uses the legacy service account entry by default', () => {
		expect(getKeychainTokenSource()).toEqual({
			type: 'keychain',
			service: 'agent-vm',
			account: '1p-service-account',
		});
	});

	it('derives isolated service account entries from a configured account name', () => {
		expect(getKeychainTokenSource({ accountName: 'shravan-claw-beta' })).toEqual({
			type: 'keychain',
			service: 'agent-vm',
			account: '1p-service-account--shravan-claw-beta',
		});
	});

	it('checks for tokens using the configured Keychain account', () => {
		const execFileSync = vi.fn(() => 'stored-token');

		expect(hasServiceAccountToken({ accountName: 'shravan-claw', execFileSync })).toBe(true);

		expect(execFileSync).toHaveBeenCalledWith('/usr/bin/security', [
			'find-generic-password',
			'-s',
			'agent-vm',
			'-a',
			'1p-service-account--shravan-claw',
			'-w',
		]);
	});

	it('stores tokens using the configured Keychain account without placing tokens in argv', () => {
		const spawnSync = vi.fn(
			(
				_command: string,
				_args: readonly string[],
				_options: { readonly encoding: 'utf8'; readonly input: string },
			) => ({ status: 0, stderr: '', stdout: '' }),
		);

		storeServiceAccountToken('service-account-token', {
			accountName: 'shravan-claw',
			spawnSync,
		});

		expect(spawnSync).toHaveBeenCalledWith(
			'/usr/bin/security',
			[
				'add-generic-password',
				'-s',
				'agent-vm',
				'-a',
				'1p-service-account--shravan-claw',
				'-U',
				'-w',
			],
			{
				encoding: 'utf8',
				input: 'service-account-token',
			},
		);
		const args = spawnSync.mock.calls[0]?.[1] ?? [];
		expect(args).not.toContain('service-account-token');
	});

	it('rejects unsafe configured account names before invoking security', () => {
		const execFileSync = vi.fn(() => '');

		expect(() => getKeychainTokenSource({ accountName: 'bad/name' })).toThrow(
			'Invalid 1Password Keychain account name',
		);
		expect(() =>
			storeServiceAccountToken('service-account-token', {
				accountName: 'bad/name',
				execFileSync,
			}),
		).toThrow('Invalid 1Password Keychain account name');
		expect(execFileSync).not.toHaveBeenCalled();
	});

	it('redacts token content from Keychain write failures', () => {
		const spawnSync = vi.fn(
			(
				_command: string,
				_args: readonly string[],
				_options: { readonly encoding: 'utf8'; readonly input: string },
			) => ({
				status: 1,
				stderr: 'security failed while storing service-account-token',
				stdout: '',
			}),
		);

		expect(() =>
			storeServiceAccountToken('service-account-token', {
				accountName: 'shravan-claw',
				spawnSync,
			}),
		).toThrow('Failed to store 1Password service account token in macOS Keychain.');
		expect(() =>
			storeServiceAccountToken('service-account-token', {
				accountName: 'shravan-claw',
				spawnSync,
			}),
		).not.toThrow('service-account-token');
	});
});
