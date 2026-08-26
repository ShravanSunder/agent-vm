import {
	encodeConfiguredCliPreparedImageIdentity,
	preparedManagedToolPortalConfigSchema,
	type PreparedManagedToolPortalConfig,
} from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

import {
	compileCredentialedRuntimeConfig,
	createControllerCredentialedRuntimeRegistryPublisher,
} from './credentialed-runtime-registry.js';

function configuredOperation(options: {
	readonly environmentName?: string;
	readonly operationPath: string;
}): object {
	return {
		calls: { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' },
		commands: [{ path: options.operationPath.split(' ') }],
		deniedPatterns: [],
		executablePath: '/usr/local/bin/gog',
		executionTarget: {
			allowedHosts: ['www.googleapis.com'],
			credentialBinding: 'google',
			credentialEnvironment: {
				[options.environmentName ?? 'GOG_DATA_DIR']: { kind: 'credential_root' },
			},
			credentialFiles: [{ path: 'sa-c3VuQGV4YW1wbGUuY29t.json', source: 'service-account' }],
			environment: { kind: 'empty' },
			guestCwd: '/work',
			imageReference: encodeConfiguredCliPreparedImageIdentity({
				fingerprint: 'sha256:gog-image',
				imageReference: '/images/gog',
				schemaVersion: 1,
			}),
			kind: 'ephemeral_managed_vm',
			runtimeId: 'google-workspace',
		},
		kind: 'configured_cli',
		mandatoryArgvPrefix: [],
		output: {
			modelVisibleStderr: 'none',
			overflow: 'truncate',
			stderrMaxBytes: 4096,
			stdoutMaxBytes: 4096,
		},
		safeHelp: 'Use Gog with tokenized argv.',
		stdin: { kind: 'none' },
		timeout: { kind: 'quick' },
	};
}

function preparedConfig(): PreparedManagedToolPortalConfig {
	return preparedManagedToolPortalConfigSchema.parse({
		agents: {
			moon: {
				credentialBindings: {
					google: {
						files: {
							'service-account': {
								ref: 'op://agent-vm-testing/google/moon',
								source: '1password',
							},
						},
					},
				},
				profile: 'google-enabled',
			},
			sun: {
				credentialBindings: {
					google: {
						files: {
							'service-account': {
								ref: 'op://agent-vm-testing/google/sun',
								source: '1password',
							},
						},
					},
				},
				profile: 'google-enabled',
			},
		},
		mode: 'managed',
		profiles: {
			'google-enabled': {
				namespaces: {
					google: {
						backend: {
							kind: 'controller_execution',
							operations: {
								calendar_list: configuredOperation({ operationPath: 'calendar list' }),
								gmail_search: configuredOperation({ operationPath: 'gmail search' }),
							},
						},
						calls: {
							requiresApproval: { allow: [], deny: [] },
							withoutApproval: { allow: ['calendar_list', 'gmail_search'], deny: [] },
						},
						discovery: { summary: 'Google Workspace CLI operations.' },
						tools: { allow: ['calendar_list', 'gmail_search'], deny: [] },
					},
				},
			},
		},
		schemaVersion: 1,
	});
}

function resolveSunCalendar(
	compiled: ReturnType<typeof compileCredentialedRuntimeConfig>,
): ReturnType<ReturnType<typeof compileCredentialedRuntimeConfig>['registrySnapshot']['resolve']> {
	return compiled.registrySnapshot.resolve({
		agentId: 'sun',
		cohortRevision: compiled.registrySnapshot.cohortRevision,
		namespaceId: 'google',
		operationName: 'calendar_list',
		profileId: 'google-enabled',
	});
}

describe('credentialed runtime registry compiler', () => {
	it('projects a safe persisted cohort and retains refs only in the controller snapshot', () => {
		const compiled = compileCredentialedRuntimeConfig({
			preparedConfig: preparedConfig(),
			zoneId: 'zone-a',
		});
		const serializedSafeConfig = JSON.stringify(compiled.effectiveToolPortalConfig);
		for (const forbiddenValue of [
			'op://',
			'credentialBindings',
			'credentialFiles',
			'credentialEnvironment',
			'google-workspace',
			'sa-c3VuQGV4YW1wbGUuY29t.json',
		]) {
			expect(serializedSafeConfig).not.toContain(forbiddenValue);
		}
		expect(compiled.effectiveToolPortalConfig.credentialedRuntimeRevision).toMatch(/^sha256:/u);
		expect(resolveSunCalendar(compiled).credentialBinding.files['service-account']?.ref).toBe(
			'op://agent-vm-testing/google/sun',
		);
	});

	it('shares one group across compatible operations but separates agents', () => {
		const compiled = compileCredentialedRuntimeConfig({
			preparedConfig: preparedConfig(),
			zoneId: 'zone-a',
		});
		const calendar = resolveSunCalendar(compiled);
		const gmail = compiled.registrySnapshot.resolve({
			agentId: 'sun',
			cohortRevision: compiled.registrySnapshot.cohortRevision,
			namespaceId: 'google',
			operationName: 'gmail_search',
			profileId: 'google-enabled',
		});
		const moon = compiled.registrySnapshot.resolve({
			agentId: 'moon',
			cohortRevision: compiled.registrySnapshot.cohortRevision,
			namespaceId: 'google',
			operationName: 'calendar_list',
			profileId: 'google-enabled',
		});
		expect(gmail.groupRevision).toBe(calendar.groupRevision);
		expect(moon.groupRevision).not.toBe(calendar.groupRevision);
	});

	it('excludes per-call policy from group compatibility', () => {
		const firstConfig = preparedConfig();
		const secondConfig = structuredClone(firstConfig);
		const operation =
			secondConfig.profiles['google-enabled']?.namespaces.google?.backend.kind ===
			'controller_execution'
				? secondConfig.profiles['google-enabled'].namespaces.google.backend.operations.calendar_list
				: undefined;
		if (operation?.kind !== 'configured_cli') throw new Error('Missing configured operation.');
		operation.safeHelp = 'Changed per-call guidance.';
		const first = compileCredentialedRuntimeConfig({
			preparedConfig: firstConfig,
			zoneId: 'zone-a',
		});
		const second = compileCredentialedRuntimeConfig({
			preparedConfig: secondConfig,
			zoneId: 'zone-a',
		});
		expect(resolveSunCalendar(second).groupRevision).toBe(resolveSunCalendar(first).groupRevision);
		expect(second.registrySnapshot.cohortRevision).not.toBe(first.registrySnapshot.cohortRevision);
	});

	it('rejects conflicting operations in one authored runtime group', () => {
		const config = preparedConfig();
		const operation =
			config.profiles['google-enabled']?.namespaces.google?.backend.kind === 'controller_execution'
				? config.profiles['google-enabled'].namespaces.google.backend.operations.gmail_search
				: undefined;
		if (operation?.kind !== 'configured_cli') throw new Error('Missing configured operation.');
		if (operation.executionTarget.kind !== 'ephemeral_managed_vm') {
			throw new Error('Expected Managed VM operation.');
		}
		operation.executionTarget.credentialEnvironment = {
			GOOGLE_APPLICATION_CREDENTIALS: {
				kind: 'credential_file',
				source: 'service-account',
			},
		};
		expect(() =>
			compileCredentialedRuntimeConfig({ preparedConfig: config, zoneId: 'zone-a' }),
		).toThrow('conflicting runtime-shaping policy');
	});

	it('publishes, replaces, and withdraws exact per-zone cohorts', () => {
		const publisher = createControllerCredentialedRuntimeRegistryPublisher();
		const first = compileCredentialedRuntimeConfig({
			preparedConfig: preparedConfig(),
			zoneId: 'zone-a',
		});
		const secondConfig = preparedConfig();
		const operation =
			secondConfig.profiles['google-enabled']?.namespaces.google?.backend.kind ===
			'controller_execution'
				? secondConfig.profiles['google-enabled'].namespaces.google.backend.operations.calendar_list
				: undefined;
		if (operation?.kind !== 'configured_cli') throw new Error('Missing configured operation.');
		operation.safeHelp = 'A new safe cohort.';
		const second = compileCredentialedRuntimeConfig({
			preparedConfig: secondConfig,
			zoneId: 'zone-a',
		});

		publisher.activate(first.registrySnapshot);
		expect(() =>
			publisher.resolve({
				agentId: 'sun',
				cohortRevision: second.registrySnapshot.cohortRevision,
				namespaceId: 'google',
				operationName: 'calendar_list',
				profileId: 'google-enabled',
				zoneId: 'zone-a',
			}),
		).toThrow('stale');
		publisher.activate(second.registrySnapshot);
		expect(
			publisher.resolve({
				agentId: 'sun',
				cohortRevision: second.registrySnapshot.cohortRevision,
				namespaceId: 'google',
				operationName: 'calendar_list',
				profileId: 'google-enabled',
				zoneId: 'zone-a',
			}).cohortRevision,
		).toBe(second.registrySnapshot.cohortRevision);
		publisher.withdraw('zone-a');
		expect(() =>
			publisher.resolve({
				agentId: 'sun',
				cohortRevision: second.registrySnapshot.cohortRevision,
				namespaceId: 'google',
				operationName: 'calendar_list',
				profileId: 'google-enabled',
				zoneId: 'zone-a',
			}),
		).toThrow('unavailable');
	});
});
