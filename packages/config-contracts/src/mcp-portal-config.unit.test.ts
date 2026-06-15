import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMcpPortalConfig, resolveMcpPortalProfile } from './mcp-portal-config.js';

async function writeConfigFile(text: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'agent-vm-mcp-portal-config-'));
	const configPath = join(directory, 'mcp-portal.config.jsonc');
	await writeFile(configPath, text, 'utf8');
	return configPath;
}

describe('loadMcpPortalConfig', () => {
	it('loads optional proxy auth settings, agents, and profile assignments', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"externalAuth": {
				"masterKey": { "source": "environment", "name": "MCP_PORTAL_MASTER_KEY" }
			},
			"mcpProxy": {
					"server": {
						"host": "127.0.0.1",
						"port": 18791
					},
				"auth": {
					"headerName": "authorization"
				}
			},
			"agents": {
				"shravan": { "profile": "builder" }
			},
			"profiles": {
				"builder": {
					"namespaces": {
						"linear": {
							"tools": { "allow": ["create_issue"] },
							"calls": {
								"withoutApproval": { "allow": [] },
								"requiresApproval": { "allow": ["create_issue"] }
							}
						}
					},
					"logging": { "enabled": true }
				}
			}
		}`);

		const config = await loadMcpPortalConfig(configPath);
		const profile = resolveMcpPortalProfile(config, 'builder');
		expect(config.externalAuth?.masterKey).toEqual({
			name: 'MCP_PORTAL_MASTER_KEY',
			source: 'environment',
		});
		expect(config.mcpProxy?.server.port).toBe(18791);
		expect(config.mcpProxy?.auth.headerName).toBe('authorization');
		expect(config.agents.shravan?.profile).toBe('builder');
		expect(profile).toMatchObject({
			enabledNamespaces: ['linear'],
			enabledToolsByNamespace: { linear: ['create_issue'] },
			hiddenToolsByNamespace: {},
			logging: { enabled: true },
			promptContext: { enabled: true, maxNamespaces: 12 },
		});
	});

	it('rejects legacy shared-header portal server config', async () => {
		const configPath = await writeConfigFile(`{
				"schemaVersion": 1,
				"server": {
					"host": "127.0.0.1",
					"port": 18790,
					"accessHeader": {
						"name": "x-agent-vm-mcp-portal-secret",
						"secret": { "source": "environment", "name": "MCP_PORTAL_SERVER_SECRET" }
					}
				},
				"agents": { "shravan": { "profile": "default" } },
				"profiles": { "default": { "namespaces": {} } }
			}`);

		await expect(loadMcpPortalConfig(configPath)).rejects.toThrow(/server/u);
	});

	it('rejects provider secret formatting on portal auth secrets', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"externalAuth": {
				"masterKey": {
					"source": "environment",
					"name": "MCP_PORTAL_MASTER_KEY",
					"format": { "kind": "bearer" }
				}
			},
			"agents": { "shravan": { "profile": "default" } },
			"profiles": { "default": { "namespaces": {} } }
		}`);

		await expect(loadMcpPortalConfig(configPath)).rejects.toThrow(/format/u);
	});

	it('rejects external proxy hosts outside loopback', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"externalAuth": {
				"masterKey": { "source": "environment", "name": "MCP_PORTAL_MASTER_KEY" }
			},
			"mcpProxy": {
				"server": { "host": "0.0.0.0", "port": 18791 },
				"auth": { "headerName": "authorization" }
			},
			"agents": { "shravan": { "profile": "default" } },
			"profiles": { "default": { "namespaces": {} } }
		}`);

		await expect(loadMcpPortalConfig(configPath)).rejects.toThrow(/loopback/u);
	});

	it('rejects profile inheritance in authored MCP Portal config', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"agents": { "shravan": { "profile": "builder" } },
			"profiles": {
				"builder": { "extends": "default", "namespaces": {} }
			}
		}`);

		await expect(loadMcpPortalConfig(configPath)).rejects.toThrow(/extends/u);
	});

	it('resolves per-namespace authored portal policy into the internal profile shape', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"agents": { "beta": { "profile": "default" } },
			"profiles": {
				"default": {
					"namespaces": {
						"deepwiki": {
							"tools": {
								"allow": ["read_wiki_structure", "ask_question"]
							},
							"calls": {
								"withoutApproval": { "allow": ["read_wiki_structure", "ask_question"] },
								"requiresApproval": { "allow": [] }
							}
						},
						"tavily": {
							"tools": {
								"allow": ["tavily_search", "tavily_extract"]
							},
							"calls": {
								"withoutApproval": { "allow": ["tavily_search", "tavily_extract"] },
								"requiresApproval": { "allow": [] }
							}
						}
					},
					"logging": { "enabled": true }
				}
			}
		}`);

		const config = await loadMcpPortalConfig(configPath);
		const profile = resolveMcpPortalProfile(config, 'default');

		expect(profile.enabledNamespaces).toEqual(['deepwiki', 'tavily']);
		expect(profile.enabledToolsByNamespace).toEqual({
			deepwiki: ['read_wiki_structure', 'ask_question'],
			tavily: ['tavily_search', 'tavily_extract'],
		});
		expect(profile.approval.allowWithoutApprovalTools).toEqual([
			{ namespace: 'deepwiki', toolName: 'read_wiki_structure' },
			{ namespace: 'deepwiki', toolName: 'ask_question' },
			{ namespace: 'tavily', toolName: 'tavily_search' },
			{ namespace: 'tavily', toolName: 'tavily_extract' },
		]);
		expect(profile.logging.enabled).toBe(true);
	});

	it('rejects split legacy namespace and approval profile fields', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"agents": { "beta": { "profile": "default" } },
			"profiles": {
				"default": {
					"enabledNamespaces": ["deepwiki"],
					"enabledToolsByNamespace": { "deepwiki": ["ask_question"] }
				}
			}
		}`);

		await expect(loadMcpPortalConfig(configPath)).rejects.toThrow(/enabledNamespaces/u);
	});

	it('uses only the selected profile as the complete MCP Portal policy', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"agents": { "beta": { "profile": "child" } },
			"profiles": {
				"base": {
					"namespaces": {
						"deepwiki": {
							"tools": { "allow": ["ask_question"] },
							"calls": {
								"withoutApproval": { "allow": ["ask_question"] },
								"requiresApproval": { "allow": [] }
							}
						}
					}
				},
				"child": {
					"namespaces": {
						"deepwiki": {
							"tools": {
								"allow": "*",
								"deny": ["read_wiki_contents"]
							},
							"calls": {
								"withoutApproval": { "allow": [] },
								"requiresApproval": { "allow": ["admin_tool"] }
							}
						}
					}
				}
			}
		}`);

		const config = await loadMcpPortalConfig(configPath);
		const profile = resolveMcpPortalProfile(config, 'child');

		expect(profile.enabledNamespaces).toEqual(['deepwiki']);
		expect(profile.enabledToolsByNamespace).toEqual({});
		expect(profile.hiddenToolsByNamespace).toEqual({
			deepwiki: ['read_wiki_contents'],
		});
		expect(profile.approval.allowWithoutApprovalTools).toEqual([]);
		expect(profile.approval.alwaysAskTools).toEqual([
			{ namespace: 'deepwiki', toolName: 'admin_tool' },
		]);
	});

	it('preserves profile-wide annotation policy through the new authored shape', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"agents": { "beta": { "profile": "default" } },
			"profiles": {
				"default": {
					"approval": {
						"annotationPolicy": "always-require-approval"
					},
					"namespaces": {
						"deepwiki": {
							"tools": { "allow": ["ask_question"] },
							"calls": {
								"withoutApproval": { "allow": [] },
								"requiresApproval": { "allow": ["ask_question"] }
							}
						}
					}
				}
			}
		}`);

		const config = await loadMcpPortalConfig(configPath);
		const profile = resolveMcpPortalProfile(config, 'default');

		expect(profile.approval.annotationPolicy).toBe('always-require-approval');
	});

	it('compiles namespace approval fields only for active namespaces', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"agents": { "beta": { "profile": "default" } },
			"profiles": {
				"default": {
					"namespaces": {
						"linear": {
							"tools": { "allow": ["list_issues", "create_issue"] },
							"calls": {
								"withoutApproval": { "allow": ["list_issues"] },
								"requiresApproval": { "allow": ["create_issue"] }
							},
							"approval": {
								"allowWithoutApproval": ["list_teams"],
								"alwaysAsk": ["delete_issue"],
								"trustedAnnotations": true,
								"write": ["create_issue", "delete_issue"]
							}
						},
						"inactive": {
							"tools": { "allow": [] },
							"calls": {
								"withoutApproval": { "allow": ["read_hidden"] },
								"requiresApproval": { "allow": ["write_hidden"] }
							},
							"approval": {
								"allowWithoutApproval": ["bypass_hidden"],
								"alwaysAsk": ["force_hidden"],
								"trustedAnnotations": true,
								"write": ["write_hidden"]
							}
						}
					}
				}
			}
		}`);

		const config = await loadMcpPortalConfig(configPath);
		const profile = resolveMcpPortalProfile(config, 'default');

		expect(profile.enabledNamespaces).toEqual(['linear']);
		expect(profile.approval.allowWithoutApprovalTools).toEqual([
			{ namespace: 'linear', toolName: 'list_issues' },
			{ namespace: 'linear', toolName: 'list_teams' },
		]);
		expect(profile.approval.alwaysAskTools).toEqual([
			{ namespace: 'linear', toolName: 'create_issue' },
			{ namespace: 'linear', toolName: 'delete_issue' },
		]);
		expect(profile.approval.trustedAnnotationNamespaces).toEqual(['linear']);
		expect(profile.approval.writeTools).toEqual([
			{ namespace: 'linear', toolName: 'create_issue' },
			{ namespace: 'linear', toolName: 'delete_issue' },
		]);
		expect(profile.approval.callPoliciesByNamespace).toEqual({
			linear: {
				requiresApproval: { allow: ['create_issue'], deny: [] },
				withoutApproval: { allow: ['list_issues'], deny: [] },
			},
		});
	});

	it('requires each namespace tool policy to declare an allow selector', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"agents": { "beta": { "profile": "default" } },
			"profiles": {
				"default": {
					"namespaces": {
						"linear": {
							"tools": { "deny": ["delete_comment"] },
							"calls": {
								"withoutApproval": { "allow": [] },
								"requiresApproval": { "allow": [] }
							}
						}
					}
				}
			}
		}`);

		await expect(loadMcpPortalConfig(configPath)).rejects.toThrow(/allow/u);
	});

	it('rejects namespace call policy that omits the approval-required selector', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"agents": { "beta": { "profile": "default" } },
			"profiles": {
				"default": {
					"namespaces": {
						"linear": {
							"tools": { "allow": "*" },
							"calls": {
								"withoutApproval": { "allow": ["list_issues"] }
							}
						}
					}
				}
			}
		}`);

		await expect(loadMcpPortalConfig(configPath)).rejects.toThrow(/requiresApproval/u);
	});

	it('resolves wildcard namespace tools without adding exact enabled tools', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"agents": { "beta": { "profile": "default" } },
			"profiles": {
				"default": {
					"namespaces": {
						"deepwiki": {
							"tools": { "allow": ["ask_question"] },
							"calls": {
								"withoutApproval": { "allow": ["ask_question"] },
								"requiresApproval": { "allow": [] }
							}
						},
						"linear": {
							"tools": {
								"allow": "*",
								"deny": ["delete_comment"]
							},
							"calls": {
								"withoutApproval": { "allow": ["list_issues"] },
								"requiresApproval": { "allow": "*" }
							}
						}
					}
				}
			}
		}`);

		const config = await loadMcpPortalConfig(configPath);
		const profile = resolveMcpPortalProfile(config, 'default');

		expect(profile.enabledToolsByNamespace).toEqual({
			deepwiki: ['ask_question'],
		});
		expect(profile.hiddenToolsByNamespace).toEqual({
			linear: ['delete_comment'],
		});
		expect(profile.approval.callPoliciesByNamespace.linear).toEqual({
			requiresApproval: { allow: '*', deny: [] },
			withoutApproval: { allow: ['list_issues'], deny: [] },
		});
	});

	it('keeps namespaces with an empty tool allowlist out of the resolved active profile', async () => {
		const configPath = await writeConfigFile(`{
			"schemaVersion": 1,
			"agents": { "beta": { "profile": "default" } },
			"profiles": {
				"default": {
					"namespaces": {
						"deepwiki": {
							"tools": { "allow": ["ask_question"] },
							"calls": {
								"withoutApproval": { "allow": ["ask_question"] },
								"requiresApproval": { "allow": [] }
							}
						},
						"linear": {
							"tools": { "allow": [] },
							"calls": {
								"withoutApproval": { "allow": ["list_issues"] },
								"requiresApproval": { "allow": "*" }
							}
						}
					}
				}
			}
		}`);

		const config = await loadMcpPortalConfig(configPath);
		const profile = resolveMcpPortalProfile(config, 'default');

		expect(profile.enabledNamespaces).toEqual(['deepwiki']);
		expect(profile.enabledToolsByNamespace).toEqual({
			deepwiki: ['ask_question'],
		});
		expect(profile.approval.allowWithoutApprovalTools).toEqual([
			{ namespace: 'deepwiki', toolName: 'ask_question' },
		]);
		expect(profile.approval.trustedAnnotationNamespaces).toEqual([]);
	});
});
