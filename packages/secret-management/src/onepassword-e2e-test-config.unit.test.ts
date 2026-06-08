import { describe, expect, it } from 'vitest';

import {
	defaultOnePasswordE2eVaultPrefix,
	readOnePasswordE2eTestConfig,
} from './onepassword-e2e-test-config.js';

describe('readOnePasswordE2eTestConfig', () => {
	it('reads test service account token and comma-separated test vault refs', () => {
		const config = readOnePasswordE2eTestConfig({
			AGENT_VM_TEST_OP_REFS: 'op://agent-vm-testing/item/ref1, op://agent-vm-testing/item/ref2',
			AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN: 'test-service-account-token',
		});

		expect(config).toEqual({
			secretReferences: ['op://agent-vm-testing/item/ref1', 'op://agent-vm-testing/item/ref2'],
			serviceAccountToken: 'test-service-account-token',
			vaultPrefix: defaultOnePasswordE2eVaultPrefix,
		});
	});

	it('requires a test service account token', () => {
		expect(() =>
			readOnePasswordE2eTestConfig({
				AGENT_VM_TEST_OP_REFS: 'op://agent-vm-testing/item/ref1',
			}),
		).toThrow(/AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN/u);
	});

	it('requires explicit test refs', () => {
		expect(() =>
			readOnePasswordE2eTestConfig({
				AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN: 'test-service-account-token',
			}),
		).toThrow(/AGENT_VM_TEST_OP_REFS/u);
	});

	it('rejects non-op refs', () => {
		expect(() =>
			readOnePasswordE2eTestConfig({
				AGENT_VM_TEST_OP_REFS: 'not-an-op-ref',
				AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN: 'test-service-account-token',
			}),
		).toThrow(/op:\/\/ reference/u);
	});

	it('rejects refs outside the configured test vault prefix', () => {
		expect(() =>
			readOnePasswordE2eTestConfig({
				AGENT_VM_TEST_OP_REFS: 'op://agent-vm/deployment-secret/password',
				AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN: 'test-service-account-token',
			}),
		).toThrow(/avoid deployment vaults/u);
	});
});
