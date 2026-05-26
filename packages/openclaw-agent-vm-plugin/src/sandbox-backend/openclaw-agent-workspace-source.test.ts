import { describe, expect, it } from 'vitest';

import {
	OpenClawAgentWorkspaceSourceError,
	resolveOpenClawAgentWorkspaceSource,
} from './openclaw-agent-workspace-source.js';

const fallbackPaths = {
	defaultWorkspaceDir: '/home/openclaw/.openclaw/workspace',
	stateDir: '/home/openclaw/.openclaw/state',
} as const;

describe('resolveOpenClawAgentWorkspaceSource', () => {
	it('uses the configured agent workspace when OpenClaw leaks /workspace as agentWorkspaceDir', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				...fallbackPaths,
				openClawConfig: {
					agents: {
						list: [{ id: 'beta', workspace: '/zone/agents/beta' }],
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
			}),
		).toEqual({
			kind: 'configured-agent-workspace',
			sourceDir: '/zone/agents/beta',
		});
	});

	it('uses the configured agent workspace when OpenClaw leaks a sandbox child path as agentWorkspaceDir', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				...fallbackPaths,
				openClawConfig: {
					agents: {
						list: [{ id: 'beta', workspace: '/zone/agents/beta' }],
					},
				},
				paramsAgentWorkspaceDir: '/home/openclaw/.openclaw/state/sandboxes/child-session/work',
			}),
		).toEqual({
			kind: 'configured-agent-workspace',
			sourceDir: '/zone/agents/beta',
		});
	});

	it('uses the configured agent workspace when OpenClaw leaks its implicit default workspace as agentWorkspaceDir', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				...fallbackPaths,
				openClawConfig: {
					agents: {
						list: [{ id: 'beta', workspace: '/zone/agents/beta' }],
					},
				},
				paramsAgentWorkspaceDir: '/home/openclaw/.openclaw/workspace',
			}),
		).toEqual({
			kind: 'configured-agent-workspace',
			sourceDir: '/zone/agents/beta',
		});
	});

	it('uses defaults workspace plus agent id for non-default agents without explicit workspace', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				...fallbackPaths,
				openClawConfig: {
					agents: {
						defaults: { workspace: '/zone/agents' },
						list: [{ id: 'primary', default: true }, { id: 'beta' }],
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
			}),
		).toEqual({
			kind: 'default-workspace-child',
			sourceDir: '/zone/agents/beta',
		});
	});

	it('uses defaults workspace itself for the OpenClaw default agent even when the id is not main', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'primary',
				...fallbackPaths,
				openClawConfig: {
					agents: {
						defaults: { workspace: '/zone/agents/default' },
						list: [{ id: 'primary', default: true }, { id: 'beta' }],
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
			}),
		).toEqual({
			kind: 'default-agent-workspace',
			sourceDir: '/zone/agents/default',
		});
	});

	it('mirrors OpenClaw stateDir fallback for non-default agents', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				...fallbackPaths,
				openClawConfig: {
					agents: {
						list: [{ id: 'primary', default: true }, { id: 'beta' }],
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
			}),
		).toEqual({
			kind: 'state-workspace-child',
			sourceDir: '/home/openclaw/.openclaw/state/workspace-beta',
		});
	});

	it('rejects default-agent state workspace fallback because it is not controller lease backed', () => {
		expect(() =>
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'primary',
				...fallbackPaths,
				openClawConfig: {
					agents: {
						list: [{ id: 'primary', default: true }, { id: 'beta' }],
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
			}),
		).toThrow(/configure agents\.list\[\]\.workspace or agents\.defaults\.workspace/u);
	});

	it('keeps a non-guest absolute OpenClaw source path when config is unavailable', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				...fallbackPaths,
				openClawConfig: undefined,
				paramsAgentWorkspaceDir: '/zone/agents/beta',
			}),
		).toEqual({
			kind: 'sdk-agent-workspace',
			sourceDir: '/zone/agents/beta',
		});
	});

	it('uses OpenClaw stateDir fallback when guest leakage arrives without explicit workspace config', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				...fallbackPaths,
				openClawConfig: undefined,
				paramsAgentWorkspaceDir: '/workspace',
			}),
		).toEqual({
			kind: 'state-workspace-child',
			sourceDir: '/home/openclaw/.openclaw/state/workspace-beta',
		});
	});

	it('uses OpenClaw stateDir fallback when implicit default workspace leakage arrives without explicit workspace config', () => {
		expect(
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				...fallbackPaths,
				openClawConfig: undefined,
				paramsAgentWorkspaceDir: '/home/openclaw/.openclaw/workspace',
			}),
		).toEqual({
			kind: 'state-workspace-child',
			sourceDir: '/home/openclaw/.openclaw/state/workspace-beta',
		});
	});

	it('throws a clear error when guest leakage arrives and fallback providers are unavailable', () => {
		expect(() =>
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				defaultWorkspaceDir: undefined,
				openClawConfig: undefined,
				paramsAgentWorkspaceDir: '/workspace',
				stateDir: undefined,
			}),
		).toThrow(OpenClawAgentWorkspaceSourceError);
	});

	it('rejects /work as a canonical workspace source', () => {
		expect(() =>
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				...fallbackPaths,
				openClawConfig: {
					agents: { list: [{ id: 'beta', workspace: '/work' }] },
				},
				paramsAgentWorkspaceDir: '/workspace',
			}),
		).toThrow(/must resolve to an OpenClaw\/Gondolin source path/u);
	});

	it('rejects configured agent workspaces under OpenClaw sandbox state', () => {
		expect(() =>
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				...fallbackPaths,
				openClawConfig: {
					agents: {
						list: [
							{
								id: 'beta',
								workspace: '/home/openclaw/.openclaw/state/sandboxes/child-session/work',
							},
						],
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
			}),
		).toThrow(/must resolve to a stable agent workspace path/u);
	});

	it('rejects default workspaces under OpenClaw sandbox state before deriving child paths', () => {
		expect(() =>
			resolveOpenClawAgentWorkspaceSource({
				agentId: 'beta',
				...fallbackPaths,
				openClawConfig: {
					agents: {
						defaults: {
							workspace: '/home/openclaw/.openclaw/state/sandboxes/parent-session/work',
						},
						list: [{ id: 'primary', default: true }, { id: 'beta' }],
					},
				},
				paramsAgentWorkspaceDir: '/workspace',
			}),
		).toThrow(/must resolve to a stable agent workspace path/u);
	});
});
