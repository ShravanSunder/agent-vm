import { describe, expect, it } from 'vitest';

import {
	configuredCliExecutionTargetSchema,
	controllerConfiguredCliInputSchema,
	controllerConfiguredCliOperationSchema,
	controllerEnforcedConfiguredCliOperationSchema,
	oauthConfiguredCliInputSchema,
	quickConfiguredCliInputSchema,
} from './controller-configured-cli.js';

function validCredentialedTarget(): unknown {
	return {
		allowedHosts: ['oauth2.googleapis.com'],
		credentialProjection: {
			kind: 'file_binding',
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
		},
		environment: { kind: 'empty' },
		guestCwd: '/work',
		imageReference: '../../vm-images/controller-runners/gog/build-config.json',
		kind: 'ephemeral_managed_vm',
	};
}

function validMediatedTarget(): unknown {
	return {
		allowedHosts: ['places.googleapis.com'],
		credentialProjection: {
			environment: {
				GOOGLE_PLACES_API_KEY: {
					hosts: ['places.googleapis.com'],
					secret: { source: '1password', ref: 'op://agent-vm/google-places/credential' },
				},
			},
			kind: 'http_mediation',
		},
		environment: { kind: 'empty' },
		guestCwd: '/work',
		imageReference: '../../vm-images/controller-runners/google-tools/build-config.json',
		kind: 'ephemeral_managed_vm',
	};
}

function validOAuthMediatedTarget(): unknown {
	return {
		allowedHosts: ['gmail.googleapis.com'],
		credentialProjection: {
			environment: {
				GOG_ACCESS_TOKEN: { kind: 'oauth_access_token' },
			},
			kind: 'http_mediation',
		},
		environment: { kind: 'empty' },
		guestCwd: '/work',
		imageReference: '../../vm-images/controller-runners/gog/build-config.json',
		kind: 'ephemeral_managed_vm',
	};
}

function validOAuthConfiguredCliOperation(): unknown {
	return {
		authorization: {
			kind: 'oauth_account_profile',
			rules: [
				{
					match: { flags: [], path: ['gmail', 'search'] },
					requirement: {
						applicationId: 'gmail-app',
						kind: 'oauth',
						minimumPermission: 'read',
						serviceId: 'gmail',
					},
				},
				{
					match: { flags: [], path: ['help'] },
					requirement: { kind: 'no_oauth' },
				},
			],
		},
		calls: { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' },
		commands: [{ path: ['gmail', 'search'] }, { path: ['help'] }],
		deniedPatterns: [],
		executablePath: '/usr/bin/gog',
		executionTarget: validOAuthMediatedTarget(),
		kind: 'configured_cli',
		mandatoryArgvPrefix: [],
		output: {
			modelVisibleStderr: 'none',
			overflow: 'truncate',
			stderrMaxBytes: 1_024,
			stdoutMaxBytes: 1_024,
		},
		safeHelp: 'Run one admitted Gog command.',
		stdin: { kind: 'none' },
		timeout: { kind: 'quick' },
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
		for (const fieldName of ['credentialProjection'] as const) {
			const { [fieldName]: _removed, ...withoutField } = target;
			expect(configuredCliExecutionTargetSchema.safeParse(withoutField).success).toBe(false);
		}
	});

	it('rejects authored runtime identity and loose legacy credential fields', () => {
		const target = validCredentialedTarget() as Record<string, unknown>;
		for (const legacyFields of [
			{ runtimeId: 'google-workspace' },
			{ credentialBinding: 'google' },
			{ credentialFiles: [] },
			{ credentialEnvironment: {} },
		]) {
			expect(
				configuredCliExecutionTargetSchema.safeParse({ ...target, ...legacyFields }).success,
			).toBe(false);
		}
	});

	it('accepts a strict HTTP-mediated credential projection', () => {
		expect(configuredCliExecutionTargetSchema.safeParse(validMediatedTarget()).success).toBe(true);
	});

	it.each([
		['scheme', 'https://places.googleapis.com'],
		['path', 'places.googleapis.com/v1'],
		['port', 'places.googleapis.com:443'],
		['wildcard', '*.googleapis.com'],
		['uppercase alias', 'Places.GoogleApis.com'],
		['trailing dot alias', 'places.googleapis.com.'],
		['empty label', 'places..googleapis.com'],
	])('rejects non-canonical mediated host %s', (_caseName, host) => {
		const target = validMediatedTarget() as Record<string, unknown>;
		const projection = target.credentialProjection as Record<string, unknown>;
		const environment = projection.environment as Record<string, unknown>;
		const mediated = environment.GOOGLE_PLACES_API_KEY as Record<string, unknown>;
		expect(
			configuredCliExecutionTargetSchema.safeParse({
				...target,
				allowedHosts: [host],
				credentialProjection: {
					...projection,
					environment: {
						...environment,
						GOOGLE_PLACES_API_KEY: { ...mediated, hosts: [host] },
					},
				},
			}).success,
		).toBe(false);
	});

	it.each(['127.0.0.1', '::1', 'localhost', 'credentialed-mediation.vm.host'])(
		'accepts canonical exact mediated host %s',
		(host) => {
			const target = validMediatedTarget() as Record<string, unknown>;
			const projection = target.credentialProjection as Record<string, unknown>;
			const environment = projection.environment as Record<string, unknown>;
			const mediated = environment.GOOGLE_PLACES_API_KEY as Record<string, unknown>;
			expect(
				configuredCliExecutionTargetSchema.safeParse({
					...target,
					allowedHosts: [host],
					credentialProjection: {
						...projection,
						environment: {
							...environment,
							GOOGLE_PLACES_API_KEY: { ...mediated, hosts: [host] },
						},
					},
				}).success,
			).toBe(true);
		},
	);

	it('rejects empty mediated hosts and mixed projection fields', () => {
		const target = validMediatedTarget() as Record<string, unknown>;
		const projection = target.credentialProjection as Record<string, unknown>;
		const environment = projection.environment as Record<string, unknown>;
		const mediated = environment.GOOGLE_PLACES_API_KEY as Record<string, unknown>;
		expect(
			configuredCliExecutionTargetSchema.safeParse({
				...target,
				credentialProjection: {
					...projection,
					environment: {
						...environment,
						GOOGLE_PLACES_API_KEY: { ...mediated, hosts: [] },
					},
				},
			}).success,
		).toBe(false);
		expect(
			configuredCliExecutionTargetSchema.safeParse({
				...target,
				allowedHosts: ['routes.googleapis.com'],
			}).success,
		).toBe(false);
		expect(
			configuredCliExecutionTargetSchema.safeParse({
				...target,
				credentialProjection: { ...projection, credentialBinding: 'google' },
			}).success,
		).toBe(false);
	});

	it.each([
		['absolute path', '/etc/google.json'],
		['traversal', '../google.json'],
		['dot segment', 'keys/./google.json'],
		['empty segment', 'keys//google.json'],
		['control character', 'keys/google\n.json'],
	])('rejects unsafe credential file %s', (_caseName, path) => {
		const target = validCredentialedTarget() as Record<string, unknown>;
		const projection = target.credentialProjection as Record<string, unknown>;
		expect(
			configuredCliExecutionTargetSchema.safeParse({
				...target,
				credentialProjection: {
					...projection,
					credentialFiles: [{ path, source: 'service-account' }],
				},
			}).success,
		).toBe(false);
	});

	it('rejects duplicate sources and destinations', () => {
		const target = validCredentialedTarget() as Record<string, unknown>;
		const projection = target.credentialProjection as Record<string, unknown>;
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
					credentialProjection: { ...projection, credentialFiles: duplicate },
				}).success,
			).toBe(false);
		}
	});

	it('reports projection-relative diagnostic paths for file binding refinements', () => {
		const target = validCredentialedTarget() as Record<string, unknown>;
		const projection = target.credentialProjection as Record<string, unknown>;
		const result = configuredCliExecutionTargetSchema.safeParse({
			...target,
			credentialProjection: {
				...projection,
				credentialEnvironment: {
					GOOGLE_APPLICATION_CREDENTIALS: {
						kind: 'credential_file',
						source: 'missing',
					},
				},
				credentialFiles: [
					{ path: 'same.json', source: 'service-account' },
					{ path: 'same.json', source: 'service-account' },
				],
			},
			environment: { kind: 'inherit_allowlist', names: ['GOOGLE_APPLICATION_CREDENTIALS'] },
		});
		if (result.success) throw new Error('Expected invalid credential projection.');
		expect(result.error.issues.map((issue) => issue.path)).toEqual(
			expect.arrayContaining([
				['credentialProjection', 'credentialFiles', 1, 'source'],
				['credentialProjection', 'credentialFiles', 1, 'path'],
				[
					'credentialProjection',
					'credentialEnvironment',
					'GOOGLE_APPLICATION_CREDENTIALS',
					'source',
				],
				['credentialProjection', 'credentialEnvironment', 'GOOGLE_APPLICATION_CREDENTIALS'],
			]),
		);
	});

	it('rejects unknown credential-file environment sources and ordinary environment collisions', () => {
		const target = validCredentialedTarget() as Record<string, unknown>;
		const projection = target.credentialProjection as Record<string, unknown>;
		expect(
			configuredCliExecutionTargetSchema.safeParse({
				...target,
				credentialProjection: {
					...projection,
					credentialEnvironment: {
						GOOGLE_APPLICATION_CREDENTIALS: {
							kind: 'credential_file',
							source: 'missing',
						},
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
		const projection = target.credentialProjection as Record<string, unknown>;
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
				credentialProjection: { ...projection, credentialEnvironment, credentialFiles },
			}).success,
		).toBe(false);
	});
});

describe('OAuth-configured CLI contract', () => {
	it('classifies every admitted command path with one typed authorization rule', () => {
		const result = controllerEnforcedConfiguredCliOperationSchema.safeParse(
			validOAuthConfiguredCliOperation(),
		);
		if (!result.success) {
			throw new Error(`Expected valid OAuth-configured CLI operation: ${result.error.message}`);
		}
		expect(result.data.authorization?.kind).toBe('oauth_account_profile');
	});

	it('rejects missing, duplicate, unadmitted, and flag-sensitive authorization rules', () => {
		const operation = validOAuthConfiguredCliOperation() as Record<string, unknown>;
		const authorization = operation.authorization as Record<string, unknown>;
		const rules = authorization.rules as readonly Record<string, unknown>[];
		const firstRule = rules[0];
		if (firstRule === undefined) throw new Error('Missing OAuth authorization rule.');

		for (const invalidRules of [
			[rules[0]],
			[...rules, firstRule],
			[
				...rules,
				{
					match: { flags: [], path: ['drive', 'list'] },
					requirement: {
						applicationId: 'workspace-app',
						kind: 'oauth',
						minimumPermission: 'read',
						serviceId: 'drive',
					},
				},
			],
			[
				{
					...firstRule,
					match: { flags: [{ kind: 'present', names: ['--json'] }], path: ['gmail', 'search'] },
				},
				rules[1],
			],
		]) {
			expect(
				controllerEnforcedConfiguredCliOperationSchema.safeParse({
					...operation,
					authorization: { ...authorization, rules: invalidRules },
				}).success,
			).toBe(false);
		}
	});

	it('requires accountProfile only on the OAuth-configured RPC input variant', () => {
		const oauthInput = {
			accountProfile: 'personal-google',
			argv: ['gmail', 'search'],
			reason: 'Read recent messages.',
		};
		expect(oauthConfiguredCliInputSchema.safeParse(oauthInput).success).toBe(true);
		expect(quickConfiguredCliInputSchema.safeParse(oauthInput).success).toBe(false);
		expect(controllerConfiguredCliInputSchema.safeParse(oauthInput).success).toBe(true);
		expect(
			oauthConfiguredCliInputSchema.safeParse({
				argv: ['gmail', 'search'],
				reason: 'Read recent messages.',
			}).success,
		).toBe(false);
	});
});

describe('Tool VM configured CLI contract', () => {
	const toolVmOperation = {
		executablePath: '/usr/local/bin/firecrawl',
		executionTarget: { kind: 'tool_vm', workingDirectory: '.' },
		kind: 'configured_cli',
		mandatoryArgvPrefix: [],
		output: {
			modelVisibleStderr: 'fixed_safe_summary',
			overflow: 'truncate',
			stderrMaxBytes: 4_096,
			stdoutMaxBytes: 65_536,
		},
		safeHelp: 'Use the Firecrawl CLI installed in the current Tool VM.',
		suggestCalls: {
			suggestDeny: [{ flags: [], path: ['delete'] }],
			suggestRequiresApproval: [{ flags: [], path: ['crawl'] }],
			suggestWithoutApproval: 'remaining_admitted',
		},
		suggestCommands: [
			{ flagRules: [], path: ['crawl'] },
			{ flagRules: [], path: ['delete'] },
		],
		suggestDeniedPatterns: [],
		suggestStdin: { kind: 'bounded_text', deniedPatterns: [], maxBytes: 65_536 },
		suggestTimeout: { kind: 'open' },
	} as const;

	it('accepts the existing configured CLI policy under suggest-prefixed Tool VM names', () => {
		const parsed = controllerConfiguredCliOperationSchema.parse(toolVmOperation);
		expect(parsed.executionTarget.kind).toBe('tool_vm');
		expect('suggestCalls' in parsed).toBe(true);
	});

	it('rejects enforcement-named policy properties for the Tool VM discriminant', () => {
		expect(
			controllerConfiguredCliOperationSchema.safeParse({
				...toolVmOperation,
				calls: {
					deny: [],
					requiresApproval: [],
					withoutApproval: 'remaining_admitted',
				},
				commands: toolVmOperation.suggestCommands,
				deniedPatterns: [],
				stdin: { kind: 'none' },
				timeout: { kind: 'open' },
			}).success,
		).toBe(false);
	});
});
