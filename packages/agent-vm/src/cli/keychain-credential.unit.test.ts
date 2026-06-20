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

		expect(execFileSync).toHaveBeenCalledWith('security', [
			'find-generic-password',
			'-s',
			'agent-vm',
			'-a',
			'1p-service-account--shravan-claw',
			'-w',
		]);
	});

	it('stores tokens using the configured Keychain account', () => {
		const execFileSync = vi.fn(() => '');

		storeServiceAccountToken('service-account-token', {
			accountName: 'shravan-claw',
			execFileSync,
		});

		expect(execFileSync).toHaveBeenCalledWith('security', [
			'add-generic-password',
			'-s',
			'agent-vm',
			'-a',
			'1p-service-account--shravan-claw',
			'-w',
			'service-account-token',
			'-U',
		]);
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
		const execFileSync = vi.fn(() => {
			throw new Error('security failed while storing service-account-token');
		});

		expect(() =>
			storeServiceAccountToken('service-account-token', {
				accountName: 'shravan-claw',
				execFileSync,
			}),
		).toThrow('Failed to store 1Password service account token in macOS Keychain.');
		expect(() =>
			storeServiceAccountToken('service-account-token', {
				accountName: 'shravan-claw',
				execFileSync,
			}),
		).not.toThrow('service-account-token');
	});
});
