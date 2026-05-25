# MCP Portal Item-Level Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MCP Portal mixed batches execute approval-free calls while returning item-level approval errors for only the calls that need approval.

**Architecture:** Move MCP Portal approval from one batch-level decision to a per-call decision map. In OpenClaw native plugin mode, keep OpenClaw's `before_tool_call` hook as the human approval rail, but have the hook inject a short-lived server-only `portalApprovalToken` into approved homogeneous approval batches. Mixed batches do not trigger one giant approval prompt; safe calls run and gated calls return per-item `approval_required` errors.

**Tech Stack:** TypeScript, Zod, Vitest, OpenClaw native plugin hooks, MCP Portal HMAC approval tokens, pnpm monorepo tooling.

---

## Scope

This plan only changes `agent-vm` packages:

- `@agent-vm/mcp-portal`
- `@agent-vm/openclaw-mcp-portal-plugin`
- related docs/tests

It does not require an OpenClaw core change.

The intended behavior:

```text
Input batch:
  linear.list_issues        withoutApproval
  tavily.tavily_search      withoutApproval
  linear.save_issue         requiresApproval

Result:
  linear.list_issues        executes
  tavily.tavily_search      executes
  linear.save_issue         fails as approval_required

Follow-up:
  agent retries only linear.save_issue in its own batch
  OpenClaw approval prompt appears for that homogeneous approval batch
  after approval, hook injects portalApprovalToken
  MCP Portal core verifies token and executes the approved call
```

## File Structure

### Core approval evaluation

- Modify `packages/mcp-portal/src/core/portal-tools.ts`
  - Owns the core `mcp_portal_call` execution loop.
  - Replace the single batch approval decision with a decision per prepared call id.

- Create `packages/mcp-portal/src/core/portal-approval-evaluator.ts`
  - Owns reusable policy-to-approval-decision logic.
  - Used by both the MCP proxy and the OpenClaw native plugin.
  - Verifies approval tokens only for calls that require approval.

- Create `packages/mcp-portal/src/core/portal-approval-evaluator.test.ts`
  - Pins proxy-style missing-token behavior.
  - Pins native OpenClaw-style approval-required behavior.
  - Pins token replay protection through the shared evaluator.

- Modify `packages/mcp-portal/src/core/portal-core.ts`
  - Delete the old `approvalTrustBoundary: 'openclaw-before-tool-call-hook'` branch after the native plugin starts passing a real evaluator.

- Modify `packages/mcp-portal/src/core/index.ts`
  - Export the shared approval evaluator.

### MCP proxy

- Modify `packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.ts`
  - Replace local approval-verifier policy logic with the shared evaluator.
  - Preserve proxy audit events.

- Modify `packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.test.ts`
  - Pin mixed-batch token behavior for bearer/proxy mode.

### OpenClaw native plugin

- Modify `packages/openclaw-mcp-portal-plugin/src/openclaw-plugin-api.ts`
  - Add `params?: Record<string, unknown>` to `OpenClawBeforeToolCallResult`.
  - This matches OpenClaw's real hook result shape.

- Modify `packages/openclaw-mcp-portal-plugin/src/portal-plugin-runtime-state.ts`
  - Add a process-local approval HMAC key.
  - Add a process-local consumed approval-token cache so OpenClaw native mode has the same one-shot token semantics as proxy mode.
  - The key is used only to bridge one OpenClaw-approved tool call into MCP Portal core execution.

- Modify `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.ts`
  - Keep policy blocking in the hook.
  - Require OpenClaw approval only when every call in the outer batch requires approval.
  - For mixed batches, return `undefined` so core can run safe calls and fail gated calls per item.
  - For homogeneous approval batches, inject `portalApprovalToken` into the approved params.

- Modify `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.test.ts`
  - Pin mixed batch pass-through.
  - Pin approval token injection for homogeneous approval batches.

- Modify `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts`
  - Stop using `approvalTrustBoundary: 'openclaw-before-tool-call-hook'`.
  - Provide MCP Portal core a real approval evaluator using the loaded profile and process-local approval key.

- Modify `packages/openclaw-mcp-portal-plugin/src/openclaw-plugin-api-compat.typecheck.ts`
  - Assert the local `params` hook-result type remains compatible with OpenClaw SDK.

### Docs

- Modify `docs/subsystems/mcp-portal.md`
  - Document item-level approval behavior and the retry pattern for approval-required calls.

- Modify `docs/subsystems/mcp-portal.md` only if it already contains the MCP Portal operational explanation.
  - Do not create a second docs surface unless the existing file cannot carry the explanation cleanly.

---

## Task 1: Convert Core Approval From Batch-Level To Per-Call

**Files:**

- Modify: `packages/mcp-portal/src/core/portal-tools.ts`
- Modify: `packages/mcp-portal/src/core/portal-tools.test.ts`

- [ ] **Step 1: Write the failing mixed-batch core test**

Add this test near the current approval tests in `packages/mcp-portal/src/core/portal-tools.test.ts`.

```ts
it('executes approval-free calls when another prepared call needs approval', async () => {
	const callUpstreamTool = vi.fn(async (call) => ({
		content: [{ text: `called ${call.toolName}`, type: 'text' }],
	}));
	const handlers = createPortalToolHandlers({
		approval: (calls) => ({
			decisionsByCallId: Object.fromEntries(
				calls.map((call) => [
					call.id,
					call.toolName === 'create_issue'
						? { kind: 'approval_required', level: 'critical' }
						: { kind: 'allow' },
				]),
			),
		}),
		callUpstreamTool,
		getSession: vi.fn(async () => session),
	});

	await expect(
		handlers.call({
			identity: session.identity,
			input: {
				calls: [
					{
						arguments: { title: 'Fix deploy' },
						id: 'needs-approval',
						namespace: 'linear',
						toolName: 'create_issue',
					},
					{
						arguments: {},
						id: 'safe-defaulted',
						namespace: 'linear',
						toolName: 'create_issue_with_default',
					},
				],
			},
		}),
	).resolves.toMatchObject({
		ok: false,
		results: {
			'needs-approval': {
				error: {
					kind: 'approval_required',
					level: 'critical',
					message: 'Operator approval is required before this MCP Portal call can run.',
				},
				ok: false,
			},
			'safe-defaulted': {
				ok: true,
				output: {
					namespace: 'linear',
					toolName: 'create_issue_with_default',
				},
			},
		},
	});

	expect(callUpstreamTool).toHaveBeenCalledTimes(1);
	expect(callUpstreamTool).toHaveBeenCalledWith(
		expect.objectContaining({
			arguments: { title: 'Fallback title' },
			toolName: 'create_issue_with_default',
		}),
	);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/core/portal-tools.test.ts -t 'executes approval-free calls when another prepared call needs approval'
```

Expected:

```text
FAIL
Expected callUpstreamTool to have been called 1 times
```

The current batch-level code marks both prepared calls as approval-required and executes neither.

- [ ] **Step 3: Change the approval runtime type**

In `packages/mcp-portal/src/core/portal-tools.ts`, replace the current batch-returning `approval` function type with exported decision types.

```ts
export type PortalApprovalCallDecision =
	| { readonly kind: 'allow' }
	| { readonly kind: 'approval_required'; readonly level: 'critical' | 'standard' }
	| { readonly kind: 'approval_token_invalid'; readonly reason: string }
	| { readonly kind: 'approval_token_missing' }
	| { readonly kind: 'call_blocked' };

export interface PortalApprovalEvaluation {
	readonly decisionsByCallId: Readonly<Record<string, PortalApprovalCallDecision>>;
}

export interface PortalToolRuntime {
	readonly approval?: (
		calls: readonly PortalApprovalCall[],
		identity: PortalAgentIdentity,
		approvalToken: string | undefined,
	) => PortalApprovalEvaluation;
	readonly callUpstreamTool: (call: PortalCallUpstreamTool) => Promise<unknown>;
	readonly getSession: (identity: PortalAgentIdentity) => Promise<PortalSession>;
}
```

Remove the old local `PortalApprovalDecision` type. The exported `PortalApprovalCallDecision` replaces it.

- [ ] **Step 4: Add a helper for default allow decisions**

In `packages/mcp-portal/src/core/portal-tools.ts`, add this helper near the approval types.

```ts
function approvalEvaluationForAllCalls(
	calls: readonly PortalApprovalCall[],
	decision: PortalApprovalCallDecision,
): PortalApprovalEvaluation {
	return {
		decisionsByCallId: Object.fromEntries(calls.map((call) => [call.id, decision])),
	};
}
```

- [ ] **Step 5: Apply decisions per prepared call**

In `createPortalToolHandlers(...).call`, replace the single `approval` decision block with:

```ts
const approval =
	approvalCalls.length === 0
		? approvalEvaluationForAllCalls(approvalCalls, { kind: 'allow' })
		: (runtime.approval?.(
				approvalCalls,
				call.identity,
				parsedInput.data.portalApprovalToken,
			) ??
				approvalEvaluationForAllCalls(approvalCalls, {
					kind: 'approval_token_missing',
				}));
```

Then inside the `for (const preparedResult of preparedResults)` loop, replace every use of `approval.kind` with a per-call lookup:

```ts
const approvalDecision = approval.decisionsByCallId[preparedResult.input.id] ?? {
	kind: 'approval_token_missing',
};

if (approvalDecision.kind === 'approval_required') {
	results[preparedResult.input.id] = itemError({
		error: {
			kind: 'approval_required',
			level: approvalDecision.level,
			message: 'Operator approval is required before this MCP Portal call can run.',
			namespace: preparedResult.tool.namespace,
			toolName: preparedResult.tool.toolName,
		},
		input: { ...preparedResult.input, arguments: preparedResult.validatedArguments },
	});
	continue;
}
if (approvalDecision.kind === 'approval_token_missing') {
	results[preparedResult.input.id] = itemError({
		error: {
			kind: 'approval_token_missing',
			message: 'An MCP Portal approval token is required before this MCP Portal call can run.',
			namespace: preparedResult.tool.namespace,
			toolName: preparedResult.tool.toolName,
		},
		input: { ...preparedResult.input, arguments: preparedResult.validatedArguments },
	});
	continue;
}
if (approvalDecision.kind === 'approval_token_invalid') {
	results[preparedResult.input.id] = itemError({
		error: {
			kind: 'approval_token_invalid',
			message: `MCP Portal approval token is invalid: ${approvalDecision.reason}.`,
			namespace: preparedResult.tool.namespace,
			reason: approvalDecision.reason,
			toolName: preparedResult.tool.toolName,
		},
		input: { ...preparedResult.input, arguments: preparedResult.validatedArguments },
	});
	continue;
}
if (approvalDecision.kind === 'call_blocked') {
	results[preparedResult.input.id] = itemError({
		error: {
			kind: 'call_blocked',
			message: 'MCP Portal policy does not allow this tool call.',
			namespace: preparedResult.tool.namespace,
			toolName: preparedResult.tool.toolName,
		},
		input: { ...preparedResult.input, arguments: preparedResult.validatedArguments },
	});
	continue;
}
```

Leave `approvalDecision.kind === 'allow'` as the only path that pushes to `callsToExecute`.

- [ ] **Step 6: Update existing allow helper in tests**

In `packages/mcp-portal/src/core/portal-tools.test.ts`, replace:

```ts
function allowDecision(): { readonly kind: 'allow' } {
	return { kind: 'allow' };
}
```

with:

```ts
function allowDecision(calls: readonly { readonly id: string }[]): {
	readonly decisionsByCallId: Readonly<Record<string, { readonly kind: 'allow' }>>;
} {
	return {
		decisionsByCallId: Object.fromEntries(calls.map((call) => [call.id, { kind: 'allow' }])),
	};
}
```

- [ ] **Step 7: Rename the old whole-batch approval test**

Replace the current test name:

```ts
it('fails closed for the whole batch when approval is required', async () => {
```

with:

```ts
it('returns item-level approval errors when every prepared call requires approval', async () => {
```

Inside the test, update `approval` to return decisions by call id:

```ts
approval: (calls) => ({
	decisionsByCallId: Object.fromEntries(
		calls.map((call) => [call.id, { kind: 'approval_required', level: 'critical' }]),
	),
}),
```

Keep `expect(callUpstreamTool).not.toHaveBeenCalled()`.

- [ ] **Step 8: Run the targeted core tests**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/core/portal-tools.test.ts
```

Expected:

```text
PASS packages/mcp-portal/src/core/portal-tools.test.ts
```

- [ ] **Step 9: Commit Task 1**

```bash
git add packages/mcp-portal/src/core/portal-tools.ts packages/mcp-portal/src/core/portal-tools.test.ts
git commit -m "feat: make mcp portal approvals item-level"
```

---

## Task 2: Add Shared Policy Approval Evaluator

**Files:**

- Create: `packages/mcp-portal/src/core/portal-approval-evaluator.ts`
- Create: `packages/mcp-portal/src/core/portal-approval-evaluator.test.ts`
- Modify: `packages/mcp-portal/src/core/portal-core.ts`
- Modify: `packages/mcp-portal/src/core/index.ts`
- Modify: `packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.ts`
- Modify: `packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.test.ts`

- [ ] **Step 1: Write the failing proxy test**

In `packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.test.ts`, add a test that proves token-missing affects only approval-required calls.

```ts
it('allows no-approval calls while marking only gated calls as token-missing', () => {
	const verifier = createVerifier({
		agent: {
			credentialVersion: 1,
			hmacKey: { name: 'KEY', source: 'environment' },
			profile: 'builder',
		},
		profile: {
			approval: {
				allowWithoutApprovalTools: [{ namespace: 'linear', toolName: 'list_issues' }],
				alwaysAskTools: [{ namespace: 'linear', toolName: 'create_issue' }],
				annotationPolicy: 'destructive-requires-approval',
				callPoliciesByNamespace: {},
				trustedAnnotationNamespaces: [],
				writeTools: [],
			},
			cache: { catalogTtlMs: 60_000 },
			enabledNamespaces: ['linear'],
			enabledToolsByNamespace: {},
			hiddenToolsByNamespace: {},
			logging: { enabled: false },
			promptContext: { enabled: true, maxNamespaces: 12 },
		},
	});

	expect(
		verifier(
			[
				call({ id: 'list', namespace: 'linear', toolName: 'list_issues', arguments: {} }),
				call({
					id: 'create',
					namespace: 'linear',
					toolName: 'create_issue',
					arguments: { title: 'Fix deploy' },
				}),
			],
			'agent-a',
			undefined,
		),
	).toEqual({
		decisionsByCallId: {
			create: { kind: 'approval_token_missing' },
			list: { kind: 'allow' },
		},
	});
});
```

If the existing helper names differ, keep the existing helper style but preserve the same assertion shape.

- [ ] **Step 2: Run the failing proxy test**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.test.ts -t 'allows no-approval calls while marking only gated calls as token-missing'
```

Expected:

```text
FAIL
Expected batch-level token-missing/allow shape to equal per-call decisions
```

- [ ] **Step 3: Create the shared evaluator**

Create `packages/mcp-portal/src/core/portal-approval-evaluator.ts`.

```ts
import type { ResolvedMcpPortalProfile } from '@agent-vm/config-contracts';
import { mcpPortalCallPolicyDecision } from '@agent-vm/config-contracts';

import { hashCallArguments, verifyApprovalToken } from '../portal-auth/hmac-token.js';
import type {
	PortalApprovalCall,
	PortalApprovalCallDecision,
	PortalApprovalEvaluation,
} from './portal-tools.js';

export interface PortalApprovalPolicyRecord {
	readonly hmacKey?: Buffer;
	readonly profile: ResolvedMcpPortalProfile;
}

export interface CreatePortalPolicyApprovalEvaluatorProps {
	readonly consumeTokenId?: (
		agentId: string,
		jti: string,
		expiresAtMs: number,
	) =>
		| { readonly ok: true }
		| { readonly ok: false; readonly reason: 'replay-cache-full' | 'replayed' };
	readonly missingApprovalTokenDecision?: Extract<
		PortalApprovalCallDecision,
		{ readonly kind: 'approval_required' | 'approval_token_missing' }
	>;
	readonly maxLifetimeMs?: number;
	readonly nowMs?: () => number;
	readonly resolveRecord: (agentId: string) => PortalApprovalPolicyRecord | undefined;
}

function approvalTokenCallDigests(calls: readonly PortalApprovalCall[]): readonly {
	readonly argumentsHash: string;
	readonly namespace: string;
	readonly toolName: string;
}[] {
	return calls.map((call) => ({
		argumentsHash: hashCallArguments(call.arguments),
		namespace: call.namespace,
		toolName: call.toolName,
	}));
}

function callDecisionFromVerifierReason(
	reason: string,
): Extract<PortalApprovalCallDecision, { readonly kind: 'approval_token_invalid' }> {
	return { kind: 'approval_token_invalid', reason };
}

export function createPortalPolicyApprovalEvaluator(
	props: CreatePortalPolicyApprovalEvaluatorProps,
): (
	calls: readonly PortalApprovalCall[],
	agentId: string,
	token: string | undefined,
) => PortalApprovalEvaluation {
	return (calls, agentId, token) => {
		const record = props.resolveRecord(agentId);
		if (record === undefined) {
			return {
				decisionsByCallId: Object.fromEntries(
					calls.map((call) => [
						call.id,
						callDecisionFromVerifierReason('unknown-agent'),
					]),
				),
			};
		}

		const policyDecisions = calls.map((call) =>
			mcpPortalCallPolicyDecision(record.profile, {
				...(call.tool.annotations === undefined ? {} : { annotations: call.tool.annotations }),
				namespace: call.namespace,
				toolName: call.toolName,
			}),
		);

		const decisionsByCallId: Record<string, PortalApprovalCallDecision> = {};
		const callsRequiringApproval: PortalApprovalCall[] = [];

		for (const [index, call] of calls.entries()) {
			const policyDecision = policyDecisions[index];
			if (policyDecision?.kind === 'allow_without_approval') {
				decisionsByCallId[call.id] = { kind: 'allow' };
				continue;
			}
			if (policyDecision?.kind === 'requires_approval') {
				callsRequiringApproval.push(call);
				continue;
			}
			decisionsByCallId[call.id] = { kind: 'call_blocked' };
		}

		if (callsRequiringApproval.length === 0) {
			return { decisionsByCallId };
		}
		if (record.hmacKey === undefined) {
			for (const call of callsRequiringApproval) {
				decisionsByCallId[call.id] = callDecisionFromVerifierReason('missing-hmac-key');
			}
			return { decisionsByCallId };
		}
		if (token === undefined) {
			const missingTokenDecision = props.missingApprovalTokenDecision ?? {
				kind: 'approval_token_missing',
			};
			for (const call of callsRequiringApproval) {
				decisionsByCallId[call.id] = missingTokenDecision;
			}
			return { decisionsByCallId };
		}

		const verification = verifyApprovalToken({
			agentId,
			calls: approvalTokenCallDigests(callsRequiringApproval),
			consumeTokenId:
				props.consumeTokenId === undefined
					? undefined
					: (jti, expiresAtMs) => props.consumeTokenId?.(agentId, jti, expiresAtMs) ?? { ok: true },
			key: record.hmacKey,
			...(props.maxLifetimeMs === undefined ? {} : { maxLifetimeMs: props.maxLifetimeMs }),
			nowMs: props.nowMs?.() ?? Date.now(),
			token,
		});

		if (!verification.ok) {
			for (const call of callsRequiringApproval) {
				decisionsByCallId[call.id] = callDecisionFromVerifierReason(verification.reason);
			}
			return { decisionsByCallId };
		}

		for (const call of callsRequiringApproval) {
			decisionsByCallId[call.id] = { kind: 'allow' };
		}
		return { decisionsByCallId };
	};
}
```

- [ ] **Step 4: Add shared evaluator tests for proxy and native semantics**

Create `packages/mcp-portal/src/core/portal-approval-evaluator.test.ts`.

Use the existing test profile helper style from `packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.test.ts`. Add these assertions:

```ts
it('defaults missing approval tokens to token-missing for proxy callers', () => {
	const evaluateApproval = createPortalPolicyApprovalEvaluator({
		resolveRecord: () => ({ hmacKey: Buffer.alloc(32, 1), profile }),
	});

	expect(evaluateApproval([listIssuesCall, createIssueCall], 'agent-a', undefined)).toEqual({
		decisionsByCallId: {
			create: { kind: 'approval_token_missing' },
			list: { kind: 'allow' },
		},
	});
});

it('can surface missing approval tokens as approval-required for OpenClaw native callers', () => {
	const evaluateApproval = createPortalPolicyApprovalEvaluator({
		missingApprovalTokenDecision: { kind: 'approval_required', level: 'standard' },
		resolveRecord: () => ({ hmacKey: Buffer.alloc(32, 1), profile }),
	});

	expect(evaluateApproval([listIssuesCall, createIssueCall], 'agent-a', undefined)).toEqual({
		decisionsByCallId: {
			create: { kind: 'approval_required', level: 'standard' },
			list: { kind: 'allow' },
		},
	});
});

it('rejects replayed approval tokens through the shared evaluator', () => {
	const consumed = new Set<string>();
	const evaluateApproval = createPortalPolicyApprovalEvaluator({
		consumeTokenId: (_agentId, jti) => {
			if (consumed.has(jti)) {
				return { ok: false, reason: 'replayed' };
			}
			consumed.add(jti);
			return { ok: true };
		},
		nowMs: () => 1_000,
		resolveRecord: () => ({ hmacKey, profile }),
	});

	const token = signApprovalToken({
		agentId: 'agent-a',
		calls: [createIssueDigest],
		expiresAtMs: 61_000,
		issuedAtMs: 1_000,
		key: hmacKey,
	});

	expect(evaluateApproval([createIssueCall], 'agent-a', token).decisionsByCallId['create']).toEqual({
		kind: 'allow',
	});
	expect(evaluateApproval([createIssueCall], 'agent-a', token).decisionsByCallId['create']).toEqual({
		kind: 'approval_token_invalid',
		reason: 'replayed',
	});
});
```

Keep helper names local to the test file. The important contract is that proxy mode keeps the `approval_token_missing` surface while OpenClaw native mode can produce the agent-facing `approval_required` item error.

- [ ] **Step 5: Export the shared evaluator**

In `packages/mcp-portal/src/core/index.ts`, add:

```ts
export * from './portal-approval-evaluator.js';
```

- [ ] **Step 6: Rewire the proxy verifier**

In `packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.ts`, import:

```ts
import { createPortalPolicyApprovalEvaluator } from '../core/portal-approval-evaluator.js';
```

Update `createPortalApprovalVerifier(...)` so it returns the shared evaluator's `PortalApprovalEvaluation`.

Use the existing replay cache by passing `consumeTokenId`:

```ts
const evaluateApproval = createPortalPolicyApprovalEvaluator({
	consumeTokenId: (agentId, jti, expiresAtMs) => consumeTokenId(agentId, jti, expiresAtMs),
	maxLifetimeMs: approvalTokenMaxLifetimeMs,
	resolveRecord: (agentId) => props.records.get(agentId),
});
```

Then:

```ts
return (calls, agentId, token) => {
	const evaluation = evaluateApproval(calls, agentId, token);
	auditApproval({
		agentId,
		decision: Object.values(evaluation.decisionsByCallId).every(
			(decision) => decision.kind === 'allow',
		)
			? 'allow'
			: 'deny',
		reason: 'per_call_evaluation',
	});
	return evaluation;
};
```

Keep existing audit fields when straightforward, but do not block this task on perfect audit taxonomy. The behavior contract is the per-call decision map.

- [ ] **Step 7: Delete the obsolete trusted-boundary shortcut**

In `packages/mcp-portal/src/core/portal-core.ts`, replace `CreatePortalCoreProps` with a single-props interface that always requires a real approval evaluator.

```ts
export interface CreatePortalCoreProps extends CreatePortalCoreBaseProps {
	readonly approval: PortalApprovalEvaluator;
}
```

Then replace the fallback approval block in `createPortalCore`:

```ts
const approval: PortalApprovalEvaluator =
	props.approval ??
	(() => {
		if (props.approvalTrustBoundary === 'openclaw-before-tool-call-hook') {
			return { kind: 'allow' };
		}
		throw new Error('MCP Portal approval evaluation is not configured.');
	});
```

with:

```ts
const approval = props.approval;
```

Run:

```bash
rg -n "approvalTrustBoundary|openclaw-before-tool-call-hook" packages/mcp-portal packages/openclaw-mcp-portal-plugin
```

Expected:

```text
no matches
```

- [ ] **Step 8: Run proxy and core tests**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/core/portal-approval-evaluator.test.ts packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.test.ts packages/mcp-portal/src/core/portal-tools.test.ts
```

Expected:

```text
PASS packages/mcp-portal/src/core/portal-approval-evaluator.test.ts
PASS packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.test.ts
PASS packages/mcp-portal/src/core/portal-tools.test.ts
```

- [ ] **Step 9: Commit Task 2**

```bash
git add packages/mcp-portal/src/core/portal-approval-evaluator.ts packages/mcp-portal/src/core/portal-approval-evaluator.test.ts packages/mcp-portal/src/core/portal-core.ts packages/mcp-portal/src/core/index.ts packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.ts packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.test.ts
git commit -m "feat: share mcp portal approval evaluation"
```

---

## Task 3: Bridge OpenClaw Approval Into Core With A Server-Only Token

**Files:**

- Modify: `packages/openclaw-mcp-portal-plugin/src/openclaw-plugin-api.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/openclaw-plugin-api-compat.typecheck.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/portal-plugin-runtime-state.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.test.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts`

- [ ] **Step 1: Write the failing hook tests**

In `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.test.ts`, replace the old approval-mutation test with these two tests.

```ts
it('passes mixed batches through so core can fail only gated calls', async () => {
	const handler = createBeforeToolCallHandler({ runtimeState: createRuntimeState() });

	await expect(
		handler(
			{
				params: {
					calls: [
						{
							arguments: { query: 'deploy' },
							id: 'list',
							namespace: 'linear',
							toolName: 'list_issues',
						},
						{
							arguments: { title: 'Fix deploy' },
							id: 'create',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
				toolName: 'mcp_portal_call',
			},
			{ agentId: 'shravan' },
		),
	).resolves.toBeUndefined();
});

it('injects a portal approval token for homogeneous approval batches', async () => {
	const handler = createBeforeToolCallHandler({ runtimeState: createRuntimeState() });

	await expect(
		handler(
			{
				params: {
					calls: [
						{
							arguments: { title: 'Fix deploy' },
							id: 'create',
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				},
				toolName: 'mcp_portal_call',
			},
			{ agentId: 'shravan' },
		),
	).resolves.toMatchObject({
		params: {
			portalApprovalToken: expect.any(String),
		},
		requireApproval: expect.objectContaining({
			pluginId: 'mcp-portal',
			title: expect.stringContaining('MCP Portal batch'),
		}),
	});
});
```

- [ ] **Step 2: Run the failing hook tests**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.test.ts
```

Expected:

```text
FAIL
Expected mixed batch to pass through
Expected result.params.portalApprovalToken to be a string
```

- [ ] **Step 3: Add params to the local OpenClaw hook type**

In `packages/openclaw-mcp-portal-plugin/src/openclaw-plugin-api.ts`, update:

```ts
export interface OpenClawBeforeToolCallResult {
	readonly block?: boolean;
	readonly blockReason?: string;
	readonly params?: Record<string, unknown>;
	readonly requireApproval?: {
		readonly description: string;
		readonly onResolution?: (decision: OpenClawApprovalResolution) => Promise<void> | void;
		readonly pluginId?: string;
		readonly severity?: 'critical' | 'info' | 'warning';
		readonly timeoutBehavior?: 'allow' | 'deny';
		readonly timeoutMs?: number;
		readonly title: string;
	};
}
```

- [ ] **Step 4: Strengthen the SDK compatibility typecheck**

In `packages/openclaw-mcp-portal-plugin/src/openclaw-plugin-api-compat.typecheck.ts`, add an assertion that the local before-tool-call result is assignable to the SDK hook result.

```ts
import type { PluginHookBeforeToolCallResult } from 'openclaw/plugin-sdk';
import type { OpenClawBeforeToolCallResult } from './openclaw-plugin-api.js';

export const openClawBeforeToolCallResultMatchesSdk = true satisfies AssertAssignable<
	OpenClawBeforeToolCallResult,
	PluginHookBeforeToolCallResult
>;
```

If `PluginHookBeforeToolCallResult` is already exported through the existing import path, use that exact export. Keep the assertion in this file so type drift fails during typecheck.

- [ ] **Step 5: Add a process-local approval key**

In `packages/openclaw-mcp-portal-plugin/src/portal-plugin-runtime-state.ts`, import:

```ts
import { randomBytes } from 'node:crypto';
```

Update the interface:

```ts
export interface PortalPluginRuntimeState {
	readonly consumeApprovalTokenId: (
		agentId: string,
		jti: string,
		expiresAtMs: number,
	) =>
		| { readonly ok: true }
		| { readonly ok: false; readonly reason: 'replay-cache-full' | 'replayed' };
	readonly configDir: string;
	readonly getApprovalHmacKey: () => Buffer;
	readonly getLoadedPortalConfig: () => McpPortalConfig | null;
	readonly getPortalUnavailableReason: () => string | null;
	readonly loadPortalConfig: () => Promise<McpPortalConfig>;
	readonly markPortalAvailable: () => void;
	readonly markPortalUnavailable: (reason: string) => void;
}
```

Inside `createPortalPluginRuntimeState`, add:

```ts
const approvalHmacKey = randomBytes(32);
const consumedApprovalTokenIds = new Map<string, number>();
const replayCacheLimit = 4096;
```

And return:

```ts
consumeApprovalTokenId: (agentId, jti, expiresAtMs) => {
	const nowMs = Date.now();
	for (const [tokenKey, tokenExpiresAtMs] of consumedApprovalTokenIds) {
		if (tokenExpiresAtMs <= nowMs) {
			consumedApprovalTokenIds.delete(tokenKey);
		}
	}
	const tokenKey = `${agentId}\n${jti}`;
	if (consumedApprovalTokenIds.has(tokenKey)) {
		return { ok: false, reason: 'replayed' };
	}
	if (consumedApprovalTokenIds.size >= replayCacheLimit) {
		return { ok: false, reason: 'replay-cache-full' };
	}
	consumedApprovalTokenIds.set(tokenKey, expiresAtMs);
	return { ok: true };
},
getApprovalHmacKey: () => approvalHmacKey,
```

- [ ] **Step 6: Sign approval tokens in the hook**

In `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.ts`, import:

```ts
import { hashCallArguments, signApprovalToken } from '@agent-vm/mcp-portal/portal-auth/hmac-token';
```

Add helper:

```ts
function approvalTokenForCalls(props: {
	readonly agentId: string;
	readonly calls: readonly PortalCallRequest[];
	readonly key: Buffer;
	readonly nowMs?: number;
}): string {
	const nowMs = props.nowMs ?? Date.now();
	return signApprovalToken({
		agentId: props.agentId,
		calls: props.calls.map((call) => ({
			argumentsHash: hashCallArguments(call.arguments),
			namespace: call.namespace,
			toolName: call.toolName,
		})),
		expiresAtMs: nowMs + 60_000,
		issuedAtMs: nowMs,
		key: props.key,
	});
}
```

Then replace the final approval block with:

```ts
if (approvalCalls.length === 0) {
	return undefined;
}
if (approvalCalls.length !== calls.length) {
	return undefined;
}

const toolNames = approvalCalls
	.map((call) => `${call.namespace}.${call.toolName}`)
	.toSorted()
	.join(', ');
let portalApprovalToken: string | undefined;
try {
	portalApprovalToken = approvalTokenForCalls({
		agentId,
		calls: approvalCalls,
		key: props.runtimeState.getApprovalHmacKey(),
	});
} catch (error) {
	props.logger?.warn?.(
		`mcp-portal: failed to sign OpenClaw approval token: ${
			error instanceof Error ? error.message : String(error)
		}`,
	);
}
return {
	...(portalApprovalToken === undefined
		? {}
		: { params: { ...event.params, portalApprovalToken } }),
	requireApproval: {
		description: `Allow MCP Portal batch for agent ${agentId}: ${toolNames}.`,
		pluginId: 'mcp-portal',
		severity: 'warning',
		timeoutBehavior: 'deny',
		timeoutMs: 60_000,
		title: `MCP Portal batch: ${toolNames}`,
	},
};
```

- [ ] **Step 7: Rewire native plugin core approval**

In `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts`, import:

```ts
import { createPortalPolicyApprovalEvaluator } from '@agent-vm/mcp-portal/core';
```

Change `createManagedPortalCore` to accept the runtime state:

```ts
async function createManagedPortalCore(
	configDir: string,
	runtimeState: ReturnType<typeof createPortalPluginRuntimeState>,
): Promise<PortalCore> {
```

Inside it, after `profilePolicyMaps`, create the evaluator:

```ts
const approval = createPortalPolicyApprovalEvaluator({
	consumeTokenId: (agentId, jti, expiresAtMs) =>
		runtimeState.consumeApprovalTokenId(agentId, jti, expiresAtMs),
	missingApprovalTokenDecision: { kind: 'approval_required', level: 'standard' },
	resolveRecord: (agentId) => {
		const agent = portalConfig.agents[agentId];
		if (agent === undefined) {
			return undefined;
		}
		return {
			hmacKey: runtimeState.getApprovalHmacKey(),
			profile: resolveMcpPortalProfile(portalConfig, agent.profile),
		};
	},
});
```

Then replace:

```ts
approvalTrustBoundary: 'openclaw-before-tool-call-hook',
```

with:

```ts
approval,
```

This native-mode evaluator intentionally uses the same one-shot token consumption as the proxy evaluator. A token injected into approved tool params is valid only for the exact approved call digest and only once.

Update the caller:

```ts
corePromise ??= createManagedPortalCore(configDir, runtimeState).catch((error: unknown) => {
```

- [ ] **Step 8: Run plugin tests**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.test.ts packages/openclaw-mcp-portal-plugin/src/openclaw-plugin-api-compat.typecheck.ts
```

Expected:

```text
PASS packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.test.ts
```

If Vitest does not execute the `.typecheck.ts` file directly, run the package typecheck in the next step.

- [ ] **Step 9: Run package typecheck**

Run:

```bash
pnpm --filter @agent-vm/openclaw-mcp-portal-plugin typecheck
```

Expected:

```text
Exit code 0
```

- [ ] **Step 10: Commit Task 3**

```bash
git add packages/openclaw-mcp-portal-plugin/src/openclaw-plugin-api.ts packages/openclaw-mcp-portal-plugin/src/openclaw-plugin-api-compat.typecheck.ts packages/openclaw-mcp-portal-plugin/src/portal-plugin-runtime-state.ts packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.ts packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.test.ts packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts
git commit -m "feat: bridge openclaw approval into mcp portal calls"
```

---

## Task 4: Update Core Integration Tests

**Files:**

- Modify: `packages/mcp-portal/src/core/portal-core.test.ts`
- Modify: `packages/mcp-portal/src/bin/mcp-portal.integration.test.ts`

- [ ] **Step 1: Update the portal core approval test**

In `packages/mcp-portal/src/core/portal-core.test.ts`, find the test named:

```ts
it('evaluates approval once for the full batch before upstream contact', async () => {
```

Rename it:

```ts
it('evaluates approval once and applies decisions per call before upstream contact', async () => {
```

Change the approval stub to:

```ts
const approval = vi.fn((calls) => ({
	decisionsByCallId: Object.fromEntries(
		calls.map((call) => [
			call.id,
			call.toolName === 'create_issue'
				? { kind: 'approval_required', level: 'standard' }
				: { kind: 'allow' },
		]),
	),
}));
```

Update expectations so the approval-required call fails and the allowed call executes.

- [ ] **Step 2: Run the portal core test**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/core/portal-core.test.ts -t 'evaluates approval once and applies decisions per call before upstream contact'
```

Expected:

```text
PASS packages/mcp-portal/src/core/portal-core.test.ts
```

- [ ] **Step 3: Update the CLI/proxy integration approval evaluator shape**

In `packages/mcp-portal/src/bin/mcp-portal.integration.test.ts`, update any `approval` or `createPortalApprovalVerifier` expectations to expect:

```ts
{
	decisionsByCallId: {
		[requestId]: { kind: 'allow' },
	},
}
```

instead of:

```ts
{ kind: 'allow' }
```

For approval-token-missing cases, expected output should only mark approval-required calls as `approval_token_missing`.

- [ ] **Step 4: Add a production-shaped native missing-token assertion**

In `packages/mcp-portal/src/core/portal-core.test.ts`, add or update one test to use the real `createPortalPolicyApprovalEvaluator` rather than a synthetic approval stub.

```ts
it('returns approval-required only for gated native calls when no portal token is present', async () => {
	const approval = createPortalPolicyApprovalEvaluator({
		missingApprovalTokenDecision: { kind: 'approval_required', level: 'standard' },
		resolveRecord: () => ({ hmacKey: Buffer.alloc(32, 1), profile }),
	});
	const core = createPortalCore({
		approval,
		accessPolicy,
		catalogTtlMs: 60_000,
		runtime,
		upstreamNamespaces: ['linear'],
	});

	const result = await core.collectPortalCoreResult(
		core.callStream({
			input: {
				calls: [
					{ arguments: {}, id: 'list', namespace: 'linear', toolName: 'list_issues' },
					{
						arguments: { title: 'Fix deploy' },
						id: 'create',
						namespace: 'linear',
						toolName: 'create_issue',
					},
				],
			},
			scope,
			toolName: 'mcp_portal_call',
		}),
	);

	expect(result.items).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ requestId: 'list', status: 'success' }),
			expect.objectContaining({
				error: expect.objectContaining({ code: 'approval_required' }),
				requestId: 'create',
				status: 'failed',
			}),
		]),
	);
});
```

Use the existing helper names in the file (`accessPolicy`, `runtime`, `scope`, `profile`) if they differ. This test exists to prevent the synthetic `approval_required` branch from drifting away from the production evaluator.

- [ ] **Step 5: Run MCP Portal integration tests**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/bin/mcp-portal.integration.test.ts
```

Expected:

```text
PASS packages/mcp-portal/src/bin/mcp-portal.integration.test.ts
```

- [ ] **Step 6: Commit Task 4**

```bash
git add packages/mcp-portal/src/core/portal-core.test.ts packages/mcp-portal/src/bin/mcp-portal.integration.test.ts
git commit -m "test: cover item-level mcp portal approvals"
```

---

## Task 5: Document The New Approval Semantics

**Files:**

- Modify: `docs/subsystems/mcp-portal.md`

- [ ] **Step 1: Add the operational behavior section**

In `docs/subsystems/mcp-portal.md`, add this section near the approval/policy explanation.

```md
## Item-Level Approval In Batches

`mcp_portal_call` accepts batches, but approval is evaluated per inner MCP call.

When a batch mixes approval-free calls with approval-required calls:

- approval-free calls execute normally
- blocked calls return item-level `call_blocked` errors
- approval-required calls return item-level `approval_required` errors
- the whole outer `mcp_portal_call` is not converted into one approval prompt

Agents should retry only the approval-required calls in a separate
`mcp_portal_call` batch. In OpenClaw native plugin mode, a homogeneous
approval-required batch triggers the OpenClaw plugin approval prompt. After the
operator approves it, the plugin injects a short-lived server-only
`portalApprovalToken`, and MCP Portal core verifies the token before executing
the gated calls.

This preserves parallel safe reads while keeping writes and sensitive calls
behind the configured approval policy.
```

- [ ] **Step 2: Run docs-adjacent tests if present**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/core/portal-tools.test.ts packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.test.ts
```

Expected:

```text
PASS packages/mcp-portal/src/core/portal-tools.test.ts
PASS packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.test.ts
```

- [ ] **Step 3: Commit Task 5**

```bash
git add docs/subsystems/mcp-portal.md
git commit -m "docs: explain mcp portal item-level approvals"
```

---

## Task 6: Full Verification

**Files:**

- No new source files.
- This task verifies the whole branch.

- [ ] **Step 1: Run targeted MCP Portal checks**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/core/portal-approval-evaluator.test.ts packages/mcp-portal/src/core/portal-tools.test.ts packages/mcp-portal/src/core/portal-core.test.ts packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.test.ts packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.test.ts
```

Expected:

```text
PASS
Exit code 0
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected:

```text
Exit code 0
```

- [ ] **Step 3: Run lint**

Run:

```bash
pnpm lint
```

Expected:

```text
Exit code 0
```

- [ ] **Step 4: Run format check**

Run:

```bash
pnpm fmt:check
```

Expected:

```text
Exit code 0
```

- [ ] **Step 5: Run full check**

Run:

```bash
pnpm check
```

Expected:

```text
Exit code 0
```

- [ ] **Step 6: Run unit tests**

Run:

```bash
pnpm test:unit
```

Expected:

```text
Exit code 0
```

- [ ] **Step 7: Run build**

Run:

```bash
pnpm build
```

Expected:

```text
Exit code 0
```

- [ ] **Step 8: Commit verification-only fixes if needed**

If formatting or type-only corrections were needed, commit them:

```bash
git add packages docs
git commit -m "chore: verify mcp portal approval changes"
```

If no files changed after verification, skip this commit.

---

## Task 7: Beta Validation Loop

**Files:**

- No committed source files required in `agent-vm`.
- Deployment changes belong in the beta deployment repo after this branch is built or packed.

- [ ] **Step 1: Pack local packages from this branch**

Run:

```bash
pack_dir="$(mktemp -d)"
pnpm --filter @agent-vm/mcp-portal pack --pack-destination "$pack_dir"
pnpm --filter @agent-vm/openclaw-mcp-portal-plugin pack --pack-destination "$pack_dir"
pnpm --filter @agent-vm/agent-vm pack --pack-destination "$pack_dir"
ls -1 "$pack_dir"
```

Expected:

```text
agent-vm-mcp-portal-*.tgz
agent-vm-openclaw-mcp-portal-plugin-*.tgz
agent-vm-agent-vm-*.tgz
```

- [ ] **Step 2: Install tarballs into beta using the deployment repo helper or pnpm force**

From the beta deployment repo, run the existing update helper if present. If there is no helper, run:

```bash
pnpm add --force --no-save "$pack_dir"/agent-vm-mcp-portal-*.tgz "$pack_dir"/agent-vm-openclaw-mcp-portal-plugin-*.tgz "$pack_dir"/agent-vm-agent-vm-*.tgz
```

Expected:

```text
dependencies updated from file: tarballs
```

- [ ] **Step 3: Verify beta installed the tarballs**

From the beta deployment repo, run:

```bash
pnpm list @agent-vm/mcp-portal @agent-vm/openclaw-mcp-portal-plugin @agent-vm/agent-vm
```

Expected:

```text
@agent-vm/mcp-portal file:
@agent-vm/openclaw-mcp-portal-plugin file:
@agent-vm/agent-vm file:
```

If the output shows registry versions instead of `file:`, stop and reinstall with `--force`.

- [ ] **Step 4: Validate beta config**

From the beta deployment repo, run:

```bash
pnpm validate
pnpm exec agent-vm validate --config config/system.jsonc --mcp-live
```

Expected:

```text
Exit code 0
```

- [ ] **Step 5: Restart beta**

Use the existing beta deployment restart command. After restart, verify the gateway is up with the deployment's normal status command.

Expected:

```text
beta gateway running
```

- [ ] **Step 6: Ask Pulse-beta to run the mixed-batch repro**

Ask Pulse-beta to run:

```text
Use mcp_portal_list, describe a read Linear tool and a write Linear tool, then call both in one mcp_portal_call batch.
Report per-item results.
```

Expected:

```text
read tool succeeds
write/approval tool returns item-level approval_required
no outer Plugin approval required (gateway unavailable) error
```

- [ ] **Step 7: Ask Pulse-beta to retry only the gated call**

Ask Pulse-beta:

```text
Retry only the approval-required Linear call by itself.
```

Expected:

```text
Discord/OpenClaw plugin approval prompt appears
after approval, the Linear call executes
```

- [ ] **Step 8: Capture beta evidence**

Record the beta results in the PR description:

```text
Beta mixed batch:
  safe calls: executed
  gated calls: item-level approval_required
  outer batch: no gateway-unavailable approval failure

Beta gated retry:
  homogeneous approval batch prompted
  approved call executed
```

---

## Self-Review

Spec coverage:

- Mixed batches no longer fail as one outer approval request: Task 1 and Task 3.
- Safe calls still execute in a mixed batch: Task 1.
- Approval-required calls still require human approval before execution: Task 2 and Task 3.
- No OpenClaw core change: Task 3 uses hook `params` and MCP Portal HMAC token bridging.
- Proxy/bearer mode stays secure: Task 2.
- Beta validation is explicit: Task 7.

Placeholder scan:

- No placeholder markers.
- No deferred edge handling.
- Every code-changing task includes exact code or exact replacement shape.

Type consistency:

- `PortalApprovalCallDecision` is the single decision type.
- `PortalApprovalEvaluation.decisionsByCallId` is used by core, proxy, and plugin.
- `portalApprovalToken` remains server-injected and unadvertised to the model-facing schema.
