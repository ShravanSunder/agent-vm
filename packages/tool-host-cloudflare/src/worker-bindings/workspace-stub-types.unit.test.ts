import type {
	RemovalNotice,
	RemovalNoticeAck,
	RemovalSubject,
} from '@agent-collaboration/tool-access/contracts';
import type { ConsumeApprovalTokenResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import { expectTypeOf, it } from 'vitest';

import type { WorkerBindings } from '#worker-host/index';
type WorkspaceStub = ReturnType<WorkerBindings['WORKSPACES']['get']>;
it('preserves typed removal and approval RPCs without a membership or management port', () => {
	expectTypeOf<WorkspaceStub>().not.toBeAny();
	expectTypeOf<WorkspaceStub['readRemovalMark']>().parameters.toEqualTypeOf<[RemovalSubject]>();
	expectTypeOf<WorkspaceStub['readRemovalMark']>().returns.toMatchTypeOf<Promise<number | null>>();
	expectTypeOf<WorkspaceStub['recordRemovalNotice']>().parameters.toEqualTypeOf<[RemovalNotice]>();
	expectTypeOf<WorkspaceStub['recordRemovalNotice']>().returns.toMatchTypeOf<
		Promise<RemovalNoticeAck>
	>();
	expectTypeOf<WorkspaceStub['consumeApprovalToken']>().parameters.toEqualTypeOf<
		[string, number]
	>();
	expectTypeOf<WorkspaceStub['consumeApprovalToken']>().returns.toMatchTypeOf<
		Promise<ConsumeApprovalTokenResult>
	>();
});
