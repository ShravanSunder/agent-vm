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
			credentialProjection: {
				credentialBinding: 'google',
				credentialEnvironment: {
					[options.environmentName ?? 'GOG_DATA_DIR']: { kind: 'credential_root' },
				},
				credentialFiles: [{ path: 'sa-c3VuQGV4YW1wbGUuY29t.json', source: 'service-account' }],
				kind: 'file_binding',
			},
			environment: { kind: 'empty' },
			guestCwd: '/work',
			imageReference: encodeConfiguredCliPreparedImageIdentity({
				fingerprint: 'sha256:gog-image',
				imageReference: '/images/gog',
				schemaVersion: 1,
			}),
			kind: 'ephemeral_managed_vm',
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
		const projection = resolveSunCalendar(compiled).projection;
		if (projection.kind !== 'file_binding') throw new Error('Expected file binding.');
		expect(projection.credentialBinding.files['service-account']?.ref).toBe(
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
		expect(gmail.agentRuntimeRevision).toBe(calendar.agentRuntimeRevision);
		expect(moon.agentRuntimeRevision).not.toBe(calendar.agentRuntimeRevision);
	});

	it('canonicalizes equivalent file mappings independently of authored order', () => {
		const config = preparedConfig();
		for (const agent of Object.values(config.agents)) {
			const binding = agent.credentialBindings?.google;
			if (binding === undefined) throw new Error('Missing Google binding.');
			binding.files.client = {
				ref: `op://agent-vm-testing/google/${agent === config.agents.sun ? 'sun' : 'moon'}-client`,
				source: '1password',
			};
		}
		const operations =
			config.profiles['google-enabled']?.namespaces.google?.backend.kind === 'controller_execution'
				? config.profiles['google-enabled'].namespaces.google.backend.operations
				: undefined;
		if (operations === undefined) throw new Error('Missing configured operations.');
		const calendar = operations.calendar_list;
		const gmail = operations.gmail_search;
		if (
			calendar?.kind !== 'configured_cli' ||
			gmail?.kind !== 'configured_cli' ||
			calendar.executionTarget.kind !== 'ephemeral_managed_vm' ||
			gmail.executionTarget.kind !== 'ephemeral_managed_vm' ||
			calendar.executionTarget.credentialProjection.kind !== 'file_binding' ||
			gmail.executionTarget.credentialProjection.kind !== 'file_binding'
		) {
			throw new Error('Missing file-backed Managed VM operations.');
		}
		const mappings = [
			{ path: 'client.json', source: 'client' },
			{ path: 'service-account.json', source: 'service-account' },
		];
		calendar.executionTarget.credentialProjection.credentialFiles = mappings;
		gmail.executionTarget.credentialProjection.credentialFiles = mappings.toReversed();

		const compiled = compileCredentialedRuntimeConfig({ preparedConfig: config, zoneId: 'zone-a' });
		const calendarResolution = resolveSunCalendar(compiled);
		const gmailResolution = compiled.registrySnapshot.resolve({
			agentId: 'sun',
			cohortRevision: compiled.registrySnapshot.cohortRevision,
			namespaceId: 'google',
			operationName: 'gmail_search',
			profileId: 'google-enabled',
		});
		expect(gmailResolution.agentRuntimeRevision).toBe(calendarResolution.agentRuntimeRevision);
	});

	it('canonicalizes equivalent mediated host sets independently of authored order', () => {
		const config = preparedConfig();
		const operations =
			config.profiles['google-enabled']?.namespaces.google?.backend.kind === 'controller_execution'
				? config.profiles['google-enabled'].namespaces.google.backend.operations
				: undefined;
		if (operations === undefined) throw new Error('Missing configured operations.');
		for (const [operationName, operation] of Object.entries(operations)) {
			if (
				operation.kind !== 'configured_cli' ||
				operation.executionTarget.kind !== 'ephemeral_managed_vm'
			) {
				throw new Error('Missing configured Managed VM operation.');
			}
			operation.executionTarget.allowedHosts = ['oauth2.googleapis.com', 'www.googleapis.com'];
			operation.executionTarget.credentialProjection = {
				environment: {
					GOOGLE_ACCESS_TOKEN: {
						hosts:
							operationName === 'calendar_list'
								? ['www.googleapis.com', 'oauth2.googleapis.com']
								: ['oauth2.googleapis.com', 'www.googleapis.com'],
						secret: { name: 'GOOGLE_ACCESS_TOKEN', source: 'environment' },
					},
				},
				kind: 'http_mediation',
			};
		}

		const compiled = compileCredentialedRuntimeConfig({ preparedConfig: config, zoneId: 'zone-a' });
		const calendarResolution = resolveSunCalendar(compiled);
		const gmailResolution = compiled.registrySnapshot.resolve({
			agentId: 'sun',
			cohortRevision: compiled.registrySnapshot.cohortRevision,
			namespaceId: 'google',
			operationName: 'gmail_search',
			profileId: 'google-enabled',
		});
		expect(gmailResolution.agentRuntimeRevision).toBe(calendarResolution.agentRuntimeRevision);
	});

	it('canonicalizes equivalent allowed-host and inherited-environment sets', () => {
		const config = preparedConfig();
		const operations =
			config.profiles['google-enabled']?.namespaces.google?.backend.kind === 'controller_execution'
				? config.profiles['google-enabled'].namespaces.google.backend.operations
				: undefined;
		if (operations === undefined) throw new Error('Missing configured operations.');
		const calendar = operations.calendar_list;
		const gmail = operations.gmail_search;
		if (
			calendar?.kind !== 'configured_cli' ||
			gmail?.kind !== 'configured_cli' ||
			calendar.executionTarget.kind !== 'ephemeral_managed_vm' ||
			gmail.executionTarget.kind !== 'ephemeral_managed_vm'
		) {
			throw new Error('Missing configured Managed VM operations.');
		}
		calendar.executionTarget.allowedHosts = ['www.googleapis.com', 'www.googleapis.com'];
		gmail.executionTarget.allowedHosts = ['www.googleapis.com'];
		calendar.executionTarget.environment = {
			kind: 'inherit_allowlist',
			names: ['PATH', 'HOME', 'PATH'],
		};
		gmail.executionTarget.environment = {
			kind: 'inherit_allowlist',
			names: ['HOME', 'PATH'],
		};

		const compiled = compileCredentialedRuntimeConfig({ preparedConfig: config, zoneId: 'zone-a' });
		const calendarResolution = resolveSunCalendar(compiled);
		const gmailResolution = compiled.registrySnapshot.resolve({
			agentId: 'sun',
			cohortRevision: compiled.registrySnapshot.cohortRevision,
			namespaceId: 'google',
			operationName: 'gmail_search',
			profileId: 'google-enabled',
		});
		expect(gmailResolution.agentRuntimeRevision).toBe(calendarResolution.agentRuntimeRevision);
	});

	it('retains mediated secret refs only in the controller projection', () => {
		const config = preparedConfig();
		const namespace = config.profiles['google-enabled']?.namespaces.google;
		if (namespace?.backend.kind !== 'controller_execution') {
			throw new Error('Missing controller execution namespace.');
		}
		for (const operation of Object.values(namespace.backend.operations)) {
			if (
				operation.kind !== 'configured_cli' ||
				operation.executionTarget.kind !== 'ephemeral_managed_vm'
			) {
				throw new Error('Missing configured Managed VM operation.');
			}
			operation.executionTarget.credentialProjection = {
				environment: {
					GOOGLE_PLACES_API_KEY: {
						hosts: ['www.googleapis.com'],
						secret: {
							ref: 'op://agent-vm-testing/google/places',
							source: '1password',
						},
					},
				},
				kind: 'http_mediation',
			};
		}
		const compiled = compileCredentialedRuntimeConfig({ preparedConfig: config, zoneId: 'zone-a' });
		const projection = resolveSunCalendar(compiled).projection;
		if (projection.kind !== 'http_mediation') throw new Error('Expected HTTP mediation.');
		expect(projection.environment.GOOGLE_PLACES_API_KEY?.secret).toEqual({
			ref: 'op://agent-vm-testing/google/places',
			source: '1password',
		});
		expect(JSON.stringify(compiled.effectiveToolPortalConfig)).not.toContain('google/places');
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
		expect(resolveSunCalendar(second).agentRuntimeRevision).toBe(
			resolveSunCalendar(first).agentRuntimeRevision,
		);
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
		const projection = operation.executionTarget.credentialProjection;
		if (projection.kind !== 'file_binding') throw new Error('Expected file binding.');
		projection.credentialEnvironment = {
			GOOGLE_APPLICATION_CREDENTIALS: {
				kind: 'credential_file',
				source: 'service-account',
			},
		};
		expect(() =>
			compileCredentialedRuntimeConfig({ preparedConfig: config, zoneId: 'zone-a' }),
		).toThrow('conflicting VM-shaping policy');
	});

	it('excludes unreachable operations from singleton compatibility and registry authority', () => {
		const config = preparedConfig();
		const namespace = config.profiles['google-enabled']?.namespaces.google;
		if (namespace?.backend.kind !== 'controller_execution') {
			throw new Error('Missing controller execution namespace.');
		}
		const hiddenOperation = namespace.backend.operations.gmail_search;
		if (
			hiddenOperation?.kind !== 'configured_cli' ||
			hiddenOperation.executionTarget.kind !== 'ephemeral_managed_vm'
		) {
			throw new Error('Missing credentialed operation.');
		}
		hiddenOperation.executionTarget.allowedHosts = ['incompatible.example.com'];
		if (namespace.tools.allow === '*') throw new Error('Expected explicit tool selector.');
		namespace.tools.allow = namespace.tools.allow.filter((name) => name !== 'gmail_search');
		if (namespace.calls.withoutApproval.allow === '*') {
			throw new Error('Expected explicit call selector.');
		}
		namespace.calls.withoutApproval.allow = namespace.calls.withoutApproval.allow.filter(
			(name) => name !== 'gmail_search',
		);

		const compiled = compileCredentialedRuntimeConfig({ preparedConfig: config, zoneId: 'zone-a' });
		expect(() =>
			compiled.registrySnapshot.resolve({
				agentId: 'sun',
				cohortRevision: compiled.registrySnapshot.cohortRevision,
				namespaceId: 'google',
				operationName: 'gmail_search',
				profileId: 'google-enabled',
			}),
		).toThrow('denied');
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
