import { describe, expect, it } from 'vitest';

import { encodeConfiguredCliPreparedImageIdentity } from './controller-configured-cli.js';
import {
	createGatewayRuntimeManagedToolPortalConfig,
	createEffectiveManagedToolPortalConfig,
	createToolPortalControllerExecutionProjection,
	createToolPortalMcpProjection,
	preparedManagedToolPortalConfigSchema,
	ToolPortalControllerExecutionProjectionSchema,
	toolPortalConfigSchema,
	ToolPortalMcpProjectionSchema,
} from './tool-portal-config.js';

const validManagedToolPortalConfig = {
	agents: {
		'agent-a': { profile: 'code-builder' },
	},
	mode: 'managed',
	profiles: {
		'code-builder': {
			namespaces: {
				github: {
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: ['create_issue'], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['get_issue', 'create_issue'], deny: ['delete_repo'] },
				},
				local: {
					backend: {
						kind: 'controller_execution',
						operations: { push_branch: { kind: 'registered_action' } },
					},
					calls: {
						requiresApproval: { allow: ['push_branch'], deny: [] },
						withoutApproval: { allow: [], deny: [] },
					},
					tools: { allow: ['push_branch'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
} as const;

const validStandaloneToolPortalConfig = {
	agents: validManagedToolPortalConfig.agents,
	authentication: {
		agents: {
			'agent-a': {
				approvalHmacKey: { source: 'environment', name: 'TOOL_PORTAL_AGENT_A_HMAC_KEY' },
				bearerKey: { source: 'environment', name: 'TOOL_PORTAL_AGENT_A_BEARER_KEY' },
				credentialVersion: 1,
			},
		},
	},
	drain: { timeoutMs: 5_000 },
	entrypoints: {
		http: {
			address: { host: '127.0.0.1', port: 18_792 },
			allowedHosts: ['127.0.0.1', 'localhost'],
			allowedOrigins: ['http://127.0.0.1:18792'],
			authentication: { kind: 'bearer' },
			enabled: true,
			route: '/api/tool-portal',
		},
		mcp: {
			address: { host: '127.0.0.1', port: 18_793 },
			allowedHosts: ['127.0.0.1', 'localhost'],
			allowedOrigins: ['http://127.0.0.1:18793'],
			authentication: { kind: 'bearer' },
			enabled: true,
			route: '/mcp',
			transport: 'streamable-http',
		},
		stdio: {
			authentication: { agentId: 'agent-a', kind: 'scoped-principal' },
			enabled: true,
		},
	},
	mode: 'standalone',
	profiles: {
		'code-builder': {
			namespaces: {
				github: validManagedToolPortalConfig.profiles['code-builder'].namespaces.github,
			},
		},
	},
	schemaVersion: 1,
} as const;

const validSandboxRunnerBackend = {
	kind: 'tool_vm_runner',
	operations: {
		read_file: {
			description: 'Read one bounded UTF-8 file from the current Tool VM work tree.',
			kind: 'filesystem.read',
		},
		write_file: {
			description: 'Write one bounded UTF-8 file in the current Tool VM work tree.',
			kind: 'filesystem.write',
		},
	},
	profile: 'sandbox_ssh',
} as const;

describe('tool portal config contract', () => {
	it('accepts discovery summaries only on non-MCP managed namespaces', () => {
		const nonMcpConfig = {
			...validManagedToolPortalConfig,
			profiles: {
				'code-builder': {
					namespaces: {
						...validManagedToolPortalConfig.profiles['code-builder'].namespaces,
						local: {
							...validManagedToolPortalConfig.profiles['code-builder'].namespaces.local,
							discovery: { summary: 'Controller-owned workspace operations.' },
						},
					},
				},
			},
		};
		const duplicateMcpSource = {
			...validManagedToolPortalConfig,
			profiles: {
				'code-builder': {
					namespaces: {
						...validManagedToolPortalConfig.profiles['code-builder'].namespaces,
						github: {
							...validManagedToolPortalConfig.profiles['code-builder'].namespaces.github,
							discovery: { summary: 'Duplicate MCP summary.' },
						},
					},
				},
			},
		};

		expect(toolPortalConfigSchema.safeParse(nonMcpConfig).success).toBe(true);
		expect(toolPortalConfigSchema.safeParse(duplicateMcpSource).success).toBe(false);
	});

	it('parses strict managed and standalone branches', () => {
		expect(toolPortalConfigSchema.parse(validManagedToolPortalConfig)).toMatchObject({
			agents: { 'agent-a': { profile: 'code-builder' } },
			mode: 'managed',
		});
		expect(toolPortalConfigSchema.parse(validStandaloneToolPortalConfig)).toMatchObject({
			mode: 'standalone',
			entrypoints: {
				http: { enabled: true },
				mcp: { enabled: true },
				stdio: { enabled: true },
			},
		});

		expect(
			toolPortalConfigSchema.safeParse({
				...validManagedToolPortalConfig,
				profiles: {
					'code-builder': {
						extends: 'base',
						...validManagedToolPortalConfig.profiles['code-builder'],
					},
				},
			}).success,
		).toBe(false);
	});

	it('parses registered and configured controller execution operations and rejects the old backend', () => {
		const configuredBackend = {
			kind: 'controller_execution',
			operations: {
				inspect: {
					calls: { withoutApproval: 'remaining_admitted' },
					commands: [{ path: ['inspect'] }],
					deniedPatterns: [],
					executablePath: '/usr/local/bin/inspect',
					executionTarget: {
						allowedHosts: [],
						credentialProjection: {
							credentialBinding: 'google',
							credentialEnvironment: { GOG_DATA_DIR: { kind: 'credential_root' } },
							credentialFiles: [
								{ path: 'sa-c3VuQGV4YW1wbGUuY29t.json', source: 'service-account' },
							],
							kind: 'file_binding',
						},
						environment: { kind: 'empty' },
						guestCwd: '/run',
						imageReference: '../../vm-images/controller-runners/default/build-config.json',
						kind: 'ephemeral_managed_vm',
					},
					kind: 'configured_cli',
					mandatoryArgvPrefix: [],
					output: {
						modelVisibleStderr: 'fixed_safe_summary',
						overflow: 'truncate',
						stderrMaxBytes: 65_536,
						stdoutMaxBytes: 65_536,
					},
					safeHelp: 'Inspect one isolated input.',
					stdin: { kind: 'none' },
					timeout: { kind: 'quick' },
				},
			},
		} as const;
		const config = {
			...validManagedToolPortalConfig,
			agents: {
				'agent-a': {
					credentialBindings: {
						google: {
							files: {
								'service-account': {
									ref: 'op://agent-vm-testing/google/service-account',
									source: '1password',
								},
							},
						},
					},
					profile: 'code-builder',
				},
			},
			profiles: {
				'code-builder': {
					namespaces: {
						isolated: {
							backend: configuredBackend,
							calls: {
								requiresApproval: { allow: [], deny: [] },
								withoutApproval: { allow: ['inspect'], deny: [] },
							},
							tools: { allow: ['inspect'], deny: [] },
						},
					},
				},
			},
		};

		expect(toolPortalConfigSchema.safeParse(config).success).toBe(true);
		expect(
			toolPortalConfigSchema.safeParse({
				...config,
				profiles: {
					'code-builder': {
						namespaces: {
							isolated: {
								...config.profiles['code-builder'].namespaces.isolated,
								backend: {
									...configuredBackend,
									operations: {
										inspect: {
											...configuredBackend.operations.inspect,
											executionTarget: {
												...configuredBackend.operations.inspect.executionTarget,
												imageReference: 'agent-vm-prepared-image:v1:forged',
											},
										},
									},
								},
							},
						},
					},
				},
			}).success,
		).toBe(false);
		expect(
			toolPortalConfigSchema.safeParse({
				...config,
				profiles: {
					'code-builder': {
						namespaces: {
							isolated: {
								...config.profiles['code-builder'].namespaces.isolated,
								backend: { kind: 'controller_host_action' },
							},
						},
					},
				},
			}).success,
		).toBe(false);
	});

	it('requires every managed agent using a credentialed operation to declare its own binding', () => {
		const configuredOperation = {
			calls: { withoutApproval: 'remaining_admitted' },
			commands: [{ path: ['calendar', 'list'] }],
			deniedPatterns: [],
			executablePath: '/usr/local/bin/gog',
			executionTarget: {
				allowedHosts: ['www.googleapis.com'],
				credentialProjection: {
					credentialBinding: 'google',
					credentialEnvironment: { GOG_DATA_DIR: { kind: 'credential_root' } },
					credentialFiles: [{ path: 'sa-c3VuQGV4YW1wbGUuY29t.json', source: 'service-account' }],
					kind: 'file_binding',
				},
				environment: { kind: 'empty' },
				guestCwd: '/work',
				imageReference: '../../vm-images/controller-runners/gog/build-config.json',
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
		} as const;
		const config = {
			agents: {
				sun: {
					credentialBindings: {
						google: {
							files: {
								'service-account': {
									ref: 'op://agent-vm-testing/google/service-account',
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
								operations: { calendar_list: configuredOperation },
							},
							calls: {
								requiresApproval: { allow: [], deny: [] },
								withoutApproval: { allow: ['calendar_list'], deny: [] },
							},
							tools: { allow: ['calendar_list'], deny: [] },
						},
					},
				},
			},
			schemaVersion: 1,
		} as const;

		expect(toolPortalConfigSchema.safeParse(config).success).toBe(true);
		expect(
			toolPortalConfigSchema.safeParse({
				...config,
				agents: { sun: { profile: 'google-enabled' } },
				profiles: {
					'google-enabled': {
						namespaces: {
							google: {
								...config.profiles['google-enabled'].namespaces.google,
								calls: {
									requiresApproval: { allow: [], deny: [] },
									withoutApproval: { allow: [], deny: [] },
								},
								tools: { allow: [], deny: [] },
							},
						},
					},
				},
			}).success,
		).toBe(true);
		expect(
			toolPortalConfigSchema.safeParse({
				...config,
				agents: { sun: { profile: 'google-enabled' } },
			}).success,
		).toBe(false);
		expect(
			toolPortalConfigSchema.safeParse({
				...config,
				agents: {
					sun: {
						credentialBindings: {
							google: {
								files: {
									other: {
										ref: 'op://agent-vm-testing/google/other',
										source: '1password',
									},
								},
							},
						},
						profile: 'google-enabled',
					},
				},
			}).success,
		).toBe(false);
	});

	it('rejects capabilities without a compatibility alias', () => {
		const { mode: _mode, ...configWithoutMode } = validManagedToolPortalConfig;
		expect(toolPortalConfigSchema.safeParse(configWithoutMode).success).toBe(false);

		expect(
			toolPortalConfigSchema.safeParse({
				...validManagedToolPortalConfig,
				profiles: {
					'code-builder': {
						capabilities: validManagedToolPortalConfig.profiles['code-builder'].namespaces,
					},
				},
			}).success,
		).toBe(false);
	});

	it('rejects standalone entrypoint and authentication fields in managed mode', () => {
		for (const standaloneField of ['authentication', 'drain', 'entrypoints'] as const) {
			expect(
				toolPortalConfigSchema.safeParse({
					...validManagedToolPortalConfig,
					[standaloneField]: validStandaloneToolPortalConfig[standaloneField],
				}).success,
			).toBe(false);
		}
	});

	it('requires explicit standalone entrypoint configuration and complete credentials', () => {
		expect(
			toolPortalConfigSchema.safeParse({
				...validStandaloneToolPortalConfig,
				entrypoints: {},
			}).success,
		).toBe(false);

		expect(
			toolPortalConfigSchema.safeParse({
				...validStandaloneToolPortalConfig,
				entrypoints: {
					...validStandaloneToolPortalConfig.entrypoints,
					http: { enabled: true },
				},
			}).success,
		).toBe(false);

		expect(
			toolPortalConfigSchema.safeParse({
				...validStandaloneToolPortalConfig,
				entrypoints: {
					...validStandaloneToolPortalConfig.entrypoints,
					mcp: {
						address: { host: '127.0.0.1', port: 18_793 },
						authentication: { kind: 'bearer' },
						enabled: false,
						route: '/mcp',
						transport: 'streamable-http',
					},
				},
			}).success,
		).toBe(false);

		expect(
			toolPortalConfigSchema.safeParse({
				...validStandaloneToolPortalConfig,
				authentication: {
					...validStandaloneToolPortalConfig.authentication,
					agents: {},
				},
			}).success,
		).toBe(false);

		expect(
			toolPortalConfigSchema.safeParse({
				...validStandaloneToolPortalConfig,
				authentication: {
					agents: {
						...validStandaloneToolPortalConfig.authentication.agents,
						'unknown-agent': validStandaloneToolPortalConfig.authentication.agents['agent-a'],
					},
				},
			}).success,
		).toBe(false);
	});

	it('rejects missing profiles, unknown stdio principals, and dual MCP Portal policy authority', () => {
		expect(
			toolPortalConfigSchema.safeParse({
				...validManagedToolPortalConfig,
				agents: { 'agent-a': { profile: 'missing' } },
			}).success,
		).toBe(false);

		expect(
			toolPortalConfigSchema.safeParse({
				...validStandaloneToolPortalConfig,
				entrypoints: {
					...validStandaloneToolPortalConfig.entrypoints,
					stdio: {
						authentication: { agentId: 'unknown-agent', kind: 'scoped-principal' },
						enabled: true,
					},
				},
			}).success,
		).toBe(false);

		expect(
			toolPortalConfigSchema.safeParse({
				...validManagedToolPortalConfig,
				mcpPortalProfile: 'code-builder',
			}).success,
		).toBe(false);
	});

	it('rejects unknown fields and resolved standalone credential material', () => {
		expect(
			toolPortalConfigSchema.safeParse({
				...validStandaloneToolPortalConfig,
				authentication: {
					...validStandaloneToolPortalConfig.authentication,
					audience: 'tool-portal',
				},
			}).success,
		).toBe(false);

		expect(
			toolPortalConfigSchema.safeParse({
				...validStandaloneToolPortalConfig,
				authentication: {
					agents: {
						'agent-a': {
							...validStandaloneToolPortalConfig.authentication.agents['agent-a'],
							bearerKey: 'resolved-secret-material',
						},
					},
				},
			}).success,
		).toBe(false);
	});

	it('accepts only hard-cutover Tool Portal backend kinds', () => {
		for (const acceptedBackend of [
			{ kind: 'mcp_provider' },
			validSandboxRunnerBackend,
			validManagedToolPortalConfig.profiles['code-builder'].namespaces.local.backend,
		]) {
			const namespacePolicy =
				acceptedBackend.kind === 'tool_vm_runner'
					? {
							backend: acceptedBackend,
							calls: {
								requiresApproval: { allow: ['write_file'], deny: [] },
								withoutApproval: { allow: ['read_file'], deny: [] },
							},
							tools: { allow: ['read_file', 'write_file'], deny: [] },
						}
					: acceptedBackend.kind === 'controller_execution'
						? validManagedToolPortalConfig.profiles['code-builder'].namespaces.local
						: {
								...validManagedToolPortalConfig.profiles['code-builder'].namespaces.github,
								backend: acceptedBackend,
							};
			expect(
				toolPortalConfigSchema.safeParse({
					...validManagedToolPortalConfig,
					profiles: {
						'code-builder': {
							namespaces: {
								github: namespacePolicy,
							},
						},
					},
				}).success,
			).toBe(true);
		}

		for (const legacyBackendKind of ['mcp', 'credentialed_runner', 'controller_host_action']) {
			expect(
				toolPortalConfigSchema.safeParse({
					...validManagedToolPortalConfig,
					profiles: {
						'code-builder': {
							namespaces: {
								github: {
									...validManagedToolPortalConfig.profiles['code-builder'].namespaces.github,
									backend: { kind: legacyBackendKind },
								},
							},
						},
					},
				}).success,
			).toBe(false);
		}
	});

	it.each(['controller_execution', 'tool_vm_runner'] as const)(
		'rejects the privileged %s backend in standalone mode',
		(backendKind) => {
			const managedNamespace = validManagedToolPortalConfig.profiles['code-builder'].namespaces;
			const privilegedPolicy =
				backendKind === 'tool_vm_runner'
					? {
							backend: validSandboxRunnerBackend,
							calls: {
								requiresApproval: { allow: ['write_file'], deny: [] },
								withoutApproval: { allow: ['read_file'], deny: [] },
							},
							tools: { allow: ['read_file', 'write_file'], deny: [] },
						}
					: managedNamespace.local;

			expect(
				toolPortalConfigSchema.safeParse({
					...validStandaloneToolPortalConfig,
					profiles: {
						'code-builder': {
							namespaces: { privileged: privilegedPolicy },
						},
					},
				}).success,
			).toBe(false);
		},
	);

	it('requires an explicit sandbox runner profile and non-empty trusted operation catalog', () => {
		const namespacePolicy = validManagedToolPortalConfig.profiles['code-builder'].namespaces.github;
		for (const invalidBackend of [
			{ kind: 'tool_vm_runner' },
			{ ...validSandboxRunnerBackend, profile: 'controller_rpc' },
			{ ...validSandboxRunnerBackend, operations: {} },
			{
				...validSandboxRunnerBackend,
				operations: {
					read_file: { description: '', kind: 'filesystem.read' },
				},
			},
			{
				...validSandboxRunnerBackend,
				operations: {
					read_file: { description: 'Read one file.', kind: 'shell.command' },
				},
			},
		] as const) {
			expect(
				toolPortalConfigSchema.safeParse({
					...validManagedToolPortalConfig,
					profiles: {
						'code-builder': {
							namespaces: {
								sandbox: { ...namespacePolicy, backend: invalidBackend },
							},
						},
					},
				}).success,
			).toBe(false);
		}
	});

	it('accepts only tokenized fixed sandbox commands with protected executable and cwd authority', () => {
		const namespacePolicy = validManagedToolPortalConfig.profiles['code-builder'].namespaces.github;
		const fixedCommandOperation = {
			description: 'Run the repository unit checks.',
			executable: '/usr/bin/pnpm',
			kind: 'command.fixed',
			mandatoryArgvPrefix: ['test:unit'],
			workingDirectory: '.',
		} as const;
		const configWithOperation = (operation: object): object => ({
			...validManagedToolPortalConfig,
			profiles: {
				'code-builder': {
					namespaces: {
						sandbox: {
							...namespacePolicy,
							backend: {
								kind: 'tool_vm_runner',
								operations: { run_checks: operation },
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
		});

		expect(
			toolPortalConfigSchema.safeParse(configWithOperation(fixedCommandOperation)).success,
		).toBe(true);
		for (const invalidOperation of [
			{ ...fixedCommandOperation, executable: 'pnpm' },
			{ ...fixedCommandOperation, executable: '/usr/bin/pnpm\0--unsafe' },
			{ ...fixedCommandOperation, mandatoryArgvPrefix: ['test:unit\0--unsafe'] },
			{ ...fixedCommandOperation, workingDirectory: '/work' },
			{ ...fixedCommandOperation, workingDirectory: '../state' },
			{ ...fixedCommandOperation, shell: 'pnpm test:unit' },
		] as const) {
			expect(toolPortalConfigSchema.safeParse(configWithOperation(invalidOperation)).success).toBe(
				false,
			);
		}
	});

	it('accepts only the target-specific unrestricted Tool VM CLI discriminant', () => {
		const namespacePolicy = validManagedToolPortalConfig.profiles['code-builder'].namespaces.github;
		const cliOperation = {
			advisoryHints: {
				hintDeny: [{ path: ['account', 'delete'] }],
				hintRequiresApproval: [{ flags: [{ names: ['--force'] }], path: ['crawl'] }],
			},
			executable: '/usr/local/bin/firecrawl',
			kind: 'command.cli',
			metadata: {
				categories: ['research', 'web'],
				displayName: 'Firecrawl CLI',
				source: 'firecrawl',
				version: '1.x',
			},
			output: {
				modelVisibleStderr: 'fixed_safe_summary',
				overflow: 'truncate',
				stderrMaxBytes: 65_536,
				stdoutMaxBytes: 65_536,
			},
			safeHelp: 'Run the installed Firecrawl CLI with caller-selected arguments.',
			timeout: { kind: 'open' },
			workingDirectory: '.',
		} as const;
		const configWithOperation = (
			operation: object,
			calls: object = {
				requiresApproval: { allow: [], deny: [] },
				withoutApproval: { allow: ['firecrawl'], deny: [] },
			},
		): object => ({
			...validManagedToolPortalConfig,
			profiles: {
				'code-builder': {
					namespaces: {
						sandbox: {
							...namespacePolicy,
							backend: {
								kind: 'tool_vm_runner',
								operations: { firecrawl: operation },
								profile: 'sandbox_ssh',
							},
							calls,
							tools: { allow: ['firecrawl'], deny: [] },
						},
					},
				},
			},
		});

		const parsed = toolPortalConfigSchema.safeParse(configWithOperation(cliOperation));
		expect(parsed.success).toBe(true);
		if (!parsed.success || parsed.data.mode !== 'managed') return;
		const effective = createEffectiveManagedToolPortalConfig(
			preparedManagedToolPortalConfigSchema.parse(parsed.data),
		);
		const gateway = createGatewayRuntimeManagedToolPortalConfig(effective);
		expect(gateway.profiles['code-builder']?.namespaces.sandbox?.backend).toMatchObject({
			kind: 'tool_vm_runner',
			operations: { firecrawl: cliOperation },
		});

		for (const forbiddenCliAuthority of [
			{ calls: { withoutApproval: 'remaining_admitted' } },
			{ commands: [{ path: ['crawl'] }] },
			{ deniedPatterns: [] },
			{ mandatoryArgvPrefix: ['crawl'] },
			{ stdin: { kind: 'none' } },
			{ executionTarget: { kind: 'controller_host' } },
		] as const) {
			expect(
				toolPortalConfigSchema.safeParse(
					configWithOperation({ ...cliOperation, ...forbiddenCliAuthority }),
				).success,
			).toBe(false);
		}

		expect(
			toolPortalConfigSchema.safeParse(
				configWithOperation({
					...cliOperation,
					kind: 'command.fixed',
					mandatoryArgvPrefix: [],
				}),
			).success,
		).toBe(false);
		expect(
			toolPortalConfigSchema.safeParse(
				configWithOperation(cliOperation, {
					requiresApproval: { allow: ['firecrawl'], deny: [] },
					withoutApproval: { allow: [], deny: [] },
				}),
			).success,
		).toBe(false);
	});

	it('authors all five bounded process operations while keeping argv cwd and runtime policy fixed', () => {
		const namespacePolicy = validManagedToolPortalConfig.profiles['code-builder'].namespaces.github;
		const processOperations = {
			cancel: { description: 'Cancel one bounded process.', kind: 'process.cancel' },
			logs: { description: 'Read bounded process logs.', kind: 'process.logs' },
			start: {
				description: 'Start the fixed repository watcher.',
				executable: '/usr/bin/watch-repository',
				kind: 'process.start',
				mandatoryArgvPrefix: ['--fixed'],
				maxRuntimeMs: 30_000,
				retainOutputBytes: 4_096,
				workingDirectory: 'repo',
			},
			status: { description: 'Read bounded process status.', kind: 'process.status' },
			wait: {
				description: 'Wait briefly for bounded process completion.',
				kind: 'process.wait',
				timeoutMs: 500,
			},
		} as const;
		const configWithOperations = (operations: object): object => ({
			...validManagedToolPortalConfig,
			profiles: {
				'code-builder': {
					namespaces: {
						sandbox: {
							...namespacePolicy,
							backend: { kind: 'tool_vm_runner', operations, profile: 'sandbox_ssh' },
							calls: {
								requiresApproval: { allow: [], deny: [] },
								withoutApproval: { allow: '*', deny: [] },
							},
							tools: { allow: '*', deny: [] },
						},
					},
				},
			},
		});

		expect(toolPortalConfigSchema.safeParse(configWithOperations(processOperations)).success).toBe(
			true,
		);
		for (const forbiddenStartAuthority of [
			{ argv: ['attacker'], cwd: 'outside' },
			{ maxRuntimeMs: 0 },
			{ retainOutputBytes: 0 },
		] as const) {
			expect(
				toolPortalConfigSchema.safeParse(
					configWithOperations({
						...processOperations,
						start: { ...processOperations.start, ...forbiddenStartAuthority },
					}),
				).success,
			).toBe(false);
		}
	});

	it('requires every explicit sandbox runner selector to name a configured operation', () => {
		const basePolicy = {
			backend: validSandboxRunnerBackend,
			calls: {
				requiresApproval: { allow: [], deny: [] },
				withoutApproval: { allow: ['read_file'], deny: [] },
			},
			tools: { allow: ['read_file'], deny: [] },
		} as const;
		for (const invalidPolicy of [
			{ ...basePolicy, tools: { allow: ['missing'], deny: [] } },
			{
				...basePolicy,
				calls: {
					...basePolicy.calls,
					withoutApproval: { allow: ['missing'], deny: [] },
				},
			},
			{ ...basePolicy, tools: { allow: ['read_file'], deny: ['missing'] } },
		] as const) {
			expect(
				toolPortalConfigSchema.safeParse({
					...validManagedToolPortalConfig,
					profiles: {
						'code-builder': { namespaces: { sandbox: invalidPolicy } },
					},
				}).success,
			).toBe(false);
		}

		expect(
			toolPortalConfigSchema.safeParse({
				...validManagedToolPortalConfig,
				profiles: {
					'code-builder': {
						namespaces: {
							sandbox: {
								...basePolicy,
								calls: {
									requiresApproval: { allow: [], deny: [] },
									withoutApproval: { allow: '*', deny: ['write_file'] },
								},
								tools: { allow: '*', deny: ['write_file'] },
							},
						},
					},
				},
			}).success,
		).toBe(true);
	});

	it('rejects overlapping approval selectors inside one namespace policy', () => {
		expect(
			toolPortalConfigSchema.safeParse({
				...validManagedToolPortalConfig,
				profiles: {
					'code-builder': {
						namespaces: {
							github: {
								backend: { kind: 'mcp_provider' },
								calls: {
									requiresApproval: { allow: ['create_issue'], deny: [] },
									withoutApproval: { allow: ['create_issue'], deny: [] },
								},
								tools: { allow: ['create_issue'], deny: [] },
							},
						},
					},
				},
			}).success,
		).toBe(false);

		expect(
			toolPortalConfigSchema.safeParse({
				...validManagedToolPortalConfig,
				profiles: {
					'code-builder': {
						namespaces: {
							github: {
								backend: { kind: 'mcp_provider' },
								calls: {
									requiresApproval: { allow: ['create_issue'], deny: [] },
									withoutApproval: { allow: '*', deny: [] },
								},
								tools: { allow: ['create_issue'], deny: [] },
							},
						},
					},
				},
			}).success,
		).toBe(false);
	});

	it('builds a neutral MCP projection containing only MCP-backed namespaces', () => {
		const projection = createToolPortalMcpProjection({
			agentId: 'agent-a',
			config: toolPortalConfigSchema.parse(validManagedToolPortalConfig),
		});

		expect(ToolPortalMcpProjectionSchema.parse(projection)).toEqual({
			agentId: 'agent-a',
			namespaces: {
				github: {
					calls: {
						requiresApproval: { allow: ['create_issue'], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['get_issue', 'create_issue'], deny: ['delete_repo'] },
				},
			},
			profile: 'code-builder',
		});
	});

	it('builds a controller execution projection containing only controller namespaces', () => {
		const projection = createToolPortalControllerExecutionProjection({
			agentId: 'agent-a',
			config: toolPortalConfigSchema.parse(validManagedToolPortalConfig),
		});

		expect(ToolPortalControllerExecutionProjectionSchema.parse(projection)).toEqual({
			agentId: 'agent-a',
			namespaces: {
				local: {
					calls: {
						requiresApproval: { allow: ['push_branch'], deny: [] },
						withoutApproval: { allow: [], deny: [] },
					},
					tools: { allow: ['push_branch'], deny: [] },
				},
			},
			profile: 'code-builder',
		});
	});

	it('projects configured controller execution policy without controller-trusted runner fields', () => {
		const configuredOperation = {
			calls: { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' },
			commands: [{ path: ['inspect'], flagRules: [] }],
			deniedPatterns: [],
			executablePath: '/usr/bin/inspect-host',
			executionTarget: {
				allowedHosts: [],
				credentialProjection: {
					credentialBinding: 'google',
					credentialEnvironment: { GOG_DATA_DIR: { kind: 'credential_root' } },
					credentialFiles: [{ path: 'sa-c3VuQGV4YW1wbGUuY29t.json', source: 'service-account' }],
					kind: 'file_binding',
				},
				environment: { kind: 'empty' },
				guestCwd: '/run/operation',
				imageReference: encodeConfiguredCliPreparedImageIdentity({
					fingerprint: 'sha256:prepared-runner',
					imageReference: '/images/runner/prepared',
					schemaVersion: 1,
				}),
				kind: 'ephemeral_managed_vm',
			},
			kind: 'configured_cli',
			mandatoryArgvPrefix: ['--fixed'],
			output: {
				modelVisibleStderr: 'none',
				overflow: 'truncate',
				stderrMaxBytes: 1024,
				stdoutMaxBytes: 1024,
			},
			safeHelp: 'Inspect one host resource.',
			stdin: { kind: 'none' },
			timeout: { kind: 'quick' },
		} as const;
		const preparedConfig = preparedManagedToolPortalConfigSchema.parse({
			...validManagedToolPortalConfig,
			agents: {
				'agent-a': {
					credentialBindings: {
						google: {
							files: {
								'service-account': {
									ref: 'op://agent-vm-testing/google/service-account',
									source: '1password',
								},
							},
						},
					},
					profile: 'code-builder',
				},
			},
			profiles: {
				'code-builder': {
					namespaces: {
						github: {
							...validManagedToolPortalConfig.profiles['code-builder'].namespaces.github,
							discovery: {},
						},
						local: {
							...validManagedToolPortalConfig.profiles['code-builder'].namespaces.local,
							discovery: {},
							backend: {
								kind: 'controller_execution',
								operations: { inspect_host: configuredOperation },
							},
							calls: {
								requiresApproval: { allow: ['inspect_host'], deny: [] },
								withoutApproval: { allow: [], deny: [] },
							},
							tools: { allow: ['inspect_host'], deny: [] },
						},
					},
				},
			},
		});
		const fullConfig = createEffectiveManagedToolPortalConfig(preparedConfig);

		const projected = createGatewayRuntimeManagedToolPortalConfig(fullConfig);
		const projectedOperation =
			projected.profiles['code-builder']?.namespaces.local?.backend.kind === 'controller_execution'
				? projected.profiles['code-builder'].namespaces.local.backend.operations.inspect_host
				: undefined;

		expect(projectedOperation).toEqual({
			calls: { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' },
			commands: [{ path: ['inspect'], flagRules: [] }],
			deniedPatterns: [],
			kind: 'configured_cli',
			safeHelp: 'Inspect one host resource.',
			stdin: { kind: 'none' },
			targetKind: 'ephemeral_managed_vm',
			timeout: { kind: 'quick' },
		});
		const serializedProjection = JSON.stringify(projectedOperation);
		for (const forbiddenField of [
			'executablePath',
			'mandatoryArgvPrefix',
			'executionTarget',
			'credentialBinding',
			'credentialEnvironment',
			'credentialFiles',
			'imageReference',
			'runtimeId',
			'guestCwd',
			'environment',
			'allowedHosts',
			'output',
		]) {
			expect(serializedProjection).not.toContain(`"${forbiddenField}"`);
		}
	});
});
