import type { z } from 'zod';

import {
	SandboxRetainedResultLookupRequestSchema,
	SandboxRetainedResultLookupResultSchema,
} from './operation-contracts.js';
import {
	SandboxEnvironmentCloseResultSchema,
	SandboxEnvironmentHandleRequestSchema,
	SandboxEnvironmentOpenRequestSchema,
	SandboxEnvironmentOpenResultSchema,
	SandboxEnvironmentStatusResultSchema,
} from './sandbox-environment-contracts.js';
import {
	SandboxExecCancelRequestSchema,
	SandboxExecCancelResultSchema,
	SandboxExecStartRequestSchema,
	SandboxExecStartResultSchema,
	SandboxExecWaitRequestSchema,
	SandboxExecWaitResultSchema,
} from './sandbox-execution-contracts.js';
import {
	SandboxFsListRequestSchema,
	SandboxFsListResultSchema,
	SandboxFsMkdirRequestSchema,
	SandboxFsMkdirResultSchema,
	SandboxFsReadRequestSchema,
	SandboxFsReadResultSchema,
	SandboxFsRemoveRequestSchema,
	SandboxFsRemoveResultSchema,
	SandboxFsRenameRequestSchema,
	SandboxFsRenameResultSchema,
	SandboxFsStatRequestSchema,
	SandboxFsStatResultSchema,
	SandboxFsWriteRequestSchema,
	SandboxFsWriteResultSchema,
} from './sandbox-filesystem-contracts.js';
import {
	SandboxProcessCancelRequestSchema,
	SandboxProcessCancelResultSchema,
	SandboxProcessHandleRequestSchema,
	SandboxProcessLogsRequestSchema,
	SandboxProcessLogsResultSchema,
	SandboxProcessStartRequestSchema,
	SandboxProcessStartResultSchema,
	SandboxProcessStatusResultSchema,
	SandboxProcessWaitRequestSchema,
	SandboxProcessWaitResultSchema,
} from './sandbox-process-contracts.js';
import {
	SandboxStreamCloseRequestSchema,
	SandboxStreamCloseResultSchema,
	SandboxStreamReadRequestSchema,
	SandboxStreamReadResultSchema,
	SandboxStreamWriteRequestSchema,
	SandboxStreamWriteResultSchema,
} from './sandbox-stream-contracts.js';
import {
	SandboxTerminalAttachRequestSchema,
	SandboxTerminalAttachResultSchema,
	SandboxTerminalResizeRequestSchema,
	SandboxTerminalResizeResultSchema,
} from './sandbox-terminal-contracts.js';

interface SandboxMethodContract {
	readonly request: z.ZodType;
	readonly result: z.ZodType;
}

export const SANDBOX_METHOD_CONTRACTS = {
	'sandbox.environment.close': {
		request: SandboxEnvironmentHandleRequestSchema,
		result: SandboxEnvironmentCloseResultSchema,
	},
	'sandbox.environment.open': {
		request: SandboxEnvironmentOpenRequestSchema,
		result: SandboxEnvironmentOpenResultSchema,
	},
	'sandbox.environment.status': {
		request: SandboxEnvironmentHandleRequestSchema,
		result: SandboxEnvironmentStatusResultSchema,
	},
	'sandbox.exec.cancel': {
		request: SandboxExecCancelRequestSchema,
		result: SandboxExecCancelResultSchema,
	},
	'sandbox.exec.start': {
		request: SandboxExecStartRequestSchema,
		result: SandboxExecStartResultSchema,
	},
	'sandbox.exec.wait': {
		request: SandboxExecWaitRequestSchema,
		result: SandboxExecWaitResultSchema,
	},
	'sandbox.retained-result.lookup': {
		request: SandboxRetainedResultLookupRequestSchema,
		result: SandboxRetainedResultLookupResultSchema,
	},
	'sandbox.fs.list': { request: SandboxFsListRequestSchema, result: SandboxFsListResultSchema },
	'sandbox.fs.mkdir': {
		request: SandboxFsMkdirRequestSchema,
		result: SandboxFsMkdirResultSchema,
	},
	'sandbox.fs.read': { request: SandboxFsReadRequestSchema, result: SandboxFsReadResultSchema },
	'sandbox.fs.remove': {
		request: SandboxFsRemoveRequestSchema,
		result: SandboxFsRemoveResultSchema,
	},
	'sandbox.fs.rename': {
		request: SandboxFsRenameRequestSchema,
		result: SandboxFsRenameResultSchema,
	},
	'sandbox.fs.stat': { request: SandboxFsStatRequestSchema, result: SandboxFsStatResultSchema },
	'sandbox.fs.write': {
		request: SandboxFsWriteRequestSchema,
		result: SandboxFsWriteResultSchema,
	},
	'sandbox.process.cancel': {
		request: SandboxProcessCancelRequestSchema,
		result: SandboxProcessCancelResultSchema,
	},
	'sandbox.process.logs': {
		request: SandboxProcessLogsRequestSchema,
		result: SandboxProcessLogsResultSchema,
	},
	'sandbox.process.start': {
		request: SandboxProcessStartRequestSchema,
		result: SandboxProcessStartResultSchema,
	},
	'sandbox.process.status': {
		request: SandboxProcessHandleRequestSchema,
		result: SandboxProcessStatusResultSchema,
	},
	'sandbox.process.wait': {
		request: SandboxProcessWaitRequestSchema,
		result: SandboxProcessWaitResultSchema,
	},
	'sandbox.stream.close': {
		request: SandboxStreamCloseRequestSchema,
		result: SandboxStreamCloseResultSchema,
	},
	'sandbox.stream.read': {
		request: SandboxStreamReadRequestSchema,
		result: SandboxStreamReadResultSchema,
	},
	'sandbox.stream.write': {
		request: SandboxStreamWriteRequestSchema,
		result: SandboxStreamWriteResultSchema,
	},
	'sandbox.terminal.attach': {
		request: SandboxTerminalAttachRequestSchema,
		result: SandboxTerminalAttachResultSchema,
	},
	'sandbox.terminal.resize': {
		request: SandboxTerminalResizeRequestSchema,
		result: SandboxTerminalResizeResultSchema,
	},
} as const satisfies Readonly<Record<string, SandboxMethodContract>>;

export * from './contract-foundations.js';
export * from './operation-contracts.js';
export * from './sandbox-environment-contracts.js';
export * from './sandbox-execution-contracts.js';
export * from './sandbox-filesystem-contracts.js';
export * from './sandbox-process-contracts.js';
export * from './sandbox-stream-contracts.js';
export * from './sandbox-terminal-contracts.js';
export * from './trusted-context-contracts.js';
