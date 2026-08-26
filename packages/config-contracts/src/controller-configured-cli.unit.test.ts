import { describe, expect, it } from 'vitest';

import { configuredCliExecutionTargetSchema } from './controller-configured-cli.js';

function validCredentialedTarget(): unknown {
	return {
		allowedHosts: ['oauth2.googleapis.com'],
		credentialBinding: 'google',
		credentialEnvironment: {
			GOG_DATA_DIR: { kind: 'credential_root' },
			GOOGLE_APPLICATION_CREDENTIALS: {
				kind: 'credential_file',
				source: 'service-account',
			},
		},
		credentialFiles: [
			{
				path: 'sa-c3VuQGV4YW1wbGUuY29t.json',
				source: 'service-account',
			},
		],
		environment: { kind: 'empty' },
		guestCwd: '/work',
		imageReference: '../../vm-images/controller-runners/gog/build-config.json',
		kind: 'ephemeral_managed_vm',
		runtimeId: 'google-workspace',
	};
}

describe('credentialed configured CLI target contract', () => {
	it('accepts bounded credential files and controller-authored path environment', () => {
		expect(configuredCliExecutionTargetSchema.safeParse(validCredentialedTarget()).success).toBe(
			true,
		);
	});

	it('hard-cuts the legacy uncredentialed one-shot target', () => {
		const target = validCredentialedTarget() as Record<string, unknown>;
		for (const fieldName of [
			'credentialBinding',
			'credentialEnvironment',
			'credentialFiles',
			'runtimeId',
		] as const) {
			const { [fieldName]: _removed, ...withoutField } = target;
			expect(configuredCliExecutionTargetSchema.safeParse(withoutField).success).toBe(false);
		}
	});

	it.each([
		['absolute path', '/etc/google.json'],
		['traversal', '../google.json'],
		['dot segment', 'keys/./google.json'],
		['empty segment', 'keys//google.json'],
		['control character', 'keys/google\n.json'],
	])('rejects unsafe credential file %s', (_caseName, path) => {
		const target = validCredentialedTarget() as Record<string, unknown>;
		expect(
			configuredCliExecutionTargetSchema.safeParse({
				...target,
				credentialFiles: [{ path, source: 'service-account' }],
			}).success,
		).toBe(false);
	});

	it('rejects duplicate sources and destinations', () => {
		const target = validCredentialedTarget() as Record<string, unknown>;
		for (const duplicate of [
			[
				{ path: 'first.json', source: 'service-account' },
				{ path: 'second.json', source: 'service-account' },
			],
			[
				{ path: 'same.json', source: 'service-account' },
				{ path: 'same.json', source: 'secondary' },
			],
		]) {
			expect(
				configuredCliExecutionTargetSchema.safeParse({
					...target,
					credentialFiles: duplicate,
				}).success,
			).toBe(false);
		}
	});

	it('rejects unknown credential-file environment sources and ordinary environment collisions', () => {
		const target = validCredentialedTarget() as Record<string, unknown>;
		expect(
			configuredCliExecutionTargetSchema.safeParse({
				...target,
				credentialEnvironment: {
					GOOGLE_APPLICATION_CREDENTIALS: {
						kind: 'credential_file',
						source: 'missing',
					},
				},
			}).success,
		).toBe(false);
		expect(
			configuredCliExecutionTargetSchema.safeParse({
				...target,
				environment: { kind: 'inherit_allowlist', names: ['GOG_DATA_DIR'] },
			}).success,
		).toBe(false);
	});

	it('rejects excess file and environment counts', () => {
		const target = validCredentialedTarget() as Record<string, unknown>;
		const credentialFiles = Array.from({ length: 17 }, (_, index) => ({
			path: `file-${String(index)}.json`,
			source: `source-${String(index)}`,
		}));
		const credentialEnvironment = Object.fromEntries(
			credentialFiles.map((file, index) => [
				`CREDENTIAL_${String(index)}`,
				{ kind: 'credential_file', source: file.source },
			]),
		);
		expect(
			configuredCliExecutionTargetSchema.safeParse({
				...target,
				credentialEnvironment,
				credentialFiles,
			}).success,
		).toBe(false);
	});
});
