# Socket.IO Control Plane Slice Plans

These files are the implementor-facing vertical slice plans for the hard
cutover. The root implementation plan owns the global DAG and terminal proof
gates; each slice file owns one executable work unit.

Slice file count: 19 including this README, after adding SMA on 2026-07-05.

Execution rule:
- SMA (`00b-sma-openclaw-same-zone-multi-agent.md`) is an independent plan/code repair and may run before GATE-0a.
- Run `00-gate-0-runtime-provenance.md` before any production Socket.IO cutover slice.
- Do not start code implementation if GATE-0a fails.
- For a slice, use its owned write surface first. Touch hot files only through
  the owner/sequence named in the slice.
- Each slice must pass its local proof rows before handing off to the next
  integration gate.

Slice order:
1. `00b-sma-openclaw-same-zone-multi-agent.md`
2. `00-gate-0-runtime-provenance.md`
3. `01-s1-control-protocol-contracts.md`
4. Parallel after S1: `02-s2-gateway-control-service-placement.md`,
   `03-s3-controller-session-runtime.md`,
   `08-s7-tool-portal-backend-taxonomy.md`,
   `09-swa-worker-control-contracts.md`
   - `15-sg-ssh-egress-git-policy.md` is SG (SSH Git): a
     control-plane-independent git READ host-boundary slice. After GATE-0a
     succeeds, it may run in parallel with S1; sequence its two lifecycle edits
     with S5a. It owns GIT-1 — SWc does NOT.
5. Parallel after S1+S3: `04-s4a-gateway-control-contract-lease-rpc.md`,
   `06-s6a-health-eventkind-remap.md`, `07-s6c-correlation-evidence.md`,
   `10-swb-worker-control-service.md`,
   `11-swc-worker-rpc-rewire.md`
6. After caller moves: `05-s4b-controller-route-disposition.md`,
   `07b-s6b-recovery-corroboration.md`
7. Last/removal: `12-s5a-raw-control-removal.md`,
   `13-s5b-mcp-portal-identity-removal.md`,
   `14-s5c-collector-fail-closed.md`

Terminal proof:
- `mise exec -- pnpm run test:e2e:openclaw`
- `set -a; source .env.local; set +a; AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- pnpm run test:e2e:worker`
  The bare Worker command is expected to fail the evidence wrapper when live
  Worker tests skip for missing model credentials; the mapped command is the
  canonical no-skip Worker terminal proof.
- `mise exec -- pnpm run test:e2e:vm`
- `mise exec -- pnpm test:e2e`
- `pnpm check`
- External full-system proof in `../shravan-claw-beta` with actual Discord and
  actual OpenClaw. Mock-only or package-local proof is not a substitute for
  this live deployment lane when making the PR-ready claim. Refresh beta with
  local tarballs, reconcile the OpenClaw runtime target, stage at least two
  same-zone agents for SMA proof, exercise the real non-default-agent
  Discord/OpenClaw path, and capture redacted controller/OpenClaw/Discord
  evidence.
