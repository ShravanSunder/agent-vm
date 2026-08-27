import { describe, expect, it } from 'vitest';

import {
	CanonicalBase64Schema,
	GatewayStablePrincipalDigestSchema,
	GatewayRuntimeAttachmentMetadataSchema,
	GatewayRuntimeFrameworkIdentitySchema,
	GatewayRuntimeTrustedInvocationContextSchema,
	ManagedAgentProjectionSchema,
	SANDBOX_METHOD_CONTRACTS,
	SandboxEnvironmentOpenRequestSchema,
	SandboxEnvironmentOpenResultSchema,
	SandboxEnvironmentStatusResultSchema,
	SandboxExecStartRequestSchema,
	SandboxFsRenameRequestSchema,
	SandboxFsStatRequestSchema,
	SandboxOperationControlResultSchema,
	SandboxBinaryChunkSchema,
	SandboxProcessStartRequestSchema,
	SandboxStreamHandleSchema,
	SandboxWorkRelativePathSchema,
} from './index.js';

const principalOnlyTrustedContext = {
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { kind: 'hermes', profileName: 'agent-a-profile' },
		profileAssignmentRevision: 'profiles-7',
		toolPortalProfileId: 'profile-a',
	},
} as const;

const fullyAttributedTrustedContext = {
	correlation: {
		runId: 'run-a',
		sessionId: 'session-a',
		sessionKey: 'session-key-a',
		toolCallId: 'tool-call-a',
	},
	principal: principalOnlyTrustedContext.principal,
	requester: {
		authenticatedSubjectId: 'subject-a',
	},
} as const;

describe('canonical Agent Portal contracts', () => {
	const environmentHandle = {
		handleId: 'environment-a',
		kind: 'environment',
		owningGeneration: 'generation-a',
	} as const;

	it('represents an opened environment at the selected work root by omitting logicalCwd', () => {
		const rootRequest = {};
		const rootResult = { environment: environmentHandle, kind: 'opened' } as const;

		expect(SandboxEnvironmentOpenRequestSchema.parse(rootRequest)).toEqual(rootRequest);
		expect(SandboxEnvironmentOpenResultSchema.parse(rootResult)).toEqual(rootResult);
	});

	it('represents an active environment at the selected work root by omitting logicalCwd', () => {
		const rootStatus = { environment: environmentHandle, kind: 'active' } as const;

		expect(SandboxEnvironmentStatusResultSchema.parse(rootStatus)).toEqual(rootStatus);
	});

	it('preserves a present child logicalCwd across request, open result, and active status', () => {
		const logicalCwd = 'repo/subdir';

		expect(SandboxEnvironmentOpenRequestSchema.parse({ logicalCwd })).toEqual({ logicalCwd });
		expect(
			SandboxEnvironmentOpenResultSchema.parse({
				environment: environmentHandle,
				kind: 'opened',
				logicalCwd,
			}),
		).toEqual({ environment: environmentHandle, kind: 'opened', logicalCwd });
		expect(
			SandboxEnvironmentStatusResultSchema.parse({
				environment: environmentHandle,
				kind: 'active',
				logicalCwd,
			}),
		).toEqual({ environment: environmentHandle, kind: 'active', logicalCwd });
	});

	it.each([
		[
			'sandbox.exec.start',
			SandboxExecStartRequestSchema,
			{ mode: { kind: 'direct' }, timeoutMs: 1_000 },
		],
		[
			'sandbox.process.start',
			SandboxProcessStartRequestSchema,
			{ maxRuntimeMs: 1_000, retainOutputBytes: 1_024 },
		],
	] as const)('accepts arbitrary bounded direct shell input for %s', (_method, schema, fields) => {
		const request = {
			command: 'printf "%s\\n" "$GREETING" && pwd',
			environment: environmentHandle,
			environmentVariables: [
				{ name: 'GREETING', value: 'hello world' },
				{ name: 'EMPTY_VALUE', value: '' },
			],
			cwd: '/workspace/repo/subdir',
			...fields,
		};

		expect(schema.parse(request)).toEqual(request);
	});

	it.each([
		['legacy capability', { capability: { name: 'shell', namespace: 'sandbox' } }],
		['legacy arguments', { arguments: { command: 'pwd' } }],
		['agent identity', { agentId: 'agent-b' }],
		['SSH authority', { ssh: { host: 'tool-vm' } }],
		['lease authority', { leaseId: 'lease-a' }],
		['controller authority', { controllerAction: 'execute-command' }],
	] as const)('rejects %s from direct shell public requests', (_caseName, forbiddenField) => {
		const request = {
			command: 'pwd',
			environment: environmentHandle,
			mode: { kind: 'direct' },
			timeoutMs: 1_000,
			...forbiddenField,
		};

		expect(SandboxExecStartRequestSchema.safeParse(request).success).toBe(false);
	});

	it.each([
		['empty command', { command: '' }],
		['NUL command', { command: 'printf before\0after' }],
		['relative cwd', { cwd: 'repo' }],
		['NUL cwd', { cwd: '/workspace/repo\0escape' }],
		['invalid environment name', { environmentVariables: [{ name: 'BAD-NAME', value: 'x' }] }],
		['NUL environment value', { environmentVariables: [{ name: 'VALID_NAME', value: 'a\0b' }] }],
		[
			'too many environment variables',
			{
				environmentVariables: Array.from({ length: 101 }, (_value, index) => ({
					name: `VALUE_${String(index)}`,
					value: 'x',
				})),
			},
		],
	] as const)('rejects bounded direct shell violation: %s', (_caseName, requestPatch) => {
		const request = {
			command: 'pwd',
			environment: environmentHandle,
			maxRuntimeMs: 1_000,
			retainOutputBytes: 1_024,
			...requestPatch,
		};

		expect(SandboxProcessStartRequestSchema.safeParse(request).success).toBe(false);
	});

	it.each([
		[SandboxExecStartRequestSchema, { mode: { kind: 'direct' as const }, timeoutMs: 1_000 }],
		[SandboxProcessStartRequestSchema, { maxRuntimeMs: 1_000, retainOutputBytes: 1_024 }],
	] as const)('rejects duplicate direct shell environment variable names', (schema, fields) => {
		const request = {
			command: 'printf "%s" "$MODE"',
			environment: environmentHandle,
			environmentVariables: [
				{ name: 'MODE', value: 'alpha' },
				{ name: 'MODE', value: 'beta' },
			],
			...fields,
		};

		expect(schema.safeParse(request).success).toBe(false);
	});

	it('accepts absolute and environment-relative guest filesystem paths', () => {
		const absoluteRequest = {
			environment: environmentHandle,
			path: '/workspace/memory/2026-07-18.md',
		} as const;
		const relativeRenameRequest = {
			destinationPath: '../workspace/skills/review/SKILL.md',
			environment: environmentHandle,
			replace: true,
			sourcePath: 'generated-skill.md',
		} as const;

		expect(SandboxFsStatRequestSchema.parse(absoluteRequest)).toEqual(absoluteRequest);
		expect(SandboxFsRenameRequestSchema.parse(relativeRenameRequest)).toEqual(
			relativeRenameRequest,
		);
	});

	it.each(['', '/workspace/memory\0escape', 'relative\0escape'])(
		'rejects invalid guest filesystem path %j',
		(requestedPath) => {
			expect(
				SandboxFsStatRequestSchema.safeParse({
					environment: environmentHandle,
					path: requestedPath,
				}).success,
			).toBe(false);
		},
	);

	it.each(['', '.', '/work', '../repo', 'repo/../subdir', 'repo//subdir'])(
		'rejects present non-child logicalCwd %j across request and result contracts',
		(logicalCwd) => {
			expect(SandboxEnvironmentOpenRequestSchema.safeParse({ logicalCwd }).success).toBe(false);
			expect(
				SandboxEnvironmentOpenResultSchema.safeParse({
					environment: environmentHandle,
					kind: 'opened',
					logicalCwd,
				}).success,
			).toBe(false);
			expect(
				SandboxEnvironmentStatusResultSchema.safeParse({
					environment: environmentHandle,
					kind: 'active',
					logicalCwd,
				}).success,
			).toBe(false);
		},
	);

	it('accepts exactly lowercase 64-hex stable principal digests', () => {
		const validDigest = 'a'.repeat(64);

		expect(GatewayStablePrincipalDigestSchema.parse(validDigest)).toBe(validDigest);
		for (const invalidDigest of [
			'',
			'a'.repeat(63),
			'a'.repeat(65),
			'A'.repeat(64),
			'g'.repeat(64),
			` ${validDigest}`,
			`${validDigest}\n`,
		]) {
			expect(GatewayStablePrincipalDigestSchema.safeParse(invalidDigest).success).toBe(false);
		}
	});

	it('accepts only discriminated managed framework identities and exact four-field projections', () => {
		// Arrange
		const defaultProfileProjection = {
			agentId: 'agent-a',
			frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
			profileAssignmentRevision: 'profile-assignment-a',
			toolPortalNamespaces: [
				{ namespace: 'filesystem', summary: 'Workspace files.' },
				{ namespace: 'github' },
			],
			toolPortalProfileId: 'profile-a',
		} as const;
		const namedProfileProjection = {
			...defaultProfileProjection,
			frameworkIdentity: { kind: 'hermes', profileName: 'agent-a-profile' },
		} as const;

		// Act / Assert
		expect(ManagedAgentProjectionSchema.parse(defaultProfileProjection)).toEqual(
			defaultProfileProjection,
		);
		const parsedHermesProjection = ManagedAgentProjectionSchema.parse(namedProfileProjection);
		expect(parsedHermesProjection).toEqual(namedProfileProjection);
		expect(Object.isFrozen(parsedHermesProjection)).toBe(true);
		expect(Object.isFrozen(parsedHermesProjection.frameworkIdentity)).toBe(true);
		expect(
			GatewayRuntimeFrameworkIdentitySchema.safeParse({
				agentId: 'agent-a',
				kind: 'hermes',
				profileName: 'agent-a-profile',
			}).success,
		).toBe(false);
		for (const retiredAuthority of [
			{ environmentScope: 'gateway:zone-a' },
			{ frameworkKind: 'hermes' },
			{ profileId: 'profile-a' },
			{ selfRoot: '/zone/agents/agent-a/self' },
			{ workRoot: '/zone/agents/agent-a/work' },
			{ workspaceId: 'workspace-a' },
		]) {
			expect(
				ManagedAgentProjectionSchema.safeParse({
					...namedProfileProjection,
					...retiredAuthority,
				}).success,
			).toBe(false);
		}
	});

	it('accepts namespace names beyond the generic opaque identifier bound', () => {
		// Arrange
		const longNamespaceName = 'n'.repeat(257);
		const projection = {
			agentId: 'agent-a',
			frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
			profileAssignmentRevision: 'profile-assignment-a',
			toolPortalNamespaces: [{ namespace: longNamespaceName }],
			toolPortalProfileId: 'profile-a',
		} as const;

		// Act / Assert
		expect(ManagedAgentProjectionSchema.safeParse(projection).success).toBe(true);
	});

	it('counts namespace summary bounds by Unicode code point', () => {
		const supplementaryCharacter = '\u{1F680}';
		const projection = {
			agentId: 'agent-a',
			frameworkIdentity: { kind: 'hermes' as const, profileName: 'agent-a' },
			profileAssignmentRevision: 'profile-assignment-a',
			toolPortalNamespaces: [{ namespace: 'unicode', summary: supplementaryCharacter.repeat(500) }],
			toolPortalProfileId: 'profile-a',
		};

		expect(ManagedAgentProjectionSchema.safeParse(projection).success).toBe(true);
		expect(
			ManagedAgentProjectionSchema.safeParse({
				...projection,
				toolPortalNamespaces: [
					{ namespace: 'unicode', summary: supplementaryCharacter.repeat(501) },
				],
			}).success,
		).toBe(false);
	});

	it('orders managed namespace names by Unicode code point', () => {
		// Arrange
		const privateUseNamespace = '\uE000';
		const supplementaryNamespace = '\u{10000}';
		const projection = {
			agentId: 'agent-a',
			frameworkIdentity: { kind: 'hermes' as const, profileName: 'agent-a' },
			profileAssignmentRevision: 'profile-assignment-a',
			toolPortalNamespaces: [
				{ namespace: privateUseNamespace },
				{ namespace: supplementaryNamespace },
			],
			toolPortalProfileId: 'profile-a',
		};

		// Act
		const acceptedResult = ManagedAgentProjectionSchema.safeParse(projection);
		const reverseResult = ManagedAgentProjectionSchema.safeParse({
			...projection,
			toolPortalNamespaces: [
				{ namespace: supplementaryNamespace },
				{ namespace: privateUseNamespace },
			],
		});

		// Assert
		expect(acceptedResult.success).toBe(true);
		expect(reverseResult.success).toBe(false);
	});

	it('rejects roots and retired authority fields from the stable caller principal', () => {
		// Arrange
		const canonicalPrincipal = {
			agentId: 'agent-a',
			frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
			profileAssignmentRevision: 'profile-assignment-a',
			toolPortalProfileId: 'profile-a',
		} as const;

		// Act / Assert
		expect(
			GatewayRuntimeTrustedInvocationContextSchema.parse({ principal: canonicalPrincipal }),
		).toEqual({ principal: canonicalPrincipal });
		for (const retiredAuthority of [
			{ environmentScope: 'gateway:zone-a' },
			{ frameworkKind: 'hermes' },
			{ profileId: 'profile-a' },
			{ selfRoot: '/zone/agents/agent-a/self' },
			{ workRoot: '/zone/agents/agent-a/work' },
			{ workspaceId: 'workspace-a' },
		]) {
			expect(
				GatewayRuntimeTrustedInvocationContextSchema.safeParse({
					principal: { ...canonicalPrincipal, ...retiredAuthority },
				}).success,
			).toBe(false);
		}
	});
	it('publishes every rich sandbox request and result pair', () => {
		// Arrange
		const expectedMethods = [
			'sandbox.environment.open',
			'sandbox.environment.close',
			'sandbox.environment.status',
			'sandbox.exec.start',
			'sandbox.exec.wait',
			'sandbox.exec.cancel',
			'sandbox.retained-result.lookup',
			'sandbox.fs.stat',
			'sandbox.fs.list',
			'sandbox.fs.read',
			'sandbox.fs.write',
			'sandbox.fs.mkdir',
			'sandbox.fs.rename',
			'sandbox.fs.remove',
			'sandbox.process.start',
			'sandbox.process.status',
			'sandbox.process.wait',
			'sandbox.process.logs',
			'sandbox.process.cancel',
			'sandbox.stream.read',
			'sandbox.stream.write',
			'sandbox.stream.close',
			'sandbox.terminal.attach',
			'sandbox.terminal.resize',
		] as const;

		// Act
		const actualMethods = Object.keys(SANDBOX_METHOD_CONTRACTS).toSorted();

		// Assert
		expect(actualMethods).toEqual([...expectedMethods].toSorted());
		for (const method of expectedMethods) {
			expect(SANDBOX_METHOD_CONTRACTS[method].request).toBeDefined();
			expect(SANDBOX_METHOD_CONTRACTS[method].result).toBeDefined();
		}
	});

	it('keeps attachment metadata strict and bounded', () => {
		// Arrange
		const attachmentMetadata = {
			attachmentGeneration: 7,
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds: ['agent-a', 'agent-b'],
			frameworkEpoch: 'hermes-framework-epoch-3',
			gatewayEpoch: 'gateway-epoch-7',
			protocolVersion: 1,
			projectionCohortDigest: 'projection-cohort:a'.padEnd(82, '0'),
			runtimeEpoch: 'tool-portal-runtime-epoch-4',
			schemaVersion: 1,
		} as const;

		// Act / Assert
		expect(GatewayRuntimeAttachmentMetadataSchema.parse(attachmentMetadata)).toEqual(
			attachmentMetadata,
		);
		expect(
			GatewayRuntimeAttachmentMetadataSchema.safeParse({
				...attachmentMetadata,
				projectionCohortDigest: undefined,
			}).success,
		).toBe(false);
	});

	it('requires only the stable principal and accepts optional requester and correlation metadata', () => {
		// Arrange / Act / Assert
		expect(GatewayRuntimeTrustedInvocationContextSchema.parse(principalOnlyTrustedContext)).toEqual(
			principalOnlyTrustedContext,
		);
		expect(
			GatewayRuntimeTrustedInvocationContextSchema.parse(fullyAttributedTrustedContext),
		).toEqual(fullyAttributedTrustedContext);
	});

	it.each([
		[
			'flat authority shape',
			{
				agentId: 'agent-a',
				authenticatedSubjectId: 'subject-a',
				frameworkIdentity: { kind: 'hermes', profileName: 'agent-a-profile' },
				profileAssignmentRevision: 'profiles-7',
				sessionId: 'session-a',
				toolPortalProfileId: 'profile-a',
			},
		],
		['missing principal', {}],
		[
			'malformed principal',
			{
				principal: {
					...principalOnlyTrustedContext.principal,
					toolPortalProfileId: '',
				},
			},
		],
	] as const)('rejects trusted invocation context with %s', (_caseName, trustedContext) => {
		// Arrange / Act / Assert
		expect(GatewayRuntimeTrustedInvocationContextSchema.safeParse(trustedContext).success).toBe(
			false,
		);
	});

	it('accepts canonical base64 and rejects non-canonical encodings', () => {
		// Arrange / Act / Assert
		expect(CanonicalBase64Schema.parse('aGVsbG8=')).toBe('aGVsbG8=');
		expect(CanonicalBase64Schema.safeParse('aGVsbG8').success).toBe(false);
		expect(CanonicalBase64Schema.safeParse('aGVsbG8===\n').success).toBe(false);
	});

	it('binds stream handles to one channel and validates decoded byte length', () => {
		// Arrange
		const streamHandle = {
			channel: 'stdout',
			handleId: 'stream-a',
			kind: 'stream',
			owningGeneration: 'generation-a',
		} as const;

		// Act / Assert
		expect(SandboxStreamHandleSchema.parse(streamHandle)).toEqual(streamHandle);
		expect(
			SandboxBinaryChunkSchema.parse({
				byteLength: 5,
				contentBase64: 'aGVsbG8=',
				encoding: 'base64',
			}),
		).toEqual({ byteLength: 5, contentBase64: 'aGVsbG8=', encoding: 'base64' });
		expect(
			SandboxBinaryChunkSchema.safeParse({
				byteLength: 4,
				contentBase64: 'aGVsbG8=',
				encoding: 'base64',
			}).success,
		).toBe(false);
	});

	it.each([
		'',
		'.',
		'../secret',
		'/etc/passwd',
		'safe//secret',
		'safe/./secret',
		'safe/../secret',
		'safe\0secret',
	])('rejects non-work-relative path %j', (path) => {
		// Arrange / Act / Assert
		expect(SandboxWorkRelativePathSchema.safeParse(path).success).toBe(false);
	});

	it.each([
		{
			kind: 'running',
			operation: { operationId: 'operation-a', owningGeneration: 'generation-a' },
		},
		{
			kind: 'cancel-request-accepted',
			operation: { operationId: 'operation-a', owningGeneration: 'generation-a' },
		},
		{
			kind: 'cancellation-pending',
			operation: { operationId: 'operation-a', owningGeneration: 'generation-a' },
		},
		{
			kind: 'termination-proven',
			operation: { operationId: 'operation-a', owningGeneration: 'generation-a' },
			outcome: {
				certainty: 'proven-terminated',
				kind: 'cancelled-proven',
				retryClass: 'manual-only',
			},
		},
		{
			kind: 'already-terminal',
			operation: { operationId: 'operation-a', owningGeneration: 'generation-a' },
			outcome: {
				certainty: 'proven',
				completion: 'succeeded',
				kind: 'completed',
				retryClass: 'forbidden',
			},
		},
		{
			kind: 'ambiguous',
			operation: { operationId: 'operation-a', owningGeneration: 'generation-a' },
			outcome: {
				certainty: 'side-effects-and-termination-unknown',
				kind: 'ambiguous',
				retryClass: 'forbidden',
			},
		},
	])('accepts authoritative operation control result $kind', (result) => {
		// Arrange / Act / Assert
		expect(SandboxOperationControlResultSchema.parse(result)).toEqual(result);
	});
});
