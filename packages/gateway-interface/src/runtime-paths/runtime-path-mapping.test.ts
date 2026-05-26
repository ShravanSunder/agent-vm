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
			backing: {
				kind: 'host-realfs',
				durability: 'durable',
				backup: 'included',
			},
			capabilities: {
				executionCwd: true,
				leaseMount: true,
			},
			guidanceLabel: 'agent workspace',
			id: 'agent-workspace',
			locations: {
				'controller-host': '/host/zone/agents/beta',
				'openclaw-gateway': '/zone/agents/beta',
				'tool-vm-guest': TOOL_VM_WORKSPACE_GUEST_ROOT,
			},
			rootPathAllowed: true,
			showInGuidance: {
				'controller-host': false,
			},
		},
		{
			backing: {
				kind: 'guest-rootfs-cow',
				durability: 'vm-lifetime',
			},
			capabilities: {
				executionCwd: true,
				leaseMount: false,
			},
			guidanceLabel: 'Tool VM scratch',
			id: 'tool-vm-scratch',
			locations: {
				'tool-vm-guest': TOOL_VM_SCRATCH_GUEST_ROOT,
			},
			rootPathAllowed: true,
		},
		{
			backing: {
				kind: 'host-realfs',
				durability: 'cache',
				backup: 'excluded',
			},
			capabilities: {
				executionCwd: true,
				leaseMount: false,
			},
			guidanceLabel: 'workspace cache',
			id: 'workspace-cache',
			locations: {
				'controller-host': '/host/cache/workspace',
				'openclaw-gateway': '/cache/workspace',
				'tool-vm-guest': '/workspace-cache',
			},
			rootPathAllowed: true,
		},
	],
} satisfies RuntimePathMapping;

describe('translateRuntimePath', () => {
	it('maps Tool VM guest workspace subpaths to OpenClaw gateway paths', () => {
		const result = translateRuntimePath({
			inputPath: '/workspace/app',
			mapping,
			purpose: 'executionCwd',
			sourceNamespace: 'tool-vm-guest',
			targetNamespace: 'openclaw-gateway',
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
				inputNamespace: 'tool-vm-guest',
				inputPath: '/workspace/app',
				mappingId: 'test-tool-vm',
				outputNamespace: 'openclaw-gateway',
				outputPath: '/zone/agents/beta/app',
				relativePath: 'app',
				rootId: 'agent-workspace',
			},
		});
	});

	it('maps OpenClaw gateway workspace subpaths back to Tool VM guest paths', () => {
		const result = translateRuntimePath({
			inputPath: '/zone/agents/beta/app',
			mapping,
			purpose: 'executionCwd',
			sourceNamespace: 'openclaw-gateway',
			targetNamespace: 'tool-vm-guest',
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				inputNamespace: 'openclaw-gateway',
				outputNamespace: 'tool-vm-guest',
				outputPath: '/workspace/app',
				relativePath: 'app',
				rootId: 'agent-workspace',
			},
		});
	});

	it('maps OpenClaw gateway paths to controller host backing paths', () => {
		const result = translateRuntimePath({
			inputPath: '/zone/agents/beta/app',
			mapping,
			purpose: 'leaseMount',
			sourceNamespace: 'openclaw-gateway',
			targetNamespace: 'controller-host',
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				inputNamespace: 'openclaw-gateway',
				outputNamespace: 'controller-host',
				outputPath: '/host/zone/agents/beta/app',
				relativePath: 'app',
				rootId: 'agent-workspace',
			},
		});
	});

	it('allows scratch paths as execution cwd without a lease mount target', () => {
		const result = translateRuntimePath({
			inputPath: '/work/tmp',
			mapping,
			purpose: 'executionCwd',
			sourceNamespace: 'tool-vm-guest',
			targetNamespace: 'tool-vm-guest',
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				backing: {
					kind: 'guest-rootfs-cow',
					durability: 'vm-lifetime',
				},
				inputNamespace: 'tool-vm-guest',
				outputNamespace: 'tool-vm-guest',
				outputPath: '/work/tmp',
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
			sourceNamespace: 'tool-vm-guest',
			targetNamespace: 'openclaw-gateway',
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

	it('rejects target namespaces that are not available on the matched root', () => {
		const result = translateRuntimePath({
			inputPath: '/work/tmp',
			mapping,
			purpose: 'executionCwd',
			sourceNamespace: 'tool-vm-guest',
			targetNamespace: 'openclaw-gateway',
		});

		expect(result).toMatchObject({
			error: {
				code: 'target-namespace-not-available',
				inputPath: '/work/tmp',
			},
			ok: false,
		});
	});

	it('uses longest root match within the selected source namespace', () => {
		const result = translateRuntimePath({
			inputPath: '/workspace-cache/npm',
			mapping,
			purpose: 'executionCwd',
			sourceNamespace: 'tool-vm-guest',
			targetNamespace: 'openclaw-gateway',
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				outputPath: '/cache/workspace/npm',
				rootId: 'workspace-cache',
			},
		});
	});

	it('rejects parent traversal before normalization', () => {
		const result = translateRuntimePath({
			inputPath: '/workspace/../secret',
			mapping,
			purpose: 'executionCwd',
			sourceNamespace: 'tool-vm-guest',
			targetNamespace: 'openclaw-gateway',
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
			sourceNamespace: 'tool-vm-guest',
			targetNamespace: 'openclaw-gateway',
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
					backing: {
						kind: 'host-realfs',
						durability: 'durable',
						backup: 'included',
					},
					capabilities: {
						executionCwd: false,
						leaseMount: true,
					},
					guidanceLabel: 'zone files',
					id: 'zone-files',
					locations: {
						'controller-host': '/host/zone-files',
						'openclaw-gateway': '/zone',
					},
					rootPathAllowed: false,
				},
			],
		} satisfies RuntimePathMapping;

		const result = translateRuntimePath({
			inputPath: '/zone',
			mapping: gatewayMapping,
			purpose: 'leaseMount',
			sourceNamespace: 'openclaw-gateway',
			targetNamespace: 'controller-host',
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
