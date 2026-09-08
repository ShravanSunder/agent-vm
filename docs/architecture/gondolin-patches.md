# Gondolin patches

Every Gondolin patch requires **Shravan's explicit approval** before addition or
change. This includes patch expansion/rebase, runtime monkeypatches, guest helper
changes and adopting a fork. Never infer permission from an earlier patch approval.
The operating rule is also in [AGENTS.md](../../AGENTS.md).

## Upstream patch tracker

This is the canonical tracker for every Gondolin patch carried by agent-vm.
Keep each entry after retirement so a future dependency update can distinguish an
upstream fix from a patch accidentally dropped during installation.

| Carried fix | Upstream PR | Last verified upstream state | Local state | Removal gate |
| --- | --- | --- | --- | --- |
| Early completion-promise rejection handling for guest writes/deletes | [#136](https://github.com/earendil-works/gondolin/pull/136) | Open, not draft, not merged; checked 2026-09-07; head `94b1f94828e5b834d5abe7fda478b3c7ce6ab352` | Approved two-line patch on `@earendil-works/gondolin@0.12.0` | A released dependency containing the equivalent fix is installed through the actual agent-vm consumer chain, passes the installed-dependency and real-VM regressions, and Shravan approves the dependency/patch transition |

For every added or changed patch, record its local patch path, affected dependency
version, approval scope, upstream PR URL and pinned revision, last status-check
date, first fixed release when verified, regression proof and removal gate. If no
upstream PR exists, say **not submitted** and link the issue or source evidence;
do not imply upstream submission or acceptance. Keep unadopted investigations
separate from the carried-patch list.

At dependency updates and before deployment qualification, recheck the upstream
PR and released package. An open PR is pending work on their side; a merged PR
still needs a release and local qualification. A closed/unmerged PR does not
resolve the defect or authorize dropping the local patch. Record the observed
state without assuming when upstream will resume accepting contributions.

If upstream remains unavailable or declines the fixes we need, evaluate a
maintained fork using the TODO below. Preserve these PR references in that fork's
patch history so later upstream reconciliation stays possible. Creating,
publishing or adopting the fork still requires Shravan's explicit approval.

## Approved patch: file-operation promise rejection handling

| Item | Scope |
| --- | --- |
| Dependency | `@earendil-works/gondolin@0.12.0` |
| Upstream reference | [PR #136](https://github.com/earendil-works/gondolin/pull/136), reviewed head `94b1f94828e5b834d5abe7fda478b3c7ce6ab352` |
| Local patch | [Gondolin 0.12.0 patch](../../patches/@earendil-works__gondolin@0.12.0.patch) |
| Registration | [pnpm-workspace.yaml](../../pnpm-workspace.yaml), exact version under `patchedDependencies`; lockfile records patched resolution |
| Changed code | Published `dist/src/sandbox/server-ops.js`: one internal `done.catch` in `writeGuestFile`, one in `deleteGuestFile` |
| Approval | Shravan explicitly approved this two-line patch and required visible code/repository documentation |

The host writer creates a private completion promise, consumes streamed input,
then awaits completion. An early input, transport or cancellation error can reject
that private promise before its await is attached. Catching the public
`vm.fs.writeFile` promise does not catch the separate private rejection, which can
terminate the Node controller process. Delete has the same early-error pattern.

The approved change attaches a no-op rejection observer immediately to each private
promise, matching upstream's existing read handling. The original promise still
rejects when awaited; normal caller-visible failure is preserved. This is **not**
a global unhandled-rejection suppression, a retry, or a successful-file result.
No guest binary, control protocol, rootfs mode or storage provider changes.

`vm.fs` is the access API; RealFS is an optional backing provider; VM lifecycle
is independent. This patch permits investigating the selected ephemeral-rootfs
stream path without replacing its working folder with a RealFS mount. It does
not repair every file-protocol error, concurrent-operation serialization, read
backpressure, or publication/path-safety issue.

## Regression and verification

The permanent [installed-dependency regression](../../packages/gondolin-vm-adapter/src/gondolin-file-operation-patch.host.e2e.test.ts)
uses real child Node processes with `--unhandled-rejections=strict`. Only the
VM/transport edge is injected. It verifies input failure, transport failure,
write cancellation, delete failure and success against the installed dependency,
not a copy of its implementation. The test comment points here intentionally.

```sh
pnpm vitest run --project e2e-host packages/gondolin-vm-adapter/src/gondolin-file-operation-patch.host.e2e.test.ts
```

For an isolated packed-consumer installation, set
`AGENT_VM_TEST_PACKED_CONSUMER_ROOT` to that installation's root when running the
same permanent test. It resolves agent-vm → gondolin-vm-adapter → Gondolin and
rejects dependency paths outside the isolated root before running all five
strict-rejection probes. Leave the variable unset for the workspace regression.

Before patch application, four failure cases fail while success passes. After
application, all must pass without a process-wide rejection handler. Real VM
qualification additionally covers the rootfs writer's actual failure path; a
mocked transport test alone does not establish a complete file-transfer feature.

Local qualification on 2026-09-06: the permanent regression changed from four
failures/one pass before application to five passes after application. Real
rootfs probes against the installed patched package passed source-input failure,
mid-transfer cancellation and early destination-open failure under Node's strict
unhandled-rejection mode; public errors remained visible and VM cleanup completed.
The stock guest helper was unchanged. The adapter's 33 unit tests and typecheck,
test taxonomy, new-test lint and changed-TypeScript formatting passed. Existing
type-aware warnings in the adapter are unrelated to the two-line dependency fix.
These observations do not establish full Google/Gog integration or downstream
consumer distribution.

## Installation and distribution boundary

`pnpm install --frozen-lockfile` in this workspace must apply the registered patch.
Do not edit installed `node_modules` manually or change the dependency version
without requalifying the patch and obtaining approval for the changed patch.

**A workspace pnpm patch is not automatically transitive to published consumers.**
The adapter's package currently depends on the public Gondolin package; shipping
our adapter does not make a downstream package manager inherit this workspace's
`patchedDependencies`. Do not claim released/deployed rootfs qualification from a
local patched checkout. Before shipping work that requires this fix, establish an
approved distribution path and run the regression against that exact installed
consumer artifact. No production deployment was changed by this local patch.

### Explicit deployment-root installation

For a pnpm deployment that installs agent-vm, the approved patch must also be
present at the deployment root. This is an explicit installation input, not an
automatic side effect of importing agent-vm:

```text
deployment/
  package.json              @agent-vm/agent-vm dependency
  pnpm-workspace.yaml       exact patchedDependencies entry below
  pnpm-lock.yaml            generated patched resolution, committed
  patches/
    @earendil-works__gondolin@0.12.0.patch
```

Copy the exact approved patch from this repository, preserving its contents.
Add the following entry to the deployment's existing workspace configuration;
do not replace unrelated settings or patches:

```yaml
patchedDependencies:
  '@earendil-works/gondolin@0.12.0': patches/@earendil-works__gondolin@0.12.0.patch
```

Run the deployment's normal pnpm install to update its lockfile. Commit the patch,
registration and lockfile together. Subsequent clean installations use
`pnpm install --frozen-lockfile`. Requalify if the installed adapter resolves a
different Gondolin version; a version-scoped patch is not a wildcard fix.
Actual deployment configuration edits still require deployment-change authority.

This installation path was checked in two isolated projects against published
`@agent-vm/agent-vm@0.0.147`: the unpatched transitive dependency failed the strict
Node rejection probe; root registration made it pass; a second empty project
installed from the same frozen lockfile and passed again. Resolution was followed
through agent-vm -> gondolin-vm-adapter -> Gondolin, not through a direct test-only
dependency. Install scripts were disabled for this dependency-resolution probe;
it does not prove native addon builds, controller startup or a running deployment.
No source-workspace symlinks or node_modules were copied into either project.

## Maintenance and fork TODO

- **TODO: evaluate a maintained Gondolin fork** if upstream maintenance is
  insufficient. Decide ownership, supported platforms, dependency/helper/image
  release handling and update cadence before adoption. This TODO is not permission
  to create, publish or adopt a fork; obtain Shravan's separate approval.
- Deployment-root registration is an explicit route, not automatic package
  propagation. An actual deployment must carry and verify those inputs before
  using this fix. Automatic package-contained distribution remains unresolved;
  do not hide an install-time patch script in consumers.
- Track upstream PR #136 without assuming it will merge. On a candidate fixed
  release, obtain approval for the dependency/patch transition, verify equivalent
  promise handling, remove the obsolete patch registration and run fresh installed
  dependency plus real-VM regressions. A merge alone is not a released fix.
- Any additional Gondolin defect needs its own explicit approval and entry here.
  The experimental guest duplex fix is not part of this patch.
