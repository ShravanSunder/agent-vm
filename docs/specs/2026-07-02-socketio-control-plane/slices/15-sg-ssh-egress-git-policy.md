# 15 - SG (SSH Git) Egress Read Policy

Purpose:
- Set the delivered managed VM SSH-egress execPolicy so the guest can read
  (`git-upload-pack`) but cannot push (`git-receive-pack`) at the host boundary.
- Close AF-1: this surface is normative (CUT:1844-1858) with a proof row
  (GIT-1) but had no owning slice.

Source anchors:
- CUT Git Access And Push Policy (`:1844-1860`): "the managed VM spec must set
  an SSH egress execPolicy that allows git-upload-pack, denies git-receive-pack
  unconditionally, denies non-git exec; gondolin-adapter exposes the ssh egress
  + execPolicy surface; openclaw-gateway and worker-gateway wire it into the VM
  spec."
- CUT git-access proof (`:2316-2322`).

Feasibility (verified, NOT a stop gate):
- Gondolin's host SSH server already supports git-verb egress execPolicy:
  `SshExecPolicy = (SshExecRequest) => SshExecDecision`
  (`gondolin host/src/qemu/ssh.ts:73`), git service names in
  `host/src/ssh/exec.ts`, and `host/examples/confirm-bash.ts` distinguishes
  git-upload-pack (fetch) from git-receive-pack (push).
- Repo state today: ZERO refs to `execPolicy` / `git-receive-pack` /
  `git-upload-pack` / `sshEgress`; `gondolin-adapter` exposes only inbound
  `SshAccess` (`vm-adapter.ts:59`). This is an ownership/wiring gap.

Owned write surface:
- `packages/gondolin-adapter/src/vm-adapter.ts` — expose the Gondolin
  ssh-egress + execPolicy passthrough surface (new egress config alongside
  `SshAccess`).
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts` — wire the egress config
  into the gateway VM spec.
- `packages/worker-gateway/src/worker-lifecycle.ts` — wire the egress config
  into the worker VM spec.

Dependencies:
- None on the control plane (git read path is orthogonal to Socket.IO). After
  GATE-0a succeeds, this may run early in parallel with S1.
- Coordinate the `openclaw-lifecycle.ts` / `worker-lifecycle.ts` edits with S5a
  (SG / SSH Git adds egress execPolicy config; S5a removes raw control tcpHosts —
  different regions of the same builders).

Checkpoint:
- Delivered gateway and worker VM specs carry the SSH-egress execPolicy.
- `git-upload-pack` allowed to the configured upstream git host set;
  `git-receive-pack` denied unconditionally; non-git exec denied.
- `gondolin-adapter` keeps optional repo allowlisting for future callers that
  have a trusted repo set at VM-spec construction time. The current OpenClaw
  and Worker lifecycle builders are zone-level builders and do not receive the
  task/zone repo list, so SG does not claim lifecycle-level per-repo
  enforcement in this cutover.

Proof rows:
- GIT-1 (host-boundary receive-pack denial + upload-pack allowed).

Commands:
- `pnpm test:unit` (adapter/lifecycle egress-config shape)
- `mise exec -- pnpm run test:e2e:vm`

Split trigger:
- Split the gondolin-adapter egress surface from the two-lifecycle wiring if the
  adapter change needs its own review.
