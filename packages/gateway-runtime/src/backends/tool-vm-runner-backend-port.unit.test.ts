import { Buffer } from 'node:buffer';

import {
	PortalCallResultSchema,
	PortalBackendDescribeResultSchema,
	PortalBackendListResultSchema,
	PortalBackendSearchResultSchema,
	type ArtifactReference,
	type JsonObject,
	type PortalCallResult,
} from '@agent-vm/agent-portal-sdk';
import { gatewayRuntimeManagedToolPortalConfigSchema } from '@agent-vm/config-contracts';
import {
	deriveGatewayControlStablePrincipal,
	type GatewayRuntimeToolPortalDispatchAuthorityForBackendKind,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import type {
	ToolPortalBackendCallOptions,
	ToolPortalBackendPort,
	ToolPortalInvocationOptions,
} from '@agent-vm/tool-portal';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { createGatewayRuntimeSandboxOperationAuthority } from '../sandbox/sandbox-operation-authority.js';
import type { GatewayRuntimeSandboxProcessRegistry } from '../sandbox/sandbox-process-registry.js';
import type { StrictToolVmSshClient } from '../sandbox/strict-tool-vm-ssh-client.js';
import {
	MAXIMUM_TOOL_VM_RUNNER_TEXT_WRITE_BYTES,
	createGatewayRuntimeToolVmRunnerBackendPort,
	type GatewayRuntimeToolVmRunnerArtifactWriteRequest,
	type GatewayRuntimeToolVmRunnerBackendPort,
	type GatewayRuntimeToolVmRunnerCapabilityCatalog,
	type GatewayRuntimeToolVmRunnerProfileCapabilityCatalog,
	type GatewayRuntimeToolVmRunnerSandboxBindingRequest,
} from './tool-vm-runner-backend-port.js';
import { compileGatewayRuntimeToolVmRunnerConfiguredCatalog } from './tool-vm-runner-configured-catalog.js';

const trustedContext = {
	correlation: {
		runId: 'run-a',
		sessionId: 'session-a',
		toolCallId: 'tool-call-a',
	},
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
		profileAssignmentRevision: 'profile-assignment:agent-a:7',
		toolPortalProfileId: 'code-builder',
	},
	requester: { authenticatedSubjectId: 'subject-a' },
} as const satisfies GatewayRuntimeTrustedInvocationContext;

const privilegedTrustedContext = {
	...trustedContext,
	principal: {
		...trustedContext.principal,
		profileAssignmentRevision: 'profile-assignment:agent-a:8',
		toolPortalProfileId: 'privileged',
	},
} as const satisfies GatewayRuntimeTrustedInvocationContext;

const operationContext = {
	activeUseId: 'active-use-7',
	environmentGeneration: 'environment-generation-7',
	gatewayEpoch: 'gateway-epoch-7',
	leafGeneration: 'leaf-generation-7',
	leaseId: 'lease-7',
	sshBindingId: 'ssh-binding-7',
	stablePrincipal: 'a'.repeat(64),
} as const;

const codeBuilderCapabilityCatalog = [
	{
		descriptor: {
			annotations: {},
			inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
			name: 'run_checks',
			namespace: 'sandbox',
			outputSchema: { additionalProperties: false, type: 'object' },
			related: [],
			toolRef: 'sandbox.run_checks',
		},
		operation: {
			argv: ['/usr/bin/pnpm', 'test:unit'],
			cwd: 'repo',
			kind: 'exec',
		},
		summary: {
			description: 'Run the configured unit checks in the current sandbox.',
			input: { optional: [], propertyCount: 0, required: [], type: 'object' },
			name: 'run_checks',
			namespace: 'sandbox',
			output: { optional: [], propertyCount: 4, required: [], type: 'object' },
			safety: { readOnlyHint: false },
			toolRef: 'sandbox.run_checks',
		},
	},
	{
		descriptor: {
			annotations: {},
			inputSchema: {
				additionalProperties: false,
				properties: { path: { type: 'string' } },
				required: ['path'],
				type: 'object',
			},
			name: 'read_file',
			namespace: 'sandbox',
			related: [],
			toolRef: 'sandbox.read_file',
		},
		operation: { kind: 'read-file' },
		summary: {
			description: 'Read one bounded file from the current sandbox work tree.',
			input: { optional: [], propertyCount: 1, required: ['path'], type: 'object' },
			name: 'read_file',
			namespace: 'sandbox',
			safety: { readOnlyHint: true },
			toolRef: 'sandbox.read_file',
		},
	},
	{
		descriptor: {
			annotations: {},
			inputSchema: {
				additionalProperties: false,
				properties: { path: { type: 'string' } },
				required: ['path'],
				type: 'object',
			},
			name: 'list_directory',
			namespace: 'sandbox',
			related: [],
			toolRef: 'sandbox.list_directory',
		},
		operation: { kind: 'list-directory' },
		summary: {
			description: 'List one bounded directory in the current sandbox work tree.',
			input: { optional: [], propertyCount: 1, required: ['path'], type: 'object' },
			name: 'list_directory',
			namespace: 'sandbox',
			safety: { readOnlyHint: true },
			toolRef: 'sandbox.list_directory',
		},
	},
	{
		descriptor: {
			annotations: {},
			inputSchema: {
				additionalProperties: false,
				properties: { content: { type: 'string' }, path: { type: 'string' } },
				required: ['content', 'path'],
				type: 'object',
			},
			name: 'write_file',
			namespace: 'sandbox',
			related: [],
			toolRef: 'sandbox.write_file',
		},
		operation: { kind: 'write-file' },
		summary: {
			description: 'Write one bounded text file in the current sandbox work tree.',
			input: {
				optional: [],
				propertyCount: 2,
				required: ['content', 'path'],
				type: 'object',
			},
			name: 'write_file',
			namespace: 'sandbox',
			safety: { destructiveHint: true, readOnlyHint: false },
			toolRef: 'sandbox.write_file',
		},
	},
] as const satisfies GatewayRuntimeToolVmRunnerProfileCapabilityCatalog;

const privilegedCapabilityCatalog = [
	{
		descriptor: codeBuilderCapabilityCatalog[0].descriptor,
		operation: { argv: ['/usr/bin/true'], cwd: '.', kind: 'exec' },
		summary: {
			...codeBuilderCapabilityCatalog[0].summary,
			description: 'Run the privileged profile fixed check command.',
		},
	},
] as const;

const capabilityCatalog = {
	'code-builder': codeBuilderCapabilityCatalog,
	privileged: privilegedCapabilityCatalog,
} as const satisfies GatewayRuntimeToolVmRunnerCapabilityCatalog;

type RecordedSshExecution = Parameters<StrictToolVmSshClient['execute']>[0];

interface BackendFixture {
	readonly artifactWrites: GatewayRuntimeToolVmRunnerArtifactWriteRequest[];
	readonly bindingRequests: GatewayRuntimeToolVmRunnerSandboxBindingRequest[];
	readonly endedActiveUseReasons: string[];
	readonly operationAuthority: ReturnType<typeof createGatewayRuntimeSandboxOperationAuthority>;
	readonly port: GatewayRuntimeToolVmRunnerBackendPort;
	readonly retiredGroupReasons: string[];
	readonly sshExecutions: RecordedSshExecution[];
	readonly sshWrites: { readonly bytes: Uint8Array; readonly path: string }[];
}

function artifactReferenceForRole(
	request: GatewayRuntimeToolVmRunnerArtifactWriteRequest,
): ArtifactReference {
	const fingerprintCharacter =
		request.role === 'stderr' ? 'b' : request.role === 'stdout' ? 'a' : 'c';
	return {
		byteLength: request.bytes.byteLength,
		expiresAt: '2026-07-13T20:00:00.000Z',
		fingerprint: `sha256:${fingerprintCharacter.repeat(64)}`,
		id: `${request.operationId}-${request.role}`,
		mediaType: request.mediaType,
	};
}

function failUnusedProcessRegistryOperation(): never {
	throw new Error('Process registry is unused by non-process backend tests.');
}

function unusedProcessRegistry(): GatewayRuntimeSandboxProcessRegistry {
	return {
		cancel: failUnusedProcessRegistryOperation,
		closeStream: failUnusedProcessRegistryOperation,
		logs: failUnusedProcessRegistryOperation,
		read: failUnusedProcessRegistryOperation,
		retire: async (): Promise<void> => undefined,
		resizeTerminal: failUnusedProcessRegistryOperation,
		start: async (): Promise<never> => failUnusedProcessRegistryOperation(),
		startShell: async (): Promise<never> => failUnusedProcessRegistryOperation(),
		status: failUnusedProcessRegistryOperation,
		terminalExitCode: failUnusedProcessRegistryOperation,
		wait: async (): Promise<never> => failUnusedProcessRegistryOperation(),
		write: async (): Promise<never> => failUnusedProcessRegistryOperation(),
	};
}

function createBackendFixture(options?: {
	readonly capabilityCatalog?: GatewayRuntimeToolVmRunnerCapabilityCatalog;
	readonly rejectStrictHostKey?: boolean;
	readonly rejectWriteAfterDispatch?: boolean;
}): BackendFixture {
	const artifactWrites: GatewayRuntimeToolVmRunnerArtifactWriteRequest[] = [];
	const bindingRequests: GatewayRuntimeToolVmRunnerSandboxBindingRequest[] = [];
	const endedActiveUseReasons: string[] = [];
	const retiredGroupReasons: string[] = [];
	const sshExecutions: RecordedSshExecution[] = [];
	const sshWrites: { readonly bytes: Uint8Array; readonly path: string }[] = [];
	const operationAuthority = createGatewayRuntimeSandboxOperationAuthority(operationContext);
	const strictSshClient: StrictToolVmSshClient = {
		close: (): void => undefined,
		connect: async (): Promise<void> => {
			if (options?.rejectStrictHostKey === true) {
				throw new Error('Strict SSH transport rejected the pinned host key.');
			}
		},
		execute: async (request) => {
			sshExecutions.push(request);
			return {
				exitCode: 0,
				kind: 'exited',
				stderr: Uint8Array.from([101, 114, 114]),
				stdout: Uint8Array.from([111, 107]),
			};
		},
		guestListDirectory: async () => [],
		guestMkdir: async (): Promise<void> => undefined,
		guestReadFile: async () => Uint8Array.from([]),
		guestRemove: async (): Promise<void> => undefined,
		guestRename: async (): Promise<void> => undefined,
		guestStat: async () => ({ byteLength: 0, kind: 'file' }),
		guestWriteFile: async (): Promise<void> => undefined,
		listDirectory: async () => [],
		mkdir: async (): Promise<void> => undefined,
		observeTransportFailure: () => ({ unsubscribe: (): void => undefined }),
		readFile: async () => Uint8Array.from([102, 105, 108, 101]),
		remove: async (): Promise<void> => undefined,
		rename: async (): Promise<void> => undefined,
		stat: async () => ({ byteLength: 4, kind: 'file' }),
		writeFile: async (request): Promise<void> => {
			sshWrites.push(request);
			if (options?.rejectWriteAfterDispatch === true) {
				throw new Error('SSH write failed after dispatch.');
			}
		},
	};
	const processRegistry = unusedProcessRegistry();
	const port: GatewayRuntimeToolVmRunnerBackendPort = createGatewayRuntimeToolVmRunnerBackendPort({
		artifactWriter: {
			write: async (request: GatewayRuntimeToolVmRunnerArtifactWriteRequest) => {
				artifactWrites.push(request);
				return artifactReferenceForRole(request);
			},
		},
		acquisitionPort: {
			acquire: async (request: GatewayRuntimeToolVmRunnerSandboxBindingRequest) => {
				bindingRequests.push(request);
				const requestedPrincipal = deriveGatewayControlStablePrincipal({
					principal: request.trustedContext.principal,
				});
				const admittedPrincipals = [trustedContext, privilegedTrustedContext].map((context) =>
					deriveGatewayControlStablePrincipal({ principal: context.principal }),
				);
				if (!admittedPrincipals.includes(requestedPrincipal)) {
					return {
						kind: 'not-bound' as const,
						owningGeneration: operationContext.environmentGeneration,
						reason: 'not-authorized' as const,
					};
				}
				return {
					endActiveUse: async (reason): Promise<void> => {
						endedActiveUseReasons.push(reason);
					},
					environmentGeneration: operationContext.environmentGeneration,
					kind: 'bound' as const,
					operationAuthority,
					operationContext,
					processRegistry,
					retireGroup: async (reason): Promise<void> => {
						retiredGroupReasons.push(reason);
					},
					strictSshClient,
				};
			},
		},
		capabilityCatalog: options?.capabilityCatalog ?? capabilityCatalog,
	});
	return {
		artifactWrites,
		bindingRequests,
		endedActiveUseReasons,
		operationAuthority,
		port,
		retiredGroupReasons,
		sshExecutions,
		sshWrites,
	};
}

function directCallOptions(
	operationId: string,
	invocationContext: GatewayRuntimeTrustedInvocationContext = trustedContext,
): ToolPortalBackendCallOptions<'tool_vm_runner'> {
	return {
		dispatchAuthority: {
			backendKind: 'tool_vm_runner',
			fingerprint: `sha256:${'d'.repeat(64)}`,
			kind: 'without-approval',
			operationId,
		},
		surfaceClass: 'protected_uds',
		trustedContext: invocationContext,
	};
}

function invocationOptions(
	invocationContext: GatewayRuntimeTrustedInvocationContext = trustedContext,
): ToolPortalInvocationOptions {
	return { surfaceClass: 'protected_uds', trustedContext: invocationContext };
}

async function callCapability(options: {
	readonly arguments: JsonObject;
	readonly fixture: BackendFixture;
	readonly id: string;
	readonly name: string;
	readonly operationId: string;
	readonly trustedContext?: GatewayRuntimeTrustedInvocationContext;
}): Promise<PortalCallResult> {
	return PortalCallResultSchema.parse(
		await options.fixture.port.call(
			{
				calls: [
					{
						arguments: options.arguments,
						id: options.id,
						name: options.name,
						namespace: 'sandbox',
					},
				],
			},
			directCallOptions(options.operationId, options.trustedContext),
		),
	);
}

describe('Gateway runtime Tool VM runner backend port', () => {
	it('drops namespace summaries before configured execution reaches SSH', async () => {
		// Arrange
		const namespaceSummaryPayloadCanary = 'SUMMARY_MARKER_MUST_NOT_ENTER_TOOL_VM_SSH';
		const configuredCatalog = compileGatewayRuntimeToolVmRunnerConfiguredCatalog(
			gatewayRuntimeManagedToolPortalConfigSchema.parse({
				agents: { 'agent-a': { profile: 'code-builder' } },
				mode: 'managed',
				profiles: {
					'code-builder': {
						namespaces: {
							sandbox: {
								discovery: { summary: namespaceSummaryPayloadCanary },
								backend: {
									kind: 'tool_vm_runner',
									operations: {
										run_checks: {
											description: 'Run the configured check.',
											executable: '/usr/bin/true',
											kind: 'command.fixed',
											mandatoryArgvPrefix: [],
											workingDirectory: '.',
										},
									},
									profile: 'sandbox_ssh',
								},
								calls: {
									requiresApproval: { allow: [], deny: [] },
									withoutApproval: { allow: ['run_checks'], deny: [] },
								},
								tools: { allow: ['run_checks'], deny: [] },
							},
						},
					},
				},
				schemaVersion: 1,
			}),
		);
		const fixture = createBackendFixture({ capabilityCatalog: configuredCatalog });

		// Act
		const result = await callCapability({
			arguments: {},
			fixture,
			id: 'call-summary-isolation',
			name: 'run_checks',
			operationId: '40000000-0000-4000-8000-000000000099',
			trustedContext,
		});

		// Assert
		expect(result.items[0]).toMatchObject({ status: 'ok' });
		expect(fixture.sshExecutions).toEqual([{ argv: ['/usr/bin/true'], cwd: '.' }]);
		expect(
			JSON.stringify({
				artifactWrites: fixture.artifactWrites,
				bindingRequests: fixture.bindingRequests,
				sshExecutions: fixture.sshExecutions,
				sshWrites: fixture.sshWrites,
			}),
		).not.toContain(namespaceSummaryPayloadCanary);
	});

	it('implements the exact frozen Tool Portal backend-kind contract', () => {
		const fixture = createBackendFixture();

		expect(fixture.port.backendKind).toBe('tool_vm_runner');
		expectTypeOf(fixture.port).toMatchTypeOf<ToolPortalBackendPort<'tool_vm_runner'>>();
		expectTypeOf<Parameters<typeof fixture.port.call>[1]>().toEqualTypeOf<
			ToolPortalBackendCallOptions<'tool_vm_runner'>
		>();
	});

	it('projects only the configured catalog for list, search, and describe without resolving sandbox authority', async () => {
		const fixture = createBackendFixture();

		const listResult = PortalBackendListResultSchema.parse(
			await fixture.port.list(
				{ requests: [{ id: 'list-sandbox', limit: 20, namespaces: ['sandbox'] }] },
				invocationOptions(),
			),
		);
		const searchResult = PortalBackendSearchResultSchema.parse(
			await fixture.port.search(
				{
					requests: [
						{
							id: 'search-files',
							limit: 10,
							namespaces: ['sandbox'],
							query: 'file',
							schemaDetail: 'summary',
						},
					],
				},
				invocationOptions(),
			),
		);
		const describeResult = PortalBackendDescribeResultSchema.parse(
			await fixture.port.describe(
				{
					requests: [
						{
							id: 'describe-read',
							includeJsonSchema: true,
							includeRelated: true,
							includeTypescriptHelper: false,
							includeZod: false,
							tools: [{ name: 'read_file', namespace: 'sandbox' }],
						},
					],
				},
				invocationOptions(),
			),
		);

		expect(listResult.items[0]).toMatchObject({
			status: 'ok',
			value: {
				namespaces: ['sandbox'],
				tools: [
					{ name: 'run_checks', namespace: 'sandbox' },
					{ name: 'read_file', namespace: 'sandbox' },
					{ name: 'list_directory', namespace: 'sandbox' },
					{ name: 'write_file', namespace: 'sandbox' },
				],
			},
		});
		expect(searchResult.items[0]).toMatchObject({
			status: 'ok',
			value: {
				tools: [
					{ name: 'read_file', namespace: 'sandbox' },
					{ name: 'write_file', namespace: 'sandbox' },
				],
			},
		});
		expect(describeResult.items[0]).toMatchObject({
			status: 'ok',
			value: { tools: [codeBuilderCapabilityCatalog[1].descriptor] },
		});
		expect(JSON.stringify({ describeResult, listResult, searchResult })).not.toMatch(
			/backendKind|host|identityPem|knownHostsLine|leaseId|port|privateKey|user/u,
		);
		expect(fixture.bindingRequests).toHaveLength(0);
	});

	it('selects list, search, describe, and call catalogs only from the trusted principal profile', async () => {
		const fixture = createBackendFixture();
		const privilegedList = PortalBackendListResultSchema.parse(
			await fixture.port.list(
				{ requests: [{ id: 'list-privileged', limit: 20, namespaces: ['sandbox'] }] },
				invocationOptions(privilegedTrustedContext),
			),
		);
		const privilegedSearch = PortalBackendSearchResultSchema.parse(
			await fixture.port.search(
				{
					requests: [
						{
							id: 'search-privileged',
							limit: 20,
							namespaces: ['sandbox'],
							query: 'privileged',
							schemaDetail: 'summary',
						},
					],
				},
				invocationOptions(privilegedTrustedContext),
			),
		);
		const privilegedDescribe = PortalBackendDescribeResultSchema.parse(
			await fixture.port.describe(
				{
					requests: [
						{
							id: 'describe-privileged',
							includeJsonSchema: true,
							includeRelated: true,
							includeTypescriptHelper: false,
							includeZod: false,
							tools: [{ name: 'run_checks', namespace: 'sandbox' }],
						},
					],
				},
				invocationOptions(privilegedTrustedContext),
			),
		);
		const privilegedCall = await callCapability({
			arguments: {},
			fixture,
			id: 'call-privileged-checks',
			name: 'run_checks',
			operationId: '40000000-0000-4000-8000-000000000013',
			trustedContext: privilegedTrustedContext,
		});

		expect(privilegedList.items[0]).toMatchObject({
			value: { tools: [{ description: 'Run the privileged profile fixed check command.' }] },
		});
		expect(privilegedSearch.items[0]).toMatchObject({
			value: { tools: [{ name: 'run_checks', namespace: 'sandbox' }] },
		});
		expect(privilegedDescribe.items[0]).toMatchObject({
			value: { tools: [{ name: 'run_checks', namespace: 'sandbox' }] },
		});
		expect(privilegedCall.items[0]).toMatchObject({ status: 'ok' });
		expect(fixture.sshExecutions).toEqual([{ argv: ['/usr/bin/true'], cwd: '.' }]);
	});

	it.each([
		[
			'missing trusted profile',
			'run_checks',
			{
				...trustedContext,
				principal: { ...trustedContext.principal, toolPortalProfileId: 'missing-profile' },
			},
		],
		['missing capability reference', 'missing_capability', trustedContext],
	] as const)(
		'fails a %s as proven not dispatched before binding',
		async (_label, name, context) => {
			const fixture = createBackendFixture();
			const result = await callCapability({
				arguments: {},
				fixture,
				id: 'call-missing-catalog-entry',
				name,
				operationId: '40000000-0000-4000-8000-000000000014',
				trustedContext: context,
			});

			expect(result).toMatchObject({
				items: [
					{
						outcome: { certainty: 'proven', kind: 'not-dispatched' },
						status: 'error',
					},
				],
				ok: false,
			});
			expect(fixture.bindingRequests).toHaveLength(0);
			expect(fixture.sshExecutions).toHaveLength(0);
		},
	);

	it('dispatches configured exec argv and cwd from the catalog and persists bounded output as artifacts', async () => {
		const fixture = createBackendFixture();
		const operationId = '40000000-0000-4000-8000-000000000001';

		const result = await callCapability({
			arguments: {},
			fixture,
			id: 'call-checks',
			name: 'run_checks',
			operationId,
		});

		expect(result).toMatchObject({
			items: [
				{
					artifacts: [{ id: `${operationId}-stdout` }, { id: `${operationId}-stderr` }],
					id: 'call-checks',
					operationId,
					outcome: { certainty: 'proven', completion: 'succeeded', kind: 'completed' },
					owningGeneration: operationContext.environmentGeneration,
					status: 'ok',
					value: { exitCode: 0, kind: 'exited' },
				},
			],
			ok: true,
		});
		expect(fixture.sshExecutions).toEqual([{ argv: ['/usr/bin/pnpm', 'test:unit'], cwd: 'repo' }]);
		expect(fixture.artifactWrites[0]?.role).toBe('stdout');
		expect(fixture.artifactWrites[1]?.role).toBe('stderr');
		expect(fixture.bindingRequests).toEqual([
			{
				trustedContext,
			},
		]);
		expect(fixture.retiredGroupReasons).toEqual(['completed']);
		expect(fixture.endedActiveUseReasons).toEqual([]);
	});

	it('reports a rejected SSH file write as ambiguous after dispatch', async () => {
		const fixture = createBackendFixture({ rejectWriteAfterDispatch: true });
		const result = await callCapability({
			arguments: { content: 'possibly written', path: 'notes/ambiguous.txt' },
			fixture,
			id: 'write-ambiguous',
			name: 'write_file',
			operationId: '40000000-0000-4000-8000-000000000020',
		});

		expect(result.items[0]).toMatchObject({
			outcome: { kind: 'ambiguous', retryClass: 'forbidden' },
			status: 'error',
		});
		expect(fixture.sshWrites).toHaveLength(1);
	});

	it.each([
		'backend',
		'cwd',
		'egress',
		'executable',
		'host',
		'identityPem',
		'knownHostsLine',
		'port',
		'profile',
		'user',
	] as const)(
		'rejects the public %s authority selector before binding or SSH dispatch',
		async (selector) => {
			const fixture = createBackendFixture();

			const result = await callCapability({
				arguments: { [selector]: selector === 'port' ? 22 : 'attacker-controlled' },
				fixture,
				id: `call-${selector}`,
				name: 'run_checks',
				operationId: '40000000-0000-4000-8000-000000000002',
			});

			expect(result).toMatchObject({
				items: [
					{
						outcome: { kind: 'not-dispatched', retryClass: 'safe-before-dispatch' },
						status: 'error',
					},
				],
				ok: false,
			});
			expect(fixture.bindingRequests).toHaveLength(0);
			expect(fixture.sshExecutions).toHaveLength(0);
		},
	);

	it('maps read and directory-list calls to strict work-relative SSH operations without exposing SSH selectors', async () => {
		const fixture = createBackendFixture();

		const readResult = await callCapability({
			arguments: { path: 'src/index.ts' },
			fixture,
			id: 'read-source',
			name: 'read_file',
			operationId: '40000000-0000-4000-8000-000000000003',
		});
		const listResult = await callCapability({
			arguments: { path: 'src' },
			fixture,
			id: 'list-source',
			name: 'list_directory',
			operationId: '40000000-0000-4000-8000-000000000004',
		});

		expect(readResult.items[0]).toMatchObject({
			artifacts: [{ id: '40000000-0000-4000-8000-000000000003-file' }],
			status: 'ok',
			value: { byteLength: 4, kind: 'file' },
		});
		expect(listResult.items[0]).toMatchObject({
			status: 'ok',
			value: { entries: [], kind: 'directory' },
		});
		expect(fixture.artifactWrites[0]?.role).toBe('file');
	});

	it('writes bounded UTF-8 text only to validated work-relative paths', async () => {
		const fixture = createBackendFixture();
		const result = await callCapability({
			arguments: { content: 'hello sandbox', path: 'notes/result.txt' },
			fixture,
			id: 'write-result',
			name: 'write_file',
			operationId: '40000000-0000-4000-8000-000000000015',
		});

		expect(result.items[0]).toMatchObject({
			status: 'ok',
			value: { byteLength: 13, kind: 'written', path: 'notes/result.txt' },
		});
		expect(fixture.sshWrites).toEqual([
			{ bytes: Uint8Array.from(Buffer.from('hello sandbox')), path: 'notes/result.txt' },
		]);
	});

	it.each([
		['absolute path', { content: 'blocked', path: '/etc/passwd' }],
		['parent traversal', { content: 'blocked', path: '../outside' }],
		[
			'oversized UTF-8 text',
			{
				content: 'é'.repeat(MAXIMUM_TOOL_VM_RUNNER_TEXT_WRITE_BYTES / 2 + 1),
				path: 'large.txt',
			},
		],
	] as const)('rejects %s before binding or SSH write', async (_label, callArguments) => {
		const fixture = createBackendFixture();
		const result = await callCapability({
			arguments: callArguments,
			fixture,
			id: 'write-invalid',
			name: 'write_file',
			operationId: '40000000-0000-4000-8000-000000000016',
		});

		expect(result.items[0]).toMatchObject({
			outcome: { certainty: 'proven', kind: 'not-dispatched' },
			status: 'error',
		});
		expect(fixture.bindingRequests).toHaveLength(0);
		expect(fixture.sshWrites).toHaveLength(0);
	});

	it('reports a pinned-host-key rejection as proven pre-dispatch and never executes the configured command', async () => {
		const fixture = createBackendFixture({ rejectStrictHostKey: true });

		const result = await callCapability({
			arguments: {},
			fixture,
			id: 'call-checks',
			name: 'run_checks',
			operationId: '40000000-0000-4000-8000-000000000007',
		});

		expect(result).toMatchObject({
			items: [
				{
					outcome: { certainty: 'proven', kind: 'not-dispatched' },
					status: 'error',
				},
			],
			ok: false,
		});
		expect(fixture.sshExecutions).toHaveLength(0);
		expect(fixture.artifactWrites).toHaveLength(0);
		expect(fixture.retiredGroupReasons).toEqual(['failed']);
	});

	it('does not allow a public caller to substitute trusted context or dispatch authority', async () => {
		const fixture = createBackendFixture();
		const operationId = '40000000-0000-4000-8000-000000000008';
		const authority = directCallOptions(operationId).dispatchAuthority;
		const forbiddenPublicInput = {
			dispatchAuthority: authority,
			trustedContext: {
				...trustedContext,
				principal: { ...trustedContext.principal, agentId: 'attacker-agent' },
			},
		};

		const result = await callCapability({
			arguments: forbiddenPublicInput,
			fixture,
			id: 'call-context-substitution',
			name: 'run_checks',
			operationId,
		});

		expect(result.items[0]).toMatchObject({
			outcome: { kind: 'not-dispatched' },
			status: 'error',
		});
		expect(fixture.bindingRequests).toHaveLength(0);
	});
});

const exactToolVmRunnerAuthority =
	{} as GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'tool_vm_runner'>;
void exactToolVmRunnerAuthority;
