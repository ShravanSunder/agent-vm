import type {
	PortalCallRequest,
	PortalDescribeRequest,
	PortalListRequest,
	PortalSearchRequest,
} from '@agent-vm/agent-portal-sdk';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
	ToolPortalBackendCallOptions,
	ToolPortalBackendPort,
	ToolPortalInvocationOptions,
} from './tool-portal-service.js';

function rejectUnexpectedBackendInvocation(): Promise<never> {
	return Promise.reject(new Error('Compile-contract backend ports must not execute.'));
}

const mcpProviderPort: ToolPortalBackendPort<'mcp_provider'> = {
	backendKind: 'mcp_provider',
	call: rejectUnexpectedBackendInvocation,
	describe: rejectUnexpectedBackendInvocation,
	list: rejectUnexpectedBackendInvocation,
	search: rejectUnexpectedBackendInvocation,
};

const toolVmRunnerPort: ToolPortalBackendPort<'tool_vm_runner'> = {
	backendKind: 'tool_vm_runner',
	call: rejectUnexpectedBackendInvocation,
	describe: rejectUnexpectedBackendInvocation,
	list: rejectUnexpectedBackendInvocation,
	search: rejectUnexpectedBackendInvocation,
};

const controllerExecutionPort: ToolPortalBackendPort<'controller_execution'> = {
	backendKind: 'controller_execution',
	call: rejectUnexpectedBackendInvocation,
	describe: rejectUnexpectedBackendInvocation,
	list: rejectUnexpectedBackendInvocation,
	search: rejectUnexpectedBackendInvocation,
};

const missingBackendKindPortShape = {
	call: rejectUnexpectedBackendInvocation,
	describe: rejectUnexpectedBackendInvocation,
	list: rejectUnexpectedBackendInvocation,
	search: rejectUnexpectedBackendInvocation,
};

// @ts-expect-error Frozen service backend ports require their exact backend-kind discriminant.
const missingBackendKindMcpProviderPort: ToolPortalBackendPort<'mcp_provider'> =
	missingBackendKindPortShape;

// @ts-expect-error An MCP provider port cannot carry the Tool VM runner discriminant.
const wrongBackendKindMcpProviderPort: ToolPortalBackendPort<'mcp_provider'> = toolVmRunnerPort;

// @ts-expect-error Frozen service backend ports require an explicit backend-kind type argument.
type UnqualifiedToolPortalBackendPort = ToolPortalBackendPort;

declare const unqualifiedToolPortalBackendPort: UnqualifiedToolPortalBackendPort;
declare const portalCallRequest: PortalCallRequest;
declare const portalDescribeRequest: PortalDescribeRequest;
declare const portalListRequest: PortalListRequest;
declare const portalSearchRequest: PortalSearchRequest;
declare const invocationOptions: ToolPortalInvocationOptions;
declare const mcpProviderCallOptions: ToolPortalBackendCallOptions<'mcp_provider'>;
declare const toolVmRunnerCallOptions: ToolPortalBackendCallOptions<'tool_vm_runner'>;
declare const controllerExecutionCallOptions: ToolPortalBackendCallOptions<'controller_execution'>;

function assertBackendPortInvocationContract(): void {
	void mcpProviderPort.describe(portalDescribeRequest, invocationOptions);
	void mcpProviderPort.list(portalListRequest, invocationOptions);
	void mcpProviderPort.search(portalSearchRequest, invocationOptions);
	void mcpProviderPort.call(portalCallRequest, mcpProviderCallOptions);
	void toolVmRunnerPort.call(portalCallRequest, toolVmRunnerCallOptions);
	void controllerExecutionPort.call(portalCallRequest, controllerExecutionCallOptions);

	// @ts-expect-error Backend catalog reads require explicit trusted invocation options.
	void mcpProviderPort.describe(portalDescribeRequest);
	// @ts-expect-error Backend catalog reads require explicit trusted invocation options.
	void mcpProviderPort.list(portalListRequest);
	// @ts-expect-error Backend catalog reads require explicit trusted invocation options.
	void mcpProviderPort.search(portalSearchRequest);
	// @ts-expect-error Backend calls require explicit trusted options and dispatch authority.
	void mcpProviderPort.call(portalCallRequest);
	// @ts-expect-error Trusted invocation options alone do not authorize backend dispatch.
	void mcpProviderPort.call(portalCallRequest, invocationOptions);
	// @ts-expect-error MCP providers cannot consume Tool VM runner dispatch authority.
	void mcpProviderPort.call(portalCallRequest, toolVmRunnerCallOptions);
	// @ts-expect-error Tool VM runners cannot consume controller host-action dispatch authority.
	void toolVmRunnerPort.call(portalCallRequest, controllerExecutionCallOptions);
	// @ts-expect-error Controller host actions cannot consume MCP-provider dispatch authority.
	void controllerExecutionPort.call(portalCallRequest, mcpProviderCallOptions);
	void unqualifiedToolPortalBackendPort;
}

describe('Tool Portal frozen backend port type contract', () => {
	it('declares one backend-kind-bound port for each service backend', () => {
		expect([
			mcpProviderPort.backendKind,
			toolVmRunnerPort.backendKind,
			controllerExecutionPort.backendKind,
		]).toEqual(['mcp_provider', 'tool_vm_runner', 'controller_execution']);
		expectTypeOf<
			Parameters<typeof mcpProviderPort.describe>[1]
		>().toEqualTypeOf<ToolPortalInvocationOptions>();
		expectTypeOf<
			Parameters<typeof mcpProviderPort.list>[1]
		>().toEqualTypeOf<ToolPortalInvocationOptions>();
		expectTypeOf<
			Parameters<typeof mcpProviderPort.search>[1]
		>().toEqualTypeOf<ToolPortalInvocationOptions>();
		expectTypeOf<Parameters<typeof mcpProviderPort.call>[1]>().toEqualTypeOf<
			ToolPortalBackendCallOptions<'mcp_provider'>
		>();
		expectTypeOf<Parameters<typeof toolVmRunnerPort.call>[1]>().toEqualTypeOf<
			ToolPortalBackendCallOptions<'tool_vm_runner'>
		>();
		expectTypeOf<Parameters<typeof controllerExecutionPort.call>[1]>().toEqualTypeOf<
			ToolPortalBackendCallOptions<'controller_execution'>
		>();
	});

	it('keeps trusted read options and backend-correlated call authority compile-only', () => {
		void missingBackendKindMcpProviderPort;
		void wrongBackendKindMcpProviderPort;
		expectTypeOf(assertBackendPortInvocationContract).toBeFunction();
		expect(true).toBe(true);
	});
});
