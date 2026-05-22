# Gondolin Mapped TCP Upstream Follow-Up Implementation Plan

Status: current / valid follow-up plan. Execute after `mise exec -- pnpm vitest run packages/agent-vm/src/integration-tests/live-cross-vm-ssh.integration.test.ts` passes locally and the human explicitly authorizes externally visible GitHub issue or PR actions.

Use this for:
- Filing the upstream Gondolin mapped-TCP classification issue.
- Preparing an upstream Gondolin regression test and PR.
- Removing the local `patches/@earendil-works__gondolin@0.9.1.patch` only after an upstream release contains the fix.

Do not use this for:
- Changing agent-vm's OpenClaw FS bridge.
- Designing credentialed runner execution.
- Replacing the live cross-VM SSH test.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upstream the local Gondolin mapped-TCP classification fix that agent-vm's OpenClaw Tool VM SSH path currently depends on.

**Architecture:** agent-vm uses Gondolin `tcp.hosts` to let a gateway VM SSH directly to a Tool VM's host-local `enableSsh()` listener. The local patch makes mapped-TCP sessions win classification before the generic TCP block path. This follow-up produces an upstream issue and, if accepted, an upstream PR with a regression test.

**Tech Stack:** TypeScript/JavaScript, Gondolin qemu network backend, pnpm patch evidence, GitHub issue/PR workflow, `mise exec -- ...` for local live verification.

---

## Grounding

Local patch file:

```text
patches/@earendil-works__gondolin@0.9.1.patch
```

Patch behavior in the local postinstall patch:

```js
const session = this.tcpSessions.get(info.key);
if (session?.mappedTcp) {
	session.protocol = "tcp";
	return true;
}
```

This lets explicit `tcp.hosts` mapped sessions win before protocol-specific egress policy branches. The important failure mode is the SSH-classified branch: mapped TCP sessions are created by the `tcp.hosts` path, but `allowTcpFlow` can later see `info.protocol === "ssh"` and route into SSH egress policy instead of honoring the already-mapped TCP session. The upstream fix belongs in Gondolin source (`host/src/qemu/net.ts`), while the local patch is against compiled `dist/src/qemu/net.js`.

The agent-vm proof case is:

```text
gateway VM ssh client
  -> Gondolin tcp.hosts mapped TCP
  -> host-local vm.enableSsh() listener
  -> Tool VM sshd
```

## Task 1: Capture the Upstream Report

**Files:**

- Read: `patches/@earendil-works__gondolin@0.9.1.patch`
- Read: `packages/agent-vm/src/integration-tests/live-cross-vm-ssh.integration.test.ts`
- Create: `docs/wip/communications/2026-05-22-gondolin-mapped-tcp-upstream.md`

- [ ] **Step 1: Write the report draft**

Create `docs/wip/communications/2026-05-22-gondolin-mapped-tcp-upstream.md`:

````md
# Gondolin mapped TCP classification upstream report

## Summary

Explicit `tcp.hosts` mapped TCP sessions should be allowed before protocol-
specific egress policy branches. agent-vm's OpenClaw Tool VM path depends on
this for gateway-VM-to-Tool-VM SSH through `vm.enableSsh()`.

The local patch is against compiled `dist/src/qemu/net.js`, but the upstream PR
should change the corresponding source in `host/src/qemu/net.ts`.

## Repro shape

1. Start Tool VM.
2. Call `toolVm.enableSsh({ listenHost: "127.0.0.1", listenPort })`.
3. Start gateway VM with:

   ```ts
   tcp: {
     hosts: {
       "tool-0.vm.host:22": `127.0.0.1:${listenPort}`,
     },
   }
   ```

4. From gateway VM, run `ssh tool-0.vm.host true`.

Expected: mapped TCP tunnel reaches the Tool VM sshd.

Actual without local patch: the mapped session can be classified as `ssh`, enter
the SSH egress branch in `allowTcpFlow`, and be denied because SSH egress policy
does not know this is an explicit `tcp.hosts` mapping.

## Local patch

The local patch checks `session?.mappedTcp` before protocol-specific branches:

```js
const session = this.tcpSessions.get(info.key);
if (session?.mappedTcp) {
  session.protocol = "tcp";
  return true;
}
```

## Full local patch

Use the full diff from:

```text
patches/@earendil-works__gondolin@0.9.1.patch
```

Do not paste only the short snippet into the upstream PR; the local patch also
removes redundant `const session = ...` declarations in later branches after
hoisting the session lookup.

## Proof in agent-vm

agent-vm carries a live integration test:

```bash
mise exec -- pnpm vitest run packages/agent-vm/src/integration-tests/live-cross-vm-ssh.integration.test.ts
```
````

- [ ] **Step 2: Verify the draft names the local proof**

Run:

```bash
rg -n "mapped TCP|live-cross-vm-ssh|session\\?\\.mappedTcp|tcp\\.hosts" docs/wip/communications/2026-05-22-gondolin-mapped-tcp-upstream.md
rg -n "allowTcpFlow|ssh egress|host/src/qemu/net.ts|dist/src/qemu/net.js|Full local patch" docs/wip/communications/2026-05-22-gondolin-mapped-tcp-upstream.md
```

Expected: all terms are present.

## Task 2: File the Upstream Issue

**Files:**

- Read: `docs/wip/communications/2026-05-22-gondolin-mapped-tcp-upstream.md`

- [ ] **Step 1: Confirm upstream repository**

Run:

```bash
gh repo view earendil-works/gondolin --json nameWithOwner,url
```

Expected: returns `earendil-works/gondolin`.

- [ ] **Step 2: File the issue**

Run only when the human has asked for externally visible GitHub actions:

```bash
gh issue create \
  --repo earendil-works/gondolin \
  --title "Allow explicit tcp.hosts mapped TCP before generic raw TCP block" \
  --body-file docs/wip/communications/2026-05-22-gondolin-mapped-tcp-upstream.md
```

Expected: GitHub returns the issue URL.

- [ ] **Step 3: Record the issue URL**

Append the issue URL to `docs/wip/communications/2026-05-22-gondolin-mapped-tcp-upstream.md`:

```md
## Upstream issue

<issue-url>
```

## Task 3: Prepare the Upstream PR Lane

**Files:**

- Modify in upstream Gondolin checkout, not in this agent-vm repo.

- [ ] **Step 1: Create or switch to a Gondolin upstream worktree**

Use the user's normal worktree flow in the Gondolin checkout:

```bash
wt switch -c fix-mapped-tcp-classification
```

Expected: a clean Gondolin worktree on a fix branch.

- [ ] **Step 2: Port the patch to source**

Find the source file corresponding to the patched compiled file:

```bash
rg -n "allowTcpFlow|mappedTcp|isSshFlowAllowed" host/src
```

Expected: one network backend source file owns `allowTcpFlow`.

Update the source so mapped TCP sessions are accepted before protocol-specific egress policy branches, matching the local patch's behavior.

- [ ] **Step 3: Add an upstream regression test**

Inspect upstream network backend tests first:

```bash
find host test tests -path '*qemu*' -o -path '*net*' 2>/dev/null | sort
rg -n "allowTcpFlow|mappedTcp|QemuNetworkBackend|isSshFlowAllowed" host test tests
```

Add the smallest Gondolin test that follows the existing test style and proves an explicit `tcp.hosts` mapping is allowed even when the classifier reports `protocol === "ssh"`.

At minimum, the test should assert:

```ts
expect(allowed).toBe(true);
expect(session.protocol).toBe('tcp');
```

- [ ] **Step 4: Run upstream checks**

Run the relevant Gondolin tests from the Gondolin repo:

```bash
mise exec -- pnpm test
```

If the upstream repo does not use `mise`, run its documented test command and record the exact command in the PR body.

- [ ] **Step 5: Open the upstream PR**

Run only when the human has asked for externally visible GitHub actions:

```bash
gh pr create \
  --repo earendil-works/gondolin \
  --title "Allow explicit tcp.hosts mapped TCP before generic TCP block" \
  --body "Fixes <issue-url>. Adds a regression test for explicit tcp.hosts mapped TCP classification."
```

Expected: GitHub returns the PR URL.

## Task 4: Handle Upstream Response

**Files:**

- Modify: `docs/wip/communications/2026-05-22-gondolin-mapped-tcp-upstream.md`

- [ ] **Step 1: Record upstream decision**

If upstream accepts the approach, record the issue and PR URLs.

If upstream rejects the approach or requests a different fix, document the rationale and keep maintaining the local patch. Rejection is not a failure of this plan; it means patch removal waits indefinitely or is replaced by the upstream-preferred fix.

## Task 5: Remove Local Patch After Upstream Release

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Delete: `patches/@earendil-works__gondolin@0.9.1.patch`

- [ ] **Step 1: Upgrade Gondolin after upstream release**

This task may wait indefinitely. Run only after a Gondolin release includes the mapped-TCP fix:

```bash
pnpm up @earendil-works/gondolin@<released-version>
```

- [ ] **Step 2: Remove the patch**

Delete `patches/@earendil-works__gondolin@0.9.1.patch` only after the upgraded package contains the fix.

- [ ] **Step 3: Run quality gates before removing the patch**

Run:

```bash
pnpm typecheck
pnpm test:unit
pnpm check
```

Expected: pass. If the Gondolin upgrade has unrelated breaking changes, fix those before removing the patch.

- [ ] **Step 4: Prove the agent-vm SSH path still works**

Run:

```bash
mise exec -- pnpm vitest run packages/agent-vm/src/integration-tests/live-cross-vm-ssh.integration.test.ts
```

Expected: pass.

## Self-Review Checklist

- The upstream report explains why this is a Gondolin mapped-TCP issue, not an OpenClaw FS bridge issue.
- No GitHub issue or PR is created unless the human explicitly authorizes externally visible actions.
- The local patch is removed only after an upstream Gondolin release contains the fix and the live cross-VM SSH test passes.
