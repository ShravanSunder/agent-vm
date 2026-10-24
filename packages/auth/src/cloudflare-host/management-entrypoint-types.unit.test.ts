import { expectTypeOf, it } from 'vitest';

type ManagementEntrypoint = InstanceType<
	Cloudflare.GlobalProps['mainModule']['AgentClientManagement']
>;

it('keeps the generated sign-in entrypoint and its RPC results typed', () => {
	expectTypeOf<ManagementEntrypoint>().not.toBeAny();
	expectTypeOf<ManagementEntrypoint['isLiveOwner']>().parameters.toEqualTypeOf<
		[{ readonly token: string; readonly organizationId: string }]
	>();
	expectTypeOf<ManagementEntrypoint['isLiveOwner']>().returns.toMatchTypeOf<Promise<boolean>>();
	expectTypeOf<Awaited<ReturnType<ManagementEntrypoint['isLiveOwner']>>>().not.toBeAny();
	expectTypeOf<ManagementEntrypoint['ownsAgentClient']>().parameters.toEqualTypeOf<
		[{ readonly token: string; readonly organizationId: string; readonly clientId: string }]
	>();
	expectTypeOf<ManagementEntrypoint['ownsAgentClient']>().returns.toMatchTypeOf<Promise<boolean>>();
	expectTypeOf<Awaited<ReturnType<ManagementEntrypoint['ownsAgentClient']>>>().not.toBeAny();
	expectTypeOf<Awaited<ReturnType<ManagementEntrypoint['humanCheckStatus']>>>().not.toBeAny();
	expectTypeOf<Awaited<ReturnType<ManagementEntrypoint['changeClient']>>>().not.toBeAny();
});
