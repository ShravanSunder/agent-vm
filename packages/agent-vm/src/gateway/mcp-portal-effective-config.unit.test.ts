import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	decodeConfiguredCliPreparedImageIdentity,
	mcpConfigSchema,
	toolPortalConfigSchema,
	type ControllerExecutionOperation,
	type McpConfig,
	type ToolPortalConfig,
} from '@agent-vm/config-contracts';
import { deriveGatewayRuntimePortalBindingRevision } from '@agent-vm/gateway-control-contracts';
import type { SecretResolver } from '@agent-vm/secret-management';
import type { SecretRef } from '@agent-vm/secret-management';
import { describe, expect, it, vi } from 'vitest';

import {
	planMcpPortalEffectiveConfigFromConfig,
	resolveMcpPortalEffectiveConfigFromConfig,
	type McpPortalEffectiveConfigFromConfigProps,
} from './mcp-portal-effective-config.js';

type TestSecretResolver = SecretResolver & { readonly resolveAllMock: ReturnType<typeof vi.fn> };

function createDefaultToolPortalConfigInput(namespace = 'deepwiki'): unknown {
	return {
		agents: {
			shravan: {
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
				profile: 'default',
			},
		},
		mode: 'managed',
		profiles: {
			default: {
				namespaces: {
					[namespace]: {
						backend: { kind: 'mcp_provider' },
						calls: {
							requiresApproval: { allow: [] },
							withoutApproval: { allow: '*' },
						},
						tools: { allow: '*' },
					},
				},
			},
		},
		schemaVersion: 1,
	};
}

function createEphemeralConfiguredCliToolPortalConfigInput(): unknown {
	return {
		agents: {
			shravan: {
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
				profile: 'default',
			},
		},
		mode: 'managed',
		profiles: {
			default: {
				namespaces: {
					controller: {
						backend: {
							kind: 'controller_execution',
							operations: {
								isolated: {
									calls: {
										deny: [],
										requiresApproval: [],
										withoutApproval: 'remaining_admitted',
									},
									commands: [{ path: ['run'] }],
									deniedPatterns: [],
									executablePath: '/usr/bin/printf',
									executionTarget: {
										allowedHosts: [],
										credentialProjection: {
											credentialBinding: 'google',
											credentialEnvironment: {
												GOG_DATA_DIR: { kind: 'credential_root' },
											},
											credentialFiles: [
												{
													path: 'sa-c2hyYXZhbkBleGFtcGxlLmNvbQ.json',
													source: 'service-account',
												},
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
										modelVisibleStderr: 'none',
										overflow: 'fail',
										stderrMaxBytes: 1024,
										stdoutMaxBytes: 1024,
									},
									safeHelp: 'Run one isolated operation.',
									stdin: { kind: 'none' },
									timeout: { kind: 'quick' },
								},
							},
						},
						calls: {
							requiresApproval: { allow: [] },
							withoutApproval: { allow: ['isolated'] },
						},
						tools: { allow: ['isolated'] },
					},
				},
			},
		},
		schemaVersion: 1,
	};
}

function parseMcpConfigForTest(config: unknown): McpConfig {
	return mcpConfigSchema.parse(config);
}

function parseToolPortalConfigForTest(config: unknown): ToolPortalConfig {
	return toolPortalConfigSchema.parse(config);
}

function createPlanPropsForTest(props: {
	readonly approvalAccessConfigured?: boolean;
	readonly allowedRawEnvSecretNames?: readonly string[];
	readonly declaredAgentIds?: readonly string[];
	readonly mcpConfig: unknown;
	readonly secretResolver?: SecretResolver;
	readonly toolPortalConfig?: unknown;
	readonly workspaceGitPushAgentEligibility?: {
		readonly eligibleAgentIds: readonly string[];
	};
	readonly zoneId?: string;
}): McpPortalEffectiveConfigFromConfigProps {
	const mcpConfig = parseMcpConfigForTest(props.mcpConfig);
	const firstProviderNamespace = Object.values(mcpConfig.providers)[0]?.namespace ?? 'deepwiki';
	return {
		approvalAccessConfigured: props.approvalAccessConfigured ?? false,
		effectiveHostConfigDir: path.join(tmpdir(), 'agent-vm-tool-portal-effective-test'),
		...(props.workspaceGitPushAgentEligibility === undefined
			? {}
			: { workspaceGitPushAgentEligibility: props.workspaceGitPushAgentEligibility }),
		mcpConfig,
		secretResolver: props.secretResolver ?? createSecretResolver({}),
		toolPortalConfig: parseToolPortalConfigForTest(
			props.toolPortalConfig ?? createDefaultToolPortalConfigInput(firstProviderNamespace),
		),
		zoneId: props.zoneId ?? 'shravan',
		...(props.allowedRawEnvSecretNames === undefined
			? {}
			: { allowedRawEnvSecretNames: props.allowedRawEnvSecretNames }),
		...(props.declaredAgentIds === undefined ? {} : { declaredAgentIds: props.declaredAgentIds }),
	};
}

function createSecretResolver(values: Readonly<Record<string, string>>): TestSecretResolver {
	const resolveAll = vi.fn(async (refs: Record<string, SecretRef>) =>
		Object.fromEntries(
			Object.entries(refs).map(([name, ref]) => {
				if (ref.source === 'config') {
					return [name, ref.value];
				}
				const value = values[ref.ref];
				if (value === undefined) {
					throw new Error(`missing secret ${ref.ref}`);
				}
				return [name, value];
			}),
		),
	);
	return {
		resolve: async (secretRef) => {
			if (secretRef.source === 'config') {
				return secretRef.value;
			}
			const value = values[secretRef.ref];
			if (value === undefined) {
				throw new Error(`missing secret ${secretRef.ref}`);
			}
			return value;
		},
		resolveAll,
		resolveAllMock: resolveAll,
	} satisfies SecretResolver & { readonly resolveAllMock: typeof resolveAll };
}

function createConfiguredCliOperationForOverlapTest(props: {
	readonly commandPath: readonly string[];
	readonly mandatoryArgvPrefix: readonly string[];
	readonly safeHelp: string;
}): Extract<ControllerExecutionOperation, { kind: 'configured_cli' }> {
	return {
		calls: { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' },
		commands: [{ flagRules: [], path: [...props.commandPath] }],
		deniedPatterns: [],
		executablePath: '/usr/bin/example',
		executionTarget: {
			cwd: '/var/empty',
			environment: { kind: 'empty' },
			kind: 'controller_host',
		},
		kind: 'configured_cli',
		mandatoryArgvPrefix: [...props.mandatoryArgvPrefix],
		output: {
			modelVisibleStderr: 'none',
			overflow: 'fail',
			stderrMaxBytes: 1024,
			stdoutMaxBytes: 1024,
		},
		safeHelp: props.safeHelp,
		stdin: { kind: 'none' },
		timeout: { kind: 'quick' },
	};
}

describe('MCP Portal effective config materialization', () => {
	it('prepares ephemeral configured CLI images into the atomic effective identity', async () => {
		const authoredConfigDir = path.join(tmpdir(), 'agent-vm-authored-tool-portal');
		const effectiveHostConfigDir = path.join(tmpdir(), 'agent-vm-effective-tool-portal');
		const prepareImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'fingerprint-prepared-a',
			imageReference: '/cache/prepared-image-a',
		}));
		const props = createPlanPropsForTest({
			mcpConfig: { providers: {}, schemaVersion: 1 },
			toolPortalConfig: createEphemeralConfiguredCliToolPortalConfigInput(),
		});

		const result = await resolveMcpPortalEffectiveConfigFromConfig({
			...props,
			authoredConfigDir,
			effectiveHostConfigDir,
			managedVmImages: { prepareImage },
		});
		const operation = result.credentialedRuntimeRegistrySnapshot.resolve({
			agentId: 'shravan',
			cohortRevision: result.credentialedRuntimeRegistrySnapshot.cohortRevision,
			namespaceId: 'controller',
			operationName: 'isolated',
			profileId: 'default',
		}).operation;
		if (operation.executionTarget.kind !== 'ephemeral_managed_vm') {
			throw new Error('Expected prepared credentialed Managed VM operation.');
		}

		expect(prepareImage).toHaveBeenCalledWith({
			cacheDirectory: expect.stringMatching(
				/agent-vm-effective-tool-portal\/controller-execution-images\/[a-f0-9]{64}$/u,
			),
			recipePath: path.resolve(
				authoredConfigDir,
				'../../vm-images/controller-runners/default/build-config.json',
			),
		});
		expect(
			decodeConfiguredCliPreparedImageIdentity(operation.executionTarget.imageReference),
		).toEqual({
			fingerprint: 'fingerprint-prepared-a',
			imageReference: '/cache/prepared-image-a',
			schemaVersion: 1,
		});
	});

	it('fails closed when ephemeral image preparation is unavailable', async () => {
		await expect(
			resolveMcpPortalEffectiveConfigFromConfig({
				...createPlanPropsForTest({
					mcpConfig: { providers: {}, schemaVersion: 1 },
					toolPortalConfig: createEphemeralConfiguredCliToolPortalConfigInput(),
				}),
				authoredConfigDir: path.join(tmpdir(), 'agent-vm-authored-tool-portal'),
			}),
		).rejects.toThrow('require the existing Managed VM image preparation capability');
	});

	it('does not prepare an ephemeral image for a policy-unreachable operation', async () => {
		const toolPortalConfig = parseToolPortalConfigForTest(
			createEphemeralConfiguredCliToolPortalConfigInput(),
		);
		if (toolPortalConfig.mode !== 'managed') throw new Error('Expected managed config.');
		const namespacePolicy = toolPortalConfig.profiles.default?.namespaces.controller;
		if (namespacePolicy?.backend.kind !== 'controller_execution') {
			throw new Error('Expected controller execution namespace.');
		}
		namespacePolicy.tools.allow = [];
		namespacePolicy.calls.withoutApproval.allow = [];

		const result = await resolveMcpPortalEffectiveConfigFromConfig({
			...createPlanPropsForTest({
				mcpConfig: { providers: {}, schemaVersion: 1 },
				toolPortalConfig,
			}),
			authoredConfigDir: path.join(tmpdir(), 'agent-vm-authored-tool-portal'),
		});
		expect(
			result.effectiveToolPortalConfig.profiles.default?.namespaces.controller,
		).toBeUndefined();
	});

	it('changes binding freshness when prepared bytes change behind one recipe path', async () => {
		let fingerprint = 'fingerprint-prepared-a';
		const props = {
			...createPlanPropsForTest({
				mcpConfig: { providers: {}, schemaVersion: 1 },
				toolPortalConfig: createEphemeralConfiguredCliToolPortalConfigInput(),
			}),
			authoredConfigDir: path.join(tmpdir(), 'agent-vm-authored-tool-portal'),
			managedVmImages: {
				prepareImage: async () => ({
					built: true,
					fingerprint,
					imageReference: `/cache/${fingerprint}`,
				}),
			},
		};
		const first = await resolveMcpPortalEffectiveConfigFromConfig(props);
		fingerprint = 'fingerprint-prepared-b';
		const second = await resolveMcpPortalEffectiveConfigFromConfig(props);

		expect(deriveGatewayRuntimePortalBindingRevision(first.effectiveToolPortalConfig)).not.toBe(
			deriveGatewayRuntimePortalBindingRevision(second.effectiveToolPortalConfig),
		);
	});

	it('reports HTTP provider URL hosts as required gateway egress', async () => {
		const mcpConfig = {
			providers: {
				deepwiki: {
					kind: 'mcp',
					namespace: 'deepwiki',
					transport: { kind: 'streamable-http', url: 'https://mcp.deepwiki.com/mcp' },
				},
			},
			schemaVersion: 1,
		};
		const zoneEgressHosts = [{ audience: 'gateway', host: 'api.openai.com' }];

		await expect(
			planMcpPortalEffectiveConfigFromConfig({
				...createPlanPropsForTest({ mcpConfig }),
			}),
		).resolves.toMatchObject({
			requiredGatewayEgressHosts: ['mcp.deepwiki.com'],
		});
		expect(mcpConfig.providers.deepwiki.transport).toEqual({
			kind: 'streamable-http',
			url: 'https://mcp.deepwiki.com/mcp',
		});
		expect(zoneEgressHosts).toEqual([{ audience: 'gateway', host: 'api.openai.com' }]);
	});

	it('rejects managed Tool Portal agents outside declared zone agents during materialization', async () => {
		const mcpConfig = { providers: {}, schemaVersion: 1 };

		await expect(
			planMcpPortalEffectiveConfigFromConfig(
				createPlanPropsForTest({
					declaredAgentIds: ['main'],
					mcpConfig,
					toolPortalConfig: {
						agents: {
							main: { profile: 'default' },
							ghost: { profile: 'default' },
						},
						mode: 'managed',
						profiles: {
							default: { namespaces: {} },
						},
						schemaVersion: 1,
					},
					zoneId: 'zone-a',
				}),
			),
		).rejects.toThrow(/tool-portal\.config\.jsonc declares undeclared agent "ghost"/u);
	});

	it('rejects managed Tool Portal config missing declared zone agents during materialization', async () => {
		const mcpConfig = { providers: {}, schemaVersion: 1 };

		await expect(
			planMcpPortalEffectiveConfigFromConfig(
				createPlanPropsForTest({
					declaredAgentIds: ['main', 'second'],
					mcpConfig,
					toolPortalConfig: {
						agents: {
							main: { profile: 'default' },
						},
						mode: 'managed',
						profiles: {
							default: { namespaces: {} },
						},
						schemaVersion: 1,
					},
					zoneId: 'zone-a',
				}),
			),
		).rejects.toThrow(/declared agent "second" is missing from tool-portal\.config\.jsonc agents/u);
	});

	it('materializes matching same-zone multi-agent Tool Portal bindings', async () => {
		const plan = await planMcpPortalEffectiveConfigFromConfig(
			createPlanPropsForTest({
				declaredAgentIds: ['main', 'second'],
				mcpConfig: { providers: {}, schemaVersion: 1 },
				toolPortalConfig: {
					agents: {
						main: { profile: 'default' },
						second: { profile: 'readonly' },
					},
					mode: 'managed',
					profiles: {
						default: { namespaces: {} },
						readonly: { namespaces: {} },
					},
					schemaVersion: 1,
				},
				zoneId: 'zone-a',
			}),
		);

		expect(plan.effectivePortalConfig.agents).toEqual({
			main: { credentialVersion: 1, profile: 'default' },
			second: { credentialVersion: 1, profile: 'readonly' },
		});
	});

	it('rejects approval-required managed calls when protected approval access is absent', async () => {
		// Arrange
		const props = createPlanPropsForTest({
			approvalAccessConfigured: false,
			mcpConfig: {
				providers: {
					deepwiki: {
						kind: 'mcp',
						namespace: 'deepwiki',
						transport: { kind: 'streamable-http', url: 'https://mcp.deepwiki.com/mcp' },
					},
				},
				schemaVersion: 1,
			},
			toolPortalConfig: {
				agents: { shravan: { profile: 'default' } },
				mode: 'managed',
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								backend: { kind: 'mcp_provider' },
								calls: {
									requiresApproval: { allow: ['ask_question'] },
									withoutApproval: { allow: [] },
								},
								tools: { allow: ['ask_question'] },
							},
						},
					},
				},
				schemaVersion: 1,
			},
		});

		// Act
		const planPromise = planMcpPortalEffectiveConfigFromConfig(props);

		// Assert
		await expect(planPromise).rejects.toThrow(
			/managed calls requiring approval require zones\[\]\.approvalAccess/u,
		);
	});

	it('derives approval access from visible direct-baseline configured CLI matchers', async () => {
		const configuredOperation = createConfiguredCliOperationForOverlapTest({
			commandPath: ['drive', 'delete'],
			mandatoryArgvPrefix: [],
			safeHelp: 'Delete one Drive item.',
		});
		configuredOperation.calls.requiresApproval = [
			{ flags: [{ names: ['--permanent'] }], path: ['drive', 'delete'] },
		];
		const toolPortalConfig = {
			agents: { shravan: { profile: 'default' } },
			mode: 'managed' as const,
			profiles: {
				default: {
					namespaces: {
						google: {
							backend: {
								kind: 'controller_execution' as const,
								operations: { gog: configuredOperation },
							},
							calls: {
								requiresApproval: { allow: [] as string[] },
								withoutApproval: { allow: ['gog'] },
							},
							tools: { allow: ['gog'] },
						},
					},
				},
			},
			schemaVersion: 1 as const,
		};

		await expect(
			planMcpPortalEffectiveConfigFromConfig(
				createPlanPropsForTest({
					approvalAccessConfigured: false,
					mcpConfig: { providers: {}, schemaVersion: 1 },
					toolPortalConfig,
				}),
			),
		).rejects.toThrow(/managed calls requiring approval require zones\[\]\.approvalAccess/u);

		configuredOperation.calls.requiresApproval = [];
		await expect(
			planMcpPortalEffectiveConfigFromConfig(
				createPlanPropsForTest({
					approvalAccessConfigured: false,
					mcpConfig: { providers: {}, schemaVersion: 1 },
					toolPortalConfig,
				}),
			),
		).resolves.toBeDefined();
	});

	it('requires approval access for visible Tool VM CLI approval hints', async () => {
		const toolPortalConfig = {
			agents: { shravan: { profile: 'default' } },
			mode: 'managed' as const,
			profiles: {
				default: {
					namespaces: {
						sandbox: {
							backend: {
								kind: 'tool_vm_runner' as const,
								operations: {
									cli: {
										advisoryHints: {
											hintDeny: [],
											hintRequiresApproval: [{ flags: [], path: ['publish'] }],
										},
										executable: '/usr/local/bin/tool',
										kind: 'command.cli' as const,
										output: {
											modelVisibleStderr: 'none' as const,
											overflow: 'truncate' as const,
											stderrMaxBytes: 1_024,
											stdoutMaxBytes: 1_024,
										},
										safeHelp: 'Run the Tool VM CLI.',
										timeout: { kind: 'quick' as const },
										workingDirectory: '.',
									},
								},
								profile: 'sandbox_ssh' as const,
							},
							calls: {
								requiresApproval: { allow: [] as string[] },
								withoutApproval: { allow: ['cli'] },
							},
							tools: { allow: ['cli'] },
						},
					},
				},
			},
			schemaVersion: 1 as const,
		};

		await expect(
			planMcpPortalEffectiveConfigFromConfig(
				createPlanPropsForTest({
					approvalAccessConfigured: false,
					mcpConfig: { providers: {}, schemaVersion: 1 },
					toolPortalConfig,
				}),
			),
		).rejects.toThrow(/managed calls requiring approval require zones\[\]\.approvalAccess/u);
	});

	it('does not report loopback HTTP provider URLs as external gateway egress', async () => {
		const mcpConfig = {
			providers: {
				local_proxy: {
					kind: 'mcp',
					namespace: 'local_proxy',
					transport: { kind: 'streamable-http', url: 'http://127.0.0.1:18791/mcp' },
				},
				localhost_proxy: {
					kind: 'mcp',
					namespace: 'localhost_proxy',
					transport: { kind: 'sse', url: 'http://localhost:18792/sse' },
				},
			},
			schemaVersion: 1,
		};

		await expect(
			planMcpPortalEffectiveConfigFromConfig(createPlanPropsForTest({ mcpConfig })),
		).resolves.toMatchObject({
			requiredGatewayEgressHosts: [],
		});
	});

	it('reports SSE provider URL hosts as required gateway egress', async () => {
		const mcpConfig = {
			providers: {
				linear: {
					kind: 'mcp',
					namespace: 'linear',
					transport: { kind: 'sse', url: 'https://events.linear.app/sse' },
				},
			},
			schemaVersion: 1,
		};

		await expect(
			planMcpPortalEffectiveConfigFromConfig(createPlanPropsForTest({ mcpConfig })),
		).resolves.toMatchObject({
			requiredGatewayEgressHosts: ['events.linear.app'],
		});
	});

	it('reports stdio required egress hosts', async () => {
		const mcpConfig = {
			providers: {
				tavily: {
					kind: 'mcp',
					namespace: 'tavily',
					transport: {
						args: ['-y', 'tavily-mcp'],
						command: 'npx',
						kind: 'stdio',
						networkAccess: 'declared',
						requiredEgressHosts: ['api.tavily.com'],
					},
				},
			},
			schemaVersion: 1,
		};

		await expect(
			planMcpPortalEffectiveConfigFromConfig(createPlanPropsForTest({ mcpConfig })),
		).resolves.toMatchObject({
			requiredGatewayEgressHosts: ['api.tavily.com'],
		});
	});

	it('requires stdio network access declarations', async () => {
		const mcpConfig = {
			providers: {
				tavily: {
					kind: 'mcp',
					namespace: 'tavily',
					transport: { args: ['-y', 'tavily-mcp'], command: 'npx', kind: 'stdio' },
				},
			},
			schemaVersion: 1,
		};

		await expect(
			planMcpPortalEffectiveConfigFromConfig(createPlanPropsForTest({ mcpConfig })),
		).rejects.toThrow(/tavily.*networkAccess/u);
	});

	it('requires stdio egress declarations for network-capable providers', async () => {
		const mcpConfig = {
			providers: {
				tavily: {
					kind: 'mcp',
					namespace: 'tavily',
					transport: {
						args: ['-y', 'tavily-mcp'],
						command: 'npx',
						kind: 'stdio',
						networkAccess: 'declared',
					},
				},
			},
			schemaVersion: 1,
		};

		await expect(
			planMcpPortalEffectiveConfigFromConfig(createPlanPropsForTest({ mcpConfig })),
		).rejects.toThrow(/tavily.*requiredEgressHosts/u);
	});

	it('allows explicitly local-only stdio providers', async () => {
		const mcpConfig = {
			providers: {
				local_repo: {
					kind: 'mcp',
					namespace: 'local_repo',
					transport: {
						args: ['server'],
						command: 'local-mcp',
						kind: 'stdio',
						networkAccess: 'none',
					},
				},
			},
			schemaVersion: 1,
		};

		await expect(
			planMcpPortalEffectiveConfigFromConfig(createPlanPropsForTest({ mcpConfig })),
		).resolves.toMatchObject({
			requiredGatewayEgressHosts: [],
		});
	});

	it('rejects malformed provider and mediated secret hosts', async () => {
		await Promise.all(
			['*.example.com', '', 'https://api.example.com/path'].map(async (host) => {
				const mcpConfig = {
					providers: {
						tavily: {
							kind: 'mcp',
							namespace: 'tavily',
							secretPolicies: {
								TAVILY_API_KEY: { hosts: [host], injection: 'http-mediation' },
							},
							transport: {
								args: ['-y', 'tavily-mcp'],
								command: 'npx',
								env: {
									TAVILY_API_KEY: {
										ref: 'op://agent-vm/tavily/credential',
										source: '1password',
									},
								},
								kind: 'stdio',
								networkAccess: 'declared',
								requiredEgressHosts: ['api.tavily.com'],
							},
						},
					},
					schemaVersion: 1,
				};

				await expect(
					planMcpPortalEffectiveConfigFromConfig(createPlanPropsForTest({ mcpConfig })),
				).rejects.toThrow(/secret policy TAVILY_API_KEY/u);
			}),
		);
	});

	it('deduplicates required gateway egress hosts', async () => {
		const mcpConfig = {
			providers: {
				linear: {
					kind: 'mcp',
					namespace: 'linear',
					secretPolicies: {
						authorization: { hosts: ['api.linear.app'], injection: 'http-mediation' },
					},
					transport: {
						headers: {
							authorization: {
								ref: 'op://agent-vm/linear/credential',
								source: '1password',
							},
						},
						kind: 'streamable-http',
						url: 'https://api.linear.app/mcp',
					},
				},
			},
			schemaVersion: 1,
		};

		await expect(
			planMcpPortalEffectiveConfigFromConfig(createPlanPropsForTest({ mcpConfig })),
		).resolves.toMatchObject({
			requiredGatewayEgressHosts: ['api.linear.app'],
		});
	});

	it('derives the internal MCP projection from strict managed Tool Portal policy', async () => {
		const toolPortalConfig = {
			agents: { shravan: { profile: 'default' } },
			mode: 'managed',
			profiles: { default: { namespaces: {} } },
			schemaVersion: 1,
		};
		const plan = await planMcpPortalEffectiveConfigFromConfig(
			createPlanPropsForTest({
				mcpConfig: { providers: {}, schemaVersion: 1 },
				toolPortalConfig,
			}),
		);
		const effectivePortalConfig = plan.effectivePortalConfig;

		expect(effectivePortalConfig.agents).toEqual({
			shravan: { credentialVersion: 1, profile: 'default' },
		});
		expect(effectivePortalConfig.externalAuth).toBeUndefined();
		expect(effectivePortalConfig.mcpProxy).toBeUndefined();
		expect(plan.effectiveToolPortalConfig).toEqual(parseToolPortalConfigForTest(toolPortalConfig));
	});

	it('preserves explicit controller execution namespaces for the authored profile', async () => {
		const plan = await planMcpPortalEffectiveConfigFromConfig(
			createPlanPropsForTest({
				mcpConfig: { providers: {}, schemaVersion: 1 },
				toolPortalConfig: {
					agents: {
						readonly: { profile: 'readonly' },
						shravan: { profile: 'default' },
					},
					mode: 'managed',
					profiles: {
						default: {
							namespaces: {
								controller_execution: {
									backend: {
										kind: 'controller_execution',
										operations: {
											controller_host_probe: { kind: 'registered_action' },
											workspace_git_push: { kind: 'registered_action' },
											push_branch: { kind: 'registered_action' },
											protected_uds: { kind: 'registered_action' },
										},
									},
									calls: {
										requiresApproval: { allow: [] },
										withoutApproval: {
											allow: ['workspace_git_push', 'controller_host_probe'],
										},
									},
									tools: { allow: ['workspace_git_push', 'controller_host_probe'] },
								},
							},
						},
						readonly: { namespaces: {} },
					},
					schemaVersion: 1,
				},
				workspaceGitPushAgentEligibility: { eligibleAgentIds: ['shravan'] },
			}),
		);

		expect(
			plan.effectiveToolPortalConfig.profiles.default?.namespaces.controller_execution,
		).toEqual({
			backend: {
				kind: 'controller_execution',
				operations: {
					controller_host_probe: { kind: 'registered_action' },
					workspace_git_push: { kind: 'registered_action' },
					push_branch: { kind: 'registered_action' },
					protected_uds: { kind: 'registered_action' },
				},
			},
			calls: {
				requiresApproval: { allow: [], deny: [] },
				withoutApproval: { allow: ['workspace_git_push', 'controller_host_probe'], deny: [] },
			},
			discovery: {},
			tools: { allow: ['workspace_git_push', 'controller_host_probe'], deny: [] },
		});
		expect(
			plan.effectiveToolPortalConfig.profiles.readonly?.namespaces.controller_execution,
		).toBeUndefined();
	});

	it('preserves controller host probe without requiring remote workspace Git', async () => {
		const plan = await planMcpPortalEffectiveConfigFromConfig(
			createPlanPropsForTest({
				mcpConfig: { providers: {}, schemaVersion: 1 },
				toolPortalConfig: {
					agents: { shravan: { profile: 'default' } },
					mode: 'managed',
					profiles: {
						default: {
							namespaces: {
								controller_execution: {
									backend: {
										kind: 'controller_execution',
										operations: {
											controller_host_probe: { kind: 'registered_action' },
											workspace_git_push: { kind: 'registered_action' },
											push_branch: { kind: 'registered_action' },
											protected_uds: { kind: 'registered_action' },
										},
									},
									calls: {
										requiresApproval: { allow: [] },
										withoutApproval: { allow: ['controller_host_probe'] },
									},
									tools: { allow: ['controller_host_probe'] },
								},
							},
						},
					},
					schemaVersion: 1,
				},
			}),
		);

		expect(
			plan.effectiveToolPortalConfig.profiles.default?.namespaces.controller_execution,
		).toEqual({
			backend: {
				kind: 'controller_execution',
				operations: {
					controller_host_probe: { kind: 'registered_action' },
					workspace_git_push: { kind: 'registered_action' },
					push_branch: { kind: 'registered_action' },
					protected_uds: { kind: 'registered_action' },
				},
			},
			calls: {
				requiresApproval: { allow: [], deny: [] },
				withoutApproval: { allow: ['controller_host_probe'], deny: [] },
			},
			discovery: {},
			tools: { allow: ['controller_host_probe'], deny: [] },
		});
	});

	it('rejects effective configured CLI aliases across operations and namespaces', async () => {
		await expect(
			planMcpPortalEffectiveConfigFromConfig(
				createPlanPropsForTest({
					approvalAccessConfigured: true,
					mcpConfig: { providers: {}, schemaVersion: 1 },
					toolPortalConfig: {
						agents: { shravan: { profile: 'default' } },
						mode: 'managed',
						profiles: {
							default: {
								namespaces: {
									approval_free: {
										backend: {
											kind: 'controller_execution',
											operations: {
												remove_any: createConfiguredCliOperationForOverlapTest({
													commandPath: ['remove'],
													mandatoryArgvPrefix: [],
													safeHelp: 'Remove one item.',
												}),
											},
										},
										calls: {
											requiresApproval: { allow: [] },
											withoutApproval: { allow: ['remove_any'] },
										},
										tools: { allow: ['remove_any'] },
									},
									protected: {
										backend: {
											kind: 'controller_execution',
											operations: {
												remove_all: createConfiguredCliOperationForOverlapTest({
													commandPath: ['all'],
													mandatoryArgvPrefix: ['remove'],
													safeHelp: 'Remove all items.',
												}),
											},
										},
										calls: {
											requiresApproval: { allow: ['remove_all'] },
											withoutApproval: { allow: [] },
										},
										tools: { allow: ['remove_all'] },
									},
								},
							},
						},
						schemaVersion: 1,
					},
				}),
			),
		).rejects.toThrow(/effective configured CLI command/u);
	});

	it('rejects workspace Git push materialization for an ineligible agent', async () => {
		await expect(
			planMcpPortalEffectiveConfigFromConfig(
				createPlanPropsForTest({
					mcpConfig: { providers: {}, schemaVersion: 1 },
					toolPortalConfig: {
						agents: { shravan: { profile: 'default' } },
						mode: 'managed',
						profiles: {
							default: {
								namespaces: {
									controller_execution: {
										backend: {
											kind: 'controller_execution',
											operations: {
												controller_host_probe: { kind: 'registered_action' },
												workspace_git_push: { kind: 'registered_action' },
												push_branch: { kind: 'registered_action' },
												protected_uds: { kind: 'registered_action' },
											},
										},
										calls: {
											requiresApproval: { allow: [] },
											withoutApproval: { allow: ['workspace_git_push'] },
										},
										tools: { allow: ['workspace_git_push'] },
									},
								},
							},
						},
						schemaVersion: 1,
					},
					workspaceGitPushAgentEligibility: { eligibleAgentIds: [] },
				}),
			),
		).rejects.toThrow(
			/managed agent "shravan" assigned profile "default" cannot allow workspace_git_push/u,
		);
	});

	it('rejects a shared workspace Git push profile when any assigned agent is ineligible', async () => {
		await expect(
			planMcpPortalEffectiveConfigFromConfig(
				createPlanPropsForTest({
					declaredAgentIds: ['remote-agent', 'local-agent'],
					mcpConfig: { providers: {}, schemaVersion: 1 },
					toolPortalConfig: {
						agents: {
							'local-agent': { profile: 'shared' },
							'remote-agent': { profile: 'shared' },
						},
						mode: 'managed',
						profiles: {
							shared: {
								namespaces: {
									controller_execution: {
										backend: {
											kind: 'controller_execution',
											operations: {
												controller_host_probe: { kind: 'registered_action' },
												workspace_git_push: { kind: 'registered_action' },
												push_branch: { kind: 'registered_action' },
												protected_uds: { kind: 'registered_action' },
											},
										},
										calls: {
											requiresApproval: { allow: [] },
											withoutApproval: { allow: ['workspace_git_push'] },
										},
										tools: { allow: ['workspace_git_push'] },
									},
								},
							},
						},
						schemaVersion: 1,
					},
					workspaceGitPushAgentEligibility: { eligibleAgentIds: ['remote-agent'] },
				}),
			),
		).rejects.toThrow(
			/managed agent "local-agent" assigned profile "shared" cannot allow workspace_git_push/u,
		);
	});

	it('preserves managed MCP namespaces that require approval', async () => {
		const mcpConfig = {
			providers: {
				deepwiki: {
					discovery: { summary: 'Repository documentation and Q&A.' },
					kind: 'mcp',
					namespace: 'deepwiki',
					transport: { kind: 'streamable-http', url: 'https://deepwiki.test/mcp' },
				},
			},
			schemaVersion: 1,
		};

		const plan = await planMcpPortalEffectiveConfigFromConfig(
			createPlanPropsForTest({
				approvalAccessConfigured: true,
				mcpConfig,
				toolPortalConfig: {
					agents: { shravan: { profile: 'default' } },
					mode: 'managed',
					profiles: {
						default: {
							namespaces: {
								deepwiki: {
									backend: { kind: 'mcp_provider' },
									calls: {
										requiresApproval: { allow: ['ask_question'] },
										withoutApproval: { allow: [] },
									},
									tools: { allow: '*' },
								},
							},
						},
					},
					schemaVersion: 1,
				},
			}),
		);

		expect(plan.effectiveToolPortalConfig.profiles.default?.namespaces.deepwiki).toEqual({
			backend: { kind: 'mcp_provider' },
			calls: {
				requiresApproval: { allow: ['ask_question'], deny: [] },
				withoutApproval: { allow: [], deny: [] },
			},
			tools: { allow: '*', deny: [] },
		});
	});

	it('preserves managed MCP namespaces that require approval for every tool', async () => {
		const mcpConfig = {
			providers: {
				deepwiki: {
					kind: 'mcp',
					namespace: 'deepwiki',
					transport: { kind: 'streamable-http', url: 'https://deepwiki.test/mcp' },
				},
			},
			schemaVersion: 1,
		};

		const plan = await planMcpPortalEffectiveConfigFromConfig(
			createPlanPropsForTest({
				approvalAccessConfigured: true,
				mcpConfig,
				toolPortalConfig: {
					agents: { shravan: { profile: 'default' } },
					mode: 'managed',
					profiles: {
						default: {
							namespaces: {
								deepwiki: {
									backend: { kind: 'mcp_provider' },
									calls: {
										requiresApproval: { allow: '*' },
										withoutApproval: { allow: [] },
									},
									tools: { allow: '*' },
								},
							},
						},
					},
					schemaVersion: 1,
				},
			}),
		);

		expect(
			plan.effectiveToolPortalConfig.profiles.default?.namespaces.deepwiki?.calls.requiresApproval,
		).toEqual({ allow: '*', deny: [] });
	});

	it('materializes effective discovery from the sole backend-specific summary source', async () => {
		const plan = await resolveMcpPortalEffectiveConfigFromConfig(
			createPlanPropsForTest({
				mcpConfig: {
					providers: {
						'deepwiki-production': {
							discovery: { summary: 'Repository documentation and Q&A.' },
							kind: 'mcp',
							namespace: 'deepwiki',
							transport: { kind: 'streamable-http', url: 'https://deepwiki.test/mcp' },
						},
					},
					schemaVersion: 1,
				},
				toolPortalConfig: {
					agents: { shravan: { profile: 'default' } },
					mode: 'managed',
					profiles: {
						default: {
							namespaces: {
								deepwiki: {
									backend: { kind: 'mcp_provider' },
									calls: {
										requiresApproval: { allow: [] },
										withoutApproval: { allow: '*' },
									},
									tools: { allow: '*' },
								},
								controller_execution: {
									backend: {
										kind: 'controller_execution',
										operations: {
											controller_host_probe: { kind: 'registered_action' },
										},
									},
									calls: {
										requiresApproval: { allow: [] },
										withoutApproval: { allow: ['controller_host_probe'] },
									},
									discovery: { summary: 'Controller-local tools.' },
									tools: { allow: ['controller_host_probe'] },
								},
							},
						},
					},
					schemaVersion: 1,
				},
			}),
		);

		expect(plan.effectiveToolPortalConfig.profiles.default?.namespaces).toMatchObject({
			deepwiki: { discovery: { summary: 'Repository documentation and Q&A.' } },
			controller_execution: { discovery: { summary: 'Controller-local tools.' } },
		});
	});

	it('rejects broad authored controller execution policy for registered workspace Git', async () => {
		await expect(
			planMcpPortalEffectiveConfigFromConfig(
				createPlanPropsForTest({
					mcpConfig: { providers: {}, schemaVersion: 1 },
					toolPortalConfig: {
						agents: { shravan: { profile: 'default' } },
						mode: 'managed',
						profiles: {
							default: {
								namespaces: {
									controller_execution: {
										backend: {
											kind: 'controller_execution',
											operations: {
												controller_host_probe: { kind: 'registered_action' },
												workspace_git_push: { kind: 'registered_action' },
												push_branch: { kind: 'registered_action' },
												protected_uds: { kind: 'registered_action' },
											},
										},
										calls: {
											requiresApproval: { allow: [] },
											withoutApproval: { allow: '*' },
										},
										tools: { allow: '*' },
									},
								},
							},
						},
						schemaVersion: 1,
					},
					workspaceGitPushAgentEligibility: { eligibleAgentIds: ['shravan'] },
				}),
			),
		).rejects.toThrow(/namespace "controller_execution" tools must explicitly allow/u);
	});

	it('rejects unknown registered controller execution tools for managed Hermes', async () => {
		await expect(
			planMcpPortalEffectiveConfigFromConfig(
				createPlanPropsForTest({
					mcpConfig: { providers: {}, schemaVersion: 1 },
					toolPortalConfig: {
						agents: { shravan: { profile: 'default' } },
						mode: 'managed',
						profiles: {
							default: {
								namespaces: {
									controller_execution: {
										backend: {
											kind: 'controller_execution',
											operations: {
												controller_host_probe: { kind: 'registered_action' },
												host_shell_exec: { kind: 'registered_action' },
												workspace_git_push: { kind: 'registered_action' },
												push_branch: { kind: 'registered_action' },
												protected_uds: { kind: 'registered_action' },
											},
										},
										calls: {
											requiresApproval: { allow: [] },
											withoutApproval: { allow: ['workspace_git_push', 'host_shell_exec'] },
										},
										tools: { allow: ['workspace_git_push', 'host_shell_exec'] },
									},
								},
							},
						},
						schemaVersion: 1,
					},
					workspaceGitPushAgentEligibility: { eligibleAgentIds: ['shravan'] },
				}),
			),
		).rejects.toThrow(/unknown registered controller execution action/u);
	});

	it('rejects registered controller execution actions outside their definition-owned namespace', async () => {
		await expect(
			planMcpPortalEffectiveConfigFromConfig(
				createPlanPropsForTest({
					mcpConfig: { providers: {}, schemaVersion: 1 },
					toolPortalConfig: {
						agents: { shravan: { profile: 'default' } },
						mode: 'managed',
						profiles: {
							default: {
								namespaces: {
									custom_actions: {
										backend: {
											kind: 'controller_execution',
											operations: {
												controller_host_probe: { kind: 'registered_action' },
											},
										},
										calls: {
											requiresApproval: { allow: [] },
											withoutApproval: { allow: ['controller_host_probe'] },
										},
										tools: { allow: ['controller_host_probe'] },
									},
								},
							},
						},
						schemaVersion: 1,
					},
				}),
			),
		).rejects.toThrow(/cannot remap definition-owned registered controller execution actions/u);
	});

	it('resolves 1Password provider secrets once and writes environment-only effective configs', async () => {
		const mcpConfig = {
			providers: {
				tavily: {
					kind: 'mcp',
					namespace: 'tavily',
					secretPolicies: {
						TAVILY_API_KEY: { hosts: ['api.tavily.com'], injection: 'http-mediation' },
					},
					transport: {
						args: ['-y', 'tavily-mcp'],
						command: 'npx',
						env: {
							TAVILY_API_KEY: {
								ref: 'op://agent-vm/tavily/credential',
								source: '1password',
							},
						},
						kind: 'stdio',
						networkAccess: 'declared',
						requiredEgressHosts: ['api.tavily.com'],
					},
				},
			},
			schemaVersion: 1,
		};
		const secretResolver = createSecretResolver({
			'op://agent-vm/tavily/credential': 'resolved-tavily',
		});

		const result = await resolveMcpPortalEffectiveConfigFromConfig(
			createPlanPropsForTest({ mcpConfig, secretResolver }),
		);
		const effectiveMcpConfig = result.effectiveMcpConfig as {
			readonly providers: Record<string, { readonly transport: { readonly env: unknown } }>;
		};

		expect(secretResolver.resolveAllMock).toHaveBeenCalledTimes(1);
		expect(effectiveMcpConfig.providers.tavily?.transport.env).toEqual({
			TAVILY_API_KEY: {
				name: 'AGENT_VM_MCP_TAVILY_TAVILY_API_KEY',
				source: 'environment',
			},
		});
		expect(result.runtimeMediatedSecrets).toEqual({
			AGENT_VM_MCP_TAVILY_TAVILY_API_KEY: {
				hosts: ['api.tavily.com'],
				value: 'resolved-tavily',
			},
		});
		expect(result.runtimeEnvironment).toEqual({});
		expect(result).not.toHaveProperty('pluginConfig');
	});

	it('generates provider-scoped secret env names to avoid cross-provider collisions', async () => {
		const mcpConfig = {
			providers: {
				linear: {
					kind: 'mcp',
					namespace: 'linear',
					secretPolicies: {
						authorization: { hosts: ['api.linear.app'], injection: 'http-mediation' },
					},
					transport: {
						headers: {
							authorization: {
								ref: 'op://agent-vm/linear/credential',
								source: '1password',
							},
						},
						kind: 'streamable-http',
						url: 'https://api.linear.app/mcp',
					},
				},
				notion: {
					kind: 'mcp',
					namespace: 'notion',
					secretPolicies: {
						authorization: { hosts: ['api.notion.com'], injection: 'http-mediation' },
					},
					transport: {
						headers: {
							authorization: {
								ref: 'op://agent-vm/notion/credential',
								source: '1password',
							},
						},
						kind: 'streamable-http',
						url: 'https://api.notion.com/mcp',
					},
				},
			},
			schemaVersion: 1,
		};
		const secretResolver = createSecretResolver({
			'op://agent-vm/linear/credential': 'linear-token',
			'op://agent-vm/notion/credential': 'notion-token',
		});

		const result = await resolveMcpPortalEffectiveConfigFromConfig(
			createPlanPropsForTest({ mcpConfig, secretResolver }),
		);

		expect(result.effectiveMcpConfig.providers.linear?.transport).toMatchObject({
			headers: {
				authorization: { name: 'AGENT_VM_MCP_LINEAR_AUTHORIZATION', source: 'environment' },
			},
		});
		expect(result.effectiveMcpConfig.providers.notion?.transport).toMatchObject({
			headers: {
				authorization: { name: 'AGENT_VM_MCP_NOTION_AUTHORIZATION', source: 'environment' },
			},
		});
		expect(result.runtimeMediatedSecrets).toEqual({
			AGENT_VM_MCP_LINEAR_AUTHORIZATION: {
				hosts: ['api.linear.app'],
				value: 'linear-token',
			},
			AGENT_VM_MCP_NOTION_AUTHORIZATION: {
				hosts: ['api.notion.com'],
				value: 'notion-token',
			},
		});
		expect(secretResolver.resolveAllMock).toHaveBeenCalledWith({
			AGENT_VM_MCP_LINEAR_AUTHORIZATION: {
				ref: 'op://agent-vm/linear/credential',
				source: '1password',
			},
			AGENT_VM_MCP_NOTION_AUTHORIZATION: {
				ref: 'op://agent-vm/notion/credential',
				source: '1password',
			},
		});
	});

	it('preserves provider secret formats on generated environment refs while runtime values stay raw', async () => {
		const mcpConfig = {
			providers: {
				linear: {
					kind: 'mcp',
					namespace: 'linear',
					secretPolicies: {
						authorization: { hosts: ['api.linear.app'], injection: 'http-mediation' },
					},
					transport: {
						headers: {
							authorization: {
								format: { kind: 'bearer' },
								ref: 'op://agent-vm/linear/credential',
								source: '1password',
							},
						},
						kind: 'streamable-http',
						url: 'https://api.linear.app/mcp',
					},
				},
				vendor: {
					kind: 'mcp',
					namespace: 'vendor',
					secretPolicies: {
						authorization: { hosts: [], injection: 'env' },
					},
					transport: {
						headers: {
							authorization: {
								format: { kind: 'prefix', prefix: 'Token' },
								name: 'VENDOR_TOKEN',
								source: 'environment',
							},
						},
						kind: 'streamable-http',
						url: 'https://mcp.vendor.test/mcp',
					},
				},
			},
			schemaVersion: 1,
		};
		const secretResolver = createSecretResolver({
			'op://agent-vm/linear/credential': 'linear-token',
			VENDOR_TOKEN: 'vendor-token',
		});

		const result = await resolveMcpPortalEffectiveConfigFromConfig(
			createPlanPropsForTest({
				allowedRawEnvSecretNames: ['AGENT_VM_MCP_VENDOR_AUTHORIZATION'],
				mcpConfig,
				secretResolver,
			}),
		);

		expect(result.effectiveMcpConfig.providers.linear?.transport).toMatchObject({
			headers: {
				authorization: {
					format: { kind: 'bearer' },
					name: 'AGENT_VM_MCP_LINEAR_AUTHORIZATION',
					source: 'environment',
				},
			},
		});
		expect(result.effectiveMcpConfig.providers.vendor?.transport).toMatchObject({
			headers: {
				authorization: {
					format: { kind: 'prefix', prefix: 'Token' },
					name: 'AGENT_VM_MCP_VENDOR_AUTHORIZATION',
					source: 'environment',
				},
			},
		});
		expect(result.runtimeMediatedSecrets).toEqual({
			AGENT_VM_MCP_LINEAR_AUTHORIZATION: {
				hosts: ['api.linear.app'],
				value: 'linear-token',
			},
		});
		expect(result.runtimeEnvironment).toEqual({
			AGENT_VM_MCP_VENDOR_AUTHORIZATION: 'vendor-token',
		});
		expect(secretResolver.resolveAllMock).toHaveBeenCalledWith({
			AGENT_VM_MCP_LINEAR_AUTHORIZATION: {
				ref: 'op://agent-vm/linear/credential',
				source: '1password',
			},
			AGENT_VM_MCP_VENDOR_AUTHORIZATION: {
				ref: 'VENDOR_TOKEN',
				source: 'environment',
			},
		});
	});

	it('reports both source secrets when normalized provider secret names collide', async () => {
		const mcpConfig = {
			providers: {
				linear: {
					kind: 'mcp',
					namespace: 'linear',
					secretPolicies: {
						'api-key': { hosts: ['api.linear.app'], injection: 'http-mediation' },
						api_key: { hosts: ['api.linear.app'], injection: 'http-mediation' },
					},
					transport: {
						headers: {
							'api-key': {
								ref: 'op://agent-vm/linear/api-key',
								source: '1password',
							},
							api_key: {
								ref: 'op://agent-vm/linear/api_key',
								source: '1password',
							},
						},
						kind: 'streamable-http',
						url: 'https://api.linear.app/mcp',
					},
				},
			},
			schemaVersion: 1,
		};

		await expect(
			planMcpPortalEffectiveConfigFromConfig(createPlanPropsForTest({ mcpConfig })),
		).rejects.toThrow(/api-key.*api_key|api_key.*api-key/u);
	});

	it('rejects authored environment provider secrets unless the generated env name is allowlisted', async () => {
		const mcpConfig = {
			providers: {
				linear: {
					kind: 'mcp',
					namespace: 'linear',
					secretPolicies: {
						authorization: { hosts: [], injection: 'env' },
					},
					transport: {
						headers: {
							authorization: {
								name: 'LINEAR_MCP_TOKEN',
								source: 'environment',
							},
						},
						kind: 'streamable-http',
						url: 'https://api.linear.app/mcp',
					},
				},
			},
			schemaVersion: 1,
		};
		const secretResolver = createSecretResolver({
			LINEAR_MCP_TOKEN: 'linear-env-token',
		});

		await expect(
			resolveMcpPortalEffectiveConfigFromConfig(
				createPlanPropsForTest({ mcpConfig, secretResolver }),
			),
		).rejects.toThrow(/AGENT_VM_MCP_LINEAR_AUTHORIZATION.*rawEnvSecrets/u);
	});

	it('materializes explicitly allowlisted environment provider secrets through the shared resolver', async () => {
		const mcpConfig = {
			providers: {
				linear: {
					kind: 'mcp',
					namespace: 'linear',
					secretPolicies: {
						authorization: { hosts: [], injection: 'env' },
					},
					transport: {
						headers: {
							authorization: {
								name: 'LINEAR_MCP_TOKEN',
								source: 'environment',
							},
						},
						kind: 'streamable-http',
						url: 'https://api.linear.app/mcp',
					},
				},
			},
			schemaVersion: 1,
		};
		const secretResolver = createSecretResolver({
			LINEAR_MCP_TOKEN: 'linear-env-token',
		});

		const result = await resolveMcpPortalEffectiveConfigFromConfig(
			createPlanPropsForTest({
				allowedRawEnvSecretNames: ['AGENT_VM_MCP_LINEAR_AUTHORIZATION'],
				mcpConfig,
				secretResolver,
			}),
		);

		expect(result.effectiveMcpConfig.providers.linear?.transport).toMatchObject({
			headers: {
				authorization: { name: 'AGENT_VM_MCP_LINEAR_AUTHORIZATION', source: 'environment' },
			},
		});
		expect(result.runtimeEnvironment).toEqual({
			AGENT_VM_MCP_LINEAR_AUTHORIZATION: 'linear-env-token',
		});
		expect(result.runtimeMediatedSecrets).toEqual({});
		expect(secretResolver.resolveAllMock).toHaveBeenCalledWith({
			AGENT_VM_MCP_LINEAR_AUTHORIZATION: {
				ref: 'LINEAR_MCP_TOKEN',
				source: 'environment',
			},
		});
	});

	it('materializes stdio provider http-mediation secrets as placeholder environment references', async () => {
		const mcpConfig = {
			providers: {
				perplexity: {
					kind: 'mcp',
					namespace: 'perplexity',
					secretPolicies: {
						PERPLEXITY_API_KEY: {
							hosts: ['api.perplexity.ai'],
							injection: 'http-mediation',
						},
					},
					transport: {
						args: ['-y', '-p', '@perplexity-ai/mcp-server', 'perplexity-mcp'],
						command: 'npx',
						env: {
							PERPLEXITY_API_KEY: {
								ref: 'op://agent-vm/sunfam-perplexity/credential',
								source: '1password',
							},
						},
						kind: 'stdio',
						networkAccess: 'declared',
						requiredEgressHosts: ['api.perplexity.ai'],
					},
				},
			},
			schemaVersion: 1,
		};
		const secretResolver = createSecretResolver({
			'op://agent-vm/sunfam-perplexity/credential': 'resolved-pplx-key',
		});

		const result = await resolveMcpPortalEffectiveConfigFromConfig(
			createPlanPropsForTest({ mcpConfig, secretResolver, zoneId: 'beta' }),
		);

		expect(result.effectiveMcpConfig.providers.perplexity?.transport).toMatchObject({
			env: {
				PERPLEXITY_API_KEY: {
					name: 'AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY',
					source: 'environment',
				},
			},
		});
		expect(result.runtimeEnvironment).toEqual({});
		expect(result.runtimeMediatedSecrets).toEqual({
			AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY: {
				hosts: ['api.perplexity.ai'],
				value: 'resolved-pplx-key',
			},
		});
	});

	it('rejects missing resolved provider secret values', async () => {
		const mcpConfig = {
			providers: {
				tavily: {
					kind: 'mcp',
					namespace: 'tavily',
					secretPolicies: {
						TAVILY_API_KEY: { hosts: ['api.tavily.com'], injection: 'http-mediation' },
					},
					transport: {
						args: ['-y', 'tavily-mcp'],
						command: 'npx',
						env: {
							TAVILY_API_KEY: {
								ref: 'op://agent-vm/tavily/credential',
								source: '1password',
							},
						},
						kind: 'stdio',
						networkAccess: 'declared',
						requiredEgressHosts: ['api.tavily.com'],
					},
				},
			},
			schemaVersion: 1,
		};
		const emptyResolver = {
			resolve: async () => {
				throw new Error('not used');
			},
			resolveAll: vi.fn(async () => ({})),
		} satisfies SecretResolver;

		await expect(
			resolveMcpPortalEffectiveConfigFromConfig(
				createPlanPropsForTest({ mcpConfig, secretResolver: emptyResolver }),
			),
		).rejects.toThrow(/AGENT_VM_MCP_TAVILY_TAVILY_API_KEY/u);
	});

	it('rejects empty resolved provider secret values', async () => {
		const mcpConfig = {
			providers: {
				tavily: {
					kind: 'mcp',
					namespace: 'tavily',
					secretPolicies: {
						TAVILY_API_KEY: { hosts: [], injection: 'env' },
					},
					transport: {
						args: ['-y', 'tavily-mcp'],
						command: 'npx',
						env: {
							TAVILY_API_KEY: {
								ref: 'op://agent-vm/tavily/credential',
								source: '1password',
							},
						},
						kind: 'stdio',
						networkAccess: 'declared',
						requiredEgressHosts: ['api.tavily.com'],
					},
				},
			},
			schemaVersion: 1,
		};
		const emptyValueResolver = {
			resolve: async () => {
				throw new Error('not used');
			},
			resolveAll: vi.fn(async () => ({ AGENT_VM_MCP_TAVILY_TAVILY_API_KEY: '' })),
		} satisfies SecretResolver;

		await expect(
			resolveMcpPortalEffectiveConfigFromConfig(
				createPlanPropsForTest({
					allowedRawEnvSecretNames: ['AGENT_VM_MCP_TAVILY_TAVILY_API_KEY'],
					mcpConfig,
					secretResolver: emptyValueResolver,
				}),
			),
		).rejects.toThrow(/AGENT_VM_MCP_TAVILY_TAVILY_API_KEY/u);
	});
});
