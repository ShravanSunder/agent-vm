import type { ManagedVm } from '@agent-vm/managed-vm';
import type { SecretResolver } from '@agent-vm/secret-management';
import { describe, expect, it, vi } from 'vitest';

import {
	CredentialedRuntimeCredentialRoot,
	materializeCredentialFiles,
} from './credential-file-materializer.js';
import type { CredentialedRuntimeResolution } from './credentialed-runtime-registry.js';

function resolution(): CredentialedRuntimeResolution {
	return {
		agentRuntimeRevision: 'sha256:agent-runtime',
		agentId: 'sun',
		cohortRevision: 'binding:current',
		projection: {
			credentialBinding: {
				files: {
					'service-account': {
						ref: 'op://agent-vm-testing/google/sun',
						source: '1password',
					},
				},
			},
			credentialEnvironment: {
				GOG_DATA_DIR: { kind: 'credential_root' },
				GOOGLE_APPLICATION_CREDENTIALS: {
					kind: 'credential_file',
					source: 'service-account',
				},
			},
			fileMappings: [{ path: 'sa-c3VuQGV4YW1wbGUuY29t.json', source: 'service-account' }],
			kind: 'file_binding',
		},
		namespaceId: 'google',
		operation: {
			calls: { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' },
			commands: [{ flagRules: [], path: ['calendar', 'list'] }],
			deniedPatterns: [],
			executablePath: '/usr/local/bin/gog',
			executionTarget: {
				allowedHosts: [],
				credentialProjection: {
					credentialBinding: 'google',
					credentialEnvironment: { GOG_DATA_DIR: { kind: 'credential_root' } },
					credentialFiles: [{ path: 'sa-c3VuQGV4YW1wbGUuY29t.json', source: 'service-account' }],
					kind: 'file_binding',
				},
				environment: { kind: 'empty' },
				guestCwd: '/work',
				imageReference:
					'agent-vm-prepared-image:v1:eyJmaW5nZXJwcmludCI6InNoYTI1NjppbWFnZSIsImltYWdlUmVmZXJlbmNlIjoiL2ltYWdlcy9nb2ciLCJzY2hlbWFWZXJzaW9uIjoxfQ',
				kind: 'ephemeral_managed_vm',
			},
			kind: 'configured_cli',
			mandatoryArgvPrefix: [],
			output: {
				modelVisibleStderr: 'none',
				overflow: 'truncate',
				stderrMaxBytes: 1024,
				stdoutMaxBytes: 1024,
			},
			safeHelp: 'List calendar events.',
			stdin: { kind: 'none' },
			timeout: { kind: 'quick' },
		},
		operationName: 'calendar_list',
		profileId: 'google-enabled',
		zoneId: 'zone-a',
	};
}

function materializationFixture(value: string): {
	readonly finalizeMemoryMount: ReturnType<typeof vi.fn>;
	readonly resolveAll: ReturnType<typeof vi.fn>;
	readonly secretResolver: SecretResolver;
	readonly vm: ManagedVm;
} {
	const finalizeMemoryMount = vi.fn(async () => {});
	const resolveAll = vi.fn(async () => ({ 'service-account': value }));
	return {
		finalizeMemoryMount,
		resolveAll,
		secretResolver: {
			resolve: vi.fn(async () => value),
			resolveAll,
		},
		vm: { finalizeMemoryMount } as unknown as ManagedVm,
	};
}

describe('credential file materializer', () => {
	it('resolves once, finalizes exact mode-0600 files, and returns only guest paths', async () => {
		const fixture = materializationFixture('{"type":"service_account"}');
		const result = await materializeCredentialFiles({
			resolution: resolution(),
			secretResolver: fixture.secretResolver,
			vm: fixture.vm,
		});

		expect(fixture.resolveAll).toHaveBeenCalledOnce();
		expect(fixture.finalizeMemoryMount).toHaveBeenCalledWith({
			files: [
				{
					contents: new TextEncoder().encode('{"type":"service_account"}'),
					mode: 0o600,
					relativePath: 'sa-c3VuQGV4YW1wbGUuY29t.json',
				},
			],
			guestPath: CredentialedRuntimeCredentialRoot,
		});
		expect(result.environment).toEqual({
			GOG_DATA_DIR: CredentialedRuntimeCredentialRoot,
			GOOGLE_APPLICATION_CREDENTIALS: `${CredentialedRuntimeCredentialRoot}/sa-c3VuQGV4YW1wbGUuY29t.json`,
		});
		expect(JSON.stringify(result)).not.toContain('service_account');
	});

	it.each([
		['missing value', {}],
		['unexpected value', { 'service-account': '{}', unexpected: '{}' }],
	])('rejects a %s without finalizing', async (_caseName, values) => {
		const fixture = materializationFixture('{}');
		fixture.secretResolver.resolveAll = vi.fn(async () => values);
		await expect(
			materializeCredentialFiles({
				resolution: resolution(),
				secretResolver: fixture.secretResolver,
				vm: fixture.vm,
			}),
		).rejects.toThrow('credential materialization');
		expect(fixture.finalizeMemoryMount).not.toHaveBeenCalled();
	});

	it('rejects per-file and total byte overflow without including values in errors', async () => {
		for (const value of ['x'.repeat(1_048_577), '🙂'.repeat(262_145)]) {
			const fixture = materializationFixture(value);
			let observedError: unknown;
			try {
				// oxlint-disable-next-line no-await-in-loop -- each independent overflow case records its own error
				await materializeCredentialFiles({
					resolution: resolution(),
					secretResolver: fixture.secretResolver,
					vm: fixture.vm,
				});
			} catch (error) {
				observedError = error;
			}
			expect(observedError).toBeInstanceOf(Error);
			expect(String(observedError)).not.toContain(value.slice(0, 64));
			expect(fixture.finalizeMemoryMount).not.toHaveBeenCalled();
		}
	});

	it('fails closed when finalizable memory is unavailable', async () => {
		const fixture = materializationFixture('{}');
		await expect(
			materializeCredentialFiles({
				resolution: resolution(),
				secretResolver: fixture.secretResolver,
				vm: {} as ManagedVm,
			}),
		).rejects.toThrow('finalizable memory');
	});
});
