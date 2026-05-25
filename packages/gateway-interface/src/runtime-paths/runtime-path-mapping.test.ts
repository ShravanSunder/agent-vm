import { describe, expect, it } from 'vitest';

import {
	TOOL_VM_SCRATCH_GUEST_ROOT,
	TOOL_VM_WORKSPACE_GUEST_ROOT,
	translateRuntimePath,
	type RuntimePathMapping,
} from './runtime-path-mapping.js';

const mapping = {
	id: 'test-tool-vm',
	roots: [
		{
			id: 'agent-workspace',
			guestRoot: TOOL_VM_WORKSPACE_GUEST_ROOT,
			hostRoot: '/zone/agents/beta',
			backing: {
				kind: 'host-realfs',
				durability: 'durable',
				backup: 'included',
			},
			capabilities: {
				executionCwd: true,
				leaseMount: true,
			},
			rootPathAllowed: true,
			guidanceLabel: 'agent workspace',
		},
		{
			id: 'tool-vm-scratch',
			guestRoot: TOOL_VM_SCRATCH_GUEST_ROOT,
			backing: {
				kind: 'guest-rootfs-cow',
				durability: 'vm-lifetime',
			},
			capabilities: {
				executionCwd: true,
				leaseMount: false,
			},
			rootPathAllowed: true,
			guidanceLabel: 'Tool VM scratch',
		},
		{
			id: 'workspace-cache',
			guestRoot: '/workspace-cache',
			hostRoot: '/cache/workspace',
			backing: {
				kind: 'host-realfs',
				durability: 'cache',
				backup: 'excluded',
			},
			capabilities: {
				executionCwd: true,
				leaseMount: false,
			},
			rootPathAllowed: true,
			guidanceLabel: 'workspace cache',
		},
	],
} satisfies RuntimePathMapping;

describe('translateRuntimePath', () => {
	it('maps guest workspace subpaths to host paths', () => {
		const result = translateRuntimePath({
			inputPath: '/workspace/app',
			mapping,
			purpose: 'executionCwd',
		});

		expect(result).toEqual({
			ok: true,
			value: {
				backing: {
					kind: 'host-realfs',
					durability: 'durable',
					backup: 'included',
				},
				capabilities: {
					executionCwd: true,
					leaseMount: true,
				},
				guestPath: '/workspace/app',
				guestRoot: '/workspace',
				hasHostBacking: true,
				hostPath: '/zone/agents/beta/app',
				hostRoot: '/zone/agents/beta',
				inputNamespace: 'guest',
				inputPath: '/workspace/app',
				mappingId: 'test-tool-vm',
				relativePath: 'app',
				rootId: 'agent-workspace',
			},
		});
	});

	it('maps host workspace subpaths back to guest paths', () => {
		const result = translateRuntimePath({
			inputPath: '/zone/agents/beta/app',
			mapping,
			purpose: 'executionCwd',
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				guestPath: '/workspace/app',
				hostPath: '/zone/agents/beta/app',
				inputNamespace: 'host',
				relativePath: 'app',
				rootId: 'agent-workspace',
			},
		});
	});

	it('allows scratch paths as execution cwd without host backing', () => {
		const result = translateRuntimePath({
			inputPath: '/work/tmp',
			mapping,
			purpose: 'executionCwd',
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				backing: {
					kind: 'guest-rootfs-cow',
					durability: 'vm-lifetime',
				},
				guestPath: '/work/tmp',
				hasHostBacking: false,
				inputNamespace: 'guest',
				relativePath: 'tmp',
				rootId: 'tool-vm-scratch',
			},
		});
	});

	it('rejects scratch paths for lease mounts with retry guidance', () => {
		const result = translateRuntimePath({
			inputPath: '/work/tmp',
			mapping,
			purpose: 'leaseMount',
		});

		expect(result).toEqual({
			error: {
				allowedPathForms: ['/workspace[/subpath]', '/zone/agents/beta[/subpath]'],
				code: 'purpose-not-allowed',
				inputPath: '/work/tmp',
				mappingId: 'test-tool-vm',
				message: "Path '/work/tmp' matched Tool VM scratch but cannot be used for leaseMount.",
				purpose: 'leaseMount',
				retryGuidance:
					'Use one of the allowed path forms for test-tool-vm leaseMount: /workspace[/subpath], /zone/agents/beta[/subpath].',
			},
			ok: false,
		});
	});

	it('uses longest root match', () => {
		const result = translateRuntimePath({
			inputPath: '/workspace-cache/npm',
			mapping,
			purpose: 'executionCwd',
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				guestPath: '/workspace-cache/npm',
				hostPath: '/cache/workspace/npm',
				rootId: 'workspace-cache',
			},
		});
	});

	it('rejects parent traversal before normalization', () => {
		const result = translateRuntimePath({
			inputPath: '/workspace/../secret',
			mapping,
			purpose: 'executionCwd',
		});

		expect(result).toMatchObject({
			error: {
				code: 'path-parent-traversal',
				inputPath: '/workspace/../secret',
			},
			ok: false,
		});
	});

	it('rejects unknown absolute paths with allowed forms', () => {
		const result = translateRuntimePath({
			inputPath: '/tmp/build',
			mapping,
			purpose: 'executionCwd',
		});

		expect(result).toEqual({
			error: {
				allowedPathForms: [
					'/workspace[/subpath]',
					'/zone/agents/beta[/subpath]',
					'/work[/subpath]',
					'/workspace-cache[/subpath]',
					'/cache/workspace[/subpath]',
				],
				code: 'unknown-runtime-path',
				inputPath: '/tmp/build',
				mappingId: 'test-tool-vm',
				message: "Path '/tmp/build' is not part of runtime path mapping 'test-tool-vm'.",
				purpose: 'executionCwd',
				retryGuidance:
					'Use one of the allowed path forms for test-tool-vm executionCwd: /workspace[/subpath], /zone/agents/beta[/subpath], /work[/subpath], /workspace-cache[/subpath], /cache/workspace[/subpath].',
			},
			ok: false,
		});
	});

	it('rejects exact roots when rootPathAllowed is false', () => {
		const gatewayMapping = {
			id: 'openclaw-gateway-lease',
			roots: [
				{
					id: 'zone-files',
					guestRoot: '/zone',
					hostRoot: '/host/zone-files',
					backing: {
						kind: 'host-realfs',
						durability: 'durable',
						backup: 'included',
					},
					capabilities: {
						executionCwd: false,
						leaseMount: true,
					},
					rootPathAllowed: false,
					guidanceLabel: 'zone files',
				},
			],
		} satisfies RuntimePathMapping;

		const result = translateRuntimePath({
			inputPath: '/zone',
			mapping: gatewayMapping,
			purpose: 'leaseMount',
		});

		expect(result).toMatchObject({
			error: {
				code: 'root-path-not-allowed',
				inputPath: '/zone',
			},
			ok: false,
		});
	});
});
