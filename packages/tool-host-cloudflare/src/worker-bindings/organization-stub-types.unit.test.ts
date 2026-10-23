import type { ConsumeApprovalTokenResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import { expectTypeOf, it } from 'vitest';

import type { WorkerBindings } from '#worker-host/index';

type OrganizationStub = ReturnType<WorkerBindings['ORGANIZATIONS']['get']>;

it('preserves the generated organization RPC types during package typechecking', () => {
	expectTypeOf<OrganizationStub>().not.toBeAny();
	expectTypeOf<OrganizationStub['isAgentListed']>().parameters.toEqualTypeOf<[string]>();
	expectTypeOf<OrganizationStub['isAgentListed']>().returns.toMatchTypeOf<Promise<boolean>>();
	expectTypeOf<Awaited<ReturnType<OrganizationStub['isAgentListed']>>>().not.toBeAny();
	expectTypeOf<OrganizationStub['setAgentAdmission']>().parameters.toEqualTypeOf<
		[string, 'listed' | 'removed']
	>();
	expectTypeOf<OrganizationStub['setAgentAdmission']>().returns.toMatchTypeOf<Promise<void>>();
	expectTypeOf<Awaited<ReturnType<OrganizationStub['setAgentAdmission']>>>().not.toBeAny();
	expectTypeOf<OrganizationStub['consumeApprovalToken']>().parameters.toEqualTypeOf<
		[string, number]
	>();
	expectTypeOf<OrganizationStub['consumeApprovalToken']>().returns.toMatchTypeOf<
		Promise<ConsumeApprovalTokenResult>
	>();
	expectTypeOf<Awaited<ReturnType<OrganizationStub['consumeApprovalToken']>>>().not.toBeAny();
});
