import type { ConsumeApprovalTokenResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import type { AgentClientManagementPort } from '@agent-collaboration/tool-host-core';
import { expect, expectTypeOf, it } from 'vitest';

import type { WorkerBindings } from '#worker-host/index';

type WorkspaceStub = ReturnType<WorkerBindings['WORKSPACES']['get']>;

it('preserves the generated workspace RPC types during package typechecking', () => {
	expectTypeOf<WorkspaceStub>().not.toBeAny();
	expectTypeOf<WorkspaceStub['readMembership']>().parameters.toEqualTypeOf<[string]>();
	expectTypeOf<WorkspaceStub['readMembership']>().returns.toMatchTypeOf<
		Promise<{ readonly persona: string } | null>
	>();
	expectTypeOf<Awaited<ReturnType<WorkspaceStub['readMembership']>>>().not.toBeAny();
	expectTypeOf<WorkspaceStub['setMembership']>().parameters.toEqualTypeOf<[string, string]>();
	expectTypeOf<WorkspaceStub['setMembership']>().returns.toMatchTypeOf<Promise<void>>();
	expectTypeOf<Awaited<ReturnType<WorkspaceStub['setMembership']>>>().not.toBeAny();
	expectTypeOf<WorkspaceStub['consumeApprovalToken']>().parameters.toEqualTypeOf<
		[string, number]
	>();
	expectTypeOf<WorkspaceStub['consumeApprovalToken']>().returns.toMatchTypeOf<
		Promise<ConsumeApprovalTokenResult>
	>();
	expectTypeOf<Awaited<ReturnType<WorkspaceStub['consumeApprovalToken']>>>().not.toBeAny();
});

it('keeps the optional sign-in service on the portable Core management contract', () => {
	const omitted: Pick<WorkerBindings, 'SIGN_IN'> = {};
	expect(omitted.SIGN_IN).toBeUndefined();
	type SignInManagement = NonNullable<WorkerBindings['SIGN_IN']>;
	expectTypeOf<SignInManagement>().not.toBeAny();
	expectTypeOf<SignInManagement>().toEqualTypeOf<AgentClientManagementPort>();
	expectTypeOf<Awaited<ReturnType<SignInManagement['humanCheckStatus']>>>().not.toBeAny();
	expectTypeOf<Awaited<ReturnType<SignInManagement['isLiveOwner']>>>().not.toBeAny();
	expectTypeOf<Awaited<ReturnType<SignInManagement['ownsAgentClient']>>>().not.toBeAny();
	expectTypeOf<Awaited<ReturnType<SignInManagement['registerAndLink']>>>().not.toBeAny();
	expectTypeOf<Awaited<ReturnType<SignInManagement['link']>>>().not.toBeAny();
	expectTypeOf<Awaited<ReturnType<SignInManagement['unlink']>>>().not.toBeAny();
	expectTypeOf<Awaited<ReturnType<SignInManagement['disable']>>>().not.toBeAny();
});
